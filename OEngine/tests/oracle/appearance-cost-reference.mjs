import { FIXED_SURFACE_SAMPLE_COUNT } from "../../.test-dist/material/FixedSurfaceFormulas.js";
import { surfaceFixedFormulasWgsl } from "../../.test-dist/shaders/surface_fixed_formulas.js";
import { GPU_TEXTURE_BANK_COUNT } from "../../.test-dist/gpu/GpuTextureRefAbi.js";

export function fullChannelGatherCostReference(source) {
  const current = "value[point] = appearance_dag_component(lane, a + point * 4u, slot_stride, channel);";
  if (!source.includes(current)) {
    throw new Error("channel reference requires the current production scalar accessor");
  }
  return source.replace(
    current,
    /* wgsl */ `
          let sample = appearance_dag_sample_value(lane, a + point * 4u, slot_stride);
          value[point] = sample[channel];`
  );
}

export function residentSamplerCostReference(source, sampler) {
  if (!Number.isInteger(sampler) || sampler < 0 || sampler >= 6) {
    throw new RangeError("reference sampler must belong to the original six classes");
  }
  const begin = source.indexOf("fn dag_sample_resident(");
  const end = source.indexOf("fn dag_transform_uv(");
  if (begin < 0 || end <= begin) {
    throw new Error("resident reference requires the original complete routing boundary");
  }
  const branches = Array.from(
    { length: GPU_TEXTURE_BANK_COUNT },
    (_value, bank) => /* wgsl */ `
    case ${bank}u: {
      return oengine_sample_texture_clamped(dag_texture_${bank}, dag_sampler_${sampler},
        route.x, route.y, uv, i32(oengine_texture_ref_layer(route.x)), dx, dy);
    }`
  ).join("\n");
  return (
    source.slice(0, begin) +
    /* wgsl */ `
fn dag_sample_resident(route: vec2u, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  switch oengine_texture_ref_bank(route.x) {
    ${branches}
    default: { return vec4f(0.0); }
  }
}
` +
    source.slice(end)
  );
}

/** Isolated representation candidate, never imported by production. Keep all
 * field formulas, original sampling and decode unchanged. Named private values
 * avoid a dynamically indexed private array, but do not promise register residence.
 * The full native reference still uses production Geometry and all consumers. */
export function fixedPrivateScratchReference(source) {
  const original = surfaceFixedFormulasWgsl();
  const declarations = Array.from(
    { length: FIXED_SURFACE_SAMPLE_COUNT },
    (_value, slot) => `var<private> fixed_reference_${slot}: FixedReferenceSample;`
  ).join("\n");
  const stores = Array.from(
    { length: FIXED_SURFACE_SAMPLE_COUNT },
    (_value, slot) => `case ${slot}u: { fixed_reference_${slot} = result; }`
  ).join("\n");
  const loads = Array.from(
    { length: FIXED_SURFACE_SAMPLE_COUNT },
    (_value, slot) => `case ${slot}u: { return fixed_reference_${slot}; }`
  ).join("\n");
  const helpers = /* wgsl */ `
struct FixedReferenceSample {
  raw: vec4f,
  decoded: vec4f,
  valid: f32,
}
${declarations}
fn fixed_store_sample(index: u32, value: vec4f, decoded: vec4f, valid: f32) {
  let result = FixedReferenceSample(value, decoded, valid);
  switch index {
    ${stores}
    default: {}
  }
}
fn fixed_reference_sample(index: u32) -> FixedReferenceSample {
  switch index {
    ${loads}
    default: { return FixedReferenceSample(vec4f(0.0), vec4f(0.0), 0.0); }
  }
}
fn fixed_reference_component(index: u32, channel: u32, decoded: bool) -> f32 {
  let sample = fixed_reference_sample(index);
  if decoded {
    if channel == 4u { return sample.valid; }
    return fixed_component(sample.decoded, channel);
  }
  return fixed_component(sample.raw, channel);
}
`;
  const begin = original.indexOf("fn fixed_store_sample(");
  const end = original.indexOf("fn fixed_leaf(");
  if (begin < 0 || end <= begin || !source.includes(original)) {
    throw new Error("fixed reference requires the current complete production formula body");
  }
  const replacement = (original.slice(0, begin) + helpers + original.slice(end))
    .replace(
      "return dag_values[((value >> 3u) * 9u + channel) * settings.lanes + fixed_lane];",
      "return fixed_reference_component(value >> 3u, channel, false);"
    )
    .replace("return dag_values[at];", "return fixed_reference_component(value >> 3u, channel, true);");
  if (replacement.includes("dag_values[")) {
    throw new Error("fixed private reference must remove every sample scratch access");
  }
  return source.replace(original, replacement);
}
