import { LIGHTING_BRDF_TYPES_WGSL, LIGHTING_BRDF_MATH_WGSL } from "../../.test-dist/shaders/lighting_brdf.js";
import { LIGHTING_BRDF_MATH_WGSL as FROZEN_BRDF } from "./reference/s3/lighting_brdf.mjs";

const check = (value, message) => {
  if (!value) throw new Error(message);
};

/** Compare separated invocation-private factors to immutable pre-refactor math.
 * Exact factors/order/combined finite guard are required, including HDR where
 * rejecting unshadowed overflow before visibility would lose valid lighting. */
export async function runFinalPixelSunResponseGpuOracle(device) {
  const cases = [];
  for (const roughness of [0.04, 0.2, 0.5, 1]) {
    for (const direction of [
      [0, 0, 1],
      [0.8, 0, 0.6],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -0.8],
    ]) {
      for (const coat of [0, 0.25, 1]) {
        for (const hdr of [0, 0.5, 128, 8192, 1e20, 1e38]) {
          for (const visibility of [0, 1 / 16, 0.5, 1, 1e-30]) {
            for (const diffuse of [0.6, 1e20]) {
              cases.push(
                0,
                0,
                1,
                roughness,
                0.3,
                0,
                Math.sqrt(0.91),
                coat,
                ...direction,
                roughness,
                diffuse,
                diffuse * 0.5,
                diffuse * 0.25,
                visibility,
                0.04,
                0.1,
                0.6,
                0,
                0,
                0.6,
                0.8,
                0,
                hdr,
                hdr * 0.5,
                hdr * 0.25,
                0,
                1,
                1,
                1,
                0,
              );
            }
          }
        }
      }
    }
  }
  const input = new Float32Array(cases),
    count = input.length / 32;
  const resources = [];
  const buffer = (size, usage, initial) => {
    const result = device.createBuffer({
      label: "Sun response numeric",
      size,
      usage,
      mappedAtCreation: initial !== undefined,
    });
    resources.push(result);
    if (initial !== undefined) {
      new Uint8Array(result.getMappedRange()).set(new Uint8Array(initial.buffer));
      result.unmap();
    }
    return result;
  };
  try {
    const source = buffer(input.byteLength, GPUBufferUsage.STORAGE, input);
    const output = buffer(count * 112, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const frozen = FROZEN_BRDF.replace(
      /\b(D_GGX|V_GGX_SmithCorrelated|F_Schlick|BRDF_GGX|finite_f32|re_direct_physical)\b/g,
      (name) => `frozen_${name}`,
    );
    const module = device.createShaderModule({
      label: "Sun response vs frozen BRDF",
      code: `
const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const EPSILON: f32 = 1e-6;
fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${LIGHTING_BRDF_TYPES_WGSL}
${LIGHTING_BRDF_MATH_WGSL}
${frozen}
@group(0) @binding(0) var<storage, read> cases: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let base = id.x * 8u;
  if (base >= arrayLength(&cases)) { return; }
  let geometry = SurfaceGeometry(cases[base].xyz, vec3f(0.0, 0.0, 1.0), vec3f(0.0), cases[base + 1u].xyz);
  var material: StandardMaterial;
  material.roughness = cases[base].w;
  material.diffuse = cases[base + 3u].xyz;
  material.specularF0 = cases[base + 4u].xyz;
  material.specularF90 = 1.0;
  material.energyCompensation = cases[base + 7u].xyz;
  material.coatFactor = cases[base + 1u].w;
  material.coatRoughness = cases[base + 2u].w;
  material.coatNormal = cases[base + 5u].xyz;
  let direction = cases[base + 2u].xyz;
  let visibility = cases[base + 3u].w;
  let irradiance = cases[base + 6u].xyz;
  let response = prepare_direct_physical(direction, geometry, material);
  var actual: ReflectedLight;
  if (direct_physical_can_contribute(response)) {
    apply_direct_physical(irradiance * visibility, response, &actual);
  }
  var reference: ReflectedLight;
  frozen_re_direct_physical(GpuPrimitiveTypeTable(direction, irradiance * visibility), geometry, material, &reference);
  var unshadowed: ReflectedLight;
  frozen_re_direct_physical(GpuPrimitiveTypeTable(direction, irradiance), geometry, material, &unshadowed);
  output[id.x * 7u] = vec4f(actual.diffuse + actual.specular, select(0.0, 1.0, direct_physical_can_contribute(response)));
  output[id.x * 7u + 1u] = vec4f(reference.diffuse + reference.specular, 0.0);
  output[id.x * 7u + 2u] = vec4f(unshadowed.diffuse + unshadowed.specular, 0.0);
  output[id.x * 7u + 3u] = vec4f(actual.diffuse, 0.0);
  output[id.x * 7u + 4u] = vec4f(reference.diffuse, 0.0);
  output[id.x * 7u + 5u] = vec4f(actual.specular, 0.0);
  output[id.x * 7u + 6u] = vec4f(reference.specular, 0.0);
}`,
    });
    const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
    check(errors.length === 0, errors.map((message) => message.message).join("\n"));
    const pipeline = await device.createComputePipelineAsync({
      label: "Sun response numeric",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const bindings = device.createBindGroup({
      label: "Sun response numeric",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: "Sun response numeric" });
    const pass = encoder.beginComputePass({ label: "Sun response numeric" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    let overflowWitnesses = 0,
      nonfiniteReferenceChannels = 0,
      skippedCases = 0,
      coatOnlyCases = 0;
    for (let index = 0; index < count; index++) {
      if (values[index * 28 + 3] === 0) skippedCases++;
      if (input[index * 32 + 10] === 0 && input[index * 32 + 9] > 0 && input[index * 32 + 7] > 0) {
        check(values[index * 28 + 3] === 1, "Coat-only direct lighting was incorrectly culled");
        coatOnlyCases++;
      }
      for (let channel = 0; channel < 3; channel++) {
        // The original sums can themselves overflow outside the finite guard.
        // Preserve that classification rather than tightening its input domain.
        for (const offset of [0, 12, 20]) {
          const actual = values[index * 28 + offset + channel],
            expected = values[index * 28 + offset + 4 + channel];
          check(
            actual === expected || (Number.isNaN(actual) && Number.isNaN(expected)),
            `Sun response differs at case ${index}/${offset}/${channel}: ${actual} vs ${expected}`,
          );
        }
        const expected = values[index * 28 + 4 + channel];
        if (!Number.isFinite(expected)) nonfiniteReferenceChannels++;
        if (Number.isFinite(expected) && expected > 0 && values[index * 28 + 8 + channel] === 0)
          overflowWitnesses++;
      }
    }
    check(overflowWitnesses > 0, "HDR guard negative control did not exercise restored finite lighting");
    check(skippedCases > 0 && coatOnlyCases > 0, "Missing zero-contribution/coat-only coverage");
    readback.unmap();
    return {
      cases: count,
      skippedCases,
      coatOnlyCases,
      exact: true,
      overflowWitnesses,
      nonfiniteReferenceChannels,
      reference: "8db2c82b frozen direct BRDF",
    };
  } finally {
    for (const resource of resources) resource.destroy();
  }
}
