import { APPEARANCE_DAG_INSTRUCTION_WORDS, APPEARANCE_DAG_OPS } from "../material/ExactAppearanceDag.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "./appearance_normal_filter.js";

/** One finite kernel body for all published topologies. The owner supplies
 * dag_code/read-only u32, dag_values/lane-private storage, constants/input and
 * exact resident/product sampling callbacks. No workgroup waits or barriers.
 * Values retain separate C/X/Y; only coordinate ancestors evaluate neighbors. */
export const APPEARANCE_EXACT_DAG_WGSL = /* wgsl */ `
${APPEARANCE_NORMAL_FILTER_WGSL}
// Global context owns every word in its slice until the item finishes. There
// are no shared instruction windows, barriers or implicit vec4 padding.
fn appearance_dag_component(lane: u32, slot: u32, slot_stride: u32, component: u32) -> f32 {
  return dag_values[lane + (slot + component) * slot_stride];
}
fn appearance_dag_sample_value(lane: u32, slot: u32, slot_stride: u32) -> vec4f {
  return vec4f(appearance_dag_component(lane, slot, slot_stride, 0u),
    appearance_dag_component(lane, slot, slot_stride, 1u),
    appearance_dag_component(lane, slot, slot_stride, 2u),
    appearance_dag_component(lane, slot, slot_stride, 3u));
}
fn appearance_dag_store_sample(lane: u32, slot: u32, slot_stride: u32, value: vec4f) {
  for (var component = 0u; component < 4u; component++) {
    dag_values[lane + (slot + component) * slot_stride] = value[component];
  }
}
fn appearance_dag_store_scalar(lane: u32, slot: u32, slot_stride: u32, value: vec3f, neighbors: bool) {
  let address = lane + slot * slot_stride;
  dag_values[address] = value.x;
  if neighbors {
    dag_values[address + slot_stride] = value.y;
    dag_values[address + slot_stride * 2u] = value.z;
  }
}
fn appearance_dag_load_stride(lane: u32, slot: u32, slot_stride: u32, neighbors: bool, point_stride: u32) -> vec3f {
  let center = appearance_dag_component(lane, slot, slot_stride, 0u);
  if neighbors {
    return vec3f(center, appearance_dag_component(lane, slot + point_stride, slot_stride, 0u),
      appearance_dag_component(lane, slot + point_stride * 2u, slot_stride, 0u));
  }
  return vec3f(center);
}

fn appearance_dag_evaluate(code: u32, count: u32, lane: u32, missing: u32, slot_stride: u32) {
  for (var index = 0u; index < count; index++) {
    let at = code + index * ${APPEARANCE_DAG_INSTRUCTION_WORDS}u;
    let mask = dag_code[at + 5u];
    if (mask & missing) == 0u {
      continue;
    }
    let op = dag_code[at];
    let destination = dag_code[at + 1u];
    let a = dag_code[at + 2u];
    let b = dag_code[at + 3u];
    let c = dag_code[at + 4u];
    let auxiliary = dag_code[at + 6u];
    let control = dag_code[at + 7u];
    let channel = control & 255u;
    let neighbors = (control & 65536u) != 0u;
    let width = control >> 28u;
    let points = select(1u, 3u, neighbors);
    let a_stride = ((control >> 18u) & 7u) + 1u;
    let b_stride = ((control >> 21u) & 7u) + 1u;
    let c_stride = ((control >> 24u) & 7u) + 1u;
    var value = vec3f(0.0);
    switch op {
      case ${APPEARANCE_DAG_OPS.uniformSink}u: {
        appearance_dag_publish_uniform(auxiliary,
          appearance_dag_component(lane, a, slot_stride, 0u));
        continue;
      }
      case ${APPEARANCE_DAG_OPS.fieldSink}u: {
        appearance_dag_output(auxiliary, channel,
          appearance_dag_component(lane, a, slot_stride, 0u));
        continue;
      }
      case ${APPEARANCE_DAG_OPS.constantProduct}u: {
        var constant = vec4f(0.0);
        for (var component = 0u; component < channel; component++) {
          constant[component] = appearance_dag_constant(auxiliary + component);
        }
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          appearance_dag_store_sample(lane, destination + point * 4u, slot_stride, constant);
        }
        continue;
      }
      case ${APPEARANCE_DAG_OPS.sample}u, ${APPEARANCE_DAG_OPS.product}u: {
        let u = appearance_dag_load_stride(lane, a, slot_stride, true, a_stride);
        let v = appearance_dag_load_stride(lane, b, slot_stride, true, b_stride);
        let dx = vec2f(u.y - u.x, v.y - v.x);
        let dy = vec2f(u.z - u.x, v.z - v.x);
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          let uv = vec2f(u[point], v[point]);
          if op == ${APPEARANCE_DAG_OPS.sample}u {
            appearance_dag_store_sample(lane, destination + point * 4u, slot_stride, appearance_dag_sample(auxiliary, uv, dx, dy));
          } else {
            appearance_dag_store_sample(lane, destination + point * 4u, slot_stride, appearance_dag_product(auxiliary, uv, dx, dy));
          }
        }
        continue;
      }
      case ${APPEARANCE_DAG_OPS.normalDecode}u: {
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          let raw = appearance_dag_sample_value(lane, a + point * 4u, slot_stride);
          let decoded = appearance_decode_normal_moment(raw.xyz);
          let at = destination + point * 5u;
          appearance_dag_store_sample(lane, at, slot_stride,
            vec4f(decoded.normal, decoded.roughness));
          dag_values[lane + (at + 4u) * slot_stride] = f32(decoded.direction_valid);
        }
        continue;
      }
      case ${APPEARANCE_DAG_OPS.decodedChannel}u: {
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          value[point] = appearance_dag_component(lane, a + point * 5u, slot_stride, channel);
        }
      }
      case ${APPEARANCE_DAG_OPS.channel}u: {
        let points = select(1u, 3u, neighbors);
        for (var point = 0u; point < points; point++) {
          let sample = appearance_dag_sample_value(lane, a + point * 4u, slot_stride);
          value[point] = sample[channel];
        }
      }
      default: {
        // Instruction width is semantic; ALU vectors retain the original C/X/Y
        // point arithmetic. This avoids a dynamic private RGBA matrix and its
        // repeated point loops without changing any per-component expression.
        for (var component = 0u; component < width; component++) {
          var result = vec3f(0.0);
          if op == ${APPEARANCE_DAG_OPS.constant}u {
            result = vec3f(appearance_dag_constant(auxiliary + component));
          } else if op == ${APPEARANCE_DAG_OPS.uniformLoad}u {
            result = vec3f(appearance_dag_uniform(auxiliary + component));
          } else if op == ${APPEARANCE_DAG_OPS.input}u {
            result = appearance_dag_input(auxiliary, a, channel + component, neighbors);
          } else {
            let av = appearance_dag_load_stride(lane, a + select(component, 0u, (control & 256u) != 0u), slot_stride, neighbors, a_stride);
            var bv = vec3f(0.0);
            var cv = vec3f(0.0);
            if op <= ${APPEARANCE_DAG_OPS.pow}u || op >= ${APPEARANCE_DAG_OPS.mix}u {
              bv = appearance_dag_load_stride(lane, b + select(component, 0u, (control & 512u) != 0u), slot_stride, neighbors, b_stride);
            }
            if op >= ${APPEARANCE_DAG_OPS.mix}u {
              cv = appearance_dag_load_stride(lane, c + select(component, 0u, (control & 1024u) != 0u), slot_stride, neighbors, c_stride);
            }
            switch op {
              case ${APPEARANCE_DAG_OPS.add}u: { result = av + bv; }
              case ${APPEARANCE_DAG_OPS.subtract}u: { result = av - bv; }
              case ${APPEARANCE_DAG_OPS.multiply}u: { result = av * bv; }
              case ${APPEARANCE_DAG_OPS.divide}u: { result = av / bv; }
              case ${APPEARANCE_DAG_OPS.min}u: { result = min(av, bv); }
              case ${APPEARANCE_DAG_OPS.max}u: { result = max(av, bv); }
              case ${APPEARANCE_DAG_OPS.pow}u: { result = pow(av, bv); }
              case ${APPEARANCE_DAG_OPS.sin}u: { result = sin(av); }
              case ${APPEARANCE_DAG_OPS.cos}u: { result = cos(av); }
              case ${APPEARANCE_DAG_OPS.abs}u: { result = abs(av); }
              case ${APPEARANCE_DAG_OPS.sqrt}u: { result = sqrt(av); }
              case ${APPEARANCE_DAG_OPS.mix}u: { result = av * (vec3f(1.0) - cv) + bv * cv; }
              case ${APPEARANCE_DAG_OPS.clamp}u: { result = clamp(av, bv, cv); }
              default: {}
            }
          }
          let at = destination + component;
          dag_values[lane + at * slot_stride] = result.x;
          if neighbors {
            dag_values[lane + (at + width) * slot_stride] = result.y;
            dag_values[lane + (at + width * 2u) * slot_stride] = result.z;
          }
        }
        continue;
      }
    }
    appearance_dag_store_scalar(lane, destination, slot_stride, value, neighbors);
  }
}
`;
