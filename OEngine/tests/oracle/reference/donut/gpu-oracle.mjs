import assert from "node:assert/strict";
import { NATIVE_TEMPORAL_V2_RESOLVE_WGSL } from "./taa-shader.mjs";
import { floatToHalf } from "../../../../.test-dist/loaders/float16.js";
import { resolvePixel, pqEncode } from "./taa-reference.mjs";
export async function verifyDonutSource(device, buffer, texture) {
  const width = 23,
    height = 13,
    count = width * height;
  const frame = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const exposure = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const color = texture(width, height, "rgba32float");
  const seed = texture(width, height, "rgba32float");
  const feedback = texture(width, height, "rgba32float");
  const analysis = texture(width, height, "rgba16float");
  const output = texture(width, height, "rgba32float", GPUTextureUsage.STORAGE_BINDING);
  const hdr = texture(width, height, "rgba16float", GPUTextureUsage.STORAGE_BINDING);
  const values = buffer(count * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const target = buffer(count * 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: NATIVE_TEMPORAL_V2_RESOLVE_WGSL }),
      entryPoint: "main",
    },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frame } },
      { binding: 1, resource: color.createView() },
      { binding: 2, resource: seed.createView() },
      { binding: 3, resource: feedback.createView() },
      { binding: 5, resource: { buffer: exposure } },
      { binding: 7, resource: analysis.createView() },
      { binding: 8, resource: output.createView() },
      { binding: 9, resource: hdr.createView() },
    ],
  });
  const reader = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var pq: texture_2d<f32>;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let s = textureDimensions(pq);
  if (id.x >= s.x * s.y) { return; }
  let p = vec2i(vec2u(id.x % s.x, id.x / s.x));
  out[id.x * 2u] = textureLoad(pq, p, 0);
  out[id.x * 2u + 1u] = textureLoad(hdr, p, 0);
}`,
      }),
      entryPoint: "main",
    },
  });
  const readGroup = device.createBindGroup({
    layout: reader.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: output.createView() },
      { binding: 1, resource: hdr.createView() },
      { binding: 2, resource: { buffer: values } },
    ],
  });
  const scenarios = [
    { jitter: [0, 0], motion: [0, 0], exposure: 1, valid: false },
    { jitter: [0.49, -0.49], motion: [0, 0], exposure: 0.25, valid: true },
    { jitter: [-0.49, 0.49], motion: [0.375, -0.25], exposure: 4, valid: true },
    { jitter: [2.7, -1.2], motion: [-1.25, 0.75], exposure: 1, valid: true },
    { jitter: [-1.3, 2.4], motion: [0.5, 0.25], exposure: 0.25, valid: true, reactive: 1 },
    { jitter: [0.25, -0.25], motion: [-0.375, 0.125], exposure: 1, valid: true, coverage: 0.5 },
    { jitter: [0.49, 0.49], motion: [0, 0], exposure: 0.25, valid: true, uniform: 8192 },
    { jitter: [0, 0], motion: [0, 0], exposure: 1e-4, valid: false, uniform: 1e8 },
  ];
  let maximumPqError = 0,
    maximumHdrError = 0;
  for (const scenario of scenarios) {
    const priorJitter = [-0.125, 0.125];
    const bytes = new ArrayBuffer(32);
    new Uint32Array(bytes).set([width, height, Number(scenario.valid), 0]);
    new Float32Array(bytes).set([...scenario.jitter, ...priorJitter], 4);
    device.queue.writeBuffer(frame, 0, bytes);
    device.queue.writeBuffer(exposure, 0, new Float32Array([scenario.exposure, 0, 0, 0]));
    const colors = new Float32Array(count * 4),
      prior = new Float32Array(count * 4);
    const facts = new Float32Array(count * 4),
      masks = new Uint16Array(count * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = scenario.uniform ?? (x === 11 ? 128 : 0.125 + 0.04 * x + 0.025 * y);
          colors[i + c] = v * [1, 0.8, 0.3][c] * scenario.exposure;
          prior[i + c] = pqEncode((0.2 + 0.05 * x + 0.03 * y) * [1, 0.8, 0.3][c]);
        }
        facts.set(
          [
            (scenario.motion[0] + scenario.jitter[0] - priorJitter[0]) / width,
            (scenario.motion[1] + scenario.jitter[1] - priorJitter[1]) / height,
            2,
            2,
          ],
          i,
        );
        masks.set([floatToHalf(scenario.coverage ?? 1), floatToHalf(scenario.reactive ?? 0), 0, 0], i);
      }
    for (const [tex, data, stride] of [
      [color, colors, 16],
      [feedback, prior, 16],
      [seed, facts, 16],
      [analysis, masks, 8],
    ])
      device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: width * stride }, [width, height]);
    const encoder = device.createCommandEncoder();
    for (const [p, g, nx, ny] of [
      [pipeline, group, Math.ceil(width / 8), Math.ceil(height / 8)],
      [reader, readGroup, Math.ceil(count / 64), 1],
    ]) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(p);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(nx, ny);
      pass.end();
    }
    encoder.copyBufferToBuffer(values, 0, target, 0, count * 32);
    device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(target.getMappedRange());
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const expected = resolvePixel({
          ...scenario,
          color: colors,
          feedback: prior,
          width,
          height,
          x,
          y,
          coverage: scenario.coverage ?? 1,
          reactive: scenario.reactive ?? 0,
        });
        const i = (y * width + x) * 8;
        assert.equal(result[i + 3], 0, "source feedback alpha is not confidence");
        assert.equal(result[i + 7], 1, "linear HDR alpha must be opaque");
        for (let c = 0; c < 3; c++) {
          const pqError = Math.abs(result[i + c] - expected.pq[c]);
          const hdrError = Math.abs(result[i + 4 + c] - expected.hdr[c]) / Math.max(1e-4, expected.hdr[c]);
          maximumPqError = Math.max(maximumPqError, pqError);
          maximumHdrError = Math.max(maximumHdrError, hdrError);
          assert.ok(pqError <= 2e-5, `source PQ ${x},${y}/${c}: ${pqError}`);
          assert.ok(hdrError <= 0.003, `source HDR ${x},${y}/${c}: ${hdrError}`);
        }
      }
    target.unmap();
  }
  return {
    revision: "e50042f4bbd762971cc90431261e967404855b81",
    scenarios: scenarios.length,
    pixels: scenarios.length * count,
    maximumPqError,
    maximumHdrError,
    profile: "single-sample, Catmull-Rom, 3x3 variance clamp, PQ feedback, source default 0.1 weight",
  };
}

