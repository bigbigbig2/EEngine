import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import { APPEARANCE_DAG_ENTRY_WORDS } from "../gpu/GpuAppearanceDagAbi.js";
import { SURFACE_GEOMETRY_RECORD_WGSL, surfaceGeometryReadWgsl } from "../gpu/GpuSurfaceGeometryRecordAbi.js";
import { APPEARANCE_EXACT_DAG_WGSL } from "./appearance_exact_dag.js";
import {
  appearanceDagResidentSamplingWgsl,
  APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL,
} from "./appearance_dag_sampling.js";

/** B1 integration with the current sole Geometry product. B2 replaces the
 * geometry input boundary with owner-private completion, retaining the exact
 * DAG body and sampling. No graph or product identity changes this descriptor. */
export function appearanceSurfaceExactDescriptor(): AppearanceProgramDescriptor {
  const source = /* wgsl */ `
struct DagSettings {
  queue: u32, masks: u32, entries: u32, texture_set: u32,
  constants: u32, routes: u32, inputs: u32, product_bank_words: u32,
  lanes: u32, live_slots: u32, reserved: vec2u,
}
@group(0) @binding(0) var<storage, read> dag_code: array<u32>;
@group(0) @binding(1) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(2) var<storage, read_write> dag_values: array<vec4f>;
@group(0) @binding(3) var<storage, read> surface_geometry: array<u32>;
@group(0) @binding(4) var<storage, read> surface_demand: array<u32>;
@group(0) @binding(5) var<storage, read_write> field_values: array<f32>;
@group(0) @binding(6) var<storage, read> dag_product_0: array<u32>;
@group(0) @binding(7) var<storage, read> dag_product_1: array<u32>;
@group(0) @binding(8) var<uniform> settings: DagSettings;
${SURFACE_GEOMETRY_RECORD_WGSL}
${surfaceGeometryReadWgsl("surface_geometry")}
var<private> dag_entry: u32;
var<private> dag_leaf: u32;
var<private> dag_routes_base: u32;
var<private> dag_product_bank_words: u32;
fn dag_metadata_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(dag_metadata[at], dag_metadata[at + 1u],
    dag_metadata[at + 2u], dag_metadata[at + 3u]));
}
fn appearance_dag_constant(index: u32) -> f32 {
  return bitcast<f32>(dag_metadata[settings.constants + dag_code[dag_entry + 5u] + index]);
}
fn appearance_dag_input(index: u32, semantic: u32, channel: u32, neighbors: bool) -> vec3f {
  if semantic == 0u {
    let at = settings.inputs + (dag_code[dag_entry + 7u] + index) * 4u + channel;
    return vec3f(bitcast<f32>(dag_metadata[at]));
  }
  let center = geometry_product_input(dag_leaf, semantic, 0u)[channel];
  if !neighbors {
    return vec3f(center);
  }
  return vec3f(center, geometry_product_input(dag_leaf, semantic, 1u)[channel],
    geometry_product_input(dag_leaf, semantic, 2u)[channel]);
}
${appearanceDagResidentSamplingWgsl(1)}
${APPEARANCE_DAG_PRODUCT_SAMPLING_WGSL}
${APPEARANCE_EXACT_DAG_WGSL}
@compute @workgroup_size(64)
fn surface_fields(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.lanes {
    return;
  }
  dag_routes_base = settings.routes;
  dag_product_bank_words = settings.product_bank_words;
  let count = surface_demand[5u];
  let lane = id.x * settings.live_slots;
  for (var work = id.x; work < count; work += settings.lanes) {
    dag_leaf = surface_demand[settings.queue + work];
    let entry = surface_demand[settings.entries + dag_leaf];
    dag_entry = entry * ${APPEARANCE_DAG_ENTRY_WORDS}u;
    if dag_code[dag_entry + 8u] != settings.texture_set {
      continue;
    }
    let missing = surface_demand[settings.masks + dag_leaf];
    appearance_dag_evaluate(dag_code[dag_entry], dag_code[dag_entry + 1u], lane, missing);
    let outputs = dag_code[dag_entry + 2u];
    for (var output = 0u; output < dag_code[dag_entry + 3u]; output++) {
      let at = outputs + output * 4u;
      if (dag_code[at + 3u] & missing) == 0u {
        continue;
      }
      let destination = (dag_leaf * 15u + dag_code[at]) * 4u + dag_code[at + 1u];
      field_values[destination] = dag_values[lane + dag_code[at + 2u]].x;
    }
  }
}
`;
  const buffers: GPUBindGroupLayoutEntry[] = [];
  for (let binding = 0; binding < 8; binding++) {
    buffers.push({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 2 || binding === 5 ? "storage" : "read-only-storage" },
    });
  }
  buffers.push({
    binding: 8,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "uniform", minBindingSize: 48 },
  });
  const textures: GPUBindGroupLayoutEntry[] = [];
  for (let binding = 0; binding < 9; binding++) {
    textures.push({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "float", viewDimension: "2d-array" },
    });
  }
  for (let binding = 9; binding < 15; binding++) {
    textures.push({ binding, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } });
  }
  return Object.freeze({
    source,
    entryPoint: "surface_fields",
    workgroupSize: 64,
    groups: Object.freeze([buffers, textures]),
  });
}
