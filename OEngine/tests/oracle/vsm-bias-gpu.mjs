import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
const check = (value, message) => {
  if (!value) throw new Error(message);
};

/** Actual rasterized analytic receiver plane -> actual directional sampler.
 * Inclined self-shadow and a 2.5-texel contact caster are independent goldens.
 * Uncorrected sampling is a negative control, not a production fallback. */
export async function runVsmBiasGpuOracle(device) {
  const resources = [];
  const make = (size, usage, initial) => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: !!initial });
    resources.push(buffer);
    if (initial) {
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(initial.buffer));
      buffer.unmap();
    }
    return buffer;
  };
  const constants = new Float32Array(64),
    words = new Uint32Array(constants.buffer);
  constants.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  constants.set([0, 0, 128, 0], 16);
  words.set([128, 128, 4, 1, 1, 7, 2, 0], 40);
  constants.set([1, 1, 0, 1.5], 48);
  constants.set([0, 1000, 0.001, 1], 52);
  const uniform = make(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, constants);
  const plane = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const records = new Uint32Array(16448 * 4);
  for (let i = 0; i < 16448; i++) records[i * 4 + 2] = 2;
  const descriptors = make(records.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, records);
  const count = 64 * 9;
  const output = make(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = make(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const atlas = device.createTexture({
    size: [136, 136],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const rasterModule = device.createShaderModule({
    code: `
@group(0) @binding(0) var<uniform> plane: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0)); return vec4f(p[i],0.0,1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  return clamp(.5 + dot(p.xy - vec2f(68.0), plane.xy) * plane.w * .001 + plane.z, 0.0, 1.0);
}`,
  });
  const raster = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: rasterModule, entryPoint: "vs" },
    fragment: { module: rasterModule, entryPoint: "fs", targets: [] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const rasterGroup = device.createBindGroup({
    layout: raster.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: plane } }],
  });
  const module = device.createShaderModule({
    code: `
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${VSM_SAMPLING_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var vsm_atlas_sampler: sampler;
@group(0) @binding(4) var<uniform> plane: vec4f;
@group(0) @binding(5) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${count}u) { return; }
  let pixel = id.x % 9u;
  let xy = vec2f(48.25 + f32(pixel % 3u) * 16.0, 48.75 + f32(pixel / 3u) * 16.0);
  let reference = .5 + dot(xy - vec2f(64.0), plane.xy) * plane.w * .001;
  let inverse_light = transpose(vsm_constants.light_view);
  let position = (inverse_light * vec4f(xy * plane.w, 1000.0 - reference * 1000.0, 1.0)).xyz;
  let normal_light = normalize(vec3f(plane.xy, 1.0));
  let normal = (inverse_light * vec4f(normal_light, 0.0)).xyz;
  let incident = (inverse_light * vec4f(0.0, 0.0, 1.0, 0.0)).xyz;
  let angle = f32(id.x / 9u) * 6.283185307179586 / 64.0;
  let rotation = vec2f(cos(angle), sin(angle));
  let actual = vsm_sample_directional(position, normal,
    GpuPrimitiveTypeTable(incident, vec3f(1.0)), rotation);
  let bias = (vsm_constants.filter_params.y + vsm_constants.filter_params.x * (1.0 - normal_light.z)) * plane.w * .001;
  let entry = VsmPageEntry(0u,0u,0u,0u,0u,0u,0u,0u,0,0,0u,0u);
  let uncorrected = vsm_sample_page(entry, xy / 128.0, reference, bias, rotation, vec2f(0.0));
  let edge_on = (inverse_light * vec4f(0.0, 1.0, 0.0, 0.0)).xyz;
  output[id.x] = vec4f(actual, uncorrected, reference,
    length(vsm_receiver_plane_gradient(edge_on, plane.w * .001)));
}`,
  });
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
  check(errors.length === 0, JSON.stringify(errors));
  const sample = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const group = device.createBindGroup({
    layout: sample.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: descriptors } },
      { binding: 2, resource: atlas.createView() },
      { binding: 3, resource: device.createSampler() },
      { binding: 4, resource: { buffer: plane } },
      { binding: 5, resource: { buffer: output } },
    ],
  });
  const rows = [];
  let acneWitnesses = 0,
    panningWitnesses = 0;
  try {
    for (const mip of [0, 5])
      for (const angle of [0, Math.PI / 6])
        for (const slope of [
          [0, 0],
          [1.5, 0.3],
          [4, -2],
          [8, 4],
        ])
          for (const bias of [0.5, 1, 1.5, 2])
            for (const contact of [0, 0.0025])
              for (const mode of [0, 1, 2])
                for (const radius of [1.5, 3]) {
                  constants[48] = bias;
                  constants[49] = bias;
                  constants[51] = radius;
                  words[46] = mode;
                  const worldTexel = 2 ** mip / 128;
                  const c = Math.cos(angle),
                    s = Math.sin(angle);
                  constants.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
                  records[2] = mip === 0 ? 0 : 2;
                  records[16384 * 4 + 2] = mip === 5 ? 1 : 2;
                  device.queue.writeBuffer(descriptors, 0, records);
                  device.queue.writeBuffer(uniform, 0, constants);
                  device.queue.writeBuffer(
                    plane,
                    0,
                    new Float32Array([...slope, contact * worldTexel, worldTexel]),
                  );
                  const encoder = device.createCommandEncoder();
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
                  depth.setBindGroup(0, rasterGroup);
                  depth.draw(3);
                  depth.end();
                  const pass = encoder.beginComputePass();
                  pass.setPipeline(sample);
                  pass.setBindGroup(0, group);
                  pass.dispatchWorkgroups(Math.ceil(count / 64));
                  pass.end();
                  encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
                  device.queue.submit([encoder.finish()]);
                  await readback.mapAsync(GPUMapMode.READ);
                  const values = new Float32Array(readback.getMappedRange());
                  let selfFailures = 0,
                    contactFailures = 0;
                  for (let i = 0; i < count; i++) {
                    const actual = values[i * 4],
                      negative = values[i * 4 + 1];
                    check(
                      values[i * 4 + 3] === 0,
                      "Singular receiver plane did not return a finite zero gradient",
                    );
                    if (contact === 0) {
                      if (actual !== 1) selfFailures++;
                      if (negative < 1) acneWitnesses++;
                    } else if (bias <= 1) {
                      if (actual !== 0) contactFailures++;
                    } else if (actual > 0) panningWitnesses++;
                  }
                  readback.unmap();
                  check(
                    selfFailures === 0,
                    `Self-shadow acne: ${JSON.stringify({ mip, angle, slope, bias, mode, radius, selfFailures })}`,
                  );
                  check(
                    contactFailures === 0,
                    `Contact shadow lost: ${JSON.stringify({ mip, angle, slope, bias, mode, radius, contactFailures })}`,
                  );
                  rows.push({
                    mip,
                    angle,
                    slope,
                    bias,
                    contact,
                    mode,
                    radius,
                    selfFailures,
                    contactFailures,
                  });
                }
    check(acneWitnesses > 0 && panningWitnesses > 0, "Bias sweep lacks sensitive acne/panning controls");
    return {
      passed: true,
      configurations: rows.length,
      receiverChecks: rows.length * count,
      rows,
      acneWitnesses,
      panningWitnesses,
      selected: { depth: 1, angular: 1 },
      scope:
        "Analytic planar self/contact coverage, includes actual raster and directional sampler; not arbitrary curved-scene acceptance",
    };
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    await device.queue.onSubmittedWorkDone();
    atlas.destroy();
    resources.forEach((buffer) => buffer.destroy());
  }
}
