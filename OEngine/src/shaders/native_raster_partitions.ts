import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MESHLET_RECORD_SCHEMA } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";

/** Native material classification over the existing count/prefix/scatter raster
 * algorithm. Four 32-triangle buckets and two draw sides per execution bin.
 * Work slots are preserved; queue headers remain the authoritative generation.
 * No material records/old coverage directory/Tape or CPU-visible work control. */
export const NATIVE_CASTER_QUEUE_WGSL = /* wgsl */ `
struct NativeCasterHeader {
  attempted: u32,
  written_count: u32,
  overflow: u32,
  generation: u32,
}
struct VsmCasterRecord {
  instance_slot: u32,
  geometry_slot: u32,
  meshlet_slot: u32,
  material_slot_or_range: u32,
  page_slot: u32,
  virtual_page: u32,
  packed_raster_flags: u32,
  packed_profile_lod: u32,
}
struct NativeCasterQueue {
  header: NativeCasterHeader,
  elements: array<VsmCasterRecord>,
}
`;

export function nativeRasterPartitionsWgsl(caster = false): string {
  return /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${NATIVE_MATERIAL_DIRECTORY_WGSL}
${caster ? NATIVE_CASTER_QUEUE_WGSL : ""}
@group(0) @binding(0) var<storage, read> work: ${caster ? "NativeCasterQueue" : "OEngineMeshletWorkQueueRead"};
@group(0) @binding(1) var<storage, read> directory: array<NativeMaterialDirectoryEntry>;
@group(0) @binding(2) var<storage, read> metadata: array<u32>;
@group(0) @binding(3) var<storage, read_write> states: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> indices: array<u32>;
@group(0) @binding(5) var<storage, read_write> draws: array<vec4u>;
// capacity, partitionCount, dispatchX limit, generation; source meshlet word base.
@group(0) @binding(6) var<uniform> settings: array<vec4u, 2>;
@group(1) @binding(0) var<storage, read_write> dispatch: array<u32>;
fn native_raster_partition(slot: u32) -> u32 {
  if work.header.generation != settings[0].w {
    return 0xffffffffu;
  }
  let record = work.elements[slot];
  if record.material_slot_or_range >= arrayLength(&directory) {
    return 0xffffffffu;
  }
  if (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u { return 0xffffffffu; }
  let material = directory[record.material_slot_or_range];
  if material.execution_bin >= settings[0].y / 8u || material.program_index == 0xffffffffu {
    return 0xffffffffu;
  }
  var count = 128u;
  if (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.VirtualGeometry}u) == 0u {
    let at = settings[1].x + record.meshlet_slot * ${GPU_MESHLET_RECORD_SCHEMA.stride / 4}u;
    if at + ${GPU_MESHLET_RECORD_SCHEMA.stride / 4}u > arrayLength(&metadata) { return 0xffffffffu; }
    count = metadata[at + ${GPU_MESHLET_RECORD_SCHEMA.offsets.triangle_count! / 4}u];
  }
  if count == 0u || count > 128u {
    return 0xffffffffu;
  }
  let bucket = (count - 1u) / 32u;
  let side = select(0u, 1u, (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.DoubleSided}u) != 0u);
  return material.execution_bin * 8u + bucket * 2u + side;
}
fn native_raster_count() -> u32 {
  if work.header.generation != settings[0].w {
    return 0u;
  }
  return min(work.header.written_count, min(${caster ? "settings[0].x" : "work.header.capacity"}, min(settings[0].x, arrayLength(&work.elements))));
}
@compute @workgroup_size(64)
fn begin(@builtin(global_invocation_id) id: vec3u) {
  if id.x < settings[0].y {
    for (var lane = 0u; lane < 4u; lane++) {
      atomicStore(&states[id.x * 4u + lane], 0u);
    }
    draws[id.x] = vec4u(0u);
  }
  if id.x == 0u {
    // Four diagnostic words after the partition states: overflow/malformed
    // header, invalid opaque records, stale generation, reserved. Robust bounds
    // are never treated as successful full coverage; the owning frame diagnoses
    // and rejects malformed producer publications, never reads back to schedule.
    let diagnostics_base = settings[0].y * 4u;
    for (var lane = 0u; lane < 4u; lane++) {
      atomicStore(&states[diagnostics_base + lane], 0u);
    }
    let capacity = min(settings[0].x, arrayLength(&work.elements));
    let malformed = work.header.written_count > capacity || ${caster ? "work.header.overflow != 0u" : "work.header.capacity > capacity || work.header.overflow_count != 0u"};
    atomicStore(&states[diagnostics_base], select(0u, 1u, malformed));
    atomicStore(&states[diagnostics_base + 2u], select(0u, 1u, work.header.generation != settings[0].w));
    let groups = (native_raster_count() + 63u) / 64u;
    let x = min(groups, settings[0].z);
    dispatch[0] = x;
    dispatch[1] = select(0u, (groups + max(x, 1u) - 1u) / max(x, 1u), groups != 0u);
    dispatch[2] = 1u;
  }
}
@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x + id.y * settings[0].z * 64u;
  if slot >= native_raster_count() {
    return;
  }
  let key = native_raster_partition(slot);
  if key != 0xffffffffu {
    atomicAdd(&states[key * 4u], 1u);
  } else if (work.elements[slot].packed_raster_flags & ${GPU_INSTANCE_FLAGS.Transparent}u) == 0u {
    atomicAdd(&states[settings[0].y * 4u + 1u], 1u);
  }
}
@compute @workgroup_size(1)
fn prefix() {
  var base = 0u;
  for (var key = 0u; key < settings[0].y; key++) {
    let count = atomicLoad(&states[key * 4u]);
    atomicStore(&states[key * 4u + 1u], base);
    draws[key] = vec4u(((key % 8u) / 2u + 1u) * 96u, count, 0u, 0u);
    base += count;
  }
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x + id.y * settings[0].z * 64u;
  if slot >= native_raster_count() {
    return;
  }
  let key = native_raster_partition(slot);
  if key == 0xffffffffu {
    return;
  }
  let at = atomicLoad(&states[key * 4u + 1u]) + atomicAdd(&states[key * 4u + 2u], 1u);
  indices[at] = slot;
}
`;
}
export const NATIVE_RASTER_PARTITIONS_WGSL = nativeRasterPartitionsWgsl();
