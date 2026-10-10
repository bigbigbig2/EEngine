import { PHYSICAL_SKY_DFG_WGSL } from "../../.test-dist/shaders/physical_sky_ibl.js";
import { ENVIRONMENT_BRDF_WGSL } from "../../.test-dist/shaders/native_environment_brdf.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

// Independent CPU integration of the complete Schlick / correlated-Smith BRDF.
// This sums reflection directly; it never authors or interprets Fc/Total channels.
function integrateReflection(noV, perceptualRoughness, f0) {
  const alphaSquared = Math.max(perceptualRoughness ** 2, 1e-4) ** 2;
  const view = [Math.sqrt(1 - noV * noV), 0, noV];
  let sum = 0;
  for (let i = 0; i < 1024; i++) {
    let bits = i,
      radical = 0,
      scale = 0.5;
    while (bits) {
      radical += (bits & 1) * scale;
      scale *= 0.5;
      bits >>>= 1;
    }
    const phi = (2 * Math.PI * i) / 1024;
    const hz = Math.sqrt((1 - radical) / (1 + (alphaSquared - 1) * radical));
    const hx = Math.cos(phi) * Math.sqrt(1 - hz * hz);
    const voH = Math.max(0, Math.min(1, view[0] * hx + noV * hz));
    const noL = Math.max(0, 2 * voH * hz - noV);
    if (noL === 0) continue;
    const visibility =
      0.5 /
      (noL * Math.sqrt(noV * noV * (1 - alphaSquared) + alphaSquared) +
        noV * Math.sqrt(noL * noL * (1 - alphaSquared) + alphaSquared));
    const fresnel = f0 + (1 - f0) * (1 - voH) ** 5;
    sum += ((4 * visibility * noL * voH) / hz) * fresnel;
  }
  return sum / 1024;
}

export async function runSkyIblDfgGpuOracle(device) {
  const resources = [];
  const texture = device.createTexture({
    size: [64, 64],
    format: "rgba16float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  resources.push(texture);
  const producer = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: PHYSICAL_SKY_DFG_WGSL }), entryPoint: "dfg" },
  });
  const cases = [];
  for (const x of [63, 32, 2])
    for (const y of [2, 32, 63])
      for (const f0 of [0.04, 1, 0]) {
        cases.push({ noV: (x + 0.5) / 64, roughness: (y + 0.5) / 64, f0 });
      }
  for (const [noV, roughness] of [
    [0, 0],
    [1, 1],
    [0.51, 0.47],
    [0.02, 0.99],
  ]) {
    cases.push({ noV, roughness, f0: 0.04 });
  }
  const input = device.createBuffer({
    size: cases.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(input, 0, new Float32Array(cases.flatMap((c) => [c.noV, c.roughness, c.f0, 0])));
  const output = device.createBuffer({
    size: cases.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const staging = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  resources.push(input, output, staging);
  const consumer = device.createComputePipeline({
    layout: "auto",
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
${ENVIRONMENT_BRDF_WGSL}
@group(0) @binding(0) var lut: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> cases: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = cases[id.x];
  let dfg = sample_environment_dfg(lut, c.x, c.y);
  results[id.x] = vec4f(environment_dfg_single_scatter(dfg, vec3f(c.z)), environment_clearcoat_fresnel(c.x, 1.0));
}`,
      }),
    },
  });
  try {
    const encoder = device.createCommandEncoder();
    const p = encoder.beginComputePass();
    p.setPipeline(producer);
    p.setBindGroup(
      0,
      device.createBindGroup({
        layout: producer.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
      }),
    );
    p.dispatchWorkgroups(8, 8);
    p.end();
    const c = encoder.beginComputePass();
    c.setPipeline(consumer);
    c.setBindGroup(
      0,
      device.createBindGroup({
        layout: consumer.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: input } },
          { binding: 2, resource: { buffer: output } },
        ],
      }),
    );
    c.dispatchWorkgroups(cases.length);
    c.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const actual = Array.from(new Float32Array(staging.getMappedRange()));
    staging.unmap();
    const result = cases.map((c, i) => {
      // Independent continuous-coordinate reference: evaluate the full BRDF
      // at the four surrounding LUT centres, then interpolate that integral.
      const px = c.noV * 64 - 0.5,
        py = c.roughness * 64 - 0.5;
      const x = Math.floor(px),
        y = Math.floor(py),
        fx = px - x,
        fy = py - y;
      const sample = (ix, iy) =>
        integrateReflection(
          (Math.max(0, Math.min(63, ix)) + 0.5) / 64,
          (Math.max(0, Math.min(63, iy)) + 0.5) / 64,
          c.f0,
        );
      const expected =
        (sample(x, y) * (1 - fx) + sample(x + 1, y) * fx) * (1 - fy) +
        (sample(x, y + 1) * (1 - fx) + sample(x + 1, y + 1) * fx) * fy;
      // FP16 channel rounding plus f32 integration; no scene-specific tolerance.
      check(
        Math.abs(actual[i * 4] - expected) <= 0.002 * Math.abs(expected) + 0.00015,
        `DFG ${JSON.stringify(c)}: ${actual[i * 4]} vs ${expected}`,
      );
      check(Math.abs(actual[i * 4 + 3] - (0.04 + 0.96 * (1 - c.noV) ** 5)) < 1e-6, "coat Fresnel");
      return { ...c, actual: actual[i * 4], expected };
    });
    check(
      Math.abs(result[0].actual - 0.04) < 0.001,
      "IOR 1.5 dielectric must reflect approximately 4%, not 100%",
    );
    return {
      cases: result,
      producer: "PHYSICAL_SKY_DFG_WGSL",
      consumer: "ENVIRONMENT_BRDF_WGSL",
      singleScatter: true,
    };
  } finally {
    resources.forEach((r) => r.destroy());
  }
}
