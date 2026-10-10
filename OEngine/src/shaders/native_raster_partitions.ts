import { FRAME_GEOMETRY_MESHLET_STRIDE } from "../gpu/GpuWinnerInterpolationAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_WGSL,
  GPU_MESHLET_RASTER_FLAGS as F,
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MESHLET_RECORD_SCHEMA } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { VSM_PAIR_WGSL, SHADOW_BOUNDS_WGSL } from "../gpu/GpuVsmPairAbi.js";
import { NATIVE_RASTER_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";
import {
  FRAME_GEOMETRY_ARENA_HEADER_WORDS as H,
  FRAME_GEOMETRY_ARENA_VERSION,
} from "../gpu/GpuFrameGeometryArenaAbi.js";

/** Raster-class classification over the count/prefix/scatter raster algorithm.
 * Four 32-triangle buckets and two draw sides per OPAQUE/coverage class.
 * Work slots are preserved; queue headers remain the authoritative generation.
 * No material records/old coverage directory/Tape or CPU-visible work control. */
export function nativeRasterPartitionsWgsl(caster = false): string {
  return /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${NATIVE_RASTER_DIRECTORY_WGSL}
${caster ? VSM_PAIR_WGSL + SHADOW_BOUNDS_WGSL : ""}
@group(0) @binding(0) var<storage, read> work: ${caster ? "VsmPairQueue" : "OEngineMeshletWorkQueueRead"};
@group(0) @binding(1) var<storage, read> directory: array<NativeRasterDirectoryEntry>;
@group(0) @binding(2) var<storage, read> ${caster ? "source: OEngineMeshletWorkQueueRead" : "metadata: array<u32>"};
@group(0) @binding(3) var<storage, read_write> states: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> indices: array<u32>;
@group(0) @binding(5) var<storage, read_write> draws: array<vec4u>;
// capacity, partitionCount, dispatchX limit, generation; source meshlet word base.
@group(0) @binding(6) var<uniform> settings: array<vec4u, 2>;
@group(1) @binding(0) var<storage, read_write> dispatch: array<u32>;
${
  caster
    ? `@group(0) @binding(7) var<storage, read> bounds: ShadowBoundsQueue;
fn native_raster_source_slot(slot: u32) -> u32 {
  if work.header.mode == 1u {
    return slot;
  }
  return work.elements[slot].work_slot;
}
fn native_raster_record(slot: u32) -> OEngineMeshletRasterWork {
  return source.elements[native_raster_source_slot(slot)];
}`
    : `fn native_raster_record(slot: u32) -> OEngineMeshletRasterWork { return work.elements[slot]; }`
}
fn native_raster_partition(slot: u32) -> u32 {
  if work.header.generation != settings[0].w {
    return 0xffffffffu;
  }
  ${
    caster
      ? `let source_slot = native_raster_source_slot(slot);
  if source_slot >= work.header.source_count || source_slot >= arrayLength(&source.elements) ||
    source_slot >= bounds.header.count || bounds.elements[source_slot].valid == 0u ||
    (work.header.mode == 0u && work.elements[slot].status != 1u) { return 0xffffffffu; }`
      : ""
  }
  let record = native_raster_record(slot);
  if record.material_slot_or_range >= arrayLength(&directory) {
    return 0xffffffffu;
  }
  if (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u { return 0xffffffffu; }
  let material = directory[record.material_slot_or_range];
  if material.raster_class >= settings[0].y / 8u || material.valid == 0u {
    return 0xffffffffu;
  }
  var count = ${caster ? "bounds.elements[source_slot].triangle_count" : "128u"};
  ${
    caster
      ? ""
      : /* wgsl */ `
  if (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.VirtualGeometry}u) == 0u {
    let at = settings[1].x + record.meshlet_slot * ${GPU_MESHLET_RECORD_SCHEMA.stride / 4}u;
    if at + ${GPU_MESHLET_RECORD_SCHEMA.stride / 4}u > arrayLength(&metadata) { return 0xffffffffu; }
    count = metadata[at + ${GPU_MESHLET_RECORD_SCHEMA.offsets.triangle_count! / 4}u];
  }
  `
  }
  ${
    caster
      ? ""
      : /* wgsl */ `else if settings[1].z != 0u {
    let header = settings[1].y & 0x7fffffffu;
    if metadata[header + ${H.version}u] == ${FRAME_GEOMETRY_ARENA_VERSION}u {
      let base = metadata[header + select(${H.sourceDirectory}u, ${H.filteredDirectory}u,
        (settings[1].y & 0x80000000u) != 0u)];
      if metadata[base + 1u] == work.header.generation && slot < metadata[base] {
        let entry = base + 4u + slot * ${FRAME_GEOMETRY_MESHLET_STRIDE / 4}u;
        // A real preparation capacity miss keeps the complete source draw.
        if metadata[entry + 2u] != 0u {
          count = metadata[entry + 3u];
        }
      }
    }
  }`
  }
  if count == 0u || count > 128u {
    return 0xffffffffu;
  }
  let bucket = (count - 1u) / 32u;
  let side = select(0u, 1u, (record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.DoubleSided}u) != 0u);
  return material.raster_class * 8u + bucket * 2u + side;
}
fn native_raster_count() -> u32 {
  if work.header.generation != settings[0].w {
    return 0u;
  }
  ${
    caster
      ? `if work.header.failure != 0u || work.header.mode > 1u { return 0u; }
  if work.header.mode == 1u {
    return min(work.header.source_count, min(settings[0].x, arrayLength(&source.elements)));
  }
  return min(work.header.written_count, min(settings[0].x, arrayLength(&work.elements)));`
      : "return min(work.header.written_count, min(work.header.capacity, min(settings[0].x, arrayLength(&work.elements))));"
  }
}
fn native_raster_selected(slot: u32) -> bool {
  ${
    caster
      ? "return true;"
      : `let flags = work.elements[slot].packed_raster_flags;
  return (flags & ${F.OcclusionDeferred}u) == 0u && (settings[1].w == 0u || (flags & ${F.OcclusionRecovered}u) != 0u);`
  }
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
    let malformed = ${
      caster
        ? `work.header.failure != 0u || work.header.mode > 1u ||
      work.header.written_count > capacity || work.header.source_count > min(settings[0].x, arrayLength(&source.elements)) ||
      source.header.generation != work.header.source_generation || bounds.header.generation != work.header.source_generation ||
      bounds.header.invalid != 0u || bounds.header.count != work.header.source_count`
        : "work.header.written_count > capacity || work.header.capacity > capacity || work.header.overflow_count != 0u"
    };
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
  if !native_raster_selected(slot) {
    return;
  }
  let key = native_raster_partition(slot);
  if key != 0xffffffffu {
    atomicAdd(&states[key * 4u], 1u);
  } else if ${caster ? "true" : `(work.elements[slot].packed_raster_flags & ${GPU_INSTANCE_FLAGS.Transparent}u) == 0u`} {
    atomicAdd(&states[settings[0].y * 4u + 1u], 1u);
  }
}
@compute @workgroup_size(1)
fn prefix() {
  var base = 0u;
  for (var key = 0u; key < settings[0].y; key++) {
    let count = atomicLoad(&states[key * 4u]);
    atomicStore(&states[key * 4u + 1u], base);
    let instances = ${caster ? "select(count, count * work.header.dirty_count, work.header.mode == 1u)" : "count"};
    ${
      caster
        ? `let failure = atomicLoad(&states[settings[0].y * 4u]) |
      atomicLoad(&states[settings[0].y * 4u + 1u]) | atomicLoad(&states[settings[0].y * 4u + 2u]);
    draws[key] = vec4u(((key % 8u) / 2u + 1u) * 96u, select(instances, 0u, failure != 0u), 0u, 0u);`
        : "draws[key] = vec4u(((key % 8u) / 2u + 1u) * 96u, instances, 0u, 0u);"
    }
    base += count;
  }
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x + id.y * settings[0].z * 64u;
  if slot >= native_raster_count() {
    return;
  }
  if !native_raster_selected(slot) {
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
