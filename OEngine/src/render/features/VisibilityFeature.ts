import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { ShadowGeometryWork } from "../ShadowGeometryWork.js";
import {
  PackedVisibilityPass,
  type PackedVisibilityInputs,
  type PackedVisibilityJob,
  type PackedVisibilityLateRecheckInputs,
  type PackedVisibilityOutputs,
  type PackedVisibilityPreparationEvidence,
  type PackedVisibilityPrepareJob,
  type PreparedPackedVisibility,
} from "../passes/PackedVisibilityPass.js";

/**
 * P3 Visibility Feature：统一拥有 GPU work generation → VisibilityKey/depth
 * 的生产路径；具体 raster 算法仍由已验证的 PackedVisibilityPass 执行。
 */
export class VisibilityFeature {
  private readonly implementation: PackedVisibilityPass;
  private readonly shadow: ShadowGeometryWork;

  constructor(graphics: GraphicsContext) {
    this.implementation = new PackedVisibilityPass(graphics);
    this.shadow = new ShadowGeometryWork(graphics);
  }

  get lastDrawIndirect(): boolean {
    return this.implementation.lastDrawIndirect;
  }
  get lastMeshletWorkCapacity(): number {
    return this.implementation.lastMeshletWorkCapacity;
  }
  get lastVerticesPerTriangle(): number {
    return this.implementation.lastVerticesPerTriangle;
  }
  get lastVisibilityKeyAttachmentBytes(): number {
    return this.implementation.lastVisibilityKeyAttachmentBytes;
  }
  get lastImplementation(): "hierarchy" {
    return this.implementation.lastImplementation;
  }
  get lastPreparation(): Readonly<PackedVisibilityPreparationEvidence> | null {
    return this.implementation.lastPreparation;
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs,
  ): PackedVisibilityOutputs {
    return this.implementation.addToGraph(graph, job, inputs);
  }

  addCurrentHzbLateRecheckToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityLateRecheckInputs,
  ): PackedVisibilityOutputs {
    return this.implementation.addCurrentHzbLateRecheckToGraph(graph, job, inputs);
  }

  prepare(
    job: PackedVisibilityPrepareJob,
    counters: GPUBuffer,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext,
  ): PreparedPackedVisibility {
    const prepared = this.implementation.prepareHierarchy(job, counters, camera, command);
    return Object.freeze({
      ...prepared,
      shadowGeometry: this.shadow.prepare(job, prepared.workSet, camera, command)
    });
  }

  addShadowToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: {
      camera: ResourceId;
      instances: ResourceId;
      meshletWork: ResourceId;
      frameInstances: ResourceId;
      productHeap?: ResourceId;
      productBanks?: readonly ResourceId[];
      geometrySources: readonly ResourceId[];
    }
  ): { meshletWork: ResourceId; frameInstances: ResourceId } {
    const prepared = job.prepared.shadowGeometry;
    if (!prepared) {
      throw new Error("VSM requires independently prepared Shadow Geometry");
    }
    const pass = graph.add("Geometry/shadow view work", job, (data, _resources, context) => {
      if (!data.prepared.shadowGeometry) {
        throw new Error("Shadow Geometry publication is missing");
      }
      this.shadow.encode(data, data.prepared.shadowGeometry, context.encoder as ShadeGPUCommandContext);
    });
    pass.read(inputs.camera);
    pass.read(inputs.instances);
    for (const source of inputs.geometrySources) {
      pass.read(source);
    }
    if (inputs.productHeap !== undefined) {
      pass.read(inputs.productHeap);
    }
    for (const bank of inputs.productBanks ?? []) {
      pass.read(bank);
    }
    return { meshletWork: pass.write(inputs.meshletWork), frameInstances: pass.write(inputs.frameInstances) };
  }

  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    this.shadow.release(runtime, command);
    this.implementation.release(runtime, command);
  }

  destroy(): void {
    this.shadow.destroy();
    this.implementation.destroy();
  }
}

export type {
  PackedVisibilityInputs,
  PackedVisibilityJob,
  PackedVisibilityLateRecheckInputs,
  PackedVisibilityOutputs,
  PackedVisibilityPreparationEvidence,
  PackedVisibilityPrepareJob,
  PreparedPackedVisibility,
  GeometryHierarchyView,
  GpuAssetBindings,
  GpuSceneBindings,
  GpuRenderWorldRuntime,
};
