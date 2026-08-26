import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";

export const VISIBILITY_COUNTER_WORKGROUP_SIZE = 8;
const WORKGROUP_ELEMENT_COUNT =
  VISIBILITY_COUNTER_WORKGROUP_SIZE * VISIBILITY_COUNTER_WORKGROUP_SIZE;
const SHADED_PIXEL_INDEX = counterByteOffset("shadedPixels") / 4;
const EMPTY_PIXEL_INDEX = counterByteOffset("emptyVisibilityPixels") / 4;

export const VISIBILITY_COUNTER_WGSL = /* wgsl */ `
const MESH_SENTINEL: u32 = ${VIS_MESH_CLEAR_SENTINEL}u;

@group(0) @binding(0) var mesh_ids: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write>
  frame_counters: array<atomic<u32>>;

var<workgroup> local_counts: array<vec2u, ${WORKGROUP_ELEMENT_COUNT}>;

@compute @workgroup_size(${VISIBILITY_COUNTER_WORKGROUP_SIZE}, ${VISIBILITY_COUNTER_WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) global_id: vec3u,
  @builtin(local_invocation_index) local_index: u32
) {
  let dimensions = textureDimensions(mesh_ids);
  var pixel_counts = vec2u(0u);
  if (global_id.x < dimensions.x && global_id.y < dimensions.y) {
    let mesh_id = textureLoad(mesh_ids, vec2i(global_id.xy), 0).r;
    if (mesh_id == MESH_SENTINEL) {
      pixel_counts.y = 1u;
    } else {
      pixel_counts.x = 1u;
    }
  }
  local_counts[local_index] = pixel_counts;
  workgroupBarrier();

  var stride = ${WORKGROUP_ELEMENT_COUNT / 2}u;
  loop {
    if (stride == 0u) { break; }
    if (local_index < stride) {
      local_counts[local_index] += local_counts[local_index + stride];
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }

  if (local_index == 0u) {
    atomicAdd(&frame_counters[${SHADED_PIXEL_INDEX}u], local_counts[0].x);
    atomicAdd(&frame_counters[${EMPTY_PIXEL_INDEX}u], local_counts[0].y);
  }
}
`;

const VISIBILITY_COUNTER_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "R0 visibility counters/group0",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "uint", viewDimension: "2d" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    }
  ]
};

const VISIBILITY_COUNTER_PIPELINE: CachedComputePipelineDescriptor = {
  label: "R0 visibility pixel counters",
  layout: {
    label: "R0 visibility counters/layout",
    bindGroupLayouts: [VISIBILITY_COUNTER_LAYOUT]
  },
  compute: {
    module: {
      label: "R0 visibility pixel counters",
      code: VISIBILITY_COUNTER_WGSL
    },
    entryPoint: "main"
  }
};

export class VisibilityCounterPass {
  addToGraph(
    graph: FrameGraph,
    size: { width: number; height: number },
    inputs: { meshId: ResourceId; counters: ResourceId }
  ): void {
    const dispatch = visibilityCounterDispatchSize(size.width, size.height);
    const builder = graph.add(
      "R0 visibility pixel counters",
      { dispatch },
      (data, resources, context) => {
        const command = requireCommandContext(context.encoder);
        const pass = command.constructComputePass({
          label: "R0 visibility pixel counters",
          pipeline: VISIBILITY_COUNTER_PIPELINE,
          bindings: [[
            resolveTextureView(resources.get(inputs.meshId)),
            { buffer: resolveBuffer(resources.get(inputs.counters)) }
          ]]
        });
        pass.dispatchWorkgroups(data.dispatch[0], data.dispatch[1], 1);
        pass.end();
      }
    );
    builder.read(inputs.meshId);
    builder.write(inputs.counters);
    builder.make_side_effect();
  }
}

export function visibilityCounterDispatchSize(
  width: number,
  height: number
): [number, number] {
  assertPositiveInteger(width, "width");
  assertPositiveInteger(height, "height");
  return [
    Math.ceil(width / VISIBILITY_COUNTER_WORKGROUP_SIZE),
    Math.ceil(height / VISIBILITY_COUNTER_WORKGROUP_SIZE)
  ];
}

function requireCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("VisibilityCounterPass requires ShadeGPUCommandContext");
}

function resolveBuffer(value: unknown): GPUBuffer {
  if (
    value &&
    typeof value === "object" &&
    "size" in value &&
    "usage" in value
  ) {
    return value as GPUBuffer;
  }
  throw new Error("VisibilityCounterPass expected a GPUBuffer");
}

function resolveTextureView(value: unknown): GPUTextureView {
  if (!value || typeof value !== "object") {
    throw new Error("VisibilityCounterPass expected a texture resource");
  }
  if (
    "createView" in value &&
    typeof (value as { createView?: unknown }).createView === "function"
  ) {
    return (value as { createView: () => GPUTextureView }).createView();
  }
  return value as GPUTextureView;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
