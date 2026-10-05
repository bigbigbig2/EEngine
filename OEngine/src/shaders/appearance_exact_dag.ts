import { APPEARANCE_DAG_INSTRUCTION_WORDS, APPEARANCE_DAG_OPS } from "../material/ExactAppearanceDag.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "./appearance_normal_filter.js";

/** One finite kernel body for all published topologies. The owner supplies
 * dag_code/read-only u32, dag_values/lane-private storage, constants/input and
 * exact resident/product sampling callbacks. No workgroup waits or barriers.
 * Values retain separate C/X/Y; only coordinate ancestors evaluate neighbors. */
export const APPEARANCE_EXACT_DAG_WGSL = /* wgsl */ `
${APPEARANCE_NORMAL_FILTER_WGSL}
fn appearance_dag_load(lane: u32, slot: u32) -> vec3f {
  return dag_values[lane + slot].xyz;
}

fn appearance_dag_evaluate(code: u32, count: u32, lane: u32, missing: u32) {
  for (var index = 0u; index < count; index++) {
    let at = code + index * ${APPEARANCE_DAG_INSTRUCTION_WORDS}u;
    let mask = dag_code[at + 5u];
    if (mask & missing) == 0u {
      continue;
    }
    let op = dag_code[at];
    let destination = lane + dag_code[at + 1u];
    let a = dag_code[at + 2u];
    let b = dag_code[at + 3u];
    let c = dag_code[at + 4u];
    let auxiliary = dag_code[at + 6u];
    let control = dag_code[at + 7u];
    let channel = control & 65535u;
    let neighbors = (control >> 16u) != 0u;
    var value = vec3f(0.0);
    switch op {
      case ${APPEARANCE_DAG_OPS.constant}u: {
        value = vec3f(appearance_dag_constant(auxiliary));
      }
      case ${APPEARANCE_DAG_OPS.input}u: {
        value = appearance_dag_input(auxiliary, a, channel, neighbors);
      }
      case ${APPEARANCE_DAG_OPS.sample}u, ${APPEARANCE_DAG_OPS.product}u: {
        if channel != 0u {
          let base = channel - 1u;
          let constant = vec4f(
            appearance_dag_constant(base), appearance_dag_constant(base + 1u),
            appearance_dag_constant(base + 2u), appearance_dag_constant(base + 3u));
          let points = select(1u, 3u, neighbors);
          for (var point = 0u; point < points; point++) {
            dag_values[destination + point] = constant;
          }
          continue;
        }
        let u = appearance_dag_load(lane, a);
        let v = appearance_dag_load(lane, b);
        let dx = vec2f(u.y - u.x, v.y - v.x);
        let dy = vec2f(u.z - u.x, v.z - v.x);
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          let uv = vec2f(u[point], v[point]);
          if op == ${APPEARANCE_DAG_OPS.sample}u {
            dag_values[destination + point] = appearance_dag_sample(auxiliary, uv, dx, dy);
          } else {
            dag_values[destination + point] = appearance_dag_product(auxiliary, uv, dx, dy);
          }
        }
        continue;
      }
      case ${APPEARANCE_DAG_OPS.channel}u, ${APPEARANCE_DAG_OPS.normal}u: {
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          let sample = dag_values[lane + a + point];
          if op == ${APPEARANCE_DAG_OPS.channel}u {
            value[point] = sample[channel];
          } else {
            let normal = appearance_decode_normal_moment(sample.xyz);
            if channel < 3u {
              value[point] = normal.normal[channel];
            } else if channel == 3u {
              value[point] = normal.roughness;
            } else {
              value[point] = f32(normal.direction_valid);
            }
          }
        }
      }
      default: {
        let av = appearance_dag_load(lane, a);
        let bv = appearance_dag_load(lane, b);
        let cv = appearance_dag_load(lane, c);
        switch op {
          case ${APPEARANCE_DAG_OPS.add}u: { value = av + bv; }
          case ${APPEARANCE_DAG_OPS.subtract}u: { value = av - bv; }
          case ${APPEARANCE_DAG_OPS.multiply}u: { value = av * bv; }
          case ${APPEARANCE_DAG_OPS.divide}u: { value = av / bv; }
          case ${APPEARANCE_DAG_OPS.min}u: { value = min(av, bv); }
          case ${APPEARANCE_DAG_OPS.max}u: { value = max(av, bv); }
          case ${APPEARANCE_DAG_OPS.pow}u: { value = pow(av, bv); }
          case ${APPEARANCE_DAG_OPS.sin}u: { value = sin(av); }
          case ${APPEARANCE_DAG_OPS.cos}u: { value = cos(av); }
          case ${APPEARANCE_DAG_OPS.abs}u: { value = abs(av); }
          case ${APPEARANCE_DAG_OPS.sqrt}u: { value = sqrt(av); }
          case ${APPEARANCE_DAG_OPS.mix}u: { value = av * (vec3f(1.0) - cv) + bv * cv; }
          case ${APPEARANCE_DAG_OPS.clamp}u: { value = clamp(av, bv, cv); }
          default: {}
        }
      }
    }
    dag_values[destination] = vec4f(value, 0.0);
  }
}
`;
