import { check, distribution } from "./texture-baseline-gpu.mjs";

const sparkRevision = "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf";
const sparkSourceHash = "7d3cfe62db69ac317d8288ec6820fc896ab5a39731aa8f6802d34151e69dc469";

function blockChain(width, height, bytesPerBlock) {
  const levels = [];
  do {
    const rows = Math.ceil(height / 4);
    const tightRow = Math.ceil(width / 4) * bytesPerBlock;
    const paddedRow = Math.ceil(tightRow / 256) * 256;
    levels.push({ width, height, rows, tightRow, paddedRow, bytes: tightRow * rows });
    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  } while (true);
  return levels;
}

// Only the device/encoders are wrapped. Real resources retain their WebGPU brands.
function observeDevice(device) {
  const queries = device.createQuerySet({ type: "timestamp", count: 128 });
  const resolved = device.createBuffer({
    size: 1024,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 1024,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  let state;
  const queue = new Proxy(device.queue, {
    get(target, key) {
      if (key === "submit")
        return (commands) => {
          if (state) state.submits++;
          target.submit(commands);
        };
      if (key === "copyExternalImageToTexture")
        return (source, destination, size) => {
          if (state) state.sourceUploadBytes += size.width * size.height * 4;
          target.copyExternalImageToTexture(source, destination, size);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const proxy = new Proxy(device, {
    get(target, key) {
      if (key === "queue") return queue;
      if (key === "createBuffer")
        return (descriptor) => {
          if (state) state.bufferAllocatedBytes += descriptor.size;
          return target.createBuffer(descriptor);
        };
      if (key === "createTexture")
        return (descriptor) => {
          if (state) {
            const [width, height] = descriptor.size;
            if (descriptor.format.startsWith("rgba8")) {
              let w = width,
                h = height;
              for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
                state.rgbaAllocatedBytes += w * h * 4;
                w = Math.max(1, Math.floor(w / 2));
                h = Math.max(1, Math.floor(h / 2));
              }
            }
          }
          return target.createTexture(descriptor);
        };
      if (key === "createCommandEncoder")
        return (descriptor) => {
          if (state) state.encoders++;
          const encoder = target.createCommandEncoder(descriptor);
          return new Proxy(encoder, {
            get(command, name) {
              if (name === "beginComputePass" || name === "beginRenderPass")
                return (passDescriptor) => {
                  const query = state.queryCount;
                  check(query + 2 <= 128, "Probe query capacity exceeded");
                  state.queryCount += 2;
                  state.passKinds.push(name);
                  const pass = command[name]({
                    ...passDescriptor,
                    timestampWrites: {
                      querySet: queries,
                      beginningOfPassWriteIndex: query,
                      endOfPassWriteIndex: query + 1,
                    },
                  });
                  return new Proxy(pass, {
                    get(actual, operation) {
                      if (operation === "dispatchWorkgroups")
                        return (...args) => {
                          state.dispatches++;
                          actual.dispatchWorkgroups(...args);
                        };
                      const value = Reflect.get(actual, operation, actual);
                      return typeof value === "function" ? value.bind(actual) : value;
                    },
                  });
                };
              if (name === "copyBufferToTexture")
                return (source, destination, size) => {
                  state.blockCopyPaddedBytes += source.bytesPerRow * (size.height / 4);
                  state.destinations.push({
                    mip: destination.mipLevel,
                    origin: destination.origin ?? [0, 0, 0],
                  });
                  command.copyBufferToTexture(source, destination, size);
                };
              const value = Reflect.get(command, name, command);
              return typeof value === "function" ? value.bind(command) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    proxy,
    start() {
      state = {
        queryCount: 0,
        passKinds: [],
        dispatches: 0,
        encoders: 0,
        submits: 0,
        sourceUploadBytes: 0,
        bufferAllocatedBytes: 0,
        rgbaAllocatedBytes: 0,
        blockCopyPaddedBytes: 0,
        destinations: [],
      };
    },
    async collect() {
      const evidence = state;
      state = null;
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(queries, 0, evidence.queryCount, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, evidence.queryCount * 8);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(readback.getMappedRange());
      const durations = [];
      for (let index = 0; index < evidence.queryCount; index += 2)
        durations.push(Number(values[index + 1] - values[index]) / 1e6);
      readback.unmap();
      // Stock Spark's final compute pass encodes every mip; preceding passes filter mips.
      return {
        ...evidence,
        encodeGpuMs: durations.at(-1),
        mipGpuMs: durations.slice(0, -1).reduce((sum, ms) => sum + ms, 0),
        diagnosticSubmits: 1,
      };
    },
    destroy() {
      queries.destroy();
      resolved.destroy();
      readback.destroy();
    },
  };
}

function makeSource(width, height, semantic) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (semantic === "normal") {
        pixels.set([96 + (x % 64), 96 + (y % 64), (x >> 5) & 1 ? 224 : 32, 255], at);
      } else {
        pixels.set(
          [
            Math.floor((x * 255) / width),
            Math.floor((y * 255) / height),
            ((x >> 4) ^ (y >> 4)) & 255,
            (x >> 4) & 1 ? 127 : 129,
          ],
          at,
        );
      }
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  return { canvas, pixels };
}

async function readBlocks(device, texture, levels) {
  const buffers = levels.map((level) =>
    device.createBuffer({
      size: level.paddedRow * level.rows,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  );
  const encoder = device.createCommandEncoder();
  for (let mip = 0; mip < levels.length; mip++) {
    const level = levels[mip];
    encoder.copyTextureToBuffer(
      { texture, mipLevel: mip },
      { buffer: buffers[mip], bytesPerRow: level.paddedRow },
      { width: Math.ceil(level.width / 4) * 4, height: level.rows * 4 },
    );
  }
  device.queue.submit([encoder.finish()]);
  const blocks = [];
  for (let mip = 0; mip < levels.length; mip++) {
    const level = levels[mip],
      buffer = buffers[mip];
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const tight = new Uint8Array(level.bytes);
    for (let row = 0; row < level.rows; row++)
      tight.set(
        padded.subarray(row * level.paddedRow, row * level.paddedRow + level.tightRow),
        row * level.tightRow,
      );
    blocks.push(tight);
    buffer.unmap();
    buffer.destroy();
  }
  return blocks;
}

async function qualityProbe(device, texture, source, width, height, scalar, srgb) {
  const output = device.createTexture({
    size: [64, 64],
    format: "rgba8unorm",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const module = device.createShaderModule({
    code: `
    @group(0) @binding(0) var input: texture_2d<f32>;
    @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
    @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
      if (any(id.xy >= vec2u(64))) { return; }
      let extent = textureDimensions(input);
      let position = vec2i((vec2f(id.xy) + 0.5) / 64.0 * vec2f(extent));
      var color = textureLoad(input, position, 0);
      if (${srgb}) {
        let encoded = select(1.055 * pow(max(color.rgb, vec3f(0)), vec3f(1.0 / 2.4)) - 0.055, color.rgb * 12.92, color.rgb <= vec3f(0.0031308));
        color = vec4f(encoded, color.a);
      }
      textureStore(output, vec2i(id.xy), color);
    }`,
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: texture.createView({
          dimension: "2d",
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          mipLevelCount: 1,
        }),
      },
      { binding: 1, resource: output.createView() },
    ],
  });
  const buffer = device.createBuffer({
    size: 64 * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(8, 8);
  pass.end();
  encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [64, 64]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const actual = new Uint8Array(buffer.getMappedRange());
  const squares = [0, 0, 0, 0];
  let max = 0,
    alphaThresholdFlips = 0;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const expectedAt =
        (Math.floor(((y + 0.5) * height) / 64) * width + Math.floor(((x + 0.5) * width) / 64)) * 4;
      const actualAt = (y * 64 + x) * 4;
      for (let channel = 0; channel < (scalar ? 1 : 4); channel++) {
        const difference = actual[actualAt + channel] - source[expectedAt + channel];
        squares[channel] += difference * difference;
        max = Math.max(max, Math.abs(difference));
      }
      if (!scalar && actual[actualAt + 3] >= 128 !== source[expectedAt + 3] >= 128) alphaThresholdFlips++;
    }
  buffer.unmap();
  buffer.destroy();
  output.destroy();
  return {
    samplePixels: 4096,
    mip: 0,
    rmseChannels: squares.map((sum) => Math.sqrt(sum / 4096)),
    maxChannelError: max,
    alphaThresholdFlips,
    reference: "generated byte source; sRGB sample re-encoded only by diagnostic shader",
    canonicalMipQuality: "not-proven",
    acceptance: "observational, not production quality adoption",
  };
}

export async function runTextureEncoderProbeGpuOracle(device) {
  const bytes = await (await fetch("/.local/texture-design-spark/src/spark.js")).arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  check(hash === sparkSourceHash, "Pinned Spark source changed; clone exact revision from Execution");
  const { default: Spark } = await import("/.local/texture-design-spark/src/spark.js");
  const observation = observeDevice(device);
  const initStart = performance.now();
  const spark = await Spark.create(observation.proxy, {
    preload: ["bc7-rgba", "bc4-r"],
    useTimestampQueries: false,
    cacheTempResources: false,
  });
  const initMs = performance.now() - initStart;
  const cases = [];
  const inputs = [1024, 2048, 4096].flatMap((size) =>
    ["base-color", "normal", "orm", "scalar"].map((semantic) => ({ width: size, height: size, semantic })),
  );
  inputs.push(
    { width: 257, height: 129, semantic: "orm" },
    { width: 256, height: 256, semantic: "array-layer-probe", layers: 2 },
  );
  try {
    for (const { width, height, semantic, layers = 1 } of inputs) {
      const srgb = semantic === "base-color";
      const format = semantic === "scalar" ? "bc4-r-unorm" : srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm";
      const storageWidth = Math.ceil(width / 4) * 4;
      const storageHeight = Math.ceil(height / 4) * 4;
      const levels = blockChain(storageWidth, storageHeight, semantic === "scalar" ? 8 : 16);
      const residentBytes = levels.reduce((sum, level) => sum + level.bytes, 0);
      const { canvas, pixels } = makeSource(width, height, semantic);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const decodeStart = performance.now();
      const image = await createImageBitmap(blob, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      const decodeMs = performance.now() - decodeStart;
      const cpu = [],
        wall = [],
        encode = [],
        mip = [];
      let lastEvidence, output;
      try {
        for (let sample = 0; sample < 23; sample++) {
          output = device.createTexture({
            size: [storageWidth, storageHeight, layers],
            mipLevelCount: levels.length,
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
          });
          observation.start();
          const start = performance.now();
          const result = await spark.encodeTexture(image, {
            format,
            mipmapCount: levels.length,
            mips: true,
            normal: semantic === "normal",
            outputTexture: output,
            outputMipLevel: 0,
          });
          const cpuMs = performance.now() - start;
          check(result === output, "Spark changed strict destination identity");
          await device.queue.onSubmittedWorkDone();
          const wallMs = performance.now() - start;
          lastEvidence = await observation.collect();
          if (sample >= 3) {
            cpu.push(cpuMs);
            wall.push(wallMs);
            encode.push(lastEvidence.encodeGpuMs);
            mip.push(lastEvidence.mipGpuMs);
          }
          if (sample !== 22) {
            output.destroy();
            output = null;
          }
        }
        const quality = await qualityProbe(
          device,
          output,
          pixels,
          width,
          height,
          semantic === "scalar",
          srgb,
        );
        // Diagnostic-only extraction prepares the already-cooked comparator. Never a runtime producer route.
        const blocks = await readBlocks(device, output, levels);
        const directCpu = [],
          directWall = [];
        for (let sample = 0; sample < 23; sample++) {
          const start = performance.now();
          const target = device.createTexture({
            size: [storageWidth, storageHeight, layers],
            mipLevelCount: levels.length,
            format,
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          });
          for (let level = 0; level < levels.length; level++)
            device.queue.writeTexture(
              { texture: target, mipLevel: level },
              blocks[level],
              { bytesPerRow: levels[level].tightRow },
              { width: Math.ceil(levels[level].width / 4) * 4, height: levels[level].rows * 4 },
            );
          const cpuMs = performance.now() - start;
          await device.queue.onSubmittedWorkDone();
          if (sample >= 3) {
            directCpu.push(cpuMs);
            directWall.push(performance.now() - start);
          }
          target.destroy();
        }
        check(
          lastEvidence.submits === 1 &&
            lastEvidence.destinations.every((destination) => destination.origin[2] === 0),
          "Stock Spark command/output ownership changed",
        );
        cases.push({
          width,
          height,
          storageWidth,
          storageHeight,
          layers,
          semantic,
          format,
          mipCount: levels.length,
          sourceEncodedBytes: blob.size,
          decodeMs,
          initSharedMs: initMs,
          residentBytes,
          allocatedOutputBytes: residentBytes * layers,
          sourceDecodedRgbaBytes: pixels.byteLength,
          cpuMs: distribution(cpu),
          readyWallMs: distribution(wall),
          encodeGpuMs: distribution(encode),
          mipGpuMs: distribution(mip),
          firstReadyEqualsFullReady: true,
          evidence: lastEvidence,
          estimatedTempGpuPeakBytes: lastEvidence.rgbaAllocatedBytes + lastEvidence.bufferAllocatedBytes,
          direct: {
            cpuMs: distribution(directCpu),
            readyWallMs: distribution(directWall),
            uploadBytes: residentBytes,
            runtimeTranscode: 0,
            runtimeEncode: 0,
            packageParse: "excluded: preowned final blocks",
          },
          quality,
          batches: {
            sparkWall: [distribution(wall.slice(0, 10)), distribution(wall.slice(10))],
            directWall: [distribution(directWall.slice(0, 10)), distribution(directWall.slice(10))],
          },
        });
      } finally {
        output?.destroy();
        image.close();
      }
    }
    return {
      schemaVersion: 1,
      stage: "T4.0",
      sparkRevision,
      sparkSourceHash,
      initMs,
      enabledFeatures: [...device.features],
      cases,
      decision: "DEFER",
      reasons: [
        "Stock API submits privately and copies only to array layer zero; no caller encoder/encoded buffer API",
        "Canonical semantic full-mip equivalence and lifecycle adaptation not proven",
        "Matched raw direct-BC WASM encoder bridge is T4.1, currently unavailable",
      ],
      methodology: {
        warmup: 3,
        samples: 20,
        batches: [10, 10],
        GPUWaitExcludedFromCpu: true,
        GPUQueries: "per-pass instrumentation; one separate diagnostic resolve submit",
        temporaryBytes: "descriptor-derived upper bound, not driver VRAM",
        encodedReadback: "diagnostic comparator setup only; not production preparation",
        comparisonOrder: "sequential Spark then direct; exploratory, not paired adoption evidence",
        sRGB: "base-color uses hardware sRGB; diagnostic shader returns encoded bytes for source comparison",
        actualHostPeak: null,
        productionRendererCpuImpact: null,
        qualityThreshold: "not promoted to adoption from exploratory fixture",
      },
      ownership: {
        standaloneProductionOwner: "REJECT",
        strictOutputTextureWorks: true,
        arbitraryArrayLayer: false,
        publicBlockBuffer: false,
        callerCommandEncoder: false,
        requiredAdaptation: "S2 JS adaptation + request-owned resources + fence; no shader rewrite",
        additionalEncodedCopy: "internal block buffer -> target, already required; no extra S2 copy",
      },
    };
  } finally {
    spark.dispose();
    observation.destroy();
  }
}
