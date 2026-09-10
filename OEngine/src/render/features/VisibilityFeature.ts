import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  PackedVisibilityPass,
  type PackedVisibilityInputs,
  type PackedVisibilityJob,
  type PackedVisibilityOutputs,
  type PackedVisibilityPreparationEvidence,
  type PackedVisibilityPrepareJob,
  type PreparedPackedVisibility
} from "../passes/PackedVisibilityPass.js";

/**
 * P3 Visibility Feature：统一拥有 GPU work generation → VisibilityKey/depth
 * 的生产路径；具体 raster 算法仍由已验证的 PackedVisibilityPass 执行。
 */
export class VisibilityFeature {
  private readonly implementation: PackedVisibilityPass;

  constructor(graphics: GraphicsContext) {
    this.implementation = new PackedVisibilityPass(graphics);
  }

  get lastDrawIndirect(): boolean { return this.implementation.lastDrawIndirect; }
  get lastMeshletWorkCapacity(): number { return this.implementation.lastMeshletWorkCapacity; }
  get lastVerticesPerTriangle(): number { return this.implementation.lastVerticesPerTriangle; }
  get lastVisibilityKeyAttachmentBytes(): number {
    return this.implementation.lastVisibilityKeyAttachmentBytes;
  }
  get lastImplementation(): "hierarchy" { return this.implementation.lastImplementation; }
  get lastPreparation(): Readonly<PackedVisibilityPreparationEvidence> | null {
    return this.implementation.lastPreparation;
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): PackedVisibilityOutputs {
    return this.implementation.addToGraph(graph, job, inputs);
  }

  prepare(
    job: PackedVisibilityPrepareJob,
    counters: GPUBuffer,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext
  ): PreparedPackedVisibility {
    return this.implementation.prepareHierarchy(job, counters, camera, command);
  }

  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    this.implementation.release(runtime, command);
  }

  destroy(): void {
    this.implementation.destroy();
  }
}

export type {
  PackedVisibilityInputs,
  PackedVisibilityJob,
  PackedVisibilityOutputs,
  PackedVisibilityPreparationEvidence,
  PackedVisibilityPrepareJob,
  PreparedPackedVisibility,
  GeometryHierarchyView,
  GpuAssetBindings,
  GpuSceneBindings,
  GpuRenderWorldRuntime
};
