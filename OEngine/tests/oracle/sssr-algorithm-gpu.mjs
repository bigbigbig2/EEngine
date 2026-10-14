import { SssrRuntime } from "../../.test-dist/render/reflections/SssrRuntime.js";
import {
  SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS,
  resolveScreenSpaceReflectionsSettings
} from "../../.test-dist/render/reflections/ScreenSpaceReflectionsSettings.js";
import { packSssrReceiver, planSssrCapacity } from "../../.test-dist/render/reflections/SssrAbi.js";
import { encodeFloat16, decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { SSSR_INTERSECT_WGSL } from "../../.test-dist/shaders/sssr_intersect.js";
import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "../../.test-dist/shaders/fullscreen_triangle.js";
import { SSSR_DENOISER_COMMON_WGSL } from "../../.test-dist/shaders/sssr_denoiser_common.js";
import { SSSR_REPROJECT_WGSL } from "../../.test-dist/shaders/sssr_reproject.js";
import { compareSssrStage, referenceSssrResetStages } from "./sssr-reference.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const M = [0.627404, 0.069097, 0.0163916, 0.329282, 0.91954, 0.0880132, 0.0433136, 0.0113612, 0.895595];
const multiply = (rgb) => [0, 1, 2].map((r) => M[r] * rgb[0] + M[r + 3] * rgb[1] + M[r + 6] * rgb[2]);
const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const settings = resolveScreenSpaceReflectionsSettings(SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS, {
  enabled: true
});

export async function runSssrAlgorithmGpuOracle(device) {
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const runtime = await SssrRuntime.create(device);
  const results = [];
  const resources = [];
  const buffer = (name, size, usage, data) => {
    const value = device.createBuffer({ label: name, size, usage });
    resources.push(value);
    if (data) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const texture = (name, width, height, format, data, channels = 4) => {
    const value = device.createTexture({
      label: name,
      size: [width, height],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        (format === "depth32float" ? GPUTextureUsage.RENDER_ATTACHMENT : 0)
    });
    resources.push(value);
    if (data)
      device.queue.writeTexture(
        { texture: value },
        data,
        { bytesPerRow: width * channels * data.BYTES_PER_ELEMENT },
        [width, height]
      );
    return value;
  };
  const readbacks = [];
  const observeTexture = (encoder, tex, name, mip = 0) => {
    const width = Math.max(1, tex.width >> mip),
      height = Math.max(1, tex.height >> mip);
    const bpp = tex.format === "rgba16float" ? 8 : ["r16float", "rg8unorm"].includes(tex.format) ? 2 : 4;
    const pitch = Math.ceil((width * bpp) / 256) * 256;
    const read = buffer(name, pitch * height, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    encoder.copyTextureToBuffer({ texture: tex, mipLevel: mip }, { buffer: read, bytesPerRow: pitch }, [
      width,
      height
    ]);
    const item = { name, buffer: read, width, height, bpp, pitch, format: tex.format };
    readbacks.push(item);
    return item;
  };
  const observeBuffer = (encoder, source, size, name) => {
    const read = buffer(name, size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    encoder.copyBufferToBuffer(source, 0, read, 0, size);
    const item = { name, buffer: read, size };
    readbacks.push(item);
    return item;
  };
  const decode = async (item) => {
    await item.buffer.mapAsync(GPUMapMode.READ);
    const copy = item.buffer.getMappedRange().slice(0);
    item.buffer.unmap();
    if (item.size) return new Uint32Array(copy);
    const values = [];
    const view = new DataView(copy);
    const half = item.format.endsWith("16float");
    for (let y = 0; y < item.height; y++) {
      for (let x = 0; x < item.width * item.bpp; x += item.format === "rg8unorm" ? 1 : half ? 2 : 4) {
        values.push(
          item.format === "rg8unorm"
            ? view.getUint8(y * item.pitch + x) / 255
            : half
              ? decodeFloat16(view.getUint16(y * item.pitch + x, true))
              : view.getFloat32(y * item.pitch + x, true)
        );
      }
    }
    return values;
  };
  const depthPipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({ code: FULLSCREEN_TRIANGLE_VERTEX_WGSL }),
      entryPoint: "main"
    },
    fragment: {
      module: device.createShaderModule({
        code: `@group(0) @binding(0) var source: texture_2d<f32>;
      @fragment fn main(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 { return textureLoad(source, vec2i(position.xy), 0).x; }`
      }),
      entryPoint: "main",
      targets: []
    },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
  });
  // Observe the actual input statistics to temporal clipping, while separately
  // checking them against independent scalar moment/filter math below. This
  // avoids pretending a double-precision, cancellation-sensitive variance is
  // bit-equivalent to a source FP32 accumulation or a hardware filtered sample.
  const momentsLayout = device.createBindGroupLayout({
    entries: [
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 16, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 21, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const momentsPipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [runtime.commonLayout, momentsLayout] }),
    compute: {
      module: device.createShaderModule({
        code: `${SSSR_DENOISER_COMMON_WGSL}
@group(1) @binding(21) var<storage, read_write> moment_values: array<vec4f>;
@compute @workgroup_size(64) fn moment_main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let local = sssr_remap(lane); let tile = group.xy * 8u; let pixel = tile + local;
  sssr_load_halo(tile, local); workgroupBarrier();
  if (!sssr_valid_pixel(pixel)) { return; }
  let value = sssr_local_moments(vec2i(local) + vec2i(4)); let offset = sssr_index(pixel) * 3u;
  moment_values[offset] = vec4f(value.mean, 0.0);
  moment_values[offset + 1u] = vec4f(value.variance, 0.0);
  moment_values[offset + 2u] = vec4f(sssr_average(vec2i(pixel)), 0.0);
}`
      }),
      entryPoint: "moment_main"
    }
  });
  const probeLayout = device.createBindGroupLayout({
    entries: [
      ...[2, 4, 5, 11].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" }
      })),
      {
        binding: 6,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "2d-array" }
      },
      ...[7, 10].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float" }
      })),
      ...[12, 13].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "uint" }
      })),
      { binding: 21, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 22, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ]
  });
  const probePipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [runtime.commonLayout, probeLayout] }),
    compute: {
      module: device.createShaderModule({
        code: `${SSSR_REPROJECT_WGSL}
@group(1) @binding(21) var<storage, read_write> picks: array<vec4f>;
@group(1) @binding(22) var<uniform> pick_parameters: vec4f;
@compute @workgroup_size(64) fn pick_main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let local = sssr_remap(lane); let tile = group.xy * 8u; let pixel = tile + local;
  sssr_load_halo(tile, local); workgroupBarrier();
  if (!sssr_valid_pixel(pixel)) { return; }
  let receiver = sssr_receiver(sssr_index(pixel));
  let value = sssr_pick_reprojection(vec2i(pixel), vec2i(local) + vec2i(4), sssr_lobe(receiver).w, pick_parameters.x);
  picks[sssr_index(pixel) * 2u] = vec4f(value.uv, f32(value.surface), value.acceptance);
  picks[sssr_index(pixel) * 2u + 1u] = vec4f(value.radiance, 0.0);
}`
      }),
      entryPoint: "pick_main"
    }
  });
  const historyUploadLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { format: "r32float", access: "write-only" }
      }
    ]
  });
  const historyUploadPipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [historyUploadLayout] }),
    compute: {
      module: device.createShaderModule({
        code: `@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(destination))) { return; }
  textureStore(destination, vec2i(id.xy), vec4f(textureLoad(source, vec2i(id.xy), 0).x));
}`
      }),
      entryPoint: "main"
    }
  });
  const authorHistoryDepth = async (fixture, values) => {
    const input = fixture.input;
    const source = texture("oracle/authored prior depth", input.width, input.height, "r32float", values, 1);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(historyUploadPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: historyUploadLayout,
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: runtime.active.depthHistory.createView() }
        ]
      })
    );
    pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  };

  const makeFixture = (width, height, exposure = 1, bothLobes = true, variation = false) => {
    const pixels = width * height;
    const packet = new Uint32Array(pixels * 8);
    const env = [2, 1, 0.5];
    const response = [0.25, 0.2, 0.1, bothLobes ? 0.04 : 0];
    const baseline709 = env.map((v, c) => v * (response[c] + response[3]) * exposure);
    const baseline = multiply(baseline709);
    for (let i = 0; i < pixels; i++) {
      const x = i % width,
        y = Math.floor(i / width);
      const nx = variation ? Math.sin(x * 0.5) * 0.2 : 0;
      const ny = variation ? Math.cos(y * 0.4) * 0.1 : 0;
      const selected = !variation || (x < 12 && i % 11 !== 0);
      packSssrReceiver(
        [
          nx,
          ny,
          Math.sqrt(1 - nx * nx - ny * ny),
          selected ? 0.04 : 0.6,
          nx * 0.7,
          0.2,
          Math.sqrt(0.96 - nx * nx * 0.49),
          selected ? 0.09 : 0.6,
          ...(selected ? response : [0, 0, 0, 0]),
          ...(selected ? baseline : [0, 0, 0]),
          selected ? (bothLobes ? 7 : 3) : 1
        ],
        packet,
        i * 8
      );
    }
    const halfPixels = (rgb) => {
      const values = new Uint16Array(pixels * 4);
      for (let i = 0; i < pixels; i++) values.set([...rgb.map(encodeFloat16), encodeFloat16(1)], i * 4);
      return values;
    };
    const seedData = new Float32Array(pixels * 4);
    const responseData = new Uint8Array(pixels * 4);
    const identityData = new Uint32Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      seedData.set([0, 0, 2, 2], i * 4);
      responseData.set([0, 255, 0, 0], i * 4);
      identityData.set([1, 2, 3, 4], i * 4);
    }
    // RH orthographic reverse-Z: view z=-2 -> depth 0.5. The inverse and
    // projection are a true pair, including the source +Y-down UV mapping.
    const projection = I.slice();
    projection[10] = 0.25;
    projection[14] = 1;
    const inverseProjection = I.slice();
    inverseProjection[10] = 4;
    inverseProjection[14] = -4;
    const input = {
      width,
      height,
      receivers: buffer(
        "oracle/receiver",
        packet.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        packet
      ),
      depth: texture("oracle/final reverse depth", width, height, "depth32float"),
      opaqueRadiance: texture(
        "oracle/pre SSR opaque",
        width,
        height,
        "rgba16float",
        halfPixels(multiply([4 * exposure, 2 * exposure, exposure]))
      ),
      environment: texture(
        "oracle/native oct environment",
        variation ? 8 : 1,
        variation ? 8 : 1,
        "rgba16float",
        variation
          ? new Uint16Array(
              Array.from({ length: 64 }, (_, i) =>
                [
                  0.25 + (i % 8) * 0.3,
                  0.3 + Math.floor(i / 8) * 0.2,
                  0.2 + ((i % 8) ^ Math.floor(i / 8)) * 0.1,
                  1
                ].map(encodeFloat16)
              ).flat()
            )
          : new Uint16Array([...env.map(encodeFloat16), encodeFloat16(1)])
      ),
      seed: texture("oracle/current Seed", width, height, "rgba32float", seedData),
      response: texture("oracle/current response", width, height, "rgba8unorm", responseData),
      identity: texture("oracle/full current identity", width, height, "rgba32uint", identityData),
      previousIdentity: texture("oracle/full previous identity", width, height, "rgba32uint", identityData),
      currentExposure: buffer(
        "oracle/GPU P",
        32,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        new Float32Array([exposure])
      ),
      previousExposure: buffer(
        "oracle/GPU prior P",
        32,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        new Float32Array([exposure])
      ),
      camera: {
        projection,
        inverseProjection,
        view: I,
        inverseView: I,
        inverseViewProjection: inverseProjection,
        viewProjection: projection
      },
      settings,
      diagnostic: {
        mode: "hit-confidence",
        lobe: 0,
        buffer: buffer(
          "oracle/real diagnostic consumer",
          pixels * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        )
      }
    };
    const depthData = new Float32Array(pixels).fill(0.5);
    const uploadDepth = texture("oracle/independent depth plane", width, height, "r32float", depthData, 1);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: input.depth.createView(),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 0
      }
    });
    pass.setPipeline(depthPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: depthPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: uploadDepth.createView() }]
      })
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return { input, packet, baseline, response, env, exposure };
  };

  const runFrame = async (fixture, reset = false, probeDistance) => {
    const input = { ...fixture.input, reset };
    check(runtime.prepare(input), "small SSR fixture must be admitted");
    const products = runtime.frame;
    const preparedSet = runtime.pending.set;
    const formatBytes = { rgba16float: 8, rg16float: 4, r16float: 2, r32float: 4 };
    let descriptorBytes = preparedSet.buffers.reduce((sum, value) => sum + value.size, 0);
    for (const value of preparedSet.textures)
      for (let mip = 0; mip < value.mipLevelCount; mip++) {
        descriptorBytes +=
          Math.max(1, value.width >> mip) *
          Math.max(1, value.height >> mip) *
          value.depthOrArrayLayers *
          formatBytes[value.format];
      }
    check(
      descriptorBytes === preparedSet.gpuBytes,
      "owner bytes match actual complete texture/buffer descriptors"
    );
    const encoder = device.createCommandEncoder();
    const stages = [];
    const original = runtime.dispatchCommon;
    runtime.dispatchCommon = function (...args) {
      original.apply(runtime, args);
      const stage = args[1];
      const lobe = stages.filter((s) => s.stage === stage).length;
      if (stage === "classify") {
        stages.push({
          stage,
          lobe,
          counts: observeBuffer(encoder, products.counts, 8, `classify${lobe}`),
          rays: observeBuffer(encoder, runtime.pending.set.rays, runtime.pending.set.rays.size, `rays${lobe}`)
        });
      } else if (stage === "intersect") {
        stages.push({
          stage,
          lobe,
          raw: observeTexture(
            encoder,
            runtime.pending.set.lobes[lobe].radiance[runtime.pending.write],
            `raw${lobe}`
          )
        });
        if (lobe === 0 && probeDistance !== undefined) {
          const set = runtime.pending.set;
          const probeOutput = buffer(
            "oracle/reprojection branch probe",
            input.width * input.height * 32,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
          );
          const probeParameters = buffer(
            "oracle/source ray-length input",
            16,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            new Float32Array([probeDistance, 0, 0, 0])
          );
          const pass = encoder.beginComputePass({ label: "SSSR oracle/reprojection branches" });
          pass.setPipeline(probePipeline);
          pass.setBindGroup(0, args[2]);
          pass.setBindGroup(
            1,
            device.createBindGroup({
              layout: probeLayout,
              entries: [
                { binding: 2, resource: set.lobes[0].radiance[runtime.pending.write].createView() },
                { binding: 4, resource: set.lobes[0].radiance[runtime.readIndex].createView() },
                { binding: 5, resource: set.lobes[0].statistics[runtime.readIndex].createView() },
                { binding: 6, resource: set.normalHistory.createView({ dimension: "2d-array" }) },
                { binding: 7, resource: set.depthHistory.createView() },
                { binding: 10, resource: input.seed.createView() },
                { binding: 11, resource: input.response.createView() },
                { binding: 12, resource: input.identity.createView() },
                { binding: 13, resource: input.previousIdentity.createView() },
                { binding: 21, resource: { buffer: probeOutput } },
                { binding: 22, resource: { buffer: probeParameters } }
              ]
            })
          );
          pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
          pass.end();
          stages.push({
            stage: "probe",
            lobe: 0,
            probe: observeBuffer(encoder, probeOutput, probeOutput.size, "reprojection probe")
          });
        }
      } else if (stage === "reproject") {
        stages.push({
          stage,
          lobe,
          average: observeTexture(
            encoder,
            runtime.pending.set.lobes[lobe].average[runtime.pending.write],
            `average${lobe}`
          ),
          statistics: observeTexture(
            encoder,
            runtime.pending.set.reprojectionStatistics,
            `reprojectStats${lobe}`
          ),
          reprojected: observeTexture(encoder, runtime.pending.set.reprojected, `reprojected${lobe}`)
        });
      } else if (stage === "prefilter") {
        const set = runtime.pending.set;
        const moments = buffer(
          `oracle/lobe${lobe} clipping inputs`,
          input.width * input.height * 48,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        );
        const observer = encoder.beginComputePass({ label: "SSSR oracle/statistics seam" });
        observer.setPipeline(momentsPipeline);
        observer.setBindGroup(0, args[2]);
        observer.setBindGroup(
          1,
          device.createBindGroup({
            layout: momentsLayout,
            entries: [
              { binding: 2, resource: set.lobes[lobe].radiance[runtime.readIndex].createView() },
              { binding: 8, resource: set.lobes[lobe].average[runtime.pending.write].createView() },
              { binding: 16, resource: runtime.sampler },
              { binding: 21, resource: { buffer: moments } }
            ]
          })
        );
        observer.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
        observer.end();
        stages.push({
          stage,
          lobe,
          filtered: observeTexture(encoder, set.lobes[lobe].radiance[runtime.readIndex], `prefilter${lobe}`),
          variance: observeTexture(encoder, set.prefilterVariance, `prefilterVariance${lobe}`),
          moments: observeBuffer(encoder, moments, moments.size, `moments${lobe}`)
        });
      }
    };
    try {
      runtime.encode(encoder);
    } finally {
      runtime.dispatchCommon = original;
    }
    const output = observeTexture(encoder, products.output, "final");
    const base = observeTexture(encoder, products.base, "base");
    const coat = observeTexture(encoder, products.coat, "coat");
    const stats = observeTexture(encoder, products.baseStatistics, "statistics");
    const coatStats = observeTexture(encoder, products.coatStatistics, "coatStatistics");
    const noise = observeTexture(encoder, runtime.noise, "blue noise");
    const phase = runtime.phase;
    const depth = [];
    for (let mip = 0; mip < products.capacity.mipCount; mip++)
      depth.push(observeTexture(encoder, products.depth, `depth${mip}`, mip));
    const diagnostic = observeBuffer(
      encoder,
      input.diagnostic.buffer,
      input.width * input.height * 4,
      "confidence"
    );
    device.queue.submit([encoder.finish()]);
    const done = device.queue.onSubmittedWorkDone();
    runtime.commit(done);
    await done;
    const decoded = {
      output: await decode(output),
      base: await decode(base),
      coat: await decode(coat),
      statistics: await decode(stats),
      coatStatistics: await decode(coatStats),
      noise: await decode(noise),
      phase,
      historyValid: products.historyValid,
      depth: [],
      stages: [],
      confidence: new Float32Array((await decode(diagnostic)).buffer)
    };
    for (const item of depth) decoded.depth.push(await decode(item));
    for (const item of stages) {
      const value = { stage: item.stage, lobe: item.lobe };
      for (const name of [
        "counts",
        "rays",
        "raw",
        "average",
        "statistics",
        "filtered",
        "variance",
        "moments",
        "probe",
        "reprojected"
      ])
        if (item[name])
          value[name] = ["moments", "probe"].includes(name)
            ? new Float32Array((await decode(item[name])).buffer)
            : await decode(item[name]);
      decoded.stages.push(value);
    }
    return decoded;
  };

  const verifyQueueAndComposite = (fixture, image) => {
    const width = fixture.input.width,
      height = fixture.input.height;
    const unpack = (p) => {
      const record = [];
      for (const word of fixture.packet.subarray(p * 8, p * 8 + 8))
        record.push(decodeFloat16(word & 65535), decodeFloat16(word >>> 16));
      return record;
    };
    for (let lobe = 0; lobe < 2; lobe++) {
      const classification = image.stages.find((s) => s.stage === "classify" && s.lobe === lobe);
      const coverage = new Uint8Array(width * height);
      const seen = new Set();
      for (let r = 0; r < classification.counts[0]; r++) {
        const pixel = classification.rays[r * 2],
          flags = classification.rays[r * 2 + 1];
        check(
          pixel < width * height && !seen.has(pixel),
          "ray list contains complete, unique linear identities"
        );
        seen.add(pixel);
        const x = pixel % width,
          y = Math.floor(pixel / width);
        coverage[pixel]++;
        for (const [bit, px, py] of [
          [1, x ^ 1, y],
          [2, x, y ^ 1],
          [4, x ^ 1, y ^ 1]
        ])
          if (flags & bit) {
            check(px < width && py < height, "copy flag cannot address an OOB tail");
            coverage[py * width + px]++;
          }
      }
      for (let p = 0; p < width * height; p++) {
        const values = unpack(p);
        const eligible = ((values[15] | 0) & (2 << lobe)) !== 0;
        check(
          coverage[p] === Number(eligible),
          `lobe${lobe} complete single-writer ray/copy coverage pixel${p}`
        );
      }
    }
    const inverse = (c) => [
      1.660490394 * c[0] - 0.587639093 * c[1] - 0.072851598 * c[2],
      -0.12454997 * c[0] + 1.13289988 * c[1] - 0.008347965 * c[2],
      -0.018151119 * c[0] - 0.100578725 * c[1] + 1.11872983 * c[2]
    ];
    const expected = [];
    for (let p = 0; p < width * height; p++) {
      const record = unpack(p);
      const base = inverse(image.base.slice(p * 4, p * 4 + 3)),
        coat = inverse(image.coat.slice(p * 4, p * 4 + 3));
      const specular = multiply(base.map((v, c) => record[8 + c] * v + record[11] * coat[c]));
      const hdr = fixture.hdr
        ? Array.from(fixture.hdr.subarray(p * 4, p * 4 + 4), decodeFloat16)
        : [
            ...multiply([4 * fixture.exposure, 2 * fixture.exposure, fixture.exposure]).map((v) =>
              decodeFloat16(encodeFloat16(v))
            ),
            1
          ];
      expected.push(
        ...specular.map((v, c) => hdr[c] + fixture.input.settings.strength * (v - record[12 + c])),
        hdr[3]
      );
    }
    results.push(compareSssrStage(image.output, expected, "independent-two-lobe-energy-replacement"));
  };

  const runHistoryOracles = async () => {
    const fixture = makeFixture(17, 19);
    const warm = await runFrame(fixture, true);
    const center = 9 * 17 + 8;
    const hole = new Float32Array(17 * 19).fill(0.5);
    hole[center] = 0;
    await authorHistoryDepth(fixture, hole);
    const searched = await runFrame(fixture, false, 0);
    const pick = searched.stages.find((s) => s.stage === "probe").probe;
    const offset = center * 8;
    check(
      pick[offset + 3] > 0.99 && pick[offset + 2] === 1,
      "3x3 search recovers a qualified surface candidate"
    );
    check(
      Math.abs(pick[offset] - 8.5 / 17) > 0.5 / 17 || Math.abs(pick[offset + 1] - 9.5 / 19) > 0.5 / 19,
      "search selected a real neighboring UV"
    );
    const checker = new Float32Array(17 * 19);
    for (let p = 0; p < checker.length; p++) checker[p] = ((p % 17) + Math.floor(p / 17)) & 1 ? 0.5 : 0;
    await authorHistoryDepth(fixture, checker);
    const seed = new Float32Array(17 * 19 * 4);
    for (let p = 0; p < 17 * 19; p++) seed.set([0.5 / 17, 0.5 / 19, 2, 2], p * 4);
    device.queue.writeTexture({ texture: fixture.input.seed }, seed, { bytesPerRow: 17 * 16 }, [17, 19]);
    const repaired = await runFrame(fixture, false, 0);
    const repair = repaired.stages.find((s) => s.stage === "probe").probe;
    check(
      repair[offset + 3] > 0.99 && repair[offset + 2] === 1,
      "qualified 2x2 bilinear repair recovers history when no complete 3x3 candidate exists"
    );
    check(
      Math.abs(repair[offset] - 8 / 17) < 16 * 2 ** -23 &&
        Math.abs(repair[offset + 1] - 9 / 19) < 16 * 2 ** -23,
      "Seed motion sign is current minus previous"
    );
    check(repaired.statistics[center * 2 + 1] > 1, "repaired history contributes real samples");
    const mismatch = new Uint32Array(17 * 19 * 4);
    for (let p = 0; p < 17 * 19; p++) mismatch.set([1, 2, 3, 5], p * 4);
    device.queue.writeTexture(
      { texture: fixture.input.previousIdentity },
      mismatch,
      { bytesPerRow: 17 * 16 },
      [17, 19]
    );
    const rejected = await runFrame(fixture, false, 0);
    check(
      rejected.stages.find((s) => s.stage === "probe").probe[offset + 3] === 0,
      "full identity fourth word rejects surface history"
    );
    check(rejected.statistics[center * 2 + 1] === 1, "identity rejection restarts sample count");
    const quarter = makeFixture(17, 19, 0.25);
    device.queue.writeTexture(
      { texture: quarter.input.previousIdentity },
      mismatch,
      { bytesPerRow: 17 * 16 },
      [17, 19]
    );
    device.queue.writeBuffer(quarter.input.previousExposure, 0, new Float32Array([1]));
    const virtual = await runFrame(quarter, false, 1);
    const virtualPick = virtual.stages.find((s) => s.stage === "probe").probe;
    let candidates = 0,
      exposureHistoryError = 0;
    const inverse = (c) => [
      1.660490394 * c[0] - 0.587639093 * c[1] - 0.072851598 * c[2],
      -0.12454997 * c[0] + 1.13289988 * c[1] - 0.008347965 * c[2],
      -0.018151119 * c[0] - 0.100578725 * c[1] + 1.11872983 * c[2]
    ];
    for (const [x, y] of [
      [4, 5],
      [8, 9],
      [11, 12]
    ]) {
      const p = y * 17 + x,
        v = virtualPick.subarray(p * 8, p * 8 + 8);
      const vx = ((x + 0.5) / 17) * 2 - 1,
        vy = 1 - ((y + 0.5) / 19) * 2;
      const factor = 1 + 1 / Math.hypot(vx, vy, 2);
      const expectedUV = [vx * factor * 0.5 + 0.5, -vy * factor * 0.5 + 0.5];
      check(
        v[2] === 0 && v[3] > 0.99,
        "virtual-hit candidate remains independent of receiver identity at the virtual UV"
      );
      check(
        Math.abs(v[0] - expectedUV[0]) < 16 * 2 ** -23 && Math.abs(v[1] - expectedUV[1]) < 16 * 2 ** -23,
        "full source virtual-hit parallax projection"
      );
      const tx = v[0] * 17 - 0.5,
        ty = v[1] * 19 - 0.5,
        lx = Math.floor(tx),
        ly = Math.floor(ty),
        fx = tx - lx,
        fy = ty - ly;
      const oldRGB = [0, 0, 0];
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const q = (Math.min(18, Math.max(0, ly + j)) * 17 + Math.min(16, Math.max(0, lx + i))) * 4;
          const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
          for (let c = 0; c < 3; c++) oldRGB[c] += rejected.base[q + c] * weight;
        }
      const expectedRGB = inverse(oldRGB).map((v) => v * 0.25);
      for (let c = 0; c < 3; c++)
        exposureHistoryError = Math.max(exposureHistoryError, Math.abs(v[c + 4] - expectedRGB[c]));
      candidates++;
    }
    check(
      exposureHistoryError < 32 * 2 ** -23,
      `GPU current/prior P history transport ${exposureHistoryError}`
    );
    results.push({
      name: "surface-search-repair-identity-virtual-history",
      candidates,
      exposureHistoryError,
      repairedSamples: repaired.statistics[center * 2 + 1]
    });
  };

  const runHdrAndDarkOracles = async () => {
    const fixture = makeFixture(25, 19);
    const depths = new Float32Array(25 * 19),
      hdr = new Uint16Array(25 * 19 * 4);
    const projection = I.slice();
    projection[10] = 0.1;
    projection[14] = 1;
    const inverseProjection = I.slice();
    inverseProjection[10] = 10;
    inverseProjection[14] = -10;
    fixture.input.camera = {
      projection,
      inverseProjection,
      view: I,
      inverseView: I,
      inverseViewProjection: inverseProjection,
      viewProjection: projection
    };
    const seed = new Float32Array(25 * 19 * 4);
    for (let p = 0; p < 25 * 19; p++) {
      const selected = p % 25 < 12;
      const nx = selected ? 0.9 : -0.9,
        nz = Math.sqrt(1 - nx * nx);
      packSssrReceiver(
        [
          nx,
          0,
          nz,
          0.0016,
          nx,
          0,
          nz,
          0.0016,
          ...(selected ? [0.25, 0.2, 0.1, 0.04] : [0, 0, 0, 0]),
          ...(selected ? fixture.baseline : [0, 0, 0]),
          selected ? 7 : 1
        ],
        fixture.packet,
        p * 8
      );
      const worldX = (((p % 25) + 0.5) / 25) * 2 - 1;
      const viewDepth = selected ? 3 + (0.9 / Math.sqrt(0.19)) * worldX : 3.4;
      depths[p] = 1 - viewDepth * 0.1;
      seed.set([0, 0, viewDepth, viewDepth], p * 4);
      hdr.set(
        [...multiply(selected ? [10, 2, 1] : [104000, 0, 0]).map(encodeFloat16), encodeFloat16(1)],
        p * 4
      );
    }
    fixture.hdr = hdr;
    fixture.input.settings = resolveScreenSpaceReflectionsSettings(settings, { quality: "high" });
    device.queue.writeBuffer(fixture.input.receivers, 0, fixture.packet);
    device.queue.writeTexture(
      { texture: fixture.input.opaqueRadiance },
      hdr,
      { bytesPerRow: 25 * 8 },
      [25, 19]
    );
    device.queue.writeTexture({ texture: fixture.input.seed }, seed, { bytesPerRow: 25 * 16 }, [25, 19]);
    const source = texture("oracle/HDR receiver-target depth", 25, 19, "r32float", depths, 1);
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: fixture.input.depth.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 0
        }
      });
    pass.setPipeline(depthPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: depthPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source.createView() }]
      })
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const image = await runFrame(fixture, true);
    let maximum709 = 0,
      hits = 0;
    for (const stage of image.stages.filter((s) => s.stage === "intersect")) {
      check(stage.raw.every(Number.isFinite), "working-domain HDR raw radiance remains finite");
      for (let p = 0; p < 25 * 19; p++) {
        const c = stage.raw.slice(p * 4, p * 4 + 3);
        const red = 1.660490394 * c[0] - 0.587639093 * c[1] - 0.072851598 * c[2];
        maximum709 = Math.max(maximum709, red);
      }
    }
    for (const value of image.confidence) if (value > 0) hits++;
    check(
      hits > 0 && maximum709 > 90000,
      "actual hierarchical hits transport saturated HDR outside Rec709 half range"
    );
    check(
      image.base.every(Number.isFinite) &&
        image.coat.every(Number.isFinite) &&
        image.output.every(Number.isFinite),
      "complete high-HDR denoising/composition, no half shared overflow"
    );
    verifyQueueAndComposite(fixture, image);
    const mid = {
      ...fixture,
      input: {
        ...fixture.input,
        settings: resolveScreenSpaceReflectionsSettings(fixture.input.settings, { strength: 0.5 })
      }
    };
    const halfStrength = await runFrame(mid);
    check(halfStrength.historyValid, "positive strength edits retain reflection history");
    verifyQueueAndComposite(mid, halfStrength);
    const dark = makeFixture(17, 19);
    for (let p = 0; p < 17 * 19; p++)
      packSssrReceiver(
        [0, 0, 1, 0.00005, 0, 0, 1, 0.00005, 0.25, 0.2, 0.1, 0.04, 0, 0, 0, 7],
        dark.packet,
        p * 8
      );
    device.queue.writeBuffer(dark.input.receivers, 0, dark.packet);
    device.queue.writeTexture(
      { texture: dark.input.environment },
      new Uint16Array([0, 0, 0, encodeFloat16(1)]),
      {},
      [1, 1]
    );
    const black = await runFrame(dark, true);
    for (const stage of black.stages.filter((s) => s.stage === "classify"))
      check(
        stage.counts[0] === 17 * 19 && stage.counts[1] === 9,
        "source mirror profile remains full rate and retains denoiser tiles"
      );
    check(
      black.base.every((v) => v === 0) && black.coat.every((v) => v === 0),
      "source dark branch has zero radiance"
    );
    check(
      black.statistics.every((v, i) => v === (i & 1)),
      "dark branch preserves separate source sample count in combined statistics"
    );
    verifyQueueAndComposite(dark, black);
    results.push({ name: "HDR-complete-chain-strength-and-mirror-dark", maximum709, hits });
  };

  const runPerspectiveHistoryOracle = async () => {
    const makeCamera = (near, sx, sy, cameraX) => {
      const far = 100,
        a = near / (far - near),
        b = (far * near) / (far - near);
      const projection = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, a, -1, 0, 0, b, 0]);
      const inverseProjection = new Float32Array([
        1 / sx,
        0,
        0,
        0,
        0,
        1 / sy,
        0,
        0,
        0,
        0,
        0,
        1 / b,
        0,
        0,
        -1,
        a / b
      ]);
      const view = I.slice(),
        inverseView = I.slice();
      view[12] = -cameraX;
      inverseView[12] = cameraX;
      const matrixProduct = (left, right) => {
        const result = new Float32Array(16);
        for (let column = 0; column < 4; column++)
          for (let row = 0; row < 4; row++) {
            for (let k = 0; k < 4; k++) result[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
          }
        return result;
      };
      return {
        camera: {
          projection,
          inverseProjection,
          view,
          inverseView,
          viewProjection: matrixProduct(projection, view),
          inverseViewProjection: matrixProduct(inverseView, inverseProjection)
        },
        depth: b / 2 - a
      };
    };
    const authorPlane = (fixture, depth) => {
      const source = texture(
        "oracle/perspective final depth",
        17,
        19,
        "r32float",
        new Float32Array(17 * 19).fill(depth),
        1
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: fixture.input.depth.createView(),
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: 0
          }
        });
      pass.setPipeline(depthPipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: depthPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: source.createView() }]
        })
      );
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    const old = makeFixture(17, 19),
      past = makeCamera(0.1, 19 / 17, 1, 0.2);
    old.input.camera = past.camera;
    authorPlane(old, past.depth);
    await runFrame(old, true);
    const current = makeFixture(17, 19),
      present = makeCamera(0.2, (19 / 17) * 1.1, 1.05, 0);
    current.input.camera = present.camera;
    authorPlane(current, present.depth);
    const seed = new Float32Array(17 * 19 * 4),
      ids = new Uint32Array(17 * 19 * 4);
    for (let p = 0; p < 17 * 19; p++) {
      const u = ((p % 17) + 0.5) / 17,
        v = (Math.floor(p / 17) + 0.5) / 19;
      const x = ((2 * u - 1) * 2) / present.camera.projection[0],
        y = ((1 - 2 * v) * 2) / present.camera.projection[5];
      const previousU = 0.5 + (past.camera.projection[0] * (x - 0.2)) / 4,
        previousV = 0.5 - (past.camera.projection[5] * y) / 4;
      seed.set([u - previousU, v - previousV, 2, 2], p * 4);
      ids.set([1, 2, 3, 5], p * 4);
    }
    device.queue.writeTexture({ texture: current.input.seed }, seed, { bytesPerRow: 17 * 16 }, [17, 19]);
    device.queue.writeTexture(
      { texture: current.input.previousIdentity },
      ids,
      { bytesPerRow: 17 * 16 },
      [17, 19]
    );
    const image = await runFrame(current, false, 1);
    const probes = image.stages.find((s) => s.stage === "probe").probe;
    let maxError = 0,
      parallax = 0;
    for (const [px, py] of [
      [4, 5],
      [8, 9],
      [11, 12]
    ]) {
      const p = py * 17 + px,
        u = (px + 0.5) / 17,
        v = (py + 0.5) / 19;
      const x = ((2 * u - 1) * 2) / present.camera.projection[0],
        y = ((1 - 2 * v) * 2) / present.camera.projection[5];
      const factor = 1 + 1 / Math.hypot(x, y, 2);
      const expected = [
        0.5 + (past.camera.projection[0] * (x - 0.2 / factor)) / 4,
        0.5 - (past.camera.projection[5] * y) / 4
      ];
      check(
        probes[p * 8 + 2] === 0 && probes[p * 8 + 3] > 0.99,
        "perspective virtual reprojection uses previous inverse projection for history depth"
      );
      maxError = Math.max(
        maxError,
        Math.abs(probes[p * 8] - expected[0]),
        Math.abs(probes[p * 8 + 1] - expected[1])
      );
      parallax = Math.max(parallax, Math.abs(probes[p * 8] - (u - seed[p * 4])));
    }
    check(
      maxError < 32 * 2 ** -23 && parallax > 0.01,
      "translated pinhole virtual-hit parallax differs from ordinary surface motion"
    );
    results.push({ name: "perspective-translation-distinct-projection-history", maxError, parallax });
  };

  const runCapacityAndLifecycleOracles = async () => {
    const uniformData = runtime.scratch[0].slice(0);
    new Uint32Array(uniformData)[13] = 4;
    const uniform = buffer(
      "oracle/2D dispatch ceiling",
      uniformData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      uniformData
    );
    const cases = [
      [0, 0],
      [1, 1],
      [64, 4],
      [65, 5],
      [513, 12],
      [561, 15]
    ];
    const reads = [],
      encoder = device.createCommandEncoder();
    for (const values of cases) {
      const counts = buffer(
        "oracle/independent bounded work",
        8,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        new Uint32Array(values)
      );
      const args = buffer("oracle/2D args", 24, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      runtime.dispatch(encoder, "args", [{ buffer: uniform }, { buffer: counts }, { buffer: args }], 1, 1, 1);
      reads.push(observeBuffer(encoder, args, 24, "indirect args"));
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    for (let i = 0; i < cases.length; i++) {
      const args = await decode(reads[i]);
      for (const [offset, count] of [
        [0, Math.ceil(cases[i][0] / 64)],
        [3, cases[i][1]]
      ]) {
        const x = args[offset],
          y = args[offset + 1];
        check(
          x <= 4 && y <= 4 && x * y >= count && args[offset + 2] === 1,
          "GPU 2D args preserve every ray/tile within axis limits"
        );
        if (!count) check(x === 0 && y === 0, "empty list emits zero work");
      }
    }
    const capacity = (w, h) => planSssrCapacity(w, h, device.limits);
    const a = capacity(9, 9),
      b = capacity(17, 19),
      c = capacity(25, 19);
    const charge = (plan) => plan.activeBytes - 819200;
    const ownerMaxBytes = 819200 + charge(b) + charge(c) + Math.floor(charge(a) / 2);
    const bounded = await SssrRuntime.create(device, { maxBytes: c.activeBytes, ownerMaxBytes });
    let releaseFence;
    const gate = new Promise((resolve) => {
      releaseFence = resolve;
    });
    const fixtureA = makeFixture(9, 9),
      fixtureB = makeFixture(17, 19),
      fixtureC = makeFixture(25, 19);
    const inputWithoutDiagnostic = (fixture) => ({ ...fixture.input, diagnostic: undefined });
    let heldFence;
    try {
      check(bounded.prepare(inputWithoutDiagnostic(fixtureA)), "initial bounded workset admitted");
      const first = device.createCommandEncoder();
      bounded.encode(first);
      device.queue.submit([first.finish()]);
      heldFence = device.queue.onSubmittedWorkDone().then(() => gate);
      bounded.commit(heldFence);
      check(
        bounded.prepare(inputWithoutDiagnostic(fixtureB)),
        "complete candidate admitted before retirement"
      );
      const second = device.createCommandEncoder();
      bounded.encode(second);
      device.queue.submit([second.finish()]);
      const done = device.queue.onSubmittedWorkDone();
      bounded.commit(done);
      await done;
      const bytes = bounded.allocatedBytes,
        phase = bounded.phase;
      check(
        bounded.prepare(inputWithoutDiagnostic(fixtureC)) === false &&
          bounded.allocatedBytes === bytes &&
          bounded.phase === phase,
        "retired budget deferral changes neither allocations nor publication"
      );
      releaseFence();
      await heldFence;
      await Promise.resolve();
      check(bounded.prepare(inputWithoutDiagnostic(fixtureC)), "fence completion permits exact retry");
      const withCandidateUploads = bounded.allocatedBytes;
      bounded.abort();
      check(
        bounded.phase === phase && bounded.allocatedBytes === withCandidateUploads,
        "aborted resize candidate does not publish or retire queued uniform uploads early"
      );
      await device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      check(
        bounded.allocatedBytes < withCandidateUploads,
        "aborted candidate retires after its queued uniform uploads"
      );
      check(
        bounded.prepare(inputWithoutDiagnostic(fixtureB)) && bounded.frame.historyValid,
        "aborted resize preserves the old complete history"
      );
      const callbacks = [];
      const command = {
        closed: false,
        onFinished: { addOne: (f) => callbacks.push(f) },
        onAborted: {
          addOne: (f) => {
            command.abortCallback = f;
          }
        },
        abort() {
          this.closed = true;
          this.abortCallback();
        }
      };
      bounded.attach(command);
      bounded.abort();
      check(
        command.closed && bounded.phase === phase,
        "attached abort propagates to the ordinary command owner"
      );
      results.push({
        name: "2D-indirect-budget-retirement-candidate-abort",
        cases: cases.length,
        ownerMaxBytes
      });
    } finally {
      releaseFence();
      bounded.destroy();
      await device.queue.onSubmittedWorkDone();
    }
    const plan1080 = planSssrCapacity(1920, 1080, device.limits);
    results.push({
      name: "real-device-capacity",
      storageTextures: device.limits.maxStorageTexturesPerShaderStage,
      storageBuffers: device.limits.maxStorageBuffersPerShaderStage,
      workgroupStorage: device.limits.maxComputeWorkgroupStorageSize,
      plan1080Bytes: plan1080.activeBytes,
      upper1080Bytes: 143 * 1920 * 1080 + 40 * 32400 + 1048576
    });
  };

  const runFunctionOracles = async () => {
    const fixture = makeFixture(33, 17);
    const depths = new Float32Array(33 * 17);
    for (let y = 0; y < 17; y++)
      for (let x = 0; x < 33; x++) {
        depths[y * 33 + x] = y === 16 ? 0.6 : x === 32 ? 0.7 : x === 16 ? 0.8 : x < 24 ? 0.5 : 0;
      }
    const depthUpload = texture("oracle/thin NPOT volumes", 33, 17, "r32float", depths, 1);
    const init = device.createCommandEncoder();
    const raster = init.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: fixture.input.depth.createView(),
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 0
      }
    });
    raster.setPipeline(depthPipeline);
    raster.setBindGroup(
      0,
      device.createBindGroup({
        layout: depthPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: depthUpload.createView() }]
      })
    );
    raster.draw(3);
    raster.end();
    device.queue.submit([init.finish()]);
    check(runtime.prepare({ ...fixture.input, reset: true }), "function fixture admitted");
    const encoder = device.createCommandEncoder();
    runtime.encode(encoder);
    const products = runtime.frame;
    const queries = [];
    const views = [
      [0, 0, 1],
      [0.3, 0.2, Math.sqrt(0.87)],
      [0.999, 0, Math.sqrt(1 - 0.999 ** 2)]
    ];
    for (const view of views)
      for (const alpha of [0, 0.0016, 0.25, 1]) {
        queries.push([...view, alpha, 0.17, 0.73, 0, 0]);
        queries.push([...view, alpha, 0.81, 0.13, 0, 0]);
      }
    const marchCases = [
      [0.1, 0.3, 0.9, 1, 0.5, 0, -1, 1],
      [0.9, 0.5, 0.95, 1, 0.099, 0, -0.25, 1],
      [0.1, 0.91, 0.9, 1, 0.5, 0.07, -0.6, 1],
      [0.1, 0.5, 0.9, 1, 0.9, 0, -0.01, 1],
      [0.1, 0.5, 0.9, 1, 0.7, 0, 0.5, 1],
      [0.1, 0.3, 0.9, -1, 0.5, 0, -1, 1],
      [0.1, 0.5, 0.5001, 1, 0.9, 0, -0.8, 1],
      [0.05, 0.5, 0.95, 1, 0.9, 0, -0.5, 1]
    ].map((v) => [...new Float32Array(v)]);
    const marchStart = queries.length;
    queries.push(...marchCases);
    queries.push([70000, 0, 0, 0, 0, 0, 0, 2]);
    const queryData = new Float32Array(queries.flat());
    const queryBuffer = buffer(
      "oracle/independent queries",
      queryData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      queryData
    );
    const resultBuffer = buffer(
      "oracle/function results",
      queries.length * 32,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    );
    const limitedResult = buffer(
      "oracle/budget results",
      queries.length * 32,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    );
    const hitPacket = fixture.packet.slice();
    for (let p = 0; p < 33 * 17; p++)
      packSssrReceiver([-1, 0, 0, 0.04, -1, 0, 0, 0.09, 0.25, 0.2, 0.1, 0.04, 0, 0, 0, 7], hitPacket, p * 8);
    const hitReceivers = buffer(
      "oracle/front-facing hit normals",
      hitPacket.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      hitPacket
    );
    const shader = device.createShaderModule({
      code: `${SSSR_INTERSECT_WGSL}
struct FunctionQuery { a: vec4f, b: vec4f, }
@group(1) @binding(8) var<storage, read> queries: array<FunctionQuery>;
@group(1) @binding(9) var<storage, read_write> function_results: array<vec4f>;
@compute @workgroup_size(64)
fn function_main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queries)) { return; }
  let query = queries[id.x];
  if (query.b.w == 0.0) {
    function_results[id.x * 2u] = vec4f(sssr_sample_ggx_vndf(query.a.xyz, query.a.w, query.b.xy), 0.0);
  } else if (query.b.w == 1.0) {
    let hit = sssr_march(query.a.xyz, query.b.xyz);
    function_results[id.x * 2u] = vec4f(hit.position, f32(hit.valid));
    function_results[id.x * 2u + 1u] = vec4f(sssr_validate(hit, query.a.xy, vec3f(query.a.w, 0.0, 0.0)), 0.0, 0.0, 0.0);
  } else {
    sssr_store_ray(vec2u(0u), vec3f(1.0, 2.0, 3.0), query.a.x, 0.25);
  }
}`
    });
    const B = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 5, visibility: B, storageTexture: { format: "rgba16float", access: "write-only" } },
        { binding: 6, visibility: B, storageTexture: { format: "r32float", access: "write-only" } },
        { binding: 7, visibility: B, buffer: { type: "storage" } },
        { binding: 8, visibility: B, buffer: { type: "read-only-storage" } },
        { binding: 9, visibility: B, buffer: { type: "storage" } }
      ]
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [runtime.commonLayout, layout] }),
      compute: { module: shader, entryPoint: "function_main" }
    });
    const set = runtime.pending.set;
    const diagnostic = fixture.input.diagnostic.buffer;
    const limitedData = runtime.scratch[0].slice(0);
    new Uint32Array(limitedData)[14] = 1;
    const limitedUniform = buffer(
      "oracle/one-step source option",
      limitedData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      limitedData
    );
    const dispatch = (uniformBuffer, outputBuffer) => {
      const pass = encoder.beginComputePass({ label: "SSSR independent function oracle" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: runtime.commonLayout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: hitReceivers } },
            { binding: 2, resource: set.depth.createView() },
            { binding: 3, resource: { buffer: fixture.input.currentExposure, size: 4 } },
            { binding: 4, resource: { buffer: fixture.input.previousExposure, size: 4 } }
          ]
        })
      );
      pass.setBindGroup(
        1,
        device.createBindGroup({
          layout,
          entries: [
            { binding: 5, resource: set.lobes[0].radiance[runtime.pending.write].createView() },
            { binding: 6, resource: set.rayLength.createView() },
            { binding: 7, resource: { buffer: diagnostic } },
            { binding: 8, resource: { buffer: queryBuffer } },
            { binding: 9, resource: { buffer: outputBuffer } }
          ]
        })
      );
      pass.dispatchWorkgroups(Math.ceil(queries.length / 64));
      pass.end();
    };
    dispatch(set.uniforms[0], resultBuffer);
    dispatch(limitedUniform, limitedResult);
    const resultRead = observeBuffer(encoder, resultBuffer, resultBuffer.size, "function results");
    const limitedRead = observeBuffer(encoder, limitedResult, limitedResult.size, "bounded results");
    const lengthRead = observeTexture(encoder, set.rayLength, "large world distance");
    const pyramidRead = Array.from({ length: products.capacity.mipCount }, (_, mip) =>
      observeTexture(encoder, set.depth, `NPOT${mip}`, mip)
    );
    device.queue.submit([encoder.finish()]);
    const done = device.queue.onSubmittedWorkDone();
    runtime.commit(done);
    await done;
    const actual = new Float32Array((await decode(resultRead)).buffer);
    const limited = new Float32Array((await decode(limitedRead)).buffer);
    check(
      (await decode(lengthRead))[0] === 70000,
      "ray length must survive beyond half maximum without exposure scaling"
    );
    let sourceDepth = [...depths],
      width = 33,
      height = 17;
    for (let mip = 0; mip < pyramidRead.length; mip++) {
      const image = await decode(pyramidRead[mip]);
      check(
        image.every((v, i) => v === sourceDepth[i]),
        `NPOT conservative rectangle maximum mip${mip}`
      );
      const w = Math.max(1, width >> 1),
        h = Math.max(1, height >> 1),
        next = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let maximum = 0;
          // Independent overlap predicate, no copy of GPU first/end indexing.
          for (let py = 0; py < height; py++)
            for (let px = 0; px < width; px++) {
              if (
                (px + 1) * w > x * width &&
                px * w < (x + 1) * width &&
                (py + 1) * h > y * height &&
                py * h < (y + 1) * height
              )
                maximum = Math.max(maximum, sourceDepth[py * width + px]);
            }
          next.push(maximum);
        }
      sourceDepth = next;
      width = w;
      height = h;
    }
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => {
      const n = Math.hypot(...a);
      return a.map((v) => v / n);
    };
    let vndfError = 0;
    for (let i = 0; i < marchStart; i++) {
      const q = [...queryData.subarray(i * 8, i * 8 + 8)],
        alpha = q[3];
      const v = norm([q[0] * alpha, q[1] * alpha, q[2]]);
      const t1 = v[0] ** 2 + v[1] ** 2 > 0 ? norm([-v[1], v[0], 0]) : [1, 0, 0];
      const t2 = cross(v, t1),
        radius = Math.sqrt(q[4]),
        angle = 2 * Math.PI * q[5];
      const a = radius * Math.cos(angle),
        blend = (1 + v[2]) / 2;
      const b = (1 - blend) * Math.sqrt(1 - a * a) + blend * radius * Math.sin(angle);
      const z = Math.sqrt(Math.max(0, 1 - a * a - b * b));
      const n = [0, 1, 2].map((c) => t1[c] * a + t2[c] * b + v[c] * z);
      const expected = norm([n[0] * alpha, n[1] * alpha, Math.max(0, n[2])]);
      for (let c = 0; c < 3; c++) vndfError = Math.max(vndfError, Math.abs(actual[i * 8 + c] - expected[c]));
    }
    check(vndfError < 32 * 2 ** -23, `Heitz VNDF FP32 error ${vndfError}`);
    const slab = (origin, direction, low, high) => {
      if (direction === 0)
        return origin >= low && origin <= high ? [-Infinity, Infinity] : [Infinity, -Infinity];
      const a = (low - origin) / direction,
        b = (high - origin) / direction;
      return [Math.min(a, b), Math.max(a, b)];
    };
    const brute = (q) => {
      const [ox, oy, oz, , dx, dy, dz] = q;
      const tX = dx
        ? ((Math.floor(ox * 33) + (dx > 0 ? 1 : 0)) / 33 + (dx > 0 ? 0.005 : -0.005) / 33 - ox) / dx
        : Infinity;
      const tY = dy
        ? ((Math.floor(oy * 17) + (dy > 0 ? 1 : 0)) / 17 + (dy > 0 ? 0.005 : -0.005) / 17 - oy) / dy
        : Infinity;
      let best = Infinity;
      for (let y = 0; y < 17; y++)
        for (let x = 0; x < 33; x++) {
          const depth = depths[y * 33 + x];
          if (!depth) continue;
          const ix = slab(ox, dx, x / 33, (x + 1) / 33),
            iy = slab(oy, dy, y / 17, (y + 1) / 17),
            iz = slab(oz, dz, 0, depth);
          const entry = Math.max(0, Math.min(tX, tY), ix[0], iy[0], iz[0]);
          const exit = Math.min(ix[1], iy[1], iz[1]);
          if (entry <= exit && entry < best) best = entry;
        }
      return Number.isFinite(best) ? [ox + best * dx, oy + best * dy, oz + best * dz] : null;
    };
    let marchHits = 0;
    for (let i = 0; i < marchCases.length; i++) {
      const expected = brute(marchCases[i]),
        offset = (marchStart + i) * 8;
      check(
        actual[offset + 3] === Number(expected !== null),
        `hierarchical vs full-resolution volumes ray${i}: ${actual.slice(offset, offset + 4)} expected ${expected}`
      );
      if (expected) {
        marchHits++;
        check(
          [0, 1, 2].every((c) => Math.abs(actual[offset + c] - expected[c]) < 0.02 / 17),
          `hierarchical first intersection ray${i}`
        );
      }
    }
    check(actual[(marchStart + 0) * 8 + 4] > 0.99, "valid front-side exact-depth hit confidence");
    check(actual[(marchStart + 5) * 8 + 4] === 0, "back-facing hit rejected");
    check(actual[(marchStart + 6) * 8 + 4] === 0, "two-pixel self-hit rejected");
    check(
      actual[(marchStart + 1) * 8 + 4] > 0 && actual[(marchStart + 1) * 8 + 4] < 0.1,
      "screen border fade preserved"
    );
    check(
      limited[(marchStart + 7) * 8 + 3] === 0 && actual[(marchStart + 7) * 8 + 3] === 1,
      "budget exhaustion is a miss, not an invented hit"
    );
    results.push({
      name: "GGX-depth-traversal-hit-validation",
      vndfCases: marchStart,
      vndfError,
      rays: marchCases.length,
      marchHits,
      largeRayLength: 70000
    });
  };

  try {
    const fixture = makeFixture(17, 19);
    const first = await runFrame(fixture, true);
    check(first.output.every(Number.isFinite), "SSSR full output must be finite");
    for (const values of first.depth)
      check(
        values.every((v) => v === 0.5),
        "nearest NPOT hierarchy must preserve plane/tails"
      );
    for (const stage of first.stages.filter((s) => s.stage === "classify")) {
      check(stage.counts[0] > 0 && stage.counts[0] <= 17 * 19, "bounded GPU ray count");
      check(stage.counts[1] === 9, "all odd-size tiles including tail must be queued");
    }
    const env2020 = multiply(fixture.env);
    let maxSignalError = 0;
    for (let p = 0; p < 17 * 19; p++) {
      for (let c = 0; c < 3; c++)
        maxSignalError = Math.max(
          maxSignalError,
          Math.abs(first.base[p * 4 + c] - env2020[c]),
          Math.abs(first.coat[p * 4 + c] - env2020[c])
        );
    }
    check(maxSignalError < 0.008, `constant native environment survives full denoising: ${maxSignalError}`);
    check(
      first.confidence.every((v) => v === 0),
      "plane normal faces camera: no valid screen reflection"
    );
    results.push({
      name: "full-two-lobe-odd-closure",
      maxSignalError,
      phase: runtime.phase,
      activeBytes: runtime.allocatedBytes
    });
    verifyQueueAndComposite(fixture, first);
    const beforeAbort = runtime.phase;
    check(runtime.prepare(fixture.input), "retry preparation");
    const abortedEncoder = device.createCommandEncoder();
    runtime.encode(abortedEncoder);
    runtime.abort();
    check(runtime.phase === beforeAbort, "abort must not advance phase/history");
    const retry = await runFrame(fixture);
    check(retry.output.every(Number.isFinite), "abort retry remains finite");
    const scaled = makeFixture(17, 19, 0.25);
    const quarter = await runFrame(scaled, true);
    let exposureError = 0;
    for (let p = 0; p < 17 * 19; p++)
      for (let c = 0; c < 3; c++)
        exposureError = Math.max(
          exposureError,
          Math.abs(quarter.output[p * 4 + c] * 4 - first.output[p * 4 + c])
        );
    check(exposureError < 0.016, `GPU pre-exposure equivalence: ${exposureError}`);
    results.push({ name: "abort-retry-and-exposure", exposureError });
    const variedFixture = makeFixture(25, 19, 1, true, true);
    // Base queues two tile columns; coat queues only the first. Base leaves real
    // variance in the shared scratch beside coat's active halo. The coat filter
    // must obtain zero variance for its own noneligible neighboring receivers.
    for (let p = 0; p < 25 * 19; p++) {
      if (p % 25 < 8) continue;
      const record = Array.from({ length: 16 }, (_, component) =>
        decodeFloat16((variedFixture.packet[p * 8 + (component >> 1)] >>> ((component & 1) * 16)) & 0xffff)
      );
      record[7] = 0.6;
      record[11] = 0;
      record[15] &= ~4;
      record.splice(12, 3, ...multiply(variedFixture.env.map((v, c) => v * record[8 + c])));
      packSssrReceiver(record, variedFixture.packet, p * 8);
    }
    device.queue.writeBuffer(variedFixture.input.receivers, 0, variedFixture.packet);
    const varied = await runFrame(variedFixture, true);
    verifyQueueAndComposite(variedFixture, varied);
    for (let lobe = 0; lobe < 2; lobe++) {
      const raw = varied.stages.find((s) => s.stage === "intersect" && s.lobe === lobe).raw;
      const average = varied.stages.find((s) => s.stage === "reproject" && s.lobe === lobe).average;
      const filtered = varied.stages.find((s) => s.stage === "prefilter" && s.lobe === lobe);
      const expected = referenceSssrResetStages({
        width: 25,
        height: 19,
        packet: variedFixture.packet,
        raw,
        average,
        prefilter: filtered.filtered,
        prefilterVariance: filtered.variance,
        exposure: 1,
        lobe,
        stability: 0.7,
        capturedMoments: filtered.moments
      });
      results.push(compareSssrStage(average, expected.expectedAverage, `lobe${lobe}/weighted8x8`));
      results.push(
        compareSssrStage(filtered.filtered, expected.expectedPrefilter, `lobe${lobe}/15-tap-prefilter`)
      );
      // Unscheduled pixels have no variance consumer; compare actual active tiles.
      const activeTile = (_v, p) => Math.floor((p % 25) / 8) < (lobe === 0 ? 2 : 1);
      results.push(
        compareSssrStage(
          filtered.variance.filter(activeTile),
          expected.expectedVariance.filter(activeTile),
          `lobe${lobe}/prefilter-variance`
        )
      );
      results.push(
        compareSssrStage(
          lobe ? varied.coat : varied.base,
          expected.expectedResolve,
          `lobe${lobe}/9x9-clipped-resolve`
        )
      );
      results.push(
        compareSssrStage(
          lobe ? varied.coatStatistics : varied.statistics,
          expected.expectedStatistics,
          `lobe${lobe}/resolve-statistics`
        )
      );
      check(
        raw.every((v, i) => i % 4 === 3 || v > 0),
        "quad edges and non-glossy halo must have radiance, no dropped receivers"
      );
    }
    const warmed = await runFrame(variedFixture);
    check(warmed.historyValid, "ordinary motion-independent warm frame keeps reflection history");
    verifyQueueAndComposite(variedFixture, warmed);
    for (let lobe = 0; lobe < 2; lobe++) {
      const prior = lobe ? varied.coatStatistics : varied.statistics;
      let expectedRays = 0;
      const eligible = (p) =>
        ((decodeFloat16(variedFixture.packet[p * 8 + 7] >>> 16) | 0) & (2 << lobe)) !== 0;
      for (let p = 0; p < 25 * 19; p++) {
        if (!eligible(p)) continue;
        const x = p % 25,
          y = Math.floor(p / 25),
          designated = (y & ~1) * 25 + (x & ~1);
        if (((x | y) & 1) === 0 || prior[p * 2] > 0 || !eligible(designated)) expectedRays++;
      }
      const actual = warmed.stages.find((s) => s.stage === "classify" && s.lobe === lobe).counts[0];
      check(actual === expectedRays, "variance-guided promotion preserves exact full receiver demand");
    }
    results.push({ name: "variance-guided-warm-demand", historyValid: warmed.historyValid });
    const tables = new Uint32Array(
      await (
        await fetch(new URL("../../.test-dist/render/assets/sssr/blue-noise.bin", import.meta.url))
      ).arrayBuffer()
    );
    for (const image of [first, varied]) {
      for (const pixel of [0, 1, 127, 128, 16383])
        for (let dimension = 0; dimension < 2; dimension++) {
          const value = tables[dimension] ^ tables[65536 + pixel * 8 + dimension];
          // f32 phase arithmetic is intentional in the fixed source; RG8 store
          // introduces exactly one UNORM quantization.
          const rotated = Math.fround(
            Math.fround((value + 0.5) / 256) +
              Math.fround(Math.fround(image.phase & 255) * Math.fround(1.61803398875))
          );
          const expected = Math.round((rotated - Math.floor(rotated)) * 255) / 255;
          check(
            image.noise[pixel * 2 + dimension] === expected,
            "fixed source blue noise phase/data mismatch"
          );
        }
    }
    results.push({ name: "pinned-blue-noise-exact", testedTexels: 10 });
    await runFunctionOracles();
    await runHistoryOracles();
    await runPerspectiveHistoryOracle();
    await runHdrAndDarkOracles();
    await runCapacityAndLifecycleOracles();
    runtime.releaseHistory();
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    check(
      runtime.allocatedBytes === 819204,
      "release retires full viewport worksets, retaining only fixed noise and dummy diagnostic"
    );
    check(errors.length === 0, errors.join("\n"));
    return { ok: true, results, errors };
  } finally {
    runtime.destroy();
    await device.queue.onSubmittedWorkDone();
    for (const resource of resources) resource.destroy();
  }
}
