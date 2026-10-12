import { VSM_SAMPLING_WGSL, VSM_FILTER_NOISE_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
import { loadVsmFilterData } from "../../.test-dist/render/vsm/VsmFilterNoise.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const f = Math.fround;
const points = Array.from({ length: 4 }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / 4),
    a = i * Math.PI * (3 - Math.sqrt(5));
  return [f(r * Math.cos(a)), f(r * Math.sin(a))];
});
const depthAt = (x, y) => {
  // A one-texel pole, sloped edge and clear cells; unlike a constant atlas this
  // detects incorrect gather order, missed offsets and changed empty semantics.
  if (x % 136 === 38) return 0.75;
  const cell = ((x * 17) ^ (y * 31)) % 7;
  return cell < 2 ? 0 : cell < 4 ? 0.25 : 0.75;
};

/** Independent CPU filtering plus the actual VSM noise loader/GPU kernel.
 * Covers the full 64-frame sequence, reverse-Z, negative references, every
 * border direction, coarse-sized local UV and non-power-of-two gather. */
export async function runVsmFilterGpuOracle(device) {
  const filterData = await loadVsmFilterData();
  const rotations = new Float32Array(filterData.buffer, 128 * 128 * 64, 512);
  const retained = [],
    results = [];
  const make = (size, usage, initial) => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: !!initial });
    retained.push(buffer);
    if (initial) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(initial.buffer, initial.byteOffset, initial.byteLength),
      );
      buffer.unmap();
    }
    return buffer;
  };
  // Deliberately nonzero offset: reads must honor the directory's segment base.
  const payload = new Uint8Array(filterData.length + 256);
  payload.fill(0xff, 0, 256);
  payload.set(filterData, 256);
  const noise = make(payload.length, GPUBufferUsage.STORAGE, payload);
  const constants = new Float32Array(64),
    words = new Uint32Array(constants.buffer);
  words.set([128, 128, 4, 3, 1, 7, 2, 0], 40);
  words[59] = 64;
  const uniform = make(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, constants);
  const authored = [];
  const coordinates = [0, 1 / 256, 0.25, 0.5, 0.75, 1 - 1 / 256, -3 / 128, 131 / 128];
  for (const slot of [
    [0, 0],
    [1, 1],
  ])
    for (const u of coordinates)
      for (const v of coordinates)
        for (const reference of [-0.25, 0, 0.25, 0.5, 0.75, 1.25])
          for (const bias of [0, 0.003]) {
            const index = authored.length;
            authored.push({
              uv: [f(u), f(v)],
              slot,
              reference: f(reference),
              bias: f(bias),
              pixel: [(index * 17) % 257, (index * 31) % 263],
            });
          }
  const input = new Float32Array(authored.length * 8);
  for (let i = 0; i < authored.length; i++) {
    const c = authored[i];
    input.set([...c.uv, c.reference, c.bias, ...c.slot, ...c.pixel], i * 8);
  }
  const cases = make(input.byteLength, GPUBufferUsage.STORAGE, input);
  const output = make(authored.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = make(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const module = device.createShaderModule({
    label: "VSM/new filter independent numeric",
    code: `
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${VSM_SAMPLING_WGSL}
${VSM_FILTER_NOISE_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> lighting_directory: array<u32>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var vsm_atlas_sampler: sampler;
@group(0) @binding(4) var<storage, read> cases: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> output: array<vec4f>;
// Query isn't the tested kernel, but its declaration must remain well typed.
@group(0) @binding(6) var<storage, read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x * 2u >= arrayLength(&cases)) { return; }
  let c = cases[id.x * 2u]; let p = cases[id.x * 2u + 1u];
  let rotation = vsm_filter_rotation(vec2u(p.zw));
  let entry = VsmPageEntry(u32(p.x), u32(p.y), 0u, 0u, 0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
  output[id.x] = vec4f(vsm_sample_page(entry, c.xy, c.z, c.w, rotation, vec2f(0.0)), rotation, 0.0);
}`,
  });
  check(
    !(await module.getCompilationInfo()).messages.some((m) => m.type === "error"),
    "Filter WGSL failed compilation",
  );
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const sampler = device.createSampler();
  const rasterModule = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let xy = vec2u(p.xy);
  if (xy.x % 136u == 38u) { return .75; }
  let cell = ((xy.x * 17u) ^ (xy.y * 31u)) % 7u;
  return select(select(.75, .25, cell < 4u), 0.0, cell < 2u);
}`,
  });
  const raster = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: rasterModule, entryPoint: "vs" },
    fragment: { module: rasterModule, entryPoint: "fs", targets: [] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const cpu = (c, mode, radius, phase) => {
    const noiseIndex = (c.pixel[0] % 128) + (c.pixel[1] % 128) * 128 + phase * 16384;
    const n = filterData[noiseIndex],
      rotation = mode === 2 ? [rotations[n * 2], rotations[n * 2 + 1]] : [1, 0];
    const base = c.slot.map((x) => x * 136 + 4);
    const reference = f(c.reference + c.bias);
    const visible = (x, y) => {
      const d = depthAt(base[0] + x, base[1] + y);
      return d > 0 && d > reference ? 0 : 1;
    };
    const nearest = (offset) =>
      c.uv.map((uv, axis) => Math.max(-4, Math.min(131, Math.floor(f(f(uv * 128) + offset[axis])))));
    if (mode === 0) return { value: visible(...nearest([0, 0])), rotation };
    if (mode === 1) {
      const pos = c.uv.map((uv) => Math.max(-4, Math.min(130, f(f(uv * 128) - 0.5))));
      const xy = pos.map(Math.floor),
        fract = pos.map((p, i) => f(p - xy[i]));
      const mix = (a, b, t) => f(f(a * f(1 - t)) + f(b * t));
      return {
        value: mix(
          mix(visible(xy[0], xy[1]), visible(xy[0] + 1, xy[1]), fract[0]),
          mix(visible(xy[0], xy[1] + 1), visible(xy[0] + 1, xy[1] + 1), fract[0]),
          fract[1],
        ),
        rotation,
      };
    }
    let sum = 0;
    for (const p of points) {
      const offset = [
        f(f(f(rotation[0] * p[0]) - f(rotation[1] * p[1])) * radius),
        f(f(f(rotation[1] * p[0]) + f(rotation[0] * p[1])) * radius),
      ];
      sum += visible(...nearest(offset));
    }
    return { value: sum / 4, rotation };
  };
  try {
    for (const dimension of [512, 408]) {
      const atlas = device.createTexture({
        size: [dimension, dimension],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      try {
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: noise } },
            { binding: 2, resource: atlas.createView() },
            { binding: 3, resource: sampler },
            { binding: 4, resource: { buffer: cases } },
            { binding: 5, resource: { buffer: output } },
          ],
        });
        const configurations = [
          { mode: 0, radius: 0, phase: 0 },
          { mode: 1, radius: 0, phase: 0 },
        ];
        for (const radius of [0, 1.5, 3])
          for (let phase = 0; phase < 64; phase++) configurations.push({ mode: 2, radius, phase });
        for (const [index, config] of configurations.entries()) {
          words[46] = config.mode;
          words[47] = config.phase;
          constants[51] = config.radius;
          device.queue.writeBuffer(uniform, 0, constants);
          const encoder = device.createCommandEncoder();
          if (index === 0) {
            const depth = encoder.beginRenderPass({
              colorAttachments: [],
              depthStencilAttachment: {
                view: atlas.createView(),
                depthLoadOp: "clear",
                depthClearValue: 0,
                depthStoreOp: "store",
              },
            });
            depth.setPipeline(raster);
            depth.draw(3);
            depth.end();
          }
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(authored.length / 64));
          pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = new Float32Array(readback.getMappedRange());
          for (let i = 0; i < authored.length; i++) {
            const expected = cpu(authored[i], config.mode, config.radius, config.phase);
            check(
              Math.abs(actual[i * 4] - expected.value) < 2e-6,
              `Filter mismatch dimension=${dimension} ${JSON.stringify(config)} case=${i}: ${actual[i * 4]} vs ${expected.value}`,
            );
            check(
              actual[i * 4 + 1] === expected.rotation[0] && actual[i * 4 + 2] === expected.rotation[1],
              "Wrong STBN phase/packed-byte/rotation lookup",
            );
          }
          readback.unmap();
          results.push({ dimension, ...config, receivers: authored.length });
        }
      } finally {
        atlas.destroy();
      }
    }
    return {
      passed: true,
      configurations: results.length,
      comparisons: results.length * authored.length,
      phases: 64,
      modes: ["point", "gather2x2", "disk4"],
      filterDataBytes: filterData.byteLength,
      covers: [
        "zero clear",
        "negative reference",
        "strict equality",
        "all gutters",
        "thin pole",
        "nonconstant depth",
        "non-power-of-two gather",
        "packed scalar STBN and rotation table",
      ],
    };
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    await device.queue.onSubmittedWorkDone();
    retained.forEach((buffer) => buffer.destroy());
  }
}
