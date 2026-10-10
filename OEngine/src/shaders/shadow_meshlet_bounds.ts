import { SHADOW_BOUNDS_WRITE_WGSL } from "../gpu/GpuVsmPairAbi.js";
import { GPU_INSTANCE_RECORD_WGSL, GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";

/** Geometry reads actual resident meshlet AABBs, never the instance sphere.
 * 64 lanes, sequential output, no barriers; one invalid atomic only on failure.
 * Product addresses use the same generation-checked four-bank header decoder. */
export function shadowMeshletBoundsWgsl(product: boolean): string {
  const productBindings = product
    ? /* wgsl */ `
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
@group(0) @binding(5) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, bank) => `@group(0) @binding(${6 + bank}) var<storage, read> product_bank_${bank}: array<u32>;`).join("\n")}
fn shadow_product_bounds(work: OEngineMeshletRasterWork, instance: OEngineInstanceRecord) -> OEngineVirtualMeshletHeaderV1 {
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap, work.geometry_slot,
    oengine_instance_geometry_generation(instance));
  let group = oengine_virtual_group_v1(&product_heap, asset, work.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id);
  if !asset.valid || !group.valid || !location.valid {
    return oengine_virtual_invalid_meshlet_header_v1();
  }
${Array.from(
  { length: 4 },
  (_, bank) => `  if location.bank_index == ${bank}u {
    let header = oengine_virtual_group_header_v1(&product_bank_${bank}, location, group);
    if !header.valid || header.vertex_format_id >= asset.vertex_format_count {
      return oengine_virtual_invalid_meshlet_header_v1();
    }
    return oengine_virtual_meshlet_header_v1(&product_bank_${bank}, location, group, header, work.meshlet_slot & 127u);
  }`,
).join("\n")}
  return oengine_virtual_invalid_meshlet_header_v1();
}`
    : "";
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${productBindings}
struct Constants {
  light_view: mat4x4f,
  control: vec4u,
}
${SHADOW_BOUNDS_WRITE_WGSL}
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> work_queue: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(3) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(4) var<storage, read_write> bounds: ShadowBoundsQueue;
@group(1) @binding(0) var<storage, read_write> dispatch: array<u32>;
@group(1) @binding(1) var<storage, read> dirty: array<u32>;
@compute @workgroup_size(1)
fn begin() {
  let capacity = min(constants.control.x, min(work_queue.header.capacity, arrayLength(&work_queue.elements)));
  bounds.header.count = min(work_queue.header.written_count, capacity);
  bounds.header.capacity = constants.control.x;
  bounds.header.generation = work_queue.header.generation;
  atomicStore(&bounds.header.invalid, work_queue.header.invalid_count | work_queue.header.overflow_count |
    select(0u, 1u, work_queue.header.written_count > capacity || capacity > arrayLength(&bounds.elements)));
  let groups = select((bounds.header.count + 63u) / 64u, 0u, dirty[1] == 0u);
  dispatch[0] = min(groups, constants.control.y);
  dispatch[1] = (groups + constants.control.y - 1u) / constants.control.y;
  dispatch[2] = 1u;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x + id.y * constants.control.y * 64u;
  if slot >= bounds.header.count {
    return;
  }
  bounds.elements[slot] = ShadowMeshletBounds(vec4f(0.0), 0u, 0u, vec2u(0u));
  let work = work_queue.elements[slot];
  if work.instance_slot >= arrayLength(&instances) {
    atomicOr(&bounds.header.invalid, 1u);
    return;
  }
  let instance = instances[work.instance_slot];
  if !oengine_instance_active(instance) || (instance.flags & ${GPU_INSTANCE_FLAGS.CastsShadow}u) == 0u ||
     (instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u { atomicOr(&bounds.header.invalid, 1u); return; }
  var low: vec3f;
  var high: vec3f;
  var triangles: u32;
  var vertices: u32;
  if oengine_instance_virtual_geometry(instance) {
    ${
      product
        ? `let meshlet = shadow_product_bounds(work, instance);
    if !meshlet.valid {
      atomicOr(&bounds.header.invalid, 1u);
      return;
    }
    low = meshlet.bounds_min;
    high = meshlet.bounds_max;
    triangles = meshlet.triangle_count;
    vertices = meshlet.vertex_count;`
        : "atomicOr(&bounds.header.invalid, 1u); return;"
    }
  } else {
    if work.meshlet_slot >= arrayLength(&meshlets) {
      atomicOr(&bounds.header.invalid, 1u);
      return;
    }
    let meshlet = meshlets[work.meshlet_slot];
    low = meshlet.bounds_min.xyz;
    high = meshlet.bounds_max.xyz;
    triangles = meshlet.triangle_count;
    vertices = meshlet.vertex_count;
  }
  if triangles == 0u || triangles > 128u || vertices == 0u || vertices > 256u ||
     !all(low <= high) || !all(abs(low) <= vec3f(3.402823466e38)) || !all(abs(high) <= vec3f(3.402823466e38)) {
    atomicOr(&bounds.header.invalid, 1u); return;
  }
  let object_to_world = oengine_instance_current_object_to_world(instance);
  let transform = constants.light_view * object_to_world;
  let center = (transform * vec4f((low + high) * 0.5, 1.0)).xy;
  let half_extent = (high - low) * 0.5;
  let radius = abs(transform[0].xy) * half_extent.x + abs(transform[1].xy) * half_extent.y + abs(transform[2].xy) * half_extent.z;
  // Conservative f32 rounding margin for the composed affine projection.
  let local_magnitude = abs((low + high) * 0.5) + half_extent;
  let world_magnitude = abs(object_to_world[0].xyz) * local_magnitude.x +
    abs(object_to_world[1].xyz) * local_magnitude.y + abs(object_to_world[2].xyz) * local_magnitude.z + abs(object_to_world[3].xyz);
  let light_magnitude = abs(constants.light_view[0].xy) * world_magnitude.x +
    abs(constants.light_view[1].xy) * world_magnitude.y + abs(constants.light_view[2].xy) * world_magnitude.z + abs(constants.light_view[3].xy);
  let margin = (light_magnitude + vec2f(1.0)) * 0.000004;
  let projected = vec4f(center - radius - margin, center + radius + margin);
  if !all(abs(projected) <= vec4f(3.402823466e38)) {
    atomicOr(&bounds.header.invalid, 1u);
    return;
  }
  bounds.elements[slot] = ShadowMeshletBounds(projected, triangles, 1u, vec2u(0u));
}
`;
}
