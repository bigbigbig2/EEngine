import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
import { VSM_SAMPLING_PUBLICATION_WGSL } from "../../.test-dist/shaders/vsm_sampling_publication.js";
import { REFERENCE_VSM_SAMPLING_WGSL } from "./fixtures/vsm-sampling-v1.mjs";

const check = (value, message) => { if (!value) throw new Error(message); };

/** Frozen original GPU query/PCF is the migration oracle, not a production path.
 * Numeric comparison includes every query status and exact visibility bits. */
export async function runVsmSamplingPublicationGpuOracle(device) {
  const retained = [];
  const make = (bytes, usage, initial) => {
    const buffer = device.createBuffer({ size: bytes, usage, mappedAtCreation: initial !== undefined });
    if (initial !== undefined) {
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(initial.buffer, initial.byteOffset, initial.byteLength));
      buffer.unmap();
    }
    retained.push(buffer);
    return buffer;
  };
  const compile = async (code, entryPoint = "main") => {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    check(!info.messages.some((m) => m.type === "error"), JSON.stringify(info.messages));
    return device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
  };
  const pages = 128, levels = 6, perManagement = 21888, perSampling = 16448;
  const generation = 0xfedcba98, epoch = 0xffffffee, namespace = 0xda001122;
  const constants = new Float32Array(64), words = new Uint32Array(constants.buffer);
  constants.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  words.set([pages, 128, 4, 30, levels, generation, 4, 4096], 40);
  constants.set([.1, .003, .002, 1.5], 48);
  constants.set([-3, 7, .1, 1], 52);
  words.set([epoch, namespace, 0, 0], 56);
  const uniform = make(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, constants);
  const table = make(perManagement * levels * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const descriptors = make(perSampling * levels * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const publish = await compile(VSM_SAMPLING_PUBLICATION_WGSL);
  const pubGroup = device.createBindGroup({ layout: publish.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uniform } },
    { binding: 1, resource: { buffer: table } },
    { binding: 2, resource: { buffer: descriptors } }
  ] });
  const pointValues = [];
  const nextFloat = (x, delta) => {
    const f = new Float32Array([x]), u = new Uint32Array(f.buffer);
    if (x === 0) return delta < 0 ? -1.401298464324817e-45 : 1.401298464324817e-45;
    u[0] += (x > 0 ? delta : -delta);
    return f[0];
  };
  const append = (x, y, z = 0) => pointValues.push(x, y, z, 1);
  // Boundaries are authored independently in world coordinates. Include very
  // small signed values so a fine-cell representative cannot hide FTZ behavior.
  for (let level = 0; level < levels; level++) {
    const extent = Math.fround(166.4 * 2 ** level);
    for (const mip of [0, 5]) {
      const step = Math.fround(extent / (pages >> mip));
      for (let k = -128; k <= 128; k++) {
        const boundary = Math.fround(k * step);
        for (const delta of [-1, 0, 1]) {
          const x = delta ? nextFloat(boundary, delta) : boundary;
          append(x, -.125 * step);
          append(.25 * step, x, delta * 4);
        }
      }
    }
  }
  append(1e6, 1e6); append(-1e6, -1e6);
  append(-1e-38, 1e-38); append(-1e-40, -1e-40);
  const positions = new Float32Array(pointValues), count = positions.length / 4;
  const points = make(positions.byteLength, GPUBufferUsage.STORAGE, positions);
  const outputs = [0, 1].map(() => make(count * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC));
  const staging = make(count * 64, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const atlas = device.createTexture({ size: [4096, 4096], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const depthModule = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let cell = (u32(p.x) / 7u + u32(p.y) / 11u) % 3u;
  return select(select(0.25, 0.75, cell == 1u), 0.0, cell == 2u);
}` });
  const raster = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module: depthModule, entryPoint: "vs" }, fragment: { module: depthModule, entryPoint: "fs", targets: [] }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
  const pipelines = [], groups = [];
  for (const [index, source] of [REFERENCE_VSM_SAMPLING_WGSL, VSM_SAMPLING_WGSL].entries()) {
    const declaration = index === 0 ? "vsm_page_table: array<VsmPageEntry>" : "vsm_sampling_descriptors: array<VsmSamplingDescriptor>";
    const pipeline = await compile(`
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${source}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> ${declaration};
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var<storage, read> points: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> output: array<vec4u>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&points)) { return; }
  let q = vsm_query_directional(points[id.x].xy);
  let v = vsm_sample_directional(points[id.x].xyz, normalize(vec3f(0.7, 0.01, 0.3)),
    GpuPrimitiveTypeTable(vec3f(0.0, 1.0, 0.0), vec3f(1.0)));
  output[id.x * 2u] = vec4u(q.status, q.target_status, q.level, bitcast<u32>(v));
  let valid = q.status == VSM_QUERY_FINE || q.status == VSM_QUERY_COARSE;
  output[id.x * 2u + 1u] = select(vec4u(0u), vec4u(q.entry.slot_x, q.entry.slot_y, q.entry.mip, 1u), valid);
}`);
    pipelines.push(pipeline);
    groups.push(device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: index === 0 ? table : descriptors } },
      { binding: 2, resource: atlas.createView() },
      { binding: 3, resource: { buffer: points } },
      { binding: 4, resource: { buffer: outputs[index] } }
    ] }));
  }
  const cases = [], statuses = new Set();
  device.pushErrorScope("validation");
  try {
    for (const mode of [0, 1, 2, 3]) {
      const entries = new Uint32Array(perManagement * levels * 12);
      for (let level = 0; level < levels; level++) {
        const extent = Math.fround(166.4 * 2 ** level);
        const step = Math.fround(extent / pages), shift = mode === 1 ? 37 : 0;
        const origin = [Math.fround(-extent / 2 + shift * step), Math.fround(-extent / 2 - shift * step)];
        constants.set([...origin, extent, 0], 16 + level * 4);
        const center = origin.map(x => Math.fround(x + Math.fround(extent * .5)));
        const fineMin = center.map(x => Math.floor(Math.fround(x / step)) - 64);
        for (const mip of [0, 5]) {
          const axis = mip === 0 ? 128 : 8, size = mip === 0 ? 128 : 5;
          const min = mip === 0 ? fineMin : fineMin.map(x => Math.floor(x / 32));
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const world = [min[0] + x, min[1] + y], wrap = n => ((n % axis) + axis) % axis;
            const index = level * perManagement + (mip === 5 ? perManagement - 64 : 0) + wrap(world[1]) * axis + wrap(world[0]);
            const code = mode === 2 ? 0 : mode === 3 ? 2 : (index + level) % 8;
            const flags = code === 0 ? 0 : code === 2 ? 11 : code === 3 ? 13 : 9;
            entries.set([x % 30, y % 30, code === 4 ? (mip + 1) % 6 : mip, flags,
              code === 5 ? generation - 1 : generation, 5, 0, code === 6 ? epoch - 1 : epoch,
              world[0] >>> 0, world[1] >>> 0, code === 7 ? namespace - 1 : namespace, 0], index * 12);
          }
        }
      }
      device.queue.writeBuffer(uniform, 0, constants);
      device.queue.writeBuffer(table, 0, entries);
      const encoder = device.createCommandEncoder();
      // Poison all descriptor words first: proves complete rewrite including
      // missing/dirty/outside after rolling windows and retired allocations.
      const poison = new Uint32Array(perSampling * levels * 4).fill(0xffffffff);
      device.queue.writeBuffer(descriptors, 0, poison);
      const depth = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: atlas.createView(), depthLoadOp: "clear", depthClearValue: 0, depthStoreOp: "store" } });
      depth.setPipeline(raster); depth.draw(3); depth.end();
      const publication = encoder.beginComputePass();
      publication.setPipeline(publish); publication.setBindGroup(0, pubGroup); publication.dispatchWorkgroups(Math.ceil(perSampling * levels / 64)); publication.end();
      for (let index = 0; index < 2; index++) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines[index]); pass.setBindGroup(0, groups[index]); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
        encoder.copyBufferToBuffer(outputs[index], 0, staging, index * count * 32, count * 32);
      }
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(staging.getMappedRange()), split = count * 8;
      for (let i = 0; i < split; i++) {
        check(actual[i] === actual[split + i], `mode=${mode}, point=${Math.floor(i / 8)}, word=${i % 8}: reference ${actual[i]} vs compact ${actual[split + i]}`);
        if (i % 8 === 0) statuses.add(actual[i]);
      }
      staging.unmap();
      cases.push({ mode, comparisons: count, exact: true });
    }
    check(statuses.size === 6, `Missing query status coverage: ${[...statuses]}`);
    const error = await device.popErrorScope();
    check(error === null, error?.message);
  } finally {
    await device.queue.onSubmittedWorkDone();
    atlas.destroy(); retained.forEach(buffer => buffer.destroy());
  }
  return { passed: true, cases, statuses: [...statuses].sort(), fullIdentity: { generation, epoch, namespace },
    covers: ["fine/coarse/missing/stale/dirty/outside", "f32 nextafter signed boundaries/subnormals", "window roll", "all missing/all dirty", "gutter/PCF positive and zero depth", "negative receiver depth", "poison/full write reset"] };
}
