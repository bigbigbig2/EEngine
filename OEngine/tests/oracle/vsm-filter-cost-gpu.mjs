import { VSM_SAMPLING_WGSL, VSM_FILTER_NOISE_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
import { VSM_SAMPLING_WGSL as OLD_PCF } from "./fixtures/vsm-sampling-s3.mjs";
import { loadVsmFilterData } from "../../.test-dist/render/vsm/VsmFilterNoise.js";

/** Full 1080p sampling kernel cost, not a whole-renderer FPS qualification.
 * Same atlas/receiver addresses/output writes; old radius .75 vs new disk 1.5
 * is the authorized filter-quality change. Includes disk noise lookup ALU.
 * Query/BRDF and raster/management are excluded and measured by Renderer host. */
export async function runVsmFilterCostGpuOracle(device) {
  if (!device.features.has("timestamp-query")) throw new Error("VSM cost oracle requires GPU timestamps");
  const retained = [];
  const buffer = (size, usage, initial) => {
    const result = device.createBuffer({ size, usage, mappedAtCreation: !!initial });
    retained.push(result);
    if (initial) {
      new Uint8Array(result.getMappedRange()).set(
        new Uint8Array(initial.buffer, initial.byteOffset, initial.byteLength),
      );
      result.unmap();
    }
    return result;
  };
  const width = 1920,
    height = 1080,
    frames = 128;
  const noiseData = await loadVsmFilterData();
  const noise = buffer(noiseData.length, GPUBufferUsage.STORAGE, noiseData);
  const output = buffer(width * height * 4, GPUBufferUsage.STORAGE);
  const atlas = device.createTexture({
    size: [4096, 4096],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const queries = device.createQuerySet({ type: "timestamp", count: frames * 2 });
  const resolved = buffer(frames * 16, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
  const times = buffer(frames * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: "non-filtering" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const rasterModule = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0)); return vec4f(p[i],0.0,1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let cell = ((u32(p.x)*17u) ^ (u32(p.y)*31u)) % 7u;
  return select(select(.75,.25,cell<4u),0.0,cell<2u);
}`,
  });
  const raster = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: rasterModule, entryPoint: "vs" },
    fragment: { module: rasterModule, entryPoint: "fs", targets: [] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const modes = ["old16", "old4", "disk4", "gather2x2", "point"];
  const pipelines = [],
    groups = [];
  for (const name of modes) {
    const old = name === "old16" || name === "old4";
    const data = new Float32Array(64),
      words = new Uint32Array(data.buffer);
    words.set(
      [
        128,
        128,
        4,
        30,
        6,
        1,
        name === "old16" ? 4 : old ? 2 : name === "disk4" ? 2 : name === "gather2x2" ? 1 : 0,
        0,
      ],
      40,
    );
    data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    data[51] = 1.5;
    const constants = buffer(256, GPUBufferUsage.UNIFORM, data);
    const module = device.createShaderModule({
      label: `VSM/cost/${name}`,
      code: `
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${old ? OLD_PCF : VSM_SAMPLING_WGSL + VSM_FILTER_NOISE_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(2) var vsm_atlas_sampler: sampler;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(4) var<storage, read> lighting_directory: array<u32>;
@group(0) @binding(5) var<storage, read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${width}u || id.y >= ${height}u) { return; }
  let entry = VsmPageEntry(id.x / 128u % 30u, id.y / 128u % 30u, 0u, 0u, 0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
  let uv = (vec2f(id.xy % vec2u(128u)) + vec2f(0.25)) / 128.0;
  output[id.x + id.y * ${width}u] = vsm_sample_page(entry, uv, .5, .001${old ? "" : ", vsm_filter_rotation(id.xy), vsm_receiver_plane_gradient(normalize(vec3f(.3,.2,.9)), .001)"});
}`,
    });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
    if (errors.length) throw new Error(JSON.stringify(errors));
    pipelines.push(
      await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module, entryPoint: "main" },
      }),
    );
    groups.push(
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: constants } },
          { binding: 1, resource: atlas.createView() },
          { binding: 2, resource: device.createSampler() },
          { binding: 3, resource: { buffer: output } },
          { binding: 4, resource: { buffer: noise } },
          { binding: 5, resource: { buffer: noise } },
        ],
      }),
    );
  }
  const encode = (encoder, mode, index) => {
    const pass = encoder.beginComputePass({
      label: `VSM/cost/${modes[mode]}`,
      ...(index === undefined
        ? {}
        : {
            timestampWrites: {
              querySet: queries,
              beginningOfPassWriteIndex: index * 2,
              endOfPassWriteIndex: index * 2 + 1,
            },
          }),
    });
    pass.setPipeline(pipelines[mode]);
    pass.setBindGroup(0, groups[mode]);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
  };
  try {
    const init = device.createCommandEncoder();
    const clear = init.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: atlas.createView(),
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    clear.setPipeline(raster);
    clear.draw(3);
    clear.end();
    // Unmeasured initialization only; every measured frame remains in raw.
    for (let i = 0; i < 12; i++) encode(init, i % modes.length);
    device.queue.submit([init.finish()]);
    await device.queue.onSubmittedWorkDone();
    const encoder = device.createCommandEncoder(),
      order = [];
    for (let i = 0; i < frames; i++) {
      const mode = [0, 2, 2, 0, 1, 2, 3, 4][i % 8];
      order.push(mode);
      encode(encoder, mode, i);
    }
    encoder.resolveQuerySet(queries, 0, frames * 2, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, times, 0, times.size);
    device.queue.submit([encoder.finish()]);
    await times.mapAsync(GPUMapMode.READ);
    const raw = new BigUint64Array(times.getMappedRange()),
      samples = Object.fromEntries(modes.map((name) => [name, []]));
    for (let i = 0; i < frames; i++) samples[modes[order[i]]].push(Number(raw[i * 2 + 1] - raw[i * 2]) / 1e6);
    times.unmap();
    const percentile = (values, p) => {
      const a = [...values].sort((x, y) => x - y),
        at = (a.length - 1) * p,
        i = Math.floor(at);
      return a[i] + (a[Math.ceil(at)] - a[i]) * (at - i);
    };
    return {
      passed: true,
      width,
      height,
      frames,
      samples,
      timings: Object.fromEntries(
        modes.map((name) => [
          name,
          { p50: percentile(samples[name], 0.5), p95: percentile(samples[name], 0.95) },
        ]),
      ),
      boundary: "isolated sampling instructions/noise/output, excludes page query, BRDF, raster and Temporal",
    };
  } finally {
    if (times.mapState === "mapped") times.unmap();
    await device.queue.onSubmittedWorkDone();
    queries.destroy();
    atlas.destroy();
    retained.forEach((value) => value.destroy());
  }
}
