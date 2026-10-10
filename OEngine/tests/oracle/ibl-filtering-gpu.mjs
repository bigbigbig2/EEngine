import assert from "node:assert/strict";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "../../.test-dist/shaders/native_environment_sample.js";
import { ENVIRONMENT_BRDF_WGSL } from "../../.test-dist/shaders/native_environment_brdf.js";
import { PHYSICAL_SKY_DFG_WGSL } from "../../.test-dist/shaders/physical_sky_ibl.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";
import { MANUAL_OCT_WGSL, MANUAL_DFG_WGSL } from "./fixtures/ibl-manual-reference.mjs";

function referenceSource(source) {
  const names = [...source.matchAll(/fn (\w+)\(/g)].map(m => m[1]);
  for (const name of names) source = source.replace(new RegExp(`\\b${name}\\b`, "g"), `reference_${name}`);
  return source.replace(/override OENGINE_SURFACE_NORMAL_MAX_VALUE[^;]+;/g, "");
}

export async function runIblFilteringGpuOracle(device) {
  const owned = [];
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "nearest" });
  const dfgProducer = await device.createComputePipelineAsync({ layout: "auto", compute: {
    module: device.createShaderModule({ code: PHYSICAL_SKY_DFG_WGSL }), entryPoint: "dfg",
  } });
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: {
    entryPoint: "main", module: device.createShaderModule({ code: `
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
${ENVIRONMENT_BRDF_WGSL}
${referenceSource(MANUAL_OCT_WGSL)}
${referenceSource(MANUAL_DFG_WGSL)}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(0) @binding(2) var linear_clamp: sampler;
@group(0) @binding(3) var<storage, read> cases: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&cases)) { return; }
  let c = cases[id.x];
  let uv = oct_encode(c.xyz);
  results[id.x * 4u] = vec4f(sample_native_environment(source, c.xyz, c.w), 1.0);
  results[id.x * 4u + 1u] = vec4f(reference_sample_prefiltered_environment(source, c.xyz, c.w), 1.0);
  results[id.x * 4u + 2u] = vec4f(sample_environment_dfg(lut, linear_clamp, uv.x, c.w), 0.0, 1.0);
  results[id.x * 4u + 3u] = vec4f(reference_sample_environment_dfg(lut, uv.x, c.w), 0.0, 1.0);
}` }) } });
  const groups = [];
  try {
    for (const size of [1, 3, 7, 32, 128]) for (const pattern of ["smooth", "bright-point", "plateau"]) {
      const levels = 1 + Math.floor(Math.log2(size));
      const texture = device.createTexture({ size: [size, size], mipLevelCount: levels, format: "rgba16float",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING }); owned.push(texture);
      for (let level = 0; level < levels; level++) {
        const n = Math.max(1, size >> level), data = new Uint16Array(n * n * 4);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let c = 0; c < 4; c++) {
          const value = pattern === "bright-point" ? (x === (n >> 1) && y === (n >> 1) ? 2048 : 0) :
            pattern === "plateau" ? 2048 : .1 + (x + y * .5 + level) / Math.max(n, 1) * (c + 1);
          data[(y * n + x) * 4 + c] = floatToHalf(c === 3 ? 1 : value);
        }
        device.queue.writeTexture({ texture, mipLevel: level }, data, { bytesPerRow: n * 8 }, [n, n]);
      }
      const lut = device.createTexture({ size: [64, 64], format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING }); owned.push(lut);
      const cases = [];
      const decode = (u, v) => {
        let x = 2 * u - 1, y = 2 * v - 1, z = 1 - Math.abs(x) - Math.abs(y);
        const t = Math.max(-z, 0); x += x > 0 ? -t : t; y += y > 0 ? -t : t;
        return [x, y, z];
      };
      const coords = [0, -0, 1e-7, .5 / size, 1 / size, .37123, .5, .5 + .137 / size, 1 - .5 / size, 1 - 1e-7, 1];
      for (const u of coords) for (const v of coords) for (const roughness of [0, .0001, .137, .5, .9999, 1]) {
        cases.push([...decode(u, v), roughness]);
      }
      cases.push([0, 0, 1, 0], [0, -0, -1, 0], [1, 0, 0, 1], [0, 1, -0, .5]);
      // Actual Fc/Total producer, dense first-texel/grazing region and arbitrary
      // subtexel coordinates. Keep the pre-existing tolerance fixed.
      for (let i = 0; i < 73; i++) for (let j = 0; j < 29; j++) {
        const u = i < 37 ? (i + .137) / (37 * 32) : (i - 37 + .379) / 36;
        cases.push([...decode(u, .5), (j + .371) / 29]);
      }
      const input = device.createBuffer({ size: cases.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE });
      const output = device.createBuffer({ size: cases.length * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const read = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      owned.push(input, output, read);
      device.queue.writeBuffer(input, 0, new Float32Array(cases.flat()));
      const encoder = device.createCommandEncoder();
      const producer = encoder.beginComputePass(); producer.setPipeline(dfgProducer);
      producer.setBindGroup(0, device.createBindGroup({ layout: dfgProducer.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: lut.createView() }] })); producer.dispatchWorkgroups(8, 8); producer.end();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView() }, { binding: 1, resource: lut.createView() },
        { binding: 2, resource: sampler }, { binding: 3, resource: { buffer: input } }, { binding: 4, resource: { buffer: output } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(cases.length / 64)); pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, output.size); device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ); const values = new Float32Array(read.getMappedRange());
      let maximumError = 0;
      for (let i = 0; i < cases.length; i++) for (const base of [0, 8]) for (let c = 0; c < (base === 0 ? 3 : 2); c++) {
        const actual = values[i * 16 + base + c], expected = values[i * 16 + base + 4 + c];
        const error = Math.abs(actual - expected); maximumError = Math.max(maximumError, error);
        if (base === 0) {
          assert.equal(new Uint32Array(values.buffer)[i * 16 + c], new Uint32Array(values.buffer)[i * 16 + 4 + c],
            `radiance bits ${size}/${pattern} case${i} channel${c}`);
        }
        assert.ok(Number.isFinite(actual) && error <= Math.max(.001, Math.abs(expected) * .002),
          `${size}/${pattern} case${i} ${cases[i]} component${base + c}: ${actual} vs ${expected} error ${error}`);
      }
      read.unmap(); groups.push({ size, pattern, cases: cases.length, maximumError });
      // Each group is independent; release early rather than inflate test peak.
      for (const resource of owned.splice(0)) resource.destroy();
    }
    return { status: "passed", groups, tolerance: "unchanged Native max(.001, abs(reference)*.002)" };
  } finally { await device.queue.onSubmittedWorkDone(); for (const r of owned) r.destroy(); }
}
