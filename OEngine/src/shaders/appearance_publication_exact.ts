import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { APPEARANCE_EXACT_DAG_WGSL } from "./appearance_exact_dag.js";
import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import {
  appearanceDagResidentSamplingWgsl,
  APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL
} from "./appearance_dag_sampling.js";

/** Publication-rate deterministic subgraph. Spatial nodes are excluded by the
 * compiler's dependency closure mask, before any pixel demand is generated. */
export function appearancePublicationExactDescriptor(resources = false): AppearanceProgramDescriptor {
  const source = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
@group(0) @binding(4) var<uniform> camera: CommandEncoder;
struct Settings {
  entries: u32, palette: u32, constants: u32, inputs: u32,
  lanes: u32, live_words: u32, frame: u32, reserved: u32,
  routes: u32, product_words: u32, texture_set: u32, padding: u32,
}
@group(0) @binding(0) var<storage, read> dag_code: array<u32>;
@group(0) @binding(1) var<storage, read_write> dag_metadata: array<u32>;
@group(0) @binding(2) var<storage, read_write> dag_values: array<f32>;
@group(0) @binding(3) var<uniform> settings: Settings;
var<private> dag_entry: u32;
${
  resources
    ? `
@group(0) @binding(5) var<storage, read> dag_product_0: array<u32>;
@group(0) @binding(6) var<storage, read> dag_product_1: array<u32>;
var<private> dag_routes_base: u32;
var<private> dag_product_bank_words: u32;
fn dag_metadata_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(dag_metadata[at], dag_metadata[at + 1u], dag_metadata[at + 2u], dag_metadata[at + 3u]));
}
${appearanceDagResidentSamplingWgsl(1).replace("fn appearance_dag_sample(", "fn uniform_sample_value(")}
${APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL.replace("fn appearance_dag_product(", "fn uniform_product_value(")}
fn appearance_dag_sample(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  if settings.reserved != 0u { dag_metadata[settings.reserved + (dag_entry / 16u) * 2u] += 1u; }
  return uniform_sample_value(index, uv, dx, dy);
}
fn appearance_dag_product(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  if settings.reserved != 0u { dag_metadata[settings.reserved + (dag_entry / 16u) * 2u + 1u] += 1u; }
  return uniform_product_value(index, uv, dx, dy);
}`
    : ""
}
fn appearance_dag_constant(index: u32) -> f32 {
  return bitcast<f32>(dag_metadata[settings.constants + dag_code[dag_entry + 5u] + index]);
}
fn appearance_dag_input(index: u32, semantic: u32, channel: u32, neighbors: bool) -> vec3f {
  if semantic == 9u {
    if channel == 3u {
      return vec3f(1.0);
    }
    return vec3f(camera.transform[3u][channel]);
  }
  let at = settings.inputs + (dag_code[dag_entry + 7u] + index) * 4u + channel;
  return vec3f(bitcast<f32>(dag_metadata[at]));
}
fn appearance_dag_output(field: u32, channel: u32, value: f32) {
  let palette = settings.palette + (dag_entry / 16u) * 64u;
  dag_metadata[palette + 4u + field * 4u + channel] = bitcast<u32>(value);
}
fn appearance_dag_uniform(index: u32) -> f32 {
  let plan = dag_code[dag_entry + 2u];
  return bitcast<f32>(dag_metadata[dag_code[plan + 4u] + index]);
}
fn appearance_dag_publish_uniform(index: u32, value: f32) {
  let plan = dag_code[dag_entry + 2u];
  dag_metadata[dag_code[plan + 4u] + index] = bitcast<u32>(value);
}
${APPEARANCE_EXACT_DAG_WGSL}
// No sampling callback is reachable in the publication dependency mask. An
// impossible spatial operation poisons the palette rather than inventing a value.
${
  resources
    ? ""
    : `fn appearance_dag_sample(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return vec4f(bitcast<f32>(0x7fc00000u | (settings.frame & 0u)));
}
fn appearance_dag_product(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return vec4f(bitcast<f32>(0x7fc00000u | (settings.frame & 0u)));
}`
}
@compute @workgroup_size(64)
fn publish_constants(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.lanes {
    return;
  }
  let lane = id.x;
  ${resources ? "dag_routes_base = settings.routes; dag_product_bank_words = settings.product_words;" : ""}
  for (var entry = id.x; entry < settings.entries; entry += settings.lanes) {
    dag_entry = entry * 16u;
    ${resources ? "if dag_code[dag_entry + 8u] != settings.texture_set { continue; }" : ""}
    let plan = dag_code[dag_entry + 2u];
    let frame_plan = dag_code[plan + 7u];
    let dirty = dag_metadata[dag_code[frame_plan + 2u]];
    if dirty == 0u && dag_code[frame_plan + 1u] == 0u {
      continue;
    }
    let mask = dag_code[dag_entry + 13u] & 32767u;
    let palette = settings.palette + entry * 64u;
    dag_metadata[palette] = mask;
    dag_metadata[palette + 1u] = mask;
    dag_metadata[palette + 2u] = settings.frame;
    dag_metadata[palette + 3u] = dag_code[dag_entry + 15u];
    if (dirty & 1u) != 0u {
      // Defaults exactly match the published Appearance field consumer contract.
      for (var field = 0u; field < 15u; field++) {
        var value = vec4f(0.0);
        if field == 6u || field == 12u {
          value.z = 1.0;
        }
        if field == 7u {
          value.x = 1.5;
        }
        if field == 1u || field == 3u || field == 4u || field == 8u || field == 11u || field == 13u || field == 14u {
          value.x = 1.0;
        }
        if field == 9u {
          value = vec4f(1.0, 1.0, 1.0, 0.0);
        }
        let words = bitcast<vec4u>(value);
        for (var channel = 0u; channel < 4u; channel++) {
          dag_metadata[palette + 4u + field * 4u + channel] = words[channel];
        }
      }
      appearance_dag_evaluate(dag_code[frame_plan + 3u], dag_code[frame_plan + 4u],
        lane, 0x80000000u, settings.lanes);
    }
    if (dirty & 2u) != 0u {
      appearance_dag_evaluate(dag_code[plan], dag_code[plan + 1u], lane, 0x80000000u, settings.lanes);
    }
    // Material products are committed before frame products in the same lane.
    // No other entry/lane shares their metadata or temporary context.
    appearance_dag_evaluate(dag_code[frame_plan], dag_code[frame_plan + 1u],
      lane, 0x80000000u, settings.lanes);
    for (var output = 0u; output < dag_code[plan + 6u]; output++) {
      let at = dag_code[plan + 5u] + output * 4u;
      appearance_dag_output(dag_code[at], dag_code[at + 1u],
        appearance_dag_uniform(dag_code[at + 2u]));
    }
  }
}
`;
  const groups: GPUBindGroupLayoutEntry[][] = [
    [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ...(resources
        ? [5, 6].map((binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "read-only-storage" as GPUBufferBindingType }
          }))
        : [])
    ]
  ];
  if (resources) {
    groups.push([
      ...Array.from({ length: 9 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: "float" as GPUTextureSampleType,
          viewDimension: "2d-array" as GPUTextureViewDimension
        }
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        binding: index + 9,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" as GPUSamplerBindingType }
      }))
    ]);
  }
  return Object.freeze({ source, entryPoint: "publish_constants", workgroupSize: 64, groups });
}
