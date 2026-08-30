/** 将统一的 Render Debug View 覆盖写入主管线最终 HDR 输入。 */

import type { RenderDebugView } from "../../debug/RenderDebugView.js";
import { RenderDebugView as RenderDebugViewValue } from "../../debug/RenderDebugView.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPU_VISIBILITY_DEBUG_SETTINGS_SIZE } from "../../gpu/GpuVisibilityDebugResolve.js";
import type { PackedVisibilityDebugSource } from "./PackedVisibilityPass.js";
import {
  DEPTH_DEBUG_WGSL,
  PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL,
  RENDER_DEBUG_VIEW_FORMAT,
  SURFACE_AO_DEBUG_WGSL,
  SURFACE_COLOR_DEBUG_WGSL,
  SURFACE_EMISSIVE_DEBUG_WGSL,
  SURFACE_FLAGS_DEBUG_WGSL,
  SURFACE_NORMAL_DEBUG_WGSL,
  SURFACE_PBR_DEBUG_WGSL,
  VELOCITY_DEBUG_WGSL,
  VISIBILITY_KEY_DEBUG_WGSL
} from "../../shaders/render_debug_view.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export type RenderDebugViewResources = {
  meshId: ResourceId | null;
  triangleId: ResourceId | null;
  visibilityKey: ResourceId | null;
  packedVisibility: PackedVisibilityDebugSource | null;
  depth: ResourceId;
  velocity: ResourceId | null;
  gPbr: ResourceId;
  gNormal: ResourceId;
  gAlbedo: ResourceId;
  gEmissive: ResourceId;
  surfaceFlags: ResourceId | null;
};

export class RenderDebugViewPass {
  private readonly pipelines: ReadonlyMap<
    RenderDebugView,
    CachedRenderPipelineDescriptor
  >;
  private readonly packedVisibilityPipeline: CachedRenderPipelineDescriptor;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("RenderDebugViewPass: GraphicsContext has no device");
    }
    this.pipelines = new Map([
      [
        RenderDebugViewValue.VisibilityKey,
        createPipeline(
          "Render debug/Visibility key",
          VISIBILITY_KEY_DEBUG_WGSL,
          [uintTextureEntry(0), uintTextureEntry(1), uniformEntry(2)]
        )
      ],
      [
        RenderDebugViewValue.Depth,
        createPipeline(
          "Render debug/Reverse-Z depth",
          DEPTH_DEBUG_WGSL,
          [depthTextureEntry(0), uniformEntry(1)]
        )
      ],
      [
        RenderDebugViewValue.Velocity,
        createPipeline(
          "Render debug/Velocity",
          VELOCITY_DEBUG_WGSL,
          [floatTextureEntry(0), uintTextureEntry(1), uniformEntry(2)]
        )
      ],
      [
        RenderDebugViewValue.BaseColor,
        createPipeline("Render debug/Base color", SURFACE_COLOR_DEBUG_WGSL, [floatTextureEntry(0), uintTextureEntry(1), uniformEntry(2)])
      ],
      [
        RenderDebugViewValue.ShadingNormal,
        createPipeline("Render debug/Shading normal", SURFACE_NORMAL_DEBUG_WGSL, [uintTextureEntry(0), uintTextureEntry(1), uniformEntry(2)])
      ],
      [
        RenderDebugViewValue.Metallic,
        createPipeline("Render debug/Metallic", SURFACE_PBR_DEBUG_WGSL, [floatTextureEntry(0), uintTextureEntry(1), uniformEntry(2), uniformEntry(3, 16)])
      ],
      [
        RenderDebugViewValue.Roughness,
        createPipeline("Render debug/Roughness", SURFACE_PBR_DEBUG_WGSL, [floatTextureEntry(0), uintTextureEntry(1), uniformEntry(2), uniformEntry(3, 16)])
      ],
      [
        RenderDebugViewValue.Occlusion,
        createPipeline("Render debug/Occlusion", SURFACE_AO_DEBUG_WGSL, [floatTextureEntry(0), uintTextureEntry(1), uniformEntry(2)])
      ],
      [
        RenderDebugViewValue.Emissive,
        createPipeline("Render debug/Emissive", SURFACE_EMISSIVE_DEBUG_WGSL, [uintTextureEntry(0), uintTextureEntry(1), uniformEntry(2)])
      ],
      [
        RenderDebugViewValue.MaterialId,
        createPipeline("Render debug/Material ID", SURFACE_FLAGS_DEBUG_WGSL, [uintTextureEntry(0), uniformEntry(1), uniformEntry(2, 16)])
      ],
      [
        RenderDebugViewValue.HistoryValidity,
        createPipeline("Render debug/History validity", SURFACE_FLAGS_DEBUG_WGSL, [uintTextureEntry(0), uniformEntry(1), uniformEntry(2, 16)])
      ],
      [
        RenderDebugViewValue.Reactive,
        createPipeline("Render debug/Reactive", SURFACE_FLAGS_DEBUG_WGSL, [uintTextureEntry(0), uniformEntry(1), uniformEntry(2, 16)])
      ]
    ]);
    this.packedVisibilityPipeline = createPipeline(
      "R4-A-04 Render debug/Packed Visibility resolve",
      PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL,
      [
        uintTextureEntry(0),
        storageBufferEntry(1),
        storageBufferEntry(2),
        storageBufferEntry(3),
        storageBufferEntry(4),
        storageBufferEntry(5),
        uniformEntry(6, GPU_VISIBILITY_DEBUG_SETTINGS_SIZE)
      ]
    );
  }

  addToGraph(
    graph: FrameGraph,
    view: RenderDebugView,
    resources: RenderDebugViewResources,
    outputWidth: number,
    outputHeight: number
  ): ResourceId {
    const packedVisibility =
      view === RenderDebugViewValue.VisibilityKey &&
      resources.visibilityKey !== null &&
      resources.packedVisibility !== null
        ? resources.packedVisibility
        : null;
    const pipeline = packedVisibility === null
      ? this.pipelines.get(view)
      : this.packedVisibilityPipeline;
    if (pipeline === undefined) {
      throw new Error(`RenderDebugViewPass cannot render '${view}'`);
    }
    const inputIds = inputResourceIds(view, resources, packedVisibility !== null);
    let output = -1;
    const builder = graph.add(
      `Render debug/${view}`,
      { outputWidth, outputHeight, packedVisibility },
      (data, resolved, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const lookup = data.packedVisibility?.resolve() ?? null;
        const settings = command.allocateTransientBufferAndLoad(
          new Uint32Array(lookup === null
            ? [data.outputWidth, data.outputHeight]
            : [
              data.outputWidth,
              data.outputHeight,
              lookup.meshletRecordCount,
              lookup.clusterRecordCount,
              lookup.instanceCount,
              lookup.geometryRecordCount,
              lookup.materialCapacity,
              0
            ]).buffer,
          GPUBufferUsage.UNIFORM
        );
        const bindings: GPUBindingResource[] = inputIds.map((id) =>
          resolveTextureView(resolved.get(id))
        );
        if (lookup !== null) {
          bindings.push(
            { buffer: lookup.instances },
            { buffer: lookup.meshlets },
            { buffer: lookup.visibleClusters },
            { buffer: lookup.rasterWork },
            { buffer: lookup.materials }
          );
        }
        bindings.push({ buffer: settings });
        const mode = debugMode(view);
        if (mode !== null) {
          const modeBuffer = command.allocateTransientBufferAndLoad(
            new Uint32Array([mode, 0, 0, 0]).buffer,
            GPUBufferUsage.UNIFORM
          );
          bindings.push({ buffer: modeBuffer });
        }
        const pass = command.constructRenderPass({
          label: `Render debug/${view}`,
          pipeline,
          bindings: [bindings],
          colorAttachments: [{
            view: resolveTextureView(resolved.get(output)),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.draw(3, 1, 0, 0);
        pass.end();
      }
    );
    for (const input of inputIds) builder.read(input);
    output = builder.create(`Render debug/${view} output`, {
      kind: "transient_texture",
      label: `Render debug/${view} rgba16float`,
      width: outputWidth,
      height: outputHeight,
      format: RENDER_DEBUG_VIEW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    return output;
  }

  destroy(): void {}
}

function inputResourceIds(
  view: RenderDebugView,
  resources: RenderDebugViewResources,
  packedVisibility: boolean
): ResourceId[] {
  switch (view) {
    case RenderDebugViewValue.VisibilityKey:
      if (packedVisibility) return [resources.visibilityKey!];
      if (resources.meshId === null || resources.triangleId === null) {
        throw new Error("RenderDebugViewPass requires legacy visibility IDs");
      }
      return [resources.meshId, resources.triangleId];
    case RenderDebugViewValue.Depth:
      return [resources.depth];
    case RenderDebugViewValue.Velocity:
      if (resources.velocity === null) {
        throw new Error("RenderDebugViewPass requires a velocity resource");
      }
      return [resources.velocity, requireSurfaceMetadata(view, resources)];
    case RenderDebugViewValue.BaseColor:
    case RenderDebugViewValue.Occlusion:
      return [resources.gAlbedo, requireSurfaceMetadata(view, resources)];
    case RenderDebugViewValue.ShadingNormal:
      return [resources.gNormal, requireSurfaceMetadata(view, resources)];
    case RenderDebugViewValue.Metallic:
    case RenderDebugViewValue.Roughness:
      return [resources.gPbr, requireSurfaceMetadata(view, resources)];
    case RenderDebugViewValue.Emissive:
      return [resources.gEmissive, requireSurfaceMetadata(view, resources)];
    case RenderDebugViewValue.MaterialId:
    case RenderDebugViewValue.HistoryValidity:
    case RenderDebugViewValue.Reactive:
      if (resources.surfaceFlags === null) {
        throw new Error(`RenderDebugViewPass requires Surface metadata for '${view}'`);
      }
      return [resources.surfaceFlags];
    default:
      throw new Error(`RenderDebugViewPass has no resource contract for '${view}'`);
  }
}

function createPipeline(
  label: string,
  code: string,
  entries: GPUBindGroupLayoutEntry[]
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [{ label: `${label} group0`, entries }]
    },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: RENDER_DEBUG_VIEW_FORMAT }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function uintTextureEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: "uint", viewDimension: "2d" }
  };
}

function floatTextureEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
  };
}

function depthTextureEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: "depth", viewDimension: "2d" }
  };
}

function uniformEntry(
  binding: number,
  minBindingSize?: number
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "uniform", minBindingSize }
  };
}

function debugMode(view: RenderDebugView): number | null {
  switch (view) {
    case RenderDebugViewValue.Metallic:
    case RenderDebugViewValue.MaterialId:
      return 0;
    case RenderDebugViewValue.Roughness:
    case RenderDebugViewValue.HistoryValidity:
      return 1;
    case RenderDebugViewValue.Reactive:
      return 2;
    default:
      return null;
  }
}

function requireSurfaceMetadata(
  view: RenderDebugView,
  resources: RenderDebugViewResources
): ResourceId {
  if (resources.surfaceFlags === null) {
    throw new Error(`RenderDebugViewPass requires Surface metadata for '${view}'`);
  }
  return resources.surfaceFlags;
}

function storageBufferEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "read-only-storage" }
  };
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("RenderDebugViewPass requires ShadeGPUCommandContext");
}
