import { SURFACE_WORK_SETTINGS_WGSL } from "./surface_work.js";
import { SURFACE_WORK_COHERENCE_HEADER } from "../gpu/GpuSurfaceWorkAbi.js";

/** SF09 block-exclusive-scan mathematics, applied to SF11 shader buckets.
 * A bin's workgroup scans complete 64-template chunks in order. No look-back,
 * CPU choice, subgroup lane assumption or cross-workgroup wait is involved.
 * Counts are actual covered General work; padding gives every packet one tape. */
export const SURFACE_WORK_COHERENCE_WGSL = /* wgsl */ `
${SURFACE_WORK_SETTINGS_WGSL}
@group(0) @binding(0) var<uniform> settings: SurfaceWorkSettings;
@group(0) @binding(4) var<storage, read> dag_code: array<u32>;
@group(0) @binding(5) var<storage, read> work_heap: array<u32>;
@group(0) @binding(6) var<storage, read_write> work_control: array<atomic<u32>>;
var<workgroup> counts: array<u32, 64>;
var<workgroup> configuration: array<u32, 4>;
var<workgroup> scanned_total: u32;

@compute @workgroup_size(64)
fn prefix(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let config = ${SURFACE_WORK_COHERENCE_HEADER}u + group.x * 8u;
  if lane == 0u {
    configuration[0] = atomicLoad(&work_control[config]);
    configuration[1] = atomicLoad(&work_control[config + 1u]);
    configuration[2] = atomicLoad(&work_control[config + 2u]);
    configuration[3] = atomicLoad(&work_control[config + 3u]);
    scanned_total = 0u;
  }
  workgroupBarrier();
  let histogram = workgroupUniformLoad(&configuration[0]);
  let index_base = workgroupUniformLoad(&configuration[1]);
  let capacity = workgroupUniformLoad(&configuration[2]);
  let templates = workgroupUniformLoad(&configuration[3]);
  if capacity == 0u {
    return;
  }
  for (var chunk = 0u; chunk < templates; chunk += 64u) {
    let template_index = chunk + lane;
    var count = 0u;
    if template_index < templates {
      count = atomicLoad(&work_control[histogram + template_index * 3u]);
    }
    counts[lane] = ((count + 63u) / 64u) * 64u;
    workgroupBarrier();
    for (var stride = 1u; stride < 64u; stride *= 2u) {
      let at = (lane + 1u) * stride * 2u - 1u;
      if at < 64u {
        counts[at] += counts[at - stride];
      }
      workgroupBarrier();
    }
    let base = workgroupUniformLoad(&scanned_total);
    if lane == 0u {
      scanned_total += counts[63u];
      counts[63u] = 0u;
    }
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride /= 2u) {
      let at = (lane + 1u) * stride * 2u - 1u;
      if at < 64u {
        let left = counts[at - stride];
        counts[at - stride] = counts[at];
        counts[at] += left;
      }
      workgroupBarrier();
    }
    if template_index < templates {
      atomicStore(&work_control[histogram + template_index * 3u + 1u], base + counts[lane]);
    }
    workgroupBarrier();
  }
  let total = workgroupUniformLoad(&scanned_total);
  if lane == 0u {
    atomicStore(&work_control[config + 4u], total);
    atomicStore(&work_control[config + 5u], select(0u, 2u, total <= capacity));
    atomicStore(&work_control[config + 6u], u32(total > capacity));
  }
  if total <= capacity {
    // Only this frame's actual padded runs are initialized; no capacity clear.
    for (var index = lane; index < total; index += 64u) {
      atomicStore(&work_control[index_base + index], 0xffffffffu);
    }
  }
}

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let bin = settings.bank * 8u + settings.texture_set;
  let config = ${SURFACE_WORK_COHERENCE_HEADER}u + (settings.bank * 4u + settings.texture_set / 2u) * 8u;
  if id.x >= settings.lanes || atomicLoad(&work_control[config + 5u]) != 2u {
    return;
  }
  let count = atomicLoad(&work_control[bin]) * 64u;
  // Prefix can compact the indirect grid below Q. Cover the ORIGINAL queue
  // using the actual launched context count, not the maximum scratch contexts.
  let contexts = min(settings.lanes, groups.x * 64u);
  for (var item = id.x; item < count; item += contexts) {
    let tile = atomicLoad(&work_control[settings.queue_base + bin * settings.bank_tiles + item / 64u]);
    let coordinate = vec2u((tile % settings.tiles_x) * 8u + item % 8u,
      (tile / settings.tiles_x) * 8u + (item % 64u) / 8u);
    if coordinate.x >= settings.width || settings.bank * settings.bank_rows + coordinate.y >= settings.height {
      continue;
    }
    let pixel = coordinate.y * settings.width + coordinate.x;
    let entry = work_heap[pixel * settings.source_payload.y + settings.source_payload.y - 1u];
    if entry == 0xffffffffu {
      continue;
    }
    let at = entry * 16u;
    if (dag_code[at + 13u] & 0x80000000u) != 0u || dag_code[at + 8u] * 2u + 1u != settings.texture_set {
      continue;
    }
    let plan = dag_code[at + 2u];
    let bucket = atomicLoad(&work_control[config]) + dag_code[plan + 3u] * 3u;
    let rank = atomicAdd(&work_control[bucket + 2u], 1u);
    let destination = atomicLoad(&work_control[bucket + 1u]) + rank;
    atomicStore(&work_control[atomicLoad(&work_control[config + 1u]) + destination], pixel);
  }
}
`;
