import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SHADING_FREQUENCY_COARSE4_BIT, SHADING_FREQUENCY_TILE_SIZE } from "../render/surface/ShadingFrequencyPlanAbi.js";

/** EEngine pre-material frequency planner; R20's coarse/full closure is the donor, not its GBuffer classifier. */
export const SHADING_FREQUENCY_PLAN_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
struct FrequencyExtent { width: u32, height: u32, }
@group(0) @binding(0) var frequency_key: texture_2d<u32>;
@group(0) @binding(1) var frequency_depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> frequency_meshlets: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> frequency_materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(4) var<storage, read> frequency_instances: array<OEngineInstanceRecord>;
@group(0) @binding(5) var<storage, read_write> frequency_plan: array<u32>;
@group(0) @binding(6) var<uniform> frequency_extent: FrequencyExtent;

fn frequency_static(instance: OEngineInstanceRecord) -> bool {
  if !oengine_instance_motion_valid(instance) { return false; }
  let e = 1e-6;
  return all(abs(instance.previous_from_current_affine_0 - vec4f(1.0, 0.0, 0.0, 0.0)) < vec4f(e)) &&
    all(abs(instance.previous_from_current_affine_1 - vec4f(0.0, 1.0, 0.0, 0.0)) < vec4f(e)) &&
    all(abs(instance.previous_from_current_affine_2 - vec4f(0.0, 0.0, 1.0, 0.0)) < vec4f(e));
}

fn frequency_eligible(key: u32) -> bool {
  if !oengine_visibility_key_is_valid(key) || frequency_meshlets.header.generation == 0u { return false; }
  let work_slot = oengine_visibility_key_meshlet_work_slot(key);
  if work_slot >= frequency_meshlets.header.written_count { return false; }
  let meshlet = frequency_meshlets.elements[work_slot];
  if meshlet.material_slot_or_range >= arrayLength(&frequency_materials) ||
     meshlet.instance_slot >= arrayLength(&frequency_instances) { return false; }
  let material = frequency_materials[meshlet.material_slot_or_range];
  // Material Appearance: only opaque untextured, uncolored factor material is
  // currently proven constant across a primitive. Lighting: unlit has no
  // direct/indirect/specular/shadow variation. All other classes stay full.
  return material.program_id == 0u && material.texture_binding_set_id == 0u &&
    material.payload.alpha_mode == 0u &&
    material.payload.flags == ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid | GPU_MATERIAL_VISIBILITY_FLAGS.Unlit}u &&
    frequency_static(frequency_instances[meshlet.instance_slot]);
}

fn frequency_block_eligible(origin: vec2u, rate: u32) -> bool {
  if origin.x + rate > frequency_extent.width || origin.y + rate > frequency_extent.height { return false; }
  let key = textureLoad(frequency_key, vec2i(origin), 0).x;
  if !frequency_eligible(key) { return false; }
  let depth0 = textureLoad(frequency_depth, vec2i(origin), 0);
  let depth_x = textureLoad(frequency_depth, vec2i(origin + vec2u(1u, 0u)), 0);
  let depth_y = textureLoad(frequency_depth, vec2i(origin + vec2u(0u, 1u)), 0);
  let max_delta = f32(rate) * 1.41421356 * (abs(depth_x-depth0) + abs(depth_y-depth0)) + 1e-4;
  for (var y = 0u; y < rate; y++) {
    for (var x = 0u; x < rate; x++) {
      let pixel = origin + vec2u(x, y);
      if textureLoad(frequency_key, vec2i(pixel), 0).x != key ||
         abs(textureLoad(frequency_depth, vec2i(pixel), 0) - depth0) > max_delta {
        return false;
      }
    }
  }
  return true;
}

@compute @workgroup_size(8, 8)
fn plan(@builtin(global_invocation_id) id: vec3u) {
  let tiles_x = (frequency_extent.width + ${SHADING_FREQUENCY_TILE_SIZE - 1}u) / ${SHADING_FREQUENCY_TILE_SIZE}u;
  if id.x >= tiles_x || id.y >= (frequency_extent.height + ${SHADING_FREQUENCY_TILE_SIZE - 1}u) / ${SHADING_FREQUENCY_TILE_SIZE}u { return; }
  let origin = id.xy * ${SHADING_FREQUENCY_TILE_SIZE}u;
  var mask = 0u;
  if frequency_block_eligible(origin, ${SHADING_FREQUENCY_TILE_SIZE}u) {
    mask = ${SHADING_FREQUENCY_COARSE4_BIT}u;
  } else {
    for (var cell = 0u; cell < 4u; cell++) {
      let cell_origin = origin + vec2u((cell & 1u) * 2u, (cell >> 1u) * 2u);
      if frequency_block_eligible(cell_origin, 2u) { mask |= 1u << cell; }
    }
  }
  frequency_plan[id.y * tiles_x + id.x] = mask;
}
`;

/** Bit 4 is a 4×4 representative; bits 0..3 select independent 2×2 representatives. */
export const SHADING_FREQUENCY_ANCHOR_WGSL = /* wgsl */ `
fn oengine_shading_anchor(pixel: vec2u, width: u32) -> vec2u {
  let tile = pixel / ${SHADING_FREQUENCY_TILE_SIZE}u;
  let mask = frequency_plan[tile.y * ((width + ${SHADING_FREQUENCY_TILE_SIZE - 1}u) / ${SHADING_FREQUENCY_TILE_SIZE}u) + tile.x];
  if (mask & ${SHADING_FREQUENCY_COARSE4_BIT}u) != 0u { return tile * ${SHADING_FREQUENCY_TILE_SIZE}u; }
  let cell = ((pixel.y & 3u) >> 1u) * 2u + ((pixel.x & 3u) >> 1u);
  if (mask & (1u << cell)) != 0u { return (pixel / 2u) * 2u; }
  return pixel;
}
`;
