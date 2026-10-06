import { APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";
import {
  FIXED_SURFACE_SAMPLE_COUNT,
  FIXED_SURFACE_SAMPLE_WORDS,
  FIXED_SURFACE_PLAN_WORDS,
  FIXED_SURFACE_FIELDS_BASE,
  FIXED_SURFACE_FIELD_WORDS
} from "../material/FixedSurfaceFormulas.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "./appearance_normal_filter.js";

/** Exact Fixed Surface Formulas. All output expressions are
 * fixed at renderer build time. Bounded Q-lane SoA scratch holds sampled values.
 * Publication supplies leaf references, factors
 * and formula options; there is no instruction loop or dynamic temporary array. */
export function surfaceFixedFormulasWgsl(): string {
  const vectorFields = APPEARANCE_FIELD_WIDTHS.reduce(
    (mask, width, field) => mask | (width === 3 ? 1 << field : 0),
    0
  );
  return /* wgsl */ `
${APPEARANCE_NORMAL_FILTER_WGSL}
var<private> fixed_lane: u32;
fn fixed_component(value: vec4f, channel: u32) -> f32 {
  switch channel {
    case 0u: { return value.x; }
    case 1u: { return value.y; }
    case 2u: { return value.z; }
    default: { return value.w; }
  }
}
fn fixed_store_sample(index: u32, value: vec4f, decoded: vec4f, valid: f32) {
  let at = index * 9u * settings.lanes + fixed_lane;
  for (var channel = 0u; channel < 4u; channel++) {
    dag_values[at + channel * settings.lanes] = value[channel];
    dag_values[at + (4u + channel) * settings.lanes] = decoded[channel];
  }
  dag_values[at + 8u * settings.lanes] = valid;
}
fn fixed_leaf(reference: u32) -> f32 {
  let value = reference & 0x0fffffffu;
  switch reference >> 28u {
    case 0u: { return appearance_dag_constant(value); }
    case 1u: { return fixed_component(geometry_input(value >> 8u, 0u), value & 255u); }
    case 2u: {
      let channel = value & 7u;
      return dag_values[((value >> 3u) * 9u + channel) * settings.lanes + fixed_lane];
    }
    case 3u: {
      let channel = value & 7u;
      let at = ((value >> 3u) * 9u + 4u + channel) * settings.lanes + fixed_lane;
      return dag_values[at];
    }
    case 5u: { return appearance_dag_uniform(value); }
    default: {
      return bitcast<f32>(dag_metadata[settings.inputs +
        (dag_code[dag_entry + 7u] + (value >> 8u)) * 4u + (value & 255u)]);
    }
  }
}
fn fixed_field_value(at: u32, field: u32) -> f32 {
  let option = dag_code[at];
  let a = fixed_leaf(dag_code[at + 1u]);
  if option == 0u { return a; }
  if option == 7u { return clamp(a, 0.0, 1.0); }
  if option == 6u { return a * 2.0 - 1.0; }
  let b = fixed_leaf(dag_code[at + 2u]);
  // Direct scale is common to scalar factors, emissive, color and coat fields.
  if option == 1u { return a * b; }
  if field == 0u {
    return (a * b) * fixed_leaf(dag_code[at + 3u]);
  }
  if field == 2u || field == 3u {
    return clamp(a * b, 0.0, 1.0);
  }
  if field == 4u {
    let weight = fixed_leaf(dag_code[at + 3u]);
    return a * (1.0 - weight) + b * weight;
  }
  // Signed tangent-space normal preserves multiply/subtract/scale order.
  let signed = a * 2.0 - 1.0;
  return select(signed, signed * b, option == 5u);
}
fn fixed_surface_evaluate(lane: u32, missing: u32) {
  fixed_lane = lane;
  let plan = dag_code[dag_entry] - ${FIXED_SURFACE_PLAN_WORDS}u;
  // One sampling call site prevents duplicating the finite bank/sampler switch
  // once per possible sample. The publication proves this bounded count.
  for (var index = 0u; index < dag_code[plan + ${FIXED_SURFACE_PLAN_WORDS - 1}u]; index++) {
    let at = plan + index * ${FIXED_SURFACE_SAMPLE_WORDS}u;
    if (dag_code[at + 3u] & missing) == 0u { continue; }
    let descriptor = dag_code[at];
    let source = dag_code[at + 1u];
    let semantic = dag_code[at + 2u];
    let center = geometry_input(semantic, 0u).xy;
    let dx = geometry_input(semantic, 1u).xy - center;
    let dy = geometry_input(semantic, 2u).xy - center;
    var value = vec4f(0.0);
    switch descriptor & 255u {
      case 0u: { value = appearance_dag_sample(source, center, dx, dy); }
      case 1u: { value = appearance_dag_product(source, center, dx, dy); }
      default: {
        for (var channel = 0u; channel < (descriptor >> 16u); channel++) {
          value[channel] = appearance_dag_constant(source + channel);
        }
      }
    }
    var normal = vec4f(0.0);
    var valid = 0.0;
    if (descriptor & 256u) != 0u {
      let decoded = appearance_decode_normal_moment(value.xyz);
      normal = vec4f(decoded.normal, decoded.roughness);
      valid = f32(decoded.direction_valid);
    }
    fixed_store_sample(index, value, normal, valid);
  }
  // Iterate the fixed consumer fields, never authored instructions or slots.
  for (var field = 0u; field < 15u; field++) {
    if (missing & (1u << field)) == 0u { continue; }
    let channels = select(1u, 3u, (${vectorFields}u & (1u << field)) != 0u);
    let ordinal = field + 2u * countOneBits(${vectorFields}u & ((1u << field) - 1u));
    for (var channel = 0u; channel < channels; channel++) {
      let at = plan + ${FIXED_SURFACE_FIELDS_BASE}u + (ordinal + channel) * ${FIXED_SURFACE_FIELD_WORDS}u;
      appearance_dag_output(field, channel, fixed_field_value(at, field));
    }
  }
}
`;
}
