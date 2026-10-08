import { check } from "./texture-baseline-gpu.mjs";
import {
  initializePcTextureCodecs,
  cookPcTextureRgba,
  decodePcTextureMip,
  resamplePcTexture
} from "../../.test-dist/assets/codec/PcTextureCook.js";
import {
  PcTexturePreparation,
  createPcTextureWorker
} from "../../.test-dist/assets/codec/PcTexturePreparation.js";
import {
  writeTextureProductPlane,
  openTextureProduct,
  saveTextureProduct,
  textureProductHash
} from "../../.test-dist/assets/TextureProduct.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

function sourceImage(w, h, semantic) {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (semantic === "normal-linear") a.set([80 + (x % 32), 90 + (y % 32), x % 64 < 32 ? 45 : 200, 255], i);
      else
        a.set(
          [
            40 + ((x >> 4) % 128),
            60 + ((y >> 4) % 128),
            100 + (((x + y) >> 4) % 128),
            (x + y) % 2 ? 127 : 128
          ],
          i
        );
    }
  return a;
}
// Independent unfiltered texel expansion isolates native sampling/LOD from
// device BC4 decode precision. Neither RGBA8 rounding nor ideal float RGTC
// interpolation is an exact reference for the hardware decoder.
async function expandBc4Reference(device, encoder, source, reference, mip) {
  const module = device.createShaderModule({
    code: `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var output: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= textureDimensions(output)) { return; }
  textureStore(output, id.xy, textureLoad(source, vec2i(id.xy), 1, 0));
}`
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" }
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: source.createView({ dimension: "2d-array", baseMipLevel: mip.level, mipLevelCount: 1 })
      },
      {
        binding: 1,
        resource: reference.createView({
          dimension: "2d",
          baseMipLevel: mip.level,
          mipLevelCount: 1,
          baseArrayLayer: 1,
          arrayLayerCount: 1
        })
      }
    ]
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(mip.width / 8), Math.ceil(mip.height / 8));
  pass.end();
}
function graphProgram(semantic) {
  const b = new AppearanceGraphBuilder(),
    uv = b.input("uv0", 2, "surface", undefined, "uv0");
  const sample = b.texture(
    snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb", [0.13, -0.09], [1.3, 0.8], 0.2),
    uv
  );
  b.output("rgba", sample);
  if (semantic === "normal-linear") {
    const xyz = b.operation(
      "multiply",
      b.operation(
        "subtract",
        b.operation("multiply", b.swizzle(sample, [0, 1, 2]), b.constant(2)),
        b.constant(1)
      ),
      b.constant([1.7, 0.6, 1])
    );
    b.output("normalScale", xyz);
  }
  return lowerNativeMaterial(compileAppearanceGraph(b.build()));
}
function qualityObservation(codecs, product, source) {
  const semantic = product.metadata.semantic;
  const linear = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const result = [];
  let sw = product.metadata.sourceWidth,
    sh = product.metadata.sourceHeight;
  for (const mip of product.metadata.planes[0].mips) {
    if (sw !== mip.width || sh !== mip.height) {
      source = resamplePcTexture(
        codecs.basis,
        source,
        sw,
        sh,
        mip.width,
        mip.height,
        semantic === "base-color-srgb",
        semantic === "normal-linear"
      );
    }
    sw = mip.width;
    sh = mip.height;
    const decoded = decodePcTextureMip(
      codecs.basis,
      product.chunks.get(mip.chunkId),
      sw,
      sh,
      semantic === "occlusion-linear" ? 4 : 7
    );
    let samples = 0,
      squaredError = 0,
      maximumError = 0,
      maximumAngleDegrees = 0,
      maximumLengthError = 0;
    const channels = semantic === "occlusion-linear" ? 1 : 3;
    const step = Math.max(1, Math.floor((sw * sh) / 4096));
    for (let p = 0; p < sw * sh; p += step) {
      for (let c = 0; c < channels; c++) {
        const sourceByte = source[p * 4 + (semantic === "occlusion-linear" ? 1 : c)];
        const decodedByte = decoded[p * 4 + c];
        const error =
          semantic === "base-color-srgb"
            ? Math.abs(linear(sourceByte) - linear(decodedByte))
            : Math.abs(sourceByte - decodedByte) / 255;
        maximumError = Math.max(maximumError, error);
        squaredError += error * error;
      }
      if (semantic === "normal-linear") {
        const a = [0, 1, 2].map((c) => (source[p * 4 + c] / 255) * 2 - 1);
        const b = [0, 1, 2].map((c) => (decoded[p * 4 + c] / 255) * 2 - 1);
        const al = Math.hypot(...a),
          bl = Math.hypot(...b);
        maximumLengthError = Math.max(maximumLengthError, Math.abs(al - bl));
        if (al > 0 && bl > 0) {
          maximumAngleDegrees = Math.max(
            maximumAngleDegrees,
            (Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, v, c) => sum + v * b[c], 0) / (al * bl)))) *
              180) /
              Math.PI
          );
        }
      }
      samples++;
    }
    result.push({
      level: mip.level,
      samples,
      rmse: Math.sqrt(squaredError / (samples * channels)),
      maximumError,
      maximumAngleDegrees,
      maximumLengthError
    });
  }
  return {
    reference:
      "pinned upstream CPU block decode; independent native/WASM byte equivalence is a separate Node gate",
    mips: result
  };
}

async function sampleProduct(device, codecs, product) {
  let maxError = 0,
    samples = 0,
    coverageChecks = 0,
    worst = null;
  for (let pi = 0; pi < product.metadata.planes.length; pi++) {
    const plane = product.metadata.planes[pi],
      w = product.metadata.storageWidth,
      h = product.metadata.storageHeight;
    const target = device.createTexture({
      label: "T4.1/BC-array",
      size: [w, h, 3],
      mipLevelCount: plane.mips.length,
      format: plane.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const referenceFormat =
      plane.format === "bc4-r-unorm"
        ? "r32float"
        : plane.format === "r8unorm"
          ? "r8unorm"
          : plane.format.endsWith("srgb")
            ? "rgba8unorm-srgb"
            : "rgba8unorm";
    const buffers = [];
    try {
      check(
        writeTextureProductPlane(device, product, pi, target, 1) ===
          plane.mips.reduce((sum, m) => sum + m.byteLength, 0),
        "tight upload accounting mismatch"
      );
      const program = graphProgram(product.metadata.semantic),
        n = 96,
        width = program.outputCount + 4;
      const module = device.createShaderModule({
        code: `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<storage,read_write> output: array<f32>;
@group(0) @binding(3) var<storage,read> constants:array<f32>;
fn native_material_constant(base:u32,slot:u32)->f32 {return constants[base+slot];}
fn native_material_sample_0(base:u32,uv:vec2f,dx:vec2f,dy:vec2f)->vec4f {
 return textureSampleGrad(source,source_sampler,uv,i32(base),dx,dy);
}
${program.source}
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id:vec3u){
 if id.x>=${n}u {return;}
 let i=id.x;
 let uv=vec2f(f32(i%12u)/4.0-0.4,f32(i/12u)/3.0-0.6);
 let lod=f32(i%${plane.mips.length}u)+0.35;
 let dx=vec2f(exp2(lod)/${w}.0,0.0);
 let dy=vec2f(0.0,exp2(lod)/${h}.0);
 var inputs:NativeMaterialInputs;
 inputs.center[0]=vec4f(uv,0.0,0.0);
 inputs.x[0]=vec4f(uv+dx,0.0,0.0);
 inputs.y[0]=vec4f(uv+dy,0.0,0.0);
 let values=native_material_evaluate(select(0u,1u,i<${n}u),inputs);
 for(var c=0u;c<${program.outputCount}u;c++){output[i*${width}u+c]=values[c];}
 let raw=textureSampleLevel(source,source_sampler,uv,1,lod);
 output[i*${width}u+${program.outputCount}u]=raw.r;
 // Main and VSM use the same exact coverage expression and source plane.
 let a=raw.${plane.role === "coverage" ? "r" : "a"};
 output[i*${width}u+${program.outputCount + 1}u]=select(0.0,1.0,a>=127.0/255.0);
 output[i*${width}u+${program.outputCount + 2}u]=select(0.0,1.0,a>=128.0/255.0);
 output[i*${width}u+${program.outputCount + 3}u]=select(0.0,1.0,a>=0.5);
}`
      });
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
      check(!errors.length, JSON.stringify(errors));
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
      const constants = device.createBuffer({
        size: Math.max(program.constants.length * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      buffers.push(constants);
      device.queue.writeBuffer(constants, 0, new Float32Array(program.constants));
      for (const addressMode of ["repeat", "clamp-to-edge", "mirror-repeat"]) {
        const sampler = device.createSampler({
          addressModeU: addressMode,
          addressModeV: addressMode,
          minFilter: "linear",
          magFilter: "linear",
          mipmapFilter: "linear"
        });
        const size = n * width * 4;
        const stride = Math.ceil(size / 256) * 256;
        const output = device.createBuffer({
          size: stride * 2,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        const read = device.createBuffer({
          size: stride * 2,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        buffers.push(output, read);
        const encoder = device.createCommandEncoder();
        // Reference also uses layer1, avoiding a shader branch or native evaluator change.
        const referenceArray = device.createTexture({
          size: [w, h, 2],
          mipLevelCount: plane.mips.length,
          format: referenceFormat,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            (plane.format === "bc4-r-unorm" ? GPUTextureUsage.STORAGE_BINDING : 0)
        });
        try {
          for (const m of plane.mips) {
            if (plane.format === "bc4-r-unorm") {
              await expandBc4Reference(device, encoder, target, referenceArray, m);
              continue;
            }
            const block = product.chunks.get(m.chunkId);
            const bytes =
              plane.format === "r8unorm"
                ? block
                : decodePcTextureMip(codecs.basis, block, m.width, m.height, 7);
            device.queue.writeTexture(
              { texture: referenceArray, mipLevel: m.level, origin: [0, 0, 1] },
              bytes,
              { bytesPerRow: m.width * (plane.format === "r8unorm" ? 1 : 4) },
              { width: m.width, height: m.height }
            );
          }
          for (const [index, texture] of [target, referenceArray].entries()) {
            const group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: texture.createView({ dimension: "2d-array" }) },
                { binding: 1, resource: sampler },
                { binding: 2, resource: { buffer: output, offset: index * stride, size } },
                { binding: 3, resource: { buffer: constants } }
              ]
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(3);
            pass.end();
          }
          encoder.copyBufferToBuffer(output, 0, read, 0, stride * 2);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const data = new Float32Array(read.getMappedRange());
          for (let i = 0; i < n * width; i++) {
            const error = Math.abs(data[i] - data[i + stride / 4]);
            check(Number.isFinite(error), "non-finite sample");
            if (error > maxError) {
              maxError = error;
              worst = {
                plane: plane.role,
                addressMode,
                sample: Math.floor(i / width),
                channel: i % width,
                actual: data[i],
                reference: data[i + stride / 4]
              };
            }
            if (i % width >= program.outputCount + 1 && plane.role === "coverage") {
              check(error === 0, "exact main/VSM coverage changed");
              coverageChecks++;
            }
          }
          read.unmap();
          samples += n;
        } finally {
          referenceArray.destroy();
        }
      }
    } finally {
      for (const b of buffers) b.destroy();
      target.destroy();
    }
  }
  check(
    maxError <= 0.0001,
    `BC native shader numerical error ${maxError} exceeds unchanged 1e-4: ${JSON.stringify(worst)}`
  );
  return { maxError, samples, coverageChecks };
}

export async function runPcTextureProductGpuOracle(device) {
  const codecs = await initializePcTextureCodecs();
  const workerInitializations = [];
  const service = new PcTexturePreparation({
    createWorker: async () => {
      const started = performance.now();
      const worker = await createPcTextureWorker(
        new URL("../../.test-dist/assets/codec/workers/pc-texture-worker.js", import.meta.url)
      );
      workerInitializations.push(performance.now() - started);
      return worker;
    }
  });
  const cases = [];
  let recoveryProduct;
  try {
    for (const size of [1024, 2048, 4096])
      for (const semantic of ["base-color-srgb", "normal-linear", "orm-linear", "occlusion-linear"]) {
        const rgba = sourceImage(size, size, semantic),
          start = performance.now();
        const qualitySource = rgba.slice();
        const { product, evidence } = await service.cookRgba(rgba.buffer, size, size, {
          semantic,
          sourceUri: `fixture://${size}/${semantic}`,
          channel: semantic === "occlusion-linear" ? 1 : 0
        });
        const ready = performance.now(),
          sampling = await sampleProduct(device, codecs, product);
        cases.push({
          size,
          semantic,
          wallMs: ready - start,
          worker: evidence,
          bytes: product.evidence,
          identity: product.identity,
          quality: qualityObservation(codecs, product, qualitySource),
          ...sampling
        });
      }
    const rgba = sourceImage(257, 129, "base-color-srgb");
    const { product } = await service.cookRgba(rgba.buffer, 257, 129, {
      semantic: "base-color-srgb",
      exactAlpha: true,
      sourceUri: "fixture://NPOT/coverage"
    });
    recoveryProduct = await openTextureProduct(await saveTextureProduct(product));
    cases.push({
      size: "257x129",
      semantic: "exact coverage",
      ...(await sampleProduct(device, codecs, recoveryProduct))
    });
    const suppliedNormal = await service.cookRgba(
      sourceImage(32, 32, "normal-linear").buffer,
      32,
      32,
      {
        semantic: "normal-linear",
        sourceUri: "fixture://provided-signed-nonunit"
      },
      undefined,
      [16, 8, 4, 2, 1].map((size) => new Uint8Array(size * size * 4).fill(32).buffer)
    );
    cases.push({
      semantic: "provided signed/non-unit normal",
      ...(await sampleProduct(device, codecs, suppliedNormal.product))
    });
    // Cancellation terminates an assigned worker; same producer can retry without
    // a late result changing this CPU product or a material epoch.
    const controller = new AbortController();
    const pending = service.cookRgba(
      sourceImage(2048, 2048, "normal-linear").buffer,
      2048,
      2048,
      { semantic: "normal-linear", sourceUri: "fixture://abort" },
      controller.signal
    );
    const rejected = pending.then(
      () => false,
      (e) => e.name === "AbortError"
    );
    while (service.evidence().activeWorkers === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    check(await rejected, "Assigned Worker cancellation failed");
    const retry = await service.cookRgba(sourceImage(32, 32, "orm-linear").buffer, 32, 32, {
      semantic: "orm-linear",
      sourceUri: "fixture://retry"
    });
    check(retry.product.evidence.ownedPayloadBytes > 0, "Worker retry failed");
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      const canvas = new OffscreenCanvas(32, 32),
        ctx = canvas.getContext("2d");
      ctx.fillStyle = "#52836a";
      ctx.fillRect(0, 0, 32, 32);
      const blob = await canvas.convertToBlob({ type });
      check(blob.type === type, `${type} unavailable`);
      const cooked = await service.cookImage(await blob.arrayBuffer(), type, {
        semantic: "base-color-srgb",
        sourceUri: `fixture://${type}`
      });
      cases.push({
        rawDecode: type,
        worker: cooked.evidence,
        ...(await sampleProduct(device, codecs, cooked.product))
      });
    }
  } finally {
    service.dispose();
  }
  const final = service.evidence();
  check(
    final.activeWorkers === 0 && final.queuedTasks === 0 && final.inFlightEstimatedBytes === 0,
    "Worker teardown credits not zero"
  );
  // Keep prefix evidence if a later device replay fails; no production diagnostics.
  console.info(
    "T4.1 completed product matrix",
    JSON.stringify({ cases, workerTeardown: final, workerInitializations })
  );
  const replay = await replayDeviceEpoch(codecs, recoveryProduct);
  return {
    stage: "T4.1",
    scope:
      "non-production immutable CPU product -> compressed array layer -> actual native evaluator; no renderer/residency cutover",
    cases,
    workerTeardown: final,
    workerInitializations,
    deviceEpochReplay: replay,
    largeModel: "NOT-RUN user excluded",
    gpuEncoding: "NONE Spark DEFER",
    actualDriverPeakBytes: null
  };
}
async function replayDeviceEpoch(codecs, product) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const old = await adapter.requestDevice({
    requiredFeatures: ["texture-compression-bc", "float32-filterable"]
  });
  let before;
  try {
    before = await sampleProduct(old, codecs, product);
    await old.queue.onSubmittedWorkDone();
  } finally {
    old.destroy();
  }
  const loss = await old.lost;
  const freshAdapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const recovered = await freshAdapter.requestDevice({
    requiredFeatures: ["texture-compression-bc", "float32-filterable"]
  });
  let replay;
  const errors = [];
  const onError = (event) => errors.push(event.error.message);
  recovered.addEventListener("uncapturederror", onError);
  for (const scope of ["internal", "out-of-memory", "validation"]) {
    recovered.pushErrorScope(scope);
  }
  try {
    replay = await sampleProduct(recovered, codecs, product);
    await recovered.queue.onSubmittedWorkDone();
    for (let i = 0; i < 3; i++) {
      const error = await recovered.popErrorScope();
      if (error) {
        errors.push(error.message);
      }
    }
    check(errors.length === 0, `Replay device validation: ${JSON.stringify(errors)}`);
  } finally {
    recovered.removeEventListener("uncapturederror", onError);
    recovered.destroy();
  }
  return { before, after: replay, lossReason: loss.reason, errors };
}
export async function runPcTextureRecoveryGpuOracle(device) {
  const codecs = await initializePcTextureCodecs();
  const { product } = await cookPcTextureRgba(codecs, sourceImage(257, 129, "base-color-srgb"), 257, 129, {
    semantic: "base-color-srgb",
    exactAlpha: true,
    sourceUri: "fixture://NPOT/coverage"
  });
  const owned = await openTextureProduct(await saveTextureProduct(product));
  const mips = [
    [16, 8],
    [8, 4],
    [4, 2],
    [2, 1],
    [1, 1]
  ].map(([w, h]) => new Uint8Array(w * h * 4).fill(32));
  const normal = await cookPcTextureRgba(
    codecs,
    new Uint8Array(33 * 17 * 4).fill(32),
    33,
    17,
    {
      semantic: "normal-linear",
      sourceUri: "fixture://provided-NPOT"
    },
    mips
  );
  return {
    stage: "T4.1",
    scope: "affected device-epoch replay only, same helper as full matrix; fresh adapter per device",
    identity: owned.identity,
    providedNpotNormal: await sampleProduct(device, codecs, normal.product),
    replay: await replayDeviceEpoch(codecs, owned)
  };
}
