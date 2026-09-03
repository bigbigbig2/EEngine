import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPU_SURFACE_ABI_WGSL } from "../../gpu/GpuSurfaceAbi.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const WORKGROUP = 8;
const GRADIENT_INDEX = counterByteOffset("gradientFallbackPixels") / 4;
const REACTIVE_INDEX = counterByteOffset("reactiveSurfacePixels") / 4;
const NORMAL_TEXTURE_INDEX = counterByteOffset("normalTexturePixels") / 4;
const ORM_TEXTURE_INDEX = counterByteOffset("ormTexturePixels") / 4;
const EMISSIVE_TEXTURE_INDEX = counterByteOffset("emissiveTexturePixels") / 4;
const UNLIT_INDEX = counterByteOffset("unlitSurfacePixels") / 4;
const IBL_SAMPLED_INDEX = counterByteOffset("iblSampledPixels") / 4;
const IBL_MIP_BASE_INDEX = counterByteOffset("iblMip0") / 4;

export const PACKED_SURFACE_COUNTER_WGSL = /* wgsl */ `
${GPU_SURFACE_ABI_WGSL}
@group(0) @binding(0) var surface_metadata: texture_2d<u32>;
@group(0) @binding(1) var surface_pbr: texture_2d<f32>;
@group(0) @binding(2) var specular_environment: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(surface_metadata);
  if any(id.xy >= size) { return; }
  let metadata = textureLoad(surface_metadata, vec2i(id.xy), 0).r;
  let flags = oengine_surface_flags(metadata);
  if (flags & OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK) != 0u {
    atomicAdd(&counters[${GRADIENT_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_REACTIVE) != 0u {
    atomicAdd(&counters[${REACTIVE_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_NORMAL_TEXTURE) != 0u {
    atomicAdd(&counters[${NORMAL_TEXTURE_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_ORM_TEXTURE) != 0u {
    atomicAdd(&counters[${ORM_TEXTURE_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE) != 0u {
    atomicAdd(&counters[${EMISSIVE_TEXTURE_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_UNLIT) != 0u {
    atomicAdd(&counters[${UNLIT_INDEX}u], 1u);
  }
  if (flags & OENGINE_SURFACE_FLAG_VALID) != 0u && (flags & OENGINE_SURFACE_FLAG_UNLIT) == 0u {
    let roughness = textureLoad(surface_pbr, vec2i(id.xy), 0).g;
    let max_mip = textureNumLevels(specular_environment) - 1u;
    let dominant_mip = min(u32(round(clamp(roughness, 0.0, 1.0) * f32(max_mip))), 8u);
    atomicAdd(&counters[${IBL_SAMPLED_INDEX}u], 1u);
    atomicAdd(&counters[${IBL_MIP_BASE_INDEX}u + dominant_mip], 1u);
  }
}
`;

const GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-B GPU Surface counters/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
  ]
};

const PIPELINE: CachedComputePipelineDescriptor = {
  label: "R4-B GPU Surface counters",
  layout: { label: "R4-B GPU Surface counters/layout", bindGroupLayouts: [GROUP] },
  compute: {
    module: { label: "R4-B GPU Surface counters", code: PACKED_SURFACE_COUNTER_WGSL },
    entryPoint: "main"
  }
};

/** Optional sampled observability; absent when the frame owns no GPU counter resource. */
export class PackedSurfaceCounterPass {
  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    width: number,
    height: number,
    inputs: { surfaceFlags: ResourceId; pbr: ResourceId; environment: ResourceId; counters: ResourceId }
  ): ResourceId {
    const builder = graph.add(
      "R4-B GPU Surface counters",
      { width: Math.max(1, width | 0), height: Math.max(1, height | 0) },
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const pass = command.constructComputePass({
          label: "R4-B GPU Surface counters",
          pipeline: PIPELINE,
          bindings: [[
            resolveTextureView(resources.get(inputs.surfaceFlags)),
            resolveTextureView(resources.get(inputs.pbr)),
            resolveTextureView(resources.get(inputs.environment)),
            { buffer: requireBuffer(resources.get(inputs.counters), "GPU counters") }
          ]]
        });
        pass.dispatchWorkgroups(
          Math.ceil(data.width / WORKGROUP),
          Math.ceil(data.height / WORKGROUP),
          1
        );
        pass.end();
      }
    );
    builder.read(inputs.surfaceFlags);
    builder.read(inputs.pbr);
    builder.read(inputs.environment);
    builder.read(inputs.counters);
    return builder.write(inputs.counters);
  }
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedSurfaceCounterPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedSurfaceCounterPass expected ${label} GPUBuffer`);
}
