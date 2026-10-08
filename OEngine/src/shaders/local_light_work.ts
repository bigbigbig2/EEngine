import {
  LIGHT_DATABASE_READ_CHUNK,
  POINT_LIGHT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR
} from "../gpu/LightDatabase.js";
import { LOCAL_LIGHT_TYPES_WGSL } from "../gpu/GpuLocalLightWorkAbi.js";

/** Portable count/scan/scatter. No subgroup, private light array or global reservation loop. */
export const LOCAL_LIGHT_WORK_WGSL = /* wgsl */ `
${LOCAL_LIGHT_TYPES_WGSL}
fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}
${LIGHT_DATABASE_READ_CHUNK.compile().text}
struct WorkSettings {
  bounds: u32,
  task_counts: u32,
  task_prefix: u32,
  counts: u32,
  cursors: u32,
  occupancy: u32,
  indirect_width: u32,
  reserved: u32,
}
@group(0) @binding(0) var<uniform> parameters: LocalLightParameters;
@group(0) @binding(1) var<uniform> settings: WorkSettings;
@group(0) @binding(2) var<storage, read> database: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> lookup: array<LocalLightLookup>;
@group(0) @binding(6) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(7) var winner: texture_2d<u32>;
@group(0) @binding(8) var depth: texture_depth_2d;

fn fail(flag: u32) {
  atomicOr(&output[2], flag);
  atomicStore(&output[1], 1u);
  atomicStore(&output[13], 0u);
}
fn finite(value: f32) -> bool {
  return value == value && abs(value) <= 3.402823e38;
}
fn light_sphere(tuple: u32) -> vec4f {
  let slot = tuple & 0xffffffu;
  var position: vec3f;
  var cutoff: f32;
  var radius: f32;
  if tuple >> 24u == 0u {
    let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(&database, slot);
    position = light.position;
    cutoff = light.distance;
    radius = light.radius;
  } else {
    let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(&database, slot);
    position = light.position;
    cutoff = light.distance;
    radius = light.radius;
  }
  let center = (parameters.view * vec4f(position, 1.0)).xyz;
  // Non-positive cutoff has infinite support; finite support includes the emitter radius.
  let support = select(-1.0, (cutoff + max(radius, 0.0)) * 1.000002 + 1e-5, cutoff > 0.0);
  return vec4f(center, support);
}

@compute @workgroup_size(64)
fn bounds(@builtin(global_invocation_id) id: vec3u) {
  let light = id.x;
  if light >= parameters.context.w {
    return;
  }
  let tuple = atomicLoad(&output[32u + light]);
  let slot = tuple & 0xffffffu;
  var address = 0xffffffffu;
  var bitmap = 0u;
  var bit = 0u;
  if tuple >> 24u == 0u {
    bit = (slot % POINT_LIGHTS_ELEMENTS_PER_PAGE) % 32u;
    address = point_lights_page_address(&database, slot / POINT_LIGHTS_ELEMENTS_PER_PAGE);
    if address != 0xffffffffu {
      bitmap = point_lights_page_bitmap_word(&database, address, (slot % POINT_LIGHTS_ELEMENTS_PER_PAGE) / 32u);
    }
  } else {
    bit = (slot % SPOT_LIGHTS_ELEMENTS_PER_PAGE) % 32u;
    address = spot_lights_page_address(&database, slot / SPOT_LIGHTS_ELEMENTS_PER_PAGE);
    if address != 0xffffffffu {
      bitmap = spot_lights_page_bitmap_word(&database, address, (slot % SPOT_LIGHTS_ELEMENTS_PER_PAGE) / 32u);
    }
  }
  if address == 0xffffffffu || (bitmap & (1u << bit)) == 0u {
    fail(8u);
    return;
  }
  let sphere = light_sphere(tuple);
  let base = settings.bounds + light * 8u;
  var lower = vec3u(0u);
  var upper = vec3u(parameters.grid.zw, 24u);
  var global = sphere.w <= 0.0 || !finite(sphere.w) || !all(vec3<bool>(finite(sphere.x), finite(sphere.y), finite(sphere.z)));
  if !global {
    let z = -sphere.z;
    if z + sphere.w <= 0.0 {
      upper = vec3u(0u);
    } else {
      lower.z = local_light_slice(max(0.0, z - sphere.w), parameters);
      upper.z = local_light_slice(z + sphere.w, parameters) + 1u;
      if z - sphere.w > parameters.depth.x {
        var min_ndc = vec2f(1e30);
        var max_ndc = vec2f(-1e30);
        // Project the enclosing AABB: valid only with all corners in front of the near plane.
        for (var corner = 0u; corner < 8u; corner++) {
          let sign_value = vec3f(select(-1.0, 1.0, (corner & 1u) != 0u), select(-1.0, 1.0, (corner & 2u) != 0u), select(-1.0, 1.0, (corner & 4u) != 0u));
          let p = sphere.xyz + sign_value * sphere.w;
          let ndc = p.xy * parameters.projection.xy / -p.z + parameters.projection.zw;
          min_ndc = min(min_ndc, ndc);
          max_ndc = max(max_ndc, ndc);
        }
        if !all(vec4<bool>(finite(min_ndc.x), finite(min_ndc.y), finite(max_ndc.x), finite(max_ndc.y))) {
          global = true;
        } else {
          let screen = vec2f(parameters.grid.xy);
          let lo = (vec2f(min_ndc.x, -max_ndc.y) * 0.5 + 0.5) * screen - 1.0;
          let hi = (vec2f(max_ndc.x, -min_ndc.y) * 0.5 + 0.5) * screen + 1.0;
          lower = vec3u(vec2u(clamp(floor(lo / 32.0), vec2f(0.0), vec2f(parameters.grid.zw))), lower.z);
          upper = vec3u(vec2u(clamp(floor(hi / 32.0) + 1.0, vec2f(0.0), vec2f(parameters.grid.zw))), upper.z);
        }
      }
    }
  }
  if global {
    let slot = atomicAdd(&output[8], 1u);
    atomicStore(&output[32u + atomicLoad(&output[9]) + slot], tuple);
    upper = lower;
  }
  let extent = upper - lower;
  let regions = extent.x * extent.y * extent.z;
  for (var axis = 0u; axis < 3u; axis++) {
    atomicStore(&scratch[base + axis], lower[axis]);
    atomicStore(&scratch[base + 3u + axis], upper[axis]);
  }
  atomicStore(&scratch[base + 6u], tuple);
  atomicStore(&scratch[base + 7u], regions);
  atomicStore(&scratch[settings.task_counts + light], (regions + 63u) / 64u);
}

var<workgroup> masks: array<u32, 64>;
@compute @workgroup_size(64)
fn occupancy(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  var mask = 0u;
  for (var sample = lane; sample < 1024u; sample += 64u) {
    let pixel = group.xy * 32u + vec2u(sample % 32u, sample / 32u);
    if all(pixel < parameters.grid.xy) {
      if textureLoad(winner, vec2i(pixel), 0).x != 0xffffffffu {
        let d = textureLoad(depth, vec2i(pixel), 0);
        let z = parameters.depth.w / (d + parameters.depth.z);
        let slice = local_light_slice(z, parameters);
        mask |= (1u << slice) | (1u << min(23u, slice + 1u)) | (1u << select(0u, slice - 1u, slice > 0u));
      }
    }
  }
  masks[lane] = mask;
  workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) {
    if lane < step {
      masks[lane] |= masks[lane + step];
    }
    workgroupBarrier();
  }
  if lane == 0u {
    atomicStore(&scratch[settings.occupancy + group.x + group.y * parameters.grid.z], masks[0]);
  }
}

@compute @workgroup_size(1)
fn schedule() {
  let n = parameters.context.w;
  var tasks = 0u;
  if n > 0u {
    tasks = atomicLoad(&scratch[settings.task_prefix + n - 1u]) + atomicLoad(&scratch[settings.task_counts + n - 1u]);
  }
  atomicStore(&output[14], tasks * 64u);
  if tasks == 0u && atomicLoad(&output[8]) == 0u && atomicLoad(&output[2]) == 0u {
    atomicStore(&output[1], 0u);
  }
  if tasks > atomicLoad(&output[15]) / 64u {
    fail(1u);
  }
  let enabled = atomicLoad(&output[1]) == 2u && tasks > 0u;
  let x = min(tasks, settings.indirect_width);
  indirect[0] = select(0u, x, enabled);
  indirect[1] = select(0u, (tasks + settings.indirect_width - 1u) / settings.indirect_width, enabled);
  indirect[2] = 1u;
}

fn sphere_intersects_cluster(sphere: vec4f, cell: vec3u) -> bool {
  let scale = log2(parameters.depth.y / parameters.depth.x) / 23.0;
  let lo_z = select(0.0, parameters.depth.x * exp2(f32(cell.z) * scale), cell.z > 0u);
  let hi_z = select(parameters.depth.x * exp2(f32(cell.z + 1u) * scale), 3.402823e38, cell.z == 23u);
  let z = -sphere.z;
  if z + sphere.w < lo_z || z - sphere.w > hi_z {
    return false;
  }
  let lo_pixel = vec2f(cell.xy * 32u) - 1.0;
  let hi_pixel = vec2f(min((cell.xy + 1u) * 32u, parameters.grid.xy)) + 1.0;
  let lo = (lo_pixel / vec2f(parameters.grid.xy) * 2.0 - 1.0 - vec2f(parameters.projection.z, -parameters.projection.w)) / parameters.projection.xy;
  let hi = (hi_pixel / vec2f(parameters.grid.xy) * 2.0 - 1.0 - vec2f(parameters.projection.z, -parameters.projection.w)) / parameters.projection.xy;
  // Four side planes, expanded by the sphere radius. Screen Y is downward.
  let p = vec2f(sphere.x, -sphere.y);
  if p.x - lo.x * z < -sphere.w * sqrt(1.0 + lo.x * lo.x) {
    return false;
  }
  if hi.x * z - p.x < -sphere.w * sqrt(1.0 + hi.x * hi.x) {
    return false;
  }
  if p.y - lo.y * z < -sphere.w * sqrt(1.0 + lo.y * lo.y) {
    return false;
  }
  if hi.y * z - p.y < -sphere.w * sqrt(1.0 + hi.y * hi.y) {
    return false;
  }
  return true;
}
var<workgroup> task_light: u32;
var<workgroup> task_sphere: vec4f;
fn pair_task(group: vec3u, lane: u32, scatter: bool) {
  let task = group.y * settings.indirect_width + group.x;
  if lane == 0u && task < atomicLoad(&output[14]) / 64u {
    // upper_bound selects the non-empty range even with repeated zero prefixes.
    var low = 0u;
    var high = parameters.context.w;
    while low < high {
      let mid = (low + high) / 2u;
      if atomicLoad(&scratch[settings.task_prefix + mid]) <= task {
        low = mid + 1u;
      }
      else {
        high = mid;
      }
    }
    task_light = low - 1u;
    task_sphere = light_sphere(atomicLoad(&scratch[settings.bounds + task_light * 8u + 6u]));
  }
  workgroupBarrier();
  if task >= atomicLoad(&output[14]) / 64u {
    return;
  }
  let base = settings.bounds + task_light * 8u;
  let region = (task - atomicLoad(&scratch[settings.task_prefix + task_light])) * 64u + lane;
  if region >= atomicLoad(&scratch[base + 7u]) {
    return;
  }
  let lower = vec3u(atomicLoad(&scratch[base]), atomicLoad(&scratch[base + 1u]), atomicLoad(&scratch[base + 2u]));
  let extent = vec3u(atomicLoad(&scratch[base + 3u]), atomicLoad(&scratch[base + 4u]), atomicLoad(&scratch[base + 5u])) - lower;
  let cell = lower + vec3u(region % extent.x, (region / extent.x) % extent.y, region / (extent.x * extent.y));
  let tile = cell.x + cell.y * parameters.grid.z;
  if (atomicLoad(&scratch[settings.occupancy + tile]) & (1u << cell.z)) == 0u {
    return;
  }
  if !sphere_intersects_cluster(task_sphere, cell) {
    return;
  }
  let cluster = tile + cell.z * parameters.grid.z * parameters.grid.w;
  if scatter {
    let cursor = atomicAdd(&scratch[settings.cursors + cluster], 1u);
    let range = lookup[cluster];
    if cursor >= range.count || range.offset + cursor >= atomicLoad(&output[11]) {
      fail(4u);
      return;
    }
    atomicStore(&output[32u + atomicLoad(&output[12]) + range.offset + cursor], atomicLoad(&scratch[base + 6u]));
  } else {
    atomicAdd(&scratch[settings.counts + cluster], 1u);
  }
}
@compute @workgroup_size(64)
fn count(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  pair_task(group, lane, false);
}
@compute @workgroup_size(64)
fn scatter(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  pair_task(group, lane, true);
}

@compute @workgroup_size(64)
fn allocate(@builtin(global_invocation_id) id: vec3u) {
  let cluster = id.x;
  let clusters = atomicLoad(&output[10]);
  if cluster >= clusters {
    return;
  }
  let offset = atomicLoad(&scratch[settings.cursors + cluster]);
  let count_value = atomicLoad(&scratch[settings.counts + cluster]);
  lookup[cluster] = LocalLightLookup(offset, count_value);
  atomicStore(&scratch[settings.cursors + cluster], 0u);
  if cluster + 1u == clusters {
    let total = offset + count_value;
    atomicStore(&output[13], total);
    if total > atomicLoad(&output[11]) {
      fail(2u);
    }
  }
}
@compute @workgroup_size(1)
fn scatter_schedule() {
  if atomicLoad(&output[1]) != 2u {
    indirect[0] = 0u;
    indirect[1] = 0u;
  }
}
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) id: vec3u) {
  if id.x < atomicLoad(&output[10]) && atomicLoad(&output[1]) == 2u {
    if atomicLoad(&scratch[settings.cursors + id.x]) != lookup[id.x].count {
      fail(4u);
    }
  }
}
`;

/** Recursive block scan uses disjoint regions in one scratch allocation. Add dispatches run top-down. */
export const LOCAL_LIGHT_SCAN_WGSL = /* wgsl */ `
struct ScanParameters {
  source: u32,
  destination: u32,
  sums: u32,
  count: u32,
}
@group(0) @binding(0) var<uniform> parameters: ScanParameters;
@group(0) @binding(1) var<storage, read_write> words: array<u32>;
var<workgroup> values: array<u32, 256>;
@compute @workgroup_size(256)
fn scan(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  var value = 0u;
  if id.x < parameters.count {
    value = words[parameters.source + id.x];
  }
  values[lane] = value;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var previous = 0u;
    if lane >= step {
      previous = values[lane - step];
    }
    workgroupBarrier();
    values[lane] += previous;
    workgroupBarrier();
  }
  if id.x < parameters.count {
    words[parameters.destination + id.x] = values[lane] - value;
  }
  if lane == 255u {
    words[parameters.sums + group.x] = values[255];
  }
}
@compute @workgroup_size(256)
fn add(@builtin(global_invocation_id) id: vec3u, @builtin(workgroup_id) group: vec3u) {
  if id.x < parameters.count {
    words[parameters.destination + id.x] += words[parameters.source + group.x];
  }
}
`;
