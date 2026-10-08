import type { GeometryHierarchyView } from "../geometry/GeometryHierarchy.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_STRIDE } from "../gpu/GpuInstanceAbi.js";
import {
  GEOMETRY_PAGE_DEMAND_MAX_PRIORITY,
  GEOMETRY_PAGE_DEMAND_FLAG_SHADOW
} from "../gpu/GeometryPageDemandAbiV1.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { HierarchicalWorkGenerator, type PreparedHierarchyWork } from "./HierarchicalWorkGenerator.js";
import {
  MeshletWorkCandidate,
  VirtualGeometryMeshletWorkCandidate,
  type PreparedMeshletWorkCandidate
} from "./MeshletWorkCandidate.js";
import type { PreparedFrameInstances } from "./FrameInstanceTransforms.js";
import type { PackedVisibilityPrepareJob } from "./passes/PackedVisibilityPass.js";
import type { VisibilityWorkSet } from "./VisibilityWorkSet.js";
import type { VsmDirectionalFrameConstants } from "./vsm/VsmReceiverDemandPass.js";

/** Union of clipmap XY coverage, extruded along the directional light.
 * No camera occlusion/cone test or camera SSE is valid for this caster view. */
export function shadowGeometryView(frame: VsmDirectionalFrameConstants): GeometryHierarchyView {
  const matrix = frame.lightView;
  if (matrix.length !== 16 || !matrix.every(Number.isFinite) || frame.clipOriginExtent.length === 0) {
    throw new RangeError("Shadow Geometry requires finite light/clipmap constants");
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y, extent] of frame.clipOriginExtent) {
    if (![x, y, extent].every(Number.isFinite) || extent <= 0) {
      throw new RangeError("Shadow Geometry clipmap coverage is invalid");
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + extent);
    maxY = Math.max(maxY, y + extent);
  }
  return {
    kind: "orthographic",
    cameraPosition: [0, 0, 0],
    viewportHeight: 1,
    verticalWorldSize: maxY - minY,
    frustumPlanes: [
      [matrix[0]!, matrix[4]!, matrix[8]!, matrix[12]! - minX],
      [-matrix[0]!, -matrix[4]!, -matrix[8]!, maxX - matrix[12]!],
      [matrix[1]!, matrix[5]!, matrix[9]!, matrix[13]! - minY],
      [-matrix[1]!, -matrix[5]!, -matrix[9]!, maxY - matrix[13]!],
      [0, 0, 0, 1],
      [0, 0, 0, 1]
    ]
  };
}

export interface PreparedShadowGeometry {
  readonly mainResources: VisibilityWorkSet;
  readonly hierarchy: PreparedHierarchyWork;
  readonly work: PreparedMeshletWorkCandidate;
  readonly instances: PreparedFrameInstances;
}

/** Geometry-owned shadow selection. Shares scene/residency, never main selected work. */
export class ShadowGeometryWork {
  private readonly hierarchy: HierarchicalWorkGenerator;
  private readonly ordinary: MeshletWorkCandidate;
  private readonly product: VirtualGeometryMeshletWorkCandidate;
  private readonly states = new Map<GpuRenderWorldRuntime, PreparedShadowGeometry>();
  private readonly allocations = new Set<PreparedShadowGeometry>();
  private destroyed = false;

  constructor(private readonly graphics: GraphicsContext) {
    this.hierarchy = new HierarchicalWorkGenerator(
      graphics.device,
      graphics.resource_accounting,
      "ShadowGeometryWork"
    );
    this.ordinary = new MeshletWorkCandidate(graphics.device, graphics.resource_accounting);
    this.product = new VirtualGeometryMeshletWorkCandidate(graphics.device, graphics.resource_accounting);
  }

  prepare(
    job: PackedVisibilityPrepareJob,
    main: VisibilityWorkSet,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext
  ): PreparedShadowGeometry | null {
    if (!job.shadowFrame) {
      this.release(job.runtime, command);
      return null;
    }
    shadowGeometryView(job.shadowFrame);
    const existing = this.states.get(job.runtime);
    if (existing?.mainResources === main) {
      this.graphics.frame_instances.rebind(existing.instances, camera);
      if (!existing.work.productMode) {
        this.ordinary.rebind(existing.work, {
          camera,
          counterBuffer: job.runtime.counterSink,
          countersEnabled: false
        });
      }
      return existing;
    }
    const hierarchy = this.hierarchy.prepare(
      {
        assets: job.assets,
        scene: job.scene,
        instanceBegin: job.runtime.instanceBegin,
        instanceCount: job.runtime.instanceCount,
        maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
        traversalWorkCapacity: job.runtime.hierarchyTraversalCapacity,
        visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
        rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
        counterBuffer: job.runtime.counterSink,
        virtualGeometry: job.virtualGeometry
      },
      {
        sseThreshold: 0,
        countersEnabled: false,
        diagnosticsEnabled: false,
        rasterExpansionEnabled: false,
        traversalWorkCapacity: main.key.traversalCapacity
      }
    );
    let work: PreparedMeshletWorkCandidate | null = null;
    let instances: PreparedFrameInstances | null = null;
    try {
      const common = {
        visibleClusters: hierarchy.generated.visibleClusters,
        visibleClusterCapacity: hierarchy.generated.visibleClusterCapacity,
        capacity: main.key.meshletWorkCandidateCapacity,
        counterBuffer: job.runtime.counterSink,
        countersEnabled: false,
        scene: job.scene
      };
      work = job.virtualGeometry
        ? this.product.prepare({
            ...common,
            virtualGeometry: job.virtualGeometry,
            viewUniform: hierarchy.generated.viewUniform
          })
        : this.ordinary.prepare({
            ...common,
            camera,
            assets: job.assets,
            compactionPath: main.key.meshletWorkCompactionPath
          });
      instances = this.graphics.frame_instances.prepare({
        camera,
        source: job.scene.instances,
        work: work.queue,
        workCapacity: work.capacity,
        instanceCapacity: Math.floor(job.scene.instances.size / GPU_INSTANCE_RECORD_STRIDE)
      });
    } catch (error) {
      if (instances) {
        this.graphics.frame_instances.release(instances);
      }
      if (work) {
        this.releaseWork(work);
      }
      this.hierarchy.release(hierarchy);
      throw error;
    }
    const next = Object.freeze({ mainResources: main, hierarchy, work, instances });
    this.allocations.add(next);
    this.states.set(job.runtime, next);
    if (existing) {
      command.destroyAfterGpuDone({ destroy: () => this.dispose(existing) });
    }
    return next;
  }

  encode(
    job: PackedVisibilityPrepareJob,
    prepared: PreparedShadowGeometry,
    command: ShadeGPUCommandContext
  ): void {
    if (!job.shadowFrame) {
      throw new Error("Shadow Geometry is missing its light view");
    }
    const generated = this.hierarchy.encode(
      command.gpu_encoder,
      prepared.hierarchy,
      shadowGeometryView(job.shadowFrame),
      {
        coneEnabled: false,
        previousHzb: null,
        requiredInstanceFlags: GPU_INSTANCE_FLAGS.CastsShadow,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent,
        demandFrameRevisionLow: job.demandFrameRevisionLow,
        pageDemandFlags: GEOMETRY_PAGE_DEMAND_MAX_PRIORITY | GEOMETRY_PAGE_DEMAND_FLAG_SHADOW
      }
    );
    if (job.streamingRuntime) {
      if (!generated.pageDemand || job.demandFrameIndex === undefined) {
        throw new Error("Shadow Geometry streaming requires a demand queue and frame identity");
      }
      job.streamingRuntime.encodeShadowDemandReadback(command, generated.pageDemand, job.demandFrameIndex);
    }
    if (prepared.work.productMode) {
      this.product.encode(command, prepared.work);
    } else {
      this.ordinary.encode(command, prepared.work);
    }
    this.graphics.frame_instances.encode(command.gpu_encoder, prepared.instances);
  }

  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    const state = this.states.get(runtime);
    if (!state) {
      return;
    }
    this.states.delete(runtime);
    command.destroyAfterGpuDone({ destroy: () => this.dispose(state) });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    for (const state of this.allocations) {
      this.dispose(state);
    }
    this.states.clear();
    this.hierarchy.destroy();
    this.ordinary.destroy();
    this.product.destroy();
    this.destroyed = true;
  }

  private releaseWork(work: PreparedMeshletWorkCandidate): void {
    if (work.productMode) {
      this.product.release(work);
    } else {
      this.ordinary.release(work);
    }
  }

  private dispose(state: PreparedShadowGeometry): void {
    if (!this.allocations.delete(state)) {
      return;
    }
    this.graphics.frame_instances.release(state.instances);
    this.releaseWork(state.work);
    this.hierarchy.release(state.hierarchy);
  }
}
