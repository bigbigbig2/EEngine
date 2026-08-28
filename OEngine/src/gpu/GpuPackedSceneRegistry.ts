import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { computeIndexedPackedHierarchyWorkCapacity } from "../geometry/GeometryHierarchy.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { Scene } from "../scene/Scene.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { AssetHandle, GpuAssetBindings } from "./GpuAssetStore.js";
import type {
  GpuSceneBindings,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceSetHandle,
  InstanceSource
} from "./GpuScene.js";

declare const PACKED_SCENE_HANDLE_BRAND: unique symbol;

export interface PackedSceneHandle {
  readonly [PACKED_SCENE_HANDLE_BRAND]: true;
}

/** Device-independent input for one static/mostly-static Packed Scene set. */
export interface PackedSceneSource {
  readonly geometries: readonly GeometryAssetPackage[];
  readonly materials: readonly StandardShadeMaterial[];
  readonly count: number;
  readonly geometryIndices: Uint32Array;
  readonly materialIndices: Uint32Array;
  readonly currentTransforms: Float32Array;
  readonly previousTransforms?: Float32Array;
  readonly boundsSpheres: Float32Array;
  readonly boundsMin?: Float32Array;
  readonly boundsMax?: Float32Array;
  readonly flags?: Uint32Array;
  readonly debugIds?: Uint32Array;
}

export interface PackedSceneEvidence {
  readonly schemaVersion: 1;
  readonly sceneCount: number;
  readonly instanceCount: number;
  readonly candidateMeshletCapacity: number;
  readonly hierarchyTraversalCapacity: number;
  readonly hierarchyVisibleClusterCapacity: number;
  readonly hierarchyRasterWorkCapacity: number;
  readonly workQueueBytes: number;
  readonly privateSubmitCount: 0;
}

export interface PackedSceneRuntime {
  readonly handle: PackedSceneHandle;
  readonly scene: Scene;
  readonly assetHandles: readonly AssetHandle[];
  readonly instanceHandle: InstanceSetHandle;
  readonly materials: readonly StandardShadeMaterial[];
  readonly instanceBegin: number;
  readonly instanceCount: number;
  readonly candidateMeshletCapacity: number;
  readonly hierarchyTraversalCapacity: number;
  readonly hierarchyVisibleClusterCapacity: number;
  readonly hierarchyRasterWorkCapacity: number;
  /** Zero-based deepest reachable Cluster depth. */
  readonly hierarchyMaxDepth: number;
  readonly workQueue: GPUBuffer;
  readonly indirectArgs: GPUBuffer;
  readonly counterSink: GPUBuffer;
}

interface PendingPatch {
  readonly batch: InstancePatchBatch;
}

const HANDLE_RUNTIME = new WeakMap<object, PackedSceneRuntime>();

/**
 * Associates a CPU Scene's lights/environment with one compact Geometry +
 * Instance set. It owns only the frame-local flat work buffers; residency
 * remains uniquely owned by GpuAssetStore and GpuScene.
 */
export class GpuPackedSceneRegistry {
  private readonly byScene = new Map<Scene, PackedSceneRuntime>();
  private readonly pendingPatches = new Map<Scene, PendingPatch>();
  private readonly releasingScenes = new Set<Scene>();

  constructor(private readonly graphics: GraphicsContext) {}

  stage(
    scene: Scene,
    source: PackedSceneSource,
    assetHandles: readonly AssetHandle[],
    command: ShadeGPUCommandContext
  ): PackedSceneHandle {
    if (this.byScene.has(scene)) {
      throw new Error("Scene already has a Packed Scene registration");
    }
    validateSource(source, assetHandles);
    const hierarchyCapacity = computeIndexedPackedHierarchyWorkCapacity(
      source.geometries,
      source.geometryIndices
    );
    let candidateMeshletCapacity = 0;
    for (let index = 0; index < source.count; index++) {
      const geometry = source.geometries[source.geometryIndices[index]!]!;
      candidateMeshletCapacity += geometry.directory.meshletCount;
      if (!Number.isSafeInteger(candidateMeshletCapacity) || candidateMeshletCapacity > 0xffffffff) {
        throw new RangeError("Packed Scene candidate Meshlet capacity exceeds u32");
      }
    }
    const workQueueBytes = 16 + candidateMeshletCapacity * 8;
    const storageLimit = Math.min(
      Number(this.graphics.device.limits.maxBufferSize),
      Number(this.graphics.device.limits.maxStorageBufferBindingSize)
    );
    if (workQueueBytes > storageLimit) {
      throw new RangeError(
        `Packed Scene flat work queue requires ${workQueueBytes} bytes, adapter limit is ${storageLimit}`
      );
    }
    for (const material of source.materials) this.graphics.materials.obtain(material);
    const geometryHandles = Object.freeze([...assetHandles]);
    const materialHandles = new Uint32Array(source.count);
    for (let index = 0; index < source.count; index++) {
      materialHandles[index] = source.materials[source.materialIndices[index]!]!.id >>> 0;
    }
    const instanceSource: InstanceSource = {
      count: source.count,
      geometryHandles,
      geometryIndices: source.geometryIndices,
      materialHandles,
      currentTransforms: source.currentTransforms,
      previousTransforms: source.previousTransforms,
      boundsSpheres: source.boundsSpheres,
      boundsMin: source.boundsMin,
      boundsMax: source.boundsMax,
      flags: source.flags,
      debugIds: source.debugIds
    };
    const instanceHandle = this.graphics.gpu_scene.instantiate(instanceSource, command);
    const range = this.graphics.gpu_scene.range(instanceHandle);
    const workQueue = this.graphics.device.createBuffer({
      label: "PackedScene/flat-meshlet-work",
      size: Math.max(16, workQueueBytes),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    const indirectArgs = this.graphics.device.createBuffer({
      label: "PackedScene/hardware-indirect",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
    });
    const counterSink = this.graphics.device.createBuffer({
      label: "PackedScene/disabled-counter-sink",
      size: 256,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const handle = Object.freeze({}) as PackedSceneHandle;
    const runtime: PackedSceneRuntime = Object.freeze({
      handle,
      scene,
      assetHandles: geometryHandles,
      instanceHandle,
      materials: Object.freeze([...source.materials]),
      instanceBegin: range.start,
      instanceCount: range.count,
      candidateMeshletCapacity,
      hierarchyTraversalCapacity: hierarchyCapacity.traversalWorkCapacity,
      hierarchyVisibleClusterCapacity: hierarchyCapacity.visibleClusterCapacity,
      hierarchyRasterWorkCapacity: hierarchyCapacity.rasterWorkCapacity,
      hierarchyMaxDepth: hierarchyCapacity.maxHierarchyDepth,
      workQueue,
      indirectArgs,
      counterSink
    });
    command.onFinished.addOne(() => {
      this.byScene.set(scene, runtime);
      HANDLE_RUNTIME.set(handle as object, runtime);
    });
    command.onAborted.addOne(() => {
      workQueue.destroy();
      indirectArgs.destroy();
      counterSink.destroy();
    });
    return handle;
  }

  runtime(scene: Scene): PackedSceneRuntime | null {
    return this.byScene.get(scene) ?? null;
  }

  /**
   * Detaches one Packed Scene and releases its Instance set in the caller's
   * explicit tool command. Geometry handles remain owned by the caller until
   * the command commits, so Renderer can release them through GpuAssetStore.
   */
  release(
    scene: Scene,
    command: ShadeGPUCommandContext
  ): readonly AssetHandle[] {
    const runtime = this.byScene.get(scene);
    if (runtime === undefined) {
      throw new Error("Scene has no Packed Scene registration");
    }
    if (this.releasingScenes.has(scene)) {
      throw new Error("Packed Scene release is already pending");
    }
    if (this.pendingPatches.has(scene)) {
      throw new Error("Packed Scene must not be released with a queued patch");
    }
    this.releasingScenes.add(scene);
    this.graphics.gpu_scene.release(runtime.instanceHandle, command);
    command.onFinished.addOne(() => {
      this.byScene.delete(scene);
      HANDLE_RUNTIME.delete(runtime.handle as object);
      this.releasingScenes.delete(scene);
      const destroy = (): void => {
        runtime.workQueue.destroy();
        runtime.indirectArgs.destroy();
        runtime.counterSink.destroy();
      };
      void this.graphics.device.queue.onSubmittedWorkDone().then(destroy, destroy);
    });
    command.onAborted.addOne(() => this.releasingScenes.delete(scene));
    return runtime.assetHandles;
  }

  queuePatch(scene: Scene, batch: InstancePatchBatch): void {
    if (!this.byScene.has(scene)) throw new Error("Scene has no Packed Scene registration");
    this.pendingPatches.set(scene, { batch });
  }

  encodePendingPatch(
    scene: Scene,
    command: ShadeGPUCommandContext
  ): InstancePatchResult | null {
    const pending = this.pendingPatches.get(scene);
    if (pending === undefined) return null;
    const runtime = this.byScene.get(scene)!;
    const result = this.graphics.gpu_scene.patch(
      runtime.instanceHandle,
      pending.batch,
      command
    );
    this.pendingPatches.delete(scene);
    command.onAborted.addOne(() => this.pendingPatches.set(scene, pending));
    return result;
  }

  bindings(): { assets: GpuAssetBindings; scene: GpuSceneBindings } {
    return {
      assets: this.graphics.assets.bindings(),
      scene: this.graphics.gpu_scene.bindings()
    };
  }

  evidence(): PackedSceneEvidence {
    let instanceCount = 0;
    let candidateMeshletCapacity = 0;
    let hierarchyTraversalCapacity = 0;
    let hierarchyVisibleClusterCapacity = 0;
    let hierarchyRasterWorkCapacity = 0;
    let workQueueBytes = 0;
    for (const runtime of this.byScene.values()) {
      instanceCount += runtime.instanceCount;
      candidateMeshletCapacity += runtime.candidateMeshletCapacity;
      hierarchyTraversalCapacity += runtime.hierarchyTraversalCapacity;
      hierarchyVisibleClusterCapacity += runtime.hierarchyVisibleClusterCapacity;
      hierarchyRasterWorkCapacity += runtime.hierarchyRasterWorkCapacity;
      workQueueBytes += runtime.workQueue.size;
    }
    return Object.freeze({
      schemaVersion: 1,
      sceneCount: this.byScene.size,
      instanceCount,
      candidateMeshletCapacity,
      hierarchyTraversalCapacity,
      hierarchyVisibleClusterCapacity,
      hierarchyRasterWorkCapacity,
      workQueueBytes,
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    for (const runtime of this.byScene.values()) {
      runtime.workQueue.destroy();
      runtime.indirectArgs.destroy();
      runtime.counterSink.destroy();
    }
    this.byScene.clear();
    this.pendingPatches.clear();
    this.releasingScenes.clear();
  }
}

function validateSource(
  source: PackedSceneSource,
  assetHandles: readonly AssetHandle[]
): void {
  if (!Number.isInteger(source.count) || source.count <= 0) {
    throw new RangeError("Packed Scene count must be a positive integer");
  }
  if (source.geometries.length === 0 || source.geometries.length !== assetHandles.length) {
    throw new RangeError("Packed Scene geometry packages and resident handles must match");
  }
  if (source.materials.length === 0) throw new RangeError("Packed Scene requires materials");
  assertLength(source.geometryIndices, source.count, "geometryIndices");
  assertLength(source.materialIndices, source.count, "materialIndices");
  assertLength(source.currentTransforms, source.count * 16, "currentTransforms");
  if (source.previousTransforms) assertLength(source.previousTransforms, source.count * 16, "previousTransforms");
  assertLength(source.boundsSpheres, source.count * 4, "boundsSpheres");
  if (source.boundsMin) assertLength(source.boundsMin, source.count * 3, "boundsMin");
  if (source.boundsMax) assertLength(source.boundsMax, source.count * 3, "boundsMax");
  if (source.flags) assertLength(source.flags, source.count, "flags");
  if (source.debugIds) assertLength(source.debugIds, source.count, "debugIds");
  for (let index = 0; index < source.count; index++) {
    if (source.geometryIndices[index]! >= source.geometries.length) {
      throw new RangeError(`geometryIndices[${index}] is outside the geometry package dictionary`);
    }
    if (source.materialIndices[index]! >= source.materials.length) {
      throw new RangeError(`materialIndices[${index}] is outside the material dictionary`);
    }
  }
}

function assertLength(value: ArrayLike<unknown>, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new RangeError(`${label} length ${value.length} does not match ${expected}`);
  }
}
