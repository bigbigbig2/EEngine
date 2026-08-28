import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS,
  GPU_MATERIAL_VISIBILITY_RECORD_WGSL
} from "../../gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_RASTER_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} from "../../gpu/GpuWorkGenerationAbi.js";

export const PACKED_ALPHA_COUNTER_WORKGROUP_SIZE = 64;
const ALPHA_CLUSTER_INDEX = counterByteOffset("alphaClusters") / 4;
const READ_QUEUE_HEADER_WGSL = GPU_WORK_QUEUE_HEADER_SCHEMA.wgsl.replaceAll(
  "atomic<u32>",
  "u32"
);

export const PACKED_VISIBILITY_ALPHA_COUNTER_WGSL = /* wgsl */ `
${READ_QUEUE_HEADER_WGSL}
${GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.wgsl}
${GPU_RASTER_WORK_SCHEMA.wgsl}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}

struct R4VisibleClusterQueueRead {
  header: OEngineWorkQueueHeader,
  elements: array<OEngineVisibleClusterRecord>,
}

struct R4RasterWorkQueueRead {
  header: OEngineWorkQueueHeader,
  elements: array<OEngineRasterWork>,
}

@group(0) @binding(0) var<storage, read> visible_clusters: R4VisibleClusterQueueRead;
@group(0) @binding(1) var<storage, read> raster_work: R4RasterWorkQueueRead;
@group(0) @binding(2) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(3) var<storage, read_write> frame_counters: array<atomic<u32>>;

@compute @workgroup_size(${PACKED_ALPHA_COUNTER_WORKGROUP_SIZE})
fn count_alpha_raster_work(
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(workgroup_id) group_id: vec3u,
  @builtin(num_workgroups) group_count: vec3u
) {
  let linear_group = group_id.y * group_count.x + group_id.x;
  let raster_slot = linear_group * ${PACKED_ALPHA_COUNTER_WORKGROUP_SIZE}u + local_id.x;
  let raster_written = min(raster_work.header.written, raster_work.header.capacity);
  if raster_slot >= raster_written {
    return;
  }
  let visible_slot = raster_work.elements[raster_slot].visible_cluster_slot;
  let visible_written = min(visible_clusters.header.written, visible_clusters.header.capacity);
  if visible_slot >= visible_written {
    return;
  }
  let material_handle = visible_clusters.elements[visible_slot].material_handle;
  if material_handle >= arrayLength(&materials) {
    return;
  }
  let material = materials[material_handle];
  if material.material_id != material_handle ||
    (material.flags & ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid}u) == 0u {
    return;
  }
  if material.alpha_mode == ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask}u {
    atomicAdd(&frame_counters[${ALPHA_CLUSTER_INDEX}u], 1u);
  }
}
`;

const PACKED_VISIBILITY_ALPHA_COUNTER_PIPELINE: CachedComputePipelineDescriptor = {
  label: "R4-A-06 Packed alpha RasterWork counter",
  layout: {
    label: "R4-A-06 Packed alpha RasterWork counter/layout",
    bindGroupLayouts: [{
      label: "R4-A-06 Packed alpha RasterWork counter/group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
      ]
    }]
  },
  compute: {
    module: {
      label: "R4-A-06 Packed alpha RasterWork counter",
      code: PACKED_VISIBILITY_ALPHA_COUNTER_WGSL
    },
    entryPoint: "count_alpha_raster_work"
  }
};

export function encodePackedVisibilityAlphaCounter(
  command: ShadeGPUCommandContext,
  inputs: {
    visibleClusters: GPUBuffer;
    rasterWork: GPUBuffer;
    materials: GPUBuffer;
    counters: GPUBuffer;
    rasterWorkCapacity: number;
  }
): void {
  const [workgroupsX, workgroupsY] = packedVisibilityAlphaCounterDispatchSize(
    inputs.rasterWorkCapacity,
    command.device.limits.maxComputeWorkgroupsPerDimension
  );
  const pass = command.constructComputePass({
    label: "R4-A-06 observability/Packed alpha RasterWork counter",
    pipeline: PACKED_VISIBILITY_ALPHA_COUNTER_PIPELINE,
    bindings: [[
      { buffer: inputs.visibleClusters },
      { buffer: inputs.rasterWork },
      { buffer: inputs.materials },
      { buffer: inputs.counters }
    ]]
  });
  pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
  pass.end();
}

export function packedVisibilityAlphaCounterDispatchSize(
  rasterWorkCapacity: number,
  maxWorkgroupsPerDimension: number
): readonly [number, number] {
  assertPositiveInteger(rasterWorkCapacity, "rasterWorkCapacity");
  assertPositiveInteger(maxWorkgroupsPerDimension, "maxWorkgroupsPerDimension");
  const linearWorkgroups = Math.ceil(
    rasterWorkCapacity / PACKED_ALPHA_COUNTER_WORKGROUP_SIZE
  );
  const x = Math.min(linearWorkgroups, maxWorkgroupsPerDimension);
  const y = Math.ceil(linearWorkgroups / x);
  if (y > maxWorkgroupsPerDimension) {
    throw new RangeError(
      `Packed alpha counter requires ${linearWorkgroups} workgroups, adapter 2D limit is ` +
      `${maxWorkgroupsPerDimension}x${maxWorkgroupsPerDimension}`
    );
  }
  return [x, y];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}
