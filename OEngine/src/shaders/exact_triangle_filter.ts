import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_POSITION_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_WORK_GENERATION_WGSL
} from "../gpu/GpuWorkGenerationAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import {
  GPU_EXACT_RASTER_RECORD_STRIDE,
  GPU_EXACT_RASTER_RECORD_WGSL,
  GPU_TRIANGLE_SETUP_RECORD_WGSL
} from "../gpu/GpuExactRasterAbi.js";

export const EXACT_TRIANGLE_FILTER_WORKGROUP_SIZE = 64;
export const EXACT_TRIANGLE_FILTER_SETTINGS_SIZE = 32;

const COUNTER_HW_CLUSTERS = counterByteOffset("hwClusters") / 4;
const COUNTER_ALPHA_CLUSTERS = counterByteOffset("alphaClusters") / 4;
const COUNTER_HW_TRIANGLES = counterByteOffset("hwTriangles") / 4;
const COUNTER_CANDIDATES = counterByteOffset("rasterCandidateTriangles") / 4;
const COUNTER_REJECTED = counterByteOffset("rasterRejectedTriangles") / 4;
const COUNTER_OPAQUE = counterByteOffset("opaqueRasterWork") / 4;
const COUNTER_MASK = counterByteOffset("maskRasterWork") / 4;
const COUNTER_SETUP_ATTEMPTED = counterByteOffset("setupAttempted") / 4;
const COUNTER_SETUP_WRITTEN = counterByteOffset("setupWritten") / 4;
const COUNTER_SETUP_OVERFLOW = counterByteOffset("setupOverflow") / 4;
const COUNTER_GEOMETRY_CANDIDATE_TRIANGLES = counterByteOffset("geometryCandidateTriangles") / 4;
const COUNTER_GEOMETRY_EXACT_SURVIVED = counterByteOffset("geometryExactSurvivedTriangles") / 4;
const COUNTER_GEOMETRY_QUEUE_BYTES = counterByteOffset("geometryQueueBytes") / 4;

/**
 * WebGPU port of The Forge triangle-filtering invariants. The source/commit,
 * retained AMD notice and adaptation boundary are recorded in the porting
 * ledger; this shader does not import its native command or descriptor model.
 */
export const EXACT_TRIANGLE_FILTER_WGSL = /* wgsl */ `
// Triangle classification/compaction is derived from The Forge at
// cd5046893faba2dc7869243873bf01f02a6f0df9. The upstream filtering block
// carries the MIT License (Copyright (c) 2017 Advanced Micro Devices, Inc.);
// The Forge project is Apache-2.0. See local porting ledger for exact paths.
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_WORK_GENERATION_WGSL}

struct OEngineWorkQueueHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
};

${GPU_EXACT_RASTER_RECORD_WGSL}
${GPU_TRIANGLE_SETUP_RECORD_WGSL}

struct OEngineRasterCandidateQueueRead {
  header: OEngineWorkQueueHeaderRead,
  elements: array<OEngineRasterWork>,
};

struct OEngineTriangleFilterSettings {
  viewport: vec2u,
  candidate_capacity: u32,
  class_capacity: u32,
  max_workgroups_per_dimension: u32,
  counters_enabled: u32,
  setup_threshold_pixels: u32,
  setup_capacity: u32,
};

@group(0) @binding(0) var<uniform> filter_camera: CommandEncoder;
@group(0) @binding(1) var<uniform> filter_settings: OEngineTriangleFilterSettings;
@group(0) @binding(2) var<storage, read> filter_candidates: OEngineRasterCandidateQueueRead;
@group(0) @binding(3) var<storage, read_write> filter_output: OEngineClassifiedExactRasterWorkQueue;
@group(0) @binding(4) var<storage, read> filter_instances: array<OEngineInstanceRecord>;
@group(0) @binding(5) var<storage, read> filter_geometries: array<GpuGeometryRecord>;
@group(0) @binding(6) var<storage, read> filter_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(7) var<storage, read> filter_meshlet_vertices: array<u32>;
@group(0) @binding(8) var<storage, read> filter_meshlet_triangles: array<u32>;
@group(0) @binding(9) var<storage, read> filter_vertex_data: array<u32>;
@group(0) @binding(10) var<storage, read_write> filter_setup_records: array<OEngineTriangleSetupRecord>;
@group(0) @binding(11) var<storage, read_write> filter_counters: array<atomic<u32>>;

var<workgroup> filter_opaque_count: atomic<u32>;
var<workgroup> filter_mask_count: atomic<u32>;
var<workgroup> filter_opaque_base: u32;
var<workgroup> filter_mask_base: u32;

fn filter_read_u8(byte_offset: u32) -> u32 {
  let word = filter_meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn filter_position(geometry: GpuGeometryRecord, source_vertex: u32) -> vec3f {
  return oengine_geometry_position(&filter_vertex_data, geometry, source_vertex);
}

fn filter_finite(value: vec4f) -> bool {
  return all(value == value) && all(abs(value) <= vec4f(3.402823466e+38));
}

fn filter_outside_clip(a: vec4f, b: vec4f, c: vec4f) -> bool {
  return (a.x < -a.w && b.x < -b.w && c.x < -c.w) ||
    (a.x > a.w && b.x > b.w && c.x > c.w) ||
    (a.y < -a.w && b.y < -b.w && c.y < -c.w) ||
    (a.y > a.w && b.y > b.w && c.y > c.w) ||
    (a.z < 0.0 && b.z < 0.0 && c.z < 0.0) ||
    (a.z > a.w && b.z > b.w && c.z > c.w);
}

fn filter_orientation(a: vec4f, b: vec4f, c: vec4f) -> f32 {
  return a.x * (b.y * c.w - b.w * c.y) -
    a.y * (b.x * c.w - b.w * c.x) +
    a.w * (b.x * c.y - b.y * c.x);
}

// The Forge's 23.8 fixed-point small-primitive predicate. Production uses
// one sample today; retaining the fixed-point algorithm avoids float bbox
// disagreement with Hardware rasterization at subpixel boundaries.
fn filter_small_primitive_rejected(a: vec4f, b: vec4f, c: vec4f) -> bool {
  let viewport = vec2f(filter_settings.viewport);
  let pa = vec2f(a.x / a.w * 0.5 + 0.5, 0.5 - a.y / a.w * 0.5) * viewport;
  let pb = vec2f(b.x / b.w * 0.5 + 0.5, 0.5 - b.y / b.w * 0.5) * viewport;
  let pc = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * viewport;
  let fixed_a = vec2i(pa * 256.0);
  let fixed_b = vec2i(pb * 256.0);
  let fixed_c = vec2i(pc * 256.0);
  let lo = min(fixed_a, min(fixed_b, fixed_c));
  let hi = max(fixed_a, max(fixed_b, fixed_c));
  let fractional_minimum = lo & vec2i(255);
  let distance_from_first_center = hi - ((lo & vec2i(~255)) + vec2i(128));
  return (fractional_minimum.x > 128 && distance_from_first_center.x < 255) ||
    (fractional_minimum.y > 128 && distance_from_first_center.y < 255);
}

fn filter_keep_triangle(work: OEngineRasterWork) -> bool {
  if work.instance_record_index >= arrayLength(&filter_instances) ||
    work.geometry_record_index >= arrayLength(&filter_geometries) ||
    work.meshlet_record_index >= arrayLength(&filter_meshlets) {
    return false;
  }
  let instance = filter_instances[work.instance_record_index];
  let geometry = filter_geometries[work.geometry_record_index];
  let meshlet = filter_meshlets[work.meshlet_record_index];
  if geometry.position_format != ${GPU_POSITION_FORMAT.Float32x3}u &&
    geometry.position_format != ${GPU_POSITION_FORMAT.Float32x4}u &&
    geometry.position_format != ${GPU_POSITION_FORMAT.AabbUnorm16x3}u {
    return false;
  }
  if work.local_triangle_index >= meshlet.triangle_count { return false; }
  let triangle_byte = meshlet.triangle_byte_offset + work.local_triangle_index * 3u;
  let local0 = filter_read_u8(triangle_byte);
  let local1 = filter_read_u8(triangle_byte + 1u);
  let local2 = filter_read_u8(triangle_byte + 2u);
  if local0 >= meshlet.vertex_count || local1 >= meshlet.vertex_count ||
    local2 >= meshlet.vertex_count {
    return false;
  }
  let source0 = filter_meshlet_vertices[meshlet.vertex_offset + local0];
  let source1 = filter_meshlet_vertices[meshlet.vertex_offset + local1];
  let source2 = filter_meshlet_vertices[meshlet.vertex_offset + local2];
  if source0 >= geometry.vertex_count || source1 >= geometry.vertex_count ||
    source2 >= geometry.vertex_count {
    return false;
  }
  let transform = filter_camera.view_projection_matrix * oengine_instance_current_object_to_world(instance);
  let a = transform * vec4f(filter_position(geometry, source0), 1.0);
  let b = transform * vec4f(filter_position(geometry, source1), 1.0);
  let c = transform * vec4f(filter_position(geometry, source2), 1.0);
  if !filter_finite(a) || !filter_finite(b) || !filter_finite(c) { return false; }
  if filter_outside_clip(a, b, c) { return false; }

  let crosses_near = ((a.z < 0.0 || a.w <= 0.0) ||
    (b.z < 0.0 || b.w <= 0.0) || (c.z < 0.0 || c.w <= 0.0)) &&
    ((a.z >= 0.0 && a.w > 0.0) || (b.z >= 0.0 && b.w > 0.0) ||
      (c.z >= 0.0 && c.w > 0.0));
  // Near/w crossings are deliberately fail-open, matching the CPU oracle.
  if crosses_near || a.w <= 0.0 || b.w <= 0.0 || c.w <= 0.0 { return true; }

  let determinant = filter_orientation(a, b, c);
  if abs(determinant) <= 1e-12 { return false; }
  if (work.raster_flags & ${GPU_INSTANCE_FLAGS.DoubleSided}u) == 0u {
    let linear = oengine_instance_current_object_to_world(instance);
    let mirrored = dot(linear[0].xyz, cross(linear[1].xyz, linear[2].xyz)) < 0.0;
    let front = determinant > 0.0;
    if front == mirrored { return false; }
  }
  return !filter_small_primitive_rejected(a, b, c);
}

fn filter_empty_setup() -> OEngineTriangleSetupRecord {
  return OEngineTriangleSetupRecord(
    0.0, 0.0, 0.0,
    0.0, 0.0, 0.0,
    0.0, 0.0, 0.0,
    0u
  );
}

// Builds the triangle-constant portion of perspective barycentric setup. It
// deliberately returns coverage=-1 for near crossings, degenerates and small
// triangles so the Surface consumer can fail open to its existing formula.
fn filter_setup_for_work(work: OEngineRasterWork) -> OEngineTriangleSetupRecord {
  if work.instance_record_index >= arrayLength(&filter_instances) ||
    work.geometry_record_index >= arrayLength(&filter_geometries) ||
    work.meshlet_record_index >= arrayLength(&filter_meshlets) {
    return filter_empty_setup();
  }
  let instance = filter_instances[work.instance_record_index];
  let geometry = filter_geometries[work.geometry_record_index];
  let meshlet = filter_meshlets[work.meshlet_record_index];
  if work.local_triangle_index >= meshlet.triangle_count { return filter_empty_setup(); }
  let triangle_byte = meshlet.triangle_byte_offset + work.local_triangle_index * 3u;
  let local0 = filter_read_u8(triangle_byte);
  let local1 = filter_read_u8(triangle_byte + 1u);
  let local2 = filter_read_u8(triangle_byte + 2u);
  if local0 >= meshlet.vertex_count || local1 >= meshlet.vertex_count || local2 >= meshlet.vertex_count {
    return filter_empty_setup();
  }
  let source0 = filter_meshlet_vertices[meshlet.vertex_offset + local0];
  let source1 = filter_meshlet_vertices[meshlet.vertex_offset + local1];
  let source2 = filter_meshlet_vertices[meshlet.vertex_offset + local2];
  let transform = filter_camera.view_projection_matrix * oengine_instance_current_object_to_world(instance);
  let a = transform * vec4f(filter_position(geometry, source0), 1.0);
  let b = transform * vec4f(filter_position(geometry, source1), 1.0);
  let c = transform * vec4f(filter_position(geometry, source2), 1.0);
  if !filter_finite(a) || !filter_finite(b) || !filter_finite(c) ||
    a.w <= 0.0 || b.w <= 0.0 || c.w <= 0.0 ||
    a.z < 0.0 || b.z < 0.0 || c.z < 0.0 {
    return filter_empty_setup();
  }
  let viewport = vec2f(filter_settings.viewport);
  let p0 = vec2f(a.x / a.w * 0.5 + 0.5, 0.5 - a.y / a.w * 0.5) * viewport;
  let p1 = vec2f(b.x / b.w * 0.5 + 0.5, 0.5 - b.y / b.w * 0.5) * viewport;
  let p2 = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * viewport;
  let denominator = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if abs(denominator) < 1e-8 { return filter_empty_setup(); }
  let coverage = abs(denominator) * 0.5;
  if coverage < f32(filter_settings.setup_threshold_pixels) { return filter_empty_setup(); }
  let viewport_center = viewport * 0.5;
  let lambda0 = ((p1.y - p2.y) * (viewport_center.x - p2.x) +
    (p2.x - p1.x) * (viewport_center.y - p2.y)) / denominator;
  let lambda1 = ((p2.y - p0.y) * (viewport_center.x - p2.x) +
    (p0.x - p2.x) * (viewport_center.y - p2.y)) / denominator;
  let lambda = vec3f(lambda0, lambda1, 1.0 - lambda0 - lambda1);
  let reciprocal_w = vec3f(1.0 / a.w, 1.0 / b.w, 1.0 / c.w);
  let q_center = lambda * reciprocal_w;
  return OEngineTriangleSetupRecord(
    q_center.x, q_center.y, q_center.z,
    (p1.y - p2.y) / denominator * reciprocal_w.x,
    (p2.y - p0.y) / denominator * reciprocal_w.y,
    (p0.y - p1.y) / denominator * reciprocal_w.z,
    (p2.x - p1.x) / denominator * reciprocal_w.x,
    (p0.x - p2.x) / denominator * reciprocal_w.y,
    (p1.x - p0.x) / denominator * reciprocal_w.z,
    1u
  );
}

@compute @workgroup_size(${EXACT_TRIANGLE_FILTER_WORKGROUP_SIZE})
fn exact_triangle_filter(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  if lane == 0u {
    atomicStore(&filter_opaque_count, 0u);
    atomicStore(&filter_mask_count, 0u);
    filter_opaque_base = OENGINE_WORK_QUEUE_INVALID_OFFSET;
    filter_mask_base = OENGINE_WORK_QUEUE_INVALID_OFFSET;
  }
  workgroupBarrier();

  let candidate_count = min(
    min(filter_candidates.header.written, filter_candidates.header.capacity),
    filter_settings.candidate_capacity
  );
  let candidate_index = (group.x + group.y * grid.x) *
    ${EXACT_TRIANGLE_FILTER_WORKGROUP_SIZE}u + lane;
  var keep = false;
  var mask = false;
  var local_index = 0u;
  var work = OEngineRasterWork(0u, 0u, 0u, 0u, 0u, 0u);
  if candidate_index < candidate_count {
    work = filter_candidates.elements[candidate_index];
    keep = filter_keep_triangle(work);
    mask = (work.raster_flags & ${GPU_INSTANCE_FLAGS.AlphaTested}u) != 0u;
    if keep {
      if mask {
        local_index = atomicAdd(&filter_mask_count, 1u);
      } else {
        local_index = atomicAdd(&filter_opaque_count, 1u);
      }
    }
  }
  workgroupBarrier();
  if lane == 0u {
    let opaque_count = atomicLoad(&filter_opaque_count);
    let mask_count = atomicLoad(&filter_mask_count);
    if opaque_count > 0u {
      filter_opaque_base = oengine_try_reserve_work_group(
        &filter_output.opaque_header, opaque_count
      );
    }
    if mask_count > 0u {
      filter_mask_base = oengine_try_reserve_work_group(
        &filter_output.mask_header, mask_count
      );
    }
  }
  workgroupBarrier();
  if keep {
    if mask && filter_mask_base != OENGINE_WORK_QUEUE_INVALID_OFFSET {
      let slot = filter_settings.class_capacity + filter_mask_base + local_index;
      var setup = filter_empty_setup();
      if filter_settings.setup_capacity != 0u { setup = filter_setup_for_work(work); }
      let setup_valid = slot < filter_settings.setup_capacity && setup.flags != 0u;
      filter_output.elements[slot] = OEngineExactRasterRecord(
        work.instance_record_index, work.geometry_record_index,
        work.meshlet_record_index, work.local_triangle_index,
        work.material_handle, work.raster_flags,
        select(0xffffffffu, slot, setup_valid),
        select(0u, 1u, setup_valid)
      );
      if filter_settings.counters_enabled != 0u && setup.flags != 0u {
        atomicAdd(&filter_counters[${COUNTER_SETUP_ATTEMPTED}u], 1u);
      }
      if setup_valid {
        filter_setup_records[slot] = setup;
        if filter_settings.counters_enabled != 0u { atomicAdd(&filter_counters[${COUNTER_SETUP_WRITTEN}u], 1u); }
      } else if filter_settings.counters_enabled != 0u {
        if setup.flags != 0u { atomicAdd(&filter_counters[${COUNTER_SETUP_OVERFLOW}u], 1u); }
      }
    } else if !mask && filter_opaque_base != OENGINE_WORK_QUEUE_INVALID_OFFSET {
      let exact_slot = filter_opaque_base + local_index;
      var setup = filter_empty_setup();
      if filter_settings.setup_capacity != 0u { setup = filter_setup_for_work(work); }
      let setup_valid = exact_slot < filter_settings.setup_capacity && setup.flags != 0u;
      filter_output.elements[exact_slot] = OEngineExactRasterRecord(
        work.instance_record_index, work.geometry_record_index,
        work.meshlet_record_index, work.local_triangle_index,
        work.material_handle, work.raster_flags,
        select(0xffffffffu, exact_slot, setup_valid),
        select(0u, 1u, setup_valid)
      );
      let slot = exact_slot;
      if filter_settings.counters_enabled != 0u && setup.flags != 0u {
        atomicAdd(&filter_counters[${COUNTER_SETUP_ATTEMPTED}u], 1u);
      }
      if setup_valid {
        filter_setup_records[slot] = setup;
        if filter_settings.counters_enabled != 0u { atomicAdd(&filter_counters[${COUNTER_SETUP_WRITTEN}u], 1u); }
      } else if filter_settings.counters_enabled != 0u {
        if setup.flags != 0u { atomicAdd(&filter_counters[${COUNTER_SETUP_OVERFLOW}u], 1u); }
      }
    }
  }
}

struct OEngineClassifiedDrawArgs {
  opaque: vec4u,
  mask: vec4u,
};

struct OEngineFilterDispatchArgs {
  x: u32,
  y: u32,
  z: u32,
};

@group(1) @binding(0) var<storage, read> classified_input: OEngineClassifiedExactRasterWorkQueueRead;
@group(1) @binding(1) var<storage, read_write> classified_draw: OEngineClassifiedDrawArgs;
@group(1) @binding(2) var<storage, read_write> classified_counters: array<atomic<u32>>;
@group(1) @binding(3) var<uniform> classified_settings: OEngineTriangleFilterSettings;
@group(1) @binding(4) var<storage, read> classified_candidates: OEngineRasterCandidateQueueRead;

@compute @workgroup_size(1)
fn prepare_classified_draws() {
  let opaque = min(classified_input.opaque_header.written,
    classified_input.opaque_header.capacity);
  let mask = min(classified_input.mask_header.written,
    classified_input.mask_header.capacity);
  classified_draw.opaque = vec4u(opaque * 3u, 1u, 0u, 0u);
  classified_draw.mask = vec4u(mask * 3u, 1u,
    classified_input.opaque_header.capacity * 3u, 0u);
  if classified_settings.counters_enabled != 0u {
    let candidates = min(
      classified_candidates.header.written,
      classified_candidates.header.capacity
    );
    let written = opaque + mask;
    atomicAdd(&classified_counters[${COUNTER_CANDIDATES}u], candidates);
    atomicAdd(&classified_counters[${COUNTER_REJECTED}u], candidates - min(candidates, written));
    atomicAdd(&classified_counters[${COUNTER_OPAQUE}u], opaque);
    atomicAdd(&classified_counters[${COUNTER_MASK}u], mask);
    atomicAdd(&classified_counters[${COUNTER_HW_CLUSTERS}u], written);
    atomicAdd(&classified_counters[${COUNTER_ALPHA_CLUSTERS}u], mask);
    atomicAdd(&classified_counters[${COUNTER_HW_TRIANGLES}u], written);
    atomicAdd(&classified_counters[${COUNTER_GEOMETRY_CANDIDATE_TRIANGLES}u], candidates);
    atomicAdd(&classified_counters[${COUNTER_GEOMETRY_EXACT_SURVIVED}u], written);
    atomicAdd(
      &classified_counters[${COUNTER_GEOMETRY_QUEUE_BYTES}u],
      written * ${GPU_EXACT_RASTER_RECORD_STRIDE}u
    );
  }
}

@group(2) @binding(0) var<uniform> dispatch_settings: OEngineTriangleFilterSettings;
@group(2) @binding(1) var<storage, read> dispatch_candidates: OEngineRasterCandidateQueueRead;
@group(2) @binding(2) var<storage, read_write> filter_dispatch: OEngineFilterDispatchArgs;

@compute @workgroup_size(1)
fn prepare_triangle_filter_dispatch() {
  let count = min(
    min(dispatch_candidates.header.written, dispatch_candidates.header.capacity),
    dispatch_settings.candidate_capacity
  );
  let linear = (count + ${EXACT_TRIANGLE_FILTER_WORKGROUP_SIZE - 1}u) /
    ${EXACT_TRIANGLE_FILTER_WORKGROUP_SIZE}u;
  filter_dispatch.x = min(linear, dispatch_settings.max_workgroups_per_dimension);
  filter_dispatch.y = max(
    (linear + dispatch_settings.max_workgroups_per_dimension - 1u) /
      dispatch_settings.max_workgroups_per_dimension,
    1u
  );
  filter_dispatch.z = 1u;
}
`;
