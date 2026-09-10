import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import { computeIndexedPackedHierarchyWorkCapacity } from "../geometry/GeometryHierarchy.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { ShadeDrawSide, ShadeTransparencyMode } from "../material/enums.js";
import {
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK,
  encodeInstanceMaterialKernelClass
} from "./GpuInstanceAbi.js";
import {
  GPU_MATERIAL_KERNEL_CLASS_COUNT,
  materialKernelClass
} from "./GpuMaterialKernelAbi.js";
import type { Scene } from "../scene/Scene.js";
import type { Mesh } from "../scene/Mesh.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { SceneResidencyManifest } from "./GpuSceneResidencyManifest.js";
import {
  composeGpuPackedMaterialBindings,
  type GpuPackedMaterialBindings
} from "./GpuPackedMaterialBindings.js";
import type { AssetHandle, GpuAssetBindings } from "./GpuAssetStore.js";
import type {
  GpuSceneBindings,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceSetHandle,
  InstanceSource,
  InstanceTransformPatch
} from "./GpuScene.js";
import type { ResourceHandle as AccountingResourceHandle } from "../debug/profiling/ResourceAccounting.js";

declare const GPU_RENDER_WORLD_HANDLE_BRAND: unique symbol;

export interface GpuRenderWorldHandle {
  readonly [GPU_RENDER_WORLD_HANDLE_BRAND]: true;
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

export interface PackedSceneMaterialPatch {
  readonly indices: Uint32Array;
  /** Indices into the Packed Scene material dictionary, never GPU slots or material.id. */
  readonly materialIndices: Uint32Array;
}

export interface PackedScenePatchBatch {
  readonly frameId: number;
  readonly transforms?: InstanceTransformPatch;
  readonly materials?: PackedSceneMaterialPatch;
}

export interface GpuRenderWorldEvidence {
  readonly schemaVersion: 3;
  readonly sceneCount: number;
  readonly packedSourceCount: number;
  readonly ordinarySceneAdapterCount: number;
  readonly ordinaryScenePatchCount: number;
  readonly ordinarySceneStableFrameCount: number;
  readonly ordinarySceneFullResyncRequiredCount: number;
  readonly instanceCount: number;
  readonly hierarchyTraversalCapacity: number;
  readonly hierarchyVisibleClusterCapacity: number;
  readonly hierarchyRasterWorkCapacity: number;
  readonly flatWorkBytes: 0;
  readonly privateSubmitCount: 0;
}

export interface GpuRenderWorldRuntime {
  readonly handle: GpuRenderWorldHandle;
  readonly scene: Scene;
  readonly sourceKind: "packed" | "ordinary-scene";
  readonly assetHandles: readonly AssetHandle[];
  readonly instanceHandle: InstanceSetHandle;
  readonly materials: readonly StandardShadeMaterial[];
  /** Frozen material-dictionary population addressable by opaque Material Resolve. */
  readonly opaqueMaterialCount: number;
  readonly materialSlots: readonly number[];
  readonly materialResources: GpuPackedMaterialBindings;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  /** Number of resident instances whose current material class is BLEND. */
  readonly transparentInstanceCount: number;
  /** Bit N is set when at least one resident OPAQUE/MASK instance uses kernel class N. */
  readonly activeKernelMask: number;
  readonly hierarchyTraversalCapacity: number;
  readonly hierarchyVisibleClusterCapacity: number;
  readonly hierarchyRasterWorkCapacity: number;
  /** Zero-based deepest reachable Cluster depth. */
  readonly hierarchyMaxDepth: number;
  readonly counterSink: GPUBuffer;
}

interface PendingPatch {
  readonly batch: PackedScenePatchBatch;
}

interface PackedSceneClassificationState {
  readonly materialIndices: Uint32Array;
  readonly opaqueKernelClassCounts: Uint32Array;
  transparentInstanceCount: number;
}

interface OrdinarySceneAdapterState {
  readonly meshes: readonly Mesh[];
  readonly instanceIndexByMesh: ReadonlyMap<Mesh, number>;
  readonly materialIndexByMaterial: ReadonlyMap<StandardShadeMaterial, number>;
  lastRevision: number;
}

const HANDLE_RUNTIME = new WeakMap<object, GpuRenderWorldRuntime>();

/**
 * Associates a CPU Scene's lights/environment with one compact Geometry +
 * Instance set. Residency remains uniquely owned by GpuAssetStore and
 * GpuScene; frame-local hierarchy work is owned by HierarchicalWorkGenerator.
 */
export class GpuRenderWorld {
  private readonly accountedCounterSinks = new Map<GPUBuffer, AccountingResourceHandle>();
  private readonly byScene = new Map<Scene, GpuRenderWorldRuntime>();
  private readonly pendingPatches = new Map<Scene, PendingPatch>();
  private readonly releasingScenes = new Set<Scene>();
  private readonly classificationByScene = new Map<Scene, PackedSceneClassificationState>();
  private readonly ordinaryAdapters = new Map<Scene, OrdinarySceneAdapterState>();
  private ordinaryScenePatchCount = 0;
  private ordinarySceneStableFrameCount = 0;
  private ordinarySceneFullResyncRequiredCount = 0;

  constructor(private readonly graphics: GraphicsContext) {}

  stage(
    scene: Scene,
    manifest: SceneResidencyManifest,
    assetHandles: readonly AssetHandle[],
    command: ShadeGPUCommandContext,
    ordinaryMeshes?: readonly Mesh[]
  ): GpuRenderWorldHandle {
    if (this.byScene.has(scene)) {
      throw new Error("Scene already has a GPU Render World registration");
    }
    const source = manifest.source;
    if (manifest.packages.length !== source.geometries.length ||
      manifest.materials.length !== source.materials.length) {
      throw new Error("GPU Render World manifest dictionaries do not match its source");
    }
    validateSource(source, assetHandles);
    const hierarchyCapacity = computeIndexedPackedHierarchyWorkCapacity(
      source.geometries,
      source.geometryIndices
    );
    const textureStage = this.graphics.texture_residency.stage(source.materials, command);
    const materialStage = this.graphics.material_store.stage(
      source.materials,
      textureStage.textureRoutingRefs,
      command
    );
    const geometryHandles = Object.freeze([...assetHandles]);
    const materialHandles = new Uint32Array(source.count);
    for (let index = 0; index < source.count; index++) {
      materialHandles[index] = materialStage.materialSlots[source.materialIndices[index]!]!;
    }
    const normalizedFlags = new Uint32Array(source.count);
    for (let index = 0; index < source.count; index++) {
      const material = source.materials[source.materialIndices[index]!]!;
      normalizedFlags[index] = materialClassificationFlags(
        material,
        source.flags?.[index] ?? 0
      );
    }
    const classification: PackedSceneClassificationState = {
      materialIndices: source.materialIndices.slice(),
      opaqueKernelClassCounts: countOpaqueKernelClasses(
        source.materialIndices,
        source.materials
      ),
      transparentInstanceCount: countTransparentInstances(
        source.materialIndices,
        source.materials
      )
    };
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
      flags: normalizedFlags,
      debugIds: source.debugIds
    };
    const instanceHandle = this.graphics.gpu_scene.instantiate(instanceSource, command);
    const range = this.graphics.gpu_scene.range(instanceHandle);
    const counterSink = this.createCounterSink({
      label: "GpuRenderWorld/disabled-counter-sink",
      size: GPU_COUNTER_BYTE_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const handle = Object.freeze({}) as GpuRenderWorldHandle;
    const runtime: GpuRenderWorldRuntime = Object.freeze({
      handle,
      scene,
      sourceKind: ordinaryMeshes === undefined ? "packed" : "ordinary-scene",
      assetHandles: geometryHandles,
      instanceHandle,
      materials: Object.freeze([...source.materials]),
      opaqueMaterialCount: source.materials.filter(
        (material) => material.transparency_mode !== ShadeTransparencyMode.Transparent
      ).length,
      materialSlots: materialStage.materialSlots,
      materialResources: composeGpuPackedMaterialBindings(
        materialStage.bindings,
        textureStage.bindings
      ),
      instanceBegin: range.start,
      instanceCount: range.count,
      get transparentInstanceCount() {
        return classification.transparentInstanceCount;
      },
      get activeKernelMask() {
        return activeKernelMask(classification.opaqueKernelClassCounts);
      },
      hierarchyTraversalCapacity: hierarchyCapacity.traversalWorkCapacity,
      hierarchyVisibleClusterCapacity: hierarchyCapacity.visibleClusterCapacity,
      hierarchyRasterWorkCapacity: hierarchyCapacity.rasterWorkCapacity,
      hierarchyMaxDepth: hierarchyCapacity.maxHierarchyDepth,
      counterSink
    });
    command.onFinished.addOne(() => {
      this.byScene.set(scene, runtime);
      this.classificationByScene.set(scene, classification);
      HANDLE_RUNTIME.set(handle as object, runtime);
      if (ordinaryMeshes !== undefined) {
        this.ordinaryAdapters.set(
          scene,
          createOrdinarySceneAdapterState(
            ordinaryMeshes,
            source.materials,
            scene.change_revision
          )
        );
      }
    });
    command.onAborted.addOne(() => {
      this.destroyCounterSink(counterSink);
    });
    return handle;
  }

  /** Registers an ordinary Scene adapter in the same GPU Render World owner. */
  stageOrdinaryScene(
    scene: Scene,
    manifest: SceneResidencyManifest,
    assetHandles: readonly AssetHandle[],
    meshes: readonly Mesh[],
    command: ShadeGPUCommandContext
  ): GpuRenderWorldHandle {
    if (meshes.length !== manifest.source.count) {
      throw new RangeError("Ordinary Scene adapter mesh count does not match its source");
    }
    return this.stage(scene, manifest, assetHandles, command, meshes);
  }

  runtime(scene: Scene): GpuRenderWorldRuntime | null {
    return this.byScene.get(scene) ?? null;
  }

  transparentInstanceCount(scene: Scene): number {
    return this.byScene.get(scene)?.transparentInstanceCount ?? 0;
  }

  /**
   * Detaches one render-world runtime and releases its Instance set in the caller's
   * explicit tool command. Geometry handles remain owned by the caller until
   * the command commits, so Renderer can release them through GpuAssetStore.
   */
  release(
    scene: Scene,
    command: ShadeGPUCommandContext
  ): readonly AssetHandle[] {
    const runtime = this.byScene.get(scene);
    if (runtime === undefined) {
      throw new Error("Scene has no GPU Render World registration");
    }
    if (this.releasingScenes.has(scene)) {
      throw new Error("GPU Render World release is already pending");
    }
    if (this.pendingPatches.has(scene)) {
      throw new Error("GPU Render World runtime must not be released with a queued patch");
    }
    this.releasingScenes.add(scene);
    try {
      this.graphics.material_store.release(runtime.materials, command);
      this.graphics.texture_residency.release(runtime.materials, command);
      this.graphics.gpu_scene.release(runtime.instanceHandle, command);
    } catch (error) {
      this.releasingScenes.delete(scene);
      throw error;
    }
    command.onFinished.addOne(() => {
      this.byScene.delete(scene);
      this.classificationByScene.delete(scene);
      this.ordinaryAdapters.delete(scene);
      HANDLE_RUNTIME.delete(runtime.handle as object);
      this.releasingScenes.delete(scene);
      const destroy = (): void => {
        this.destroyCounterSink(runtime.counterSink);
      };
      void this.graphics.device.queue.onSubmittedWorkDone().then(destroy, destroy);
    });
    command.onAborted.addOne(() => this.releasingScenes.delete(scene));
    return runtime.assetHandles;
  }

  queuePatch(scene: Scene, batch: PackedScenePatchBatch): void {
    const runtime = this.byScene.get(scene);
    if (runtime === undefined) throw new Error("Scene has no GPU Render World registration");
    if (runtime.sourceKind !== "packed") {
      throw new Error("Ordinary Scene adapters are patched only through SceneChangeSet");
    }
    this.pendingPatches.set(scene, { batch });
  }

  encodePendingPatch(
    scene: Scene,
    command: ShadeGPUCommandContext
  ): InstancePatchResult | null {
    const pending = this.pendingPatches.get(scene);
    if (pending === undefined) {
      return this.encodeOrdinarySceneChanges(scene, command);
    }
    const runtime = this.byScene.get(scene)!;
    const batch = toInstancePatchBatch(
      pending.batch,
      runtime.materialSlots,
      runtime.materials
    );
    const result = this.graphics.gpu_scene.patch(
      runtime.instanceHandle,
      batch,
      command
    );
    const rollbackClassification = applyMaterialClassificationPatch(
      pending.batch.materials,
      this.classificationByScene.get(scene)!,
      runtime.materials
    );
    this.pendingPatches.delete(scene);
    command.onAborted.addOne(() => {
      rollbackClassification();
      this.pendingPatches.set(scene, pending);
    });
    return result;
  }

  private encodeOrdinarySceneChanges(
    scene: Scene,
    command: ShadeGPUCommandContext
  ): InstancePatchResult | null {
    const adapter = this.ordinaryAdapters.get(scene);
    if (adapter === undefined) return null;
    const snapshot = scene.changesSince(adapter.lastRevision);
    if (snapshot.fullResyncRequired || snapshot.instanceStructureChanged) {
      this.ordinarySceneFullResyncRequiredCount++;
      throw new Error(
        `Ordinary Scene ${scene.id} requires explicit resyncScene() after a structural change`
      );
    }

    const transformIndices: number[] = [];
    const transformValues: number[] = [];
    for (const change of snapshot.transformedNodes) {
      const mesh = change.node as Mesh;
      const index = adapter.instanceIndexByMesh.get(mesh);
      if (index === undefined) continue;
      transformIndices.push(index);
      transformValues.push(...mesh.transform_global.matrix);
    }

    const materialIndices: number[] = [];
    const materialDictionaryIndices: number[] = [];
    for (const mesh of snapshot.changedMeshMaterials) {
      const index = adapter.instanceIndexByMesh.get(mesh);
      if (index === undefined) continue;
      const material = mesh.material as StandardShadeMaterial;
      const dictionaryIndex = adapter.materialIndexByMaterial.get(material);
      if (dictionaryIndex === undefined) {
        this.ordinarySceneFullResyncRequiredCount++;
        throw new Error(
          `Ordinary Scene ${scene.id} requires explicit resyncScene() for a new material`
        );
      }
      materialIndices.push(index);
      materialDictionaryIndices.push(dictionaryIndex);
    }

    if (transformIndices.length === 0 && materialIndices.length === 0) {
      adapter.lastRevision = snapshot.revision;
      this.ordinarySceneStableFrameCount++;
      return null;
    }

    const runtime = this.byScene.get(scene)!;
    const batch: PackedScenePatchBatch = {
      frameId: snapshot.revision,
      transforms: transformIndices.length === 0 ? undefined : {
        indices: Uint32Array.from(transformIndices),
        transforms: Float32Array.from(transformValues)
      },
      materials: materialIndices.length === 0 ? undefined : {
        indices: Uint32Array.from(materialIndices),
        materialIndices: Uint32Array.from(materialDictionaryIndices)
      }
    };
    const result = this.graphics.gpu_scene.patch(
      runtime.instanceHandle,
      toInstancePatchBatch(batch, runtime.materialSlots, runtime.materials),
      command
    );
    const rollbackClassification = applyMaterialClassificationPatch(
      batch.materials,
      this.classificationByScene.get(scene)!,
      runtime.materials
    );
    command.onFinished.addOne(() => {
      adapter.lastRevision = snapshot.revision;
      this.ordinaryScenePatchCount++;
    });
    command.onAborted.addOne(rollbackClassification);
    return result;
  }

  bindings(): { assets: GpuAssetBindings; scene: GpuSceneBindings } {
    return {
      assets: this.graphics.assets.bindings(),
      scene: this.graphics.gpu_scene.bindings()
    };
  }

  evidence(): GpuRenderWorldEvidence {
    let instanceCount = 0;
    let hierarchyTraversalCapacity = 0;
    let hierarchyVisibleClusterCapacity = 0;
    let hierarchyRasterWorkCapacity = 0;
    for (const runtime of this.byScene.values()) {
      instanceCount += runtime.instanceCount;
      hierarchyTraversalCapacity += runtime.hierarchyTraversalCapacity;
      hierarchyVisibleClusterCapacity += runtime.hierarchyVisibleClusterCapacity;
      hierarchyRasterWorkCapacity += runtime.hierarchyRasterWorkCapacity;
    }
    return Object.freeze({
      schemaVersion: 3,
      sceneCount: this.byScene.size,
      packedSourceCount: this.byScene.size - this.ordinaryAdapters.size,
      ordinarySceneAdapterCount: this.ordinaryAdapters.size,
      ordinaryScenePatchCount: this.ordinaryScenePatchCount,
      ordinarySceneStableFrameCount: this.ordinarySceneStableFrameCount,
      ordinarySceneFullResyncRequiredCount: this.ordinarySceneFullResyncRequiredCount,
      instanceCount,
      hierarchyTraversalCapacity,
      hierarchyVisibleClusterCapacity,
      hierarchyRasterWorkCapacity,
      flatWorkBytes: 0,
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    for (const runtime of this.byScene.values()) {
      this.destroyCounterSink(runtime.counterSink);
    }
    this.byScene.clear();
    this.pendingPatches.clear();
    this.releasingScenes.clear();
    this.classificationByScene.clear();
    this.ordinaryAdapters.clear();
  }

  private createCounterSink(descriptor: GPUBufferDescriptor): GPUBuffer {
    const buffer = this.graphics.device.createBuffer(descriptor);
    const accounting = this.graphics.resource_accounting;
    if (accounting !== undefined) {
      this.accountedCounterSinks.set(buffer, accounting.created({
        kind: "buffer",
        category: "resident",
        owner: "GpuRenderWorld",
        bytes: descriptor.size,
        label: descriptor.label
      }));
    }
    return buffer;
  }

  private destroyCounterSink(buffer: GPUBuffer): void {
    const handle = this.accountedCounterSinks.get(buffer);
    if (handle !== undefined) {
      this.accountedCounterSinks.delete(buffer);
      this.graphics.resource_accounting?.destroyed(handle);
    }
    buffer.destroy();
  }
}

function countTransparentInstances(
  materialIndices: ArrayLike<number>,
  materials: readonly StandardShadeMaterial[]
): number {
  let count = 0;
  for (let index = 0; index < materialIndices.length; index++) {
    if (isTransparentMaterial(materials[materialIndices[index]!]!)) count++;
  }
  return count;
}

function createOrdinarySceneAdapterState(
  meshes: readonly Mesh[],
  materials: readonly StandardShadeMaterial[],
  lastRevision: number
): OrdinarySceneAdapterState {
  const instanceIndexByMesh = new Map<Mesh, number>();
  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index]!;
    if (instanceIndexByMesh.has(mesh)) {
      throw new Error("Ordinary Scene adapter contains a duplicate Mesh");
    }
    instanceIndexByMesh.set(mesh, index);
  }
  const materialIndexByMaterial = new Map<StandardShadeMaterial, number>();
  for (let index = 0; index < materials.length; index++) {
    materialIndexByMaterial.set(materials[index]!, index);
  }
  return {
    meshes: Object.freeze([...meshes]),
    instanceIndexByMesh,
    materialIndexByMaterial,
    lastRevision
  };
}

function countOpaqueKernelClasses(
  materialIndices: ArrayLike<number>,
  materials: readonly StandardShadeMaterial[]
): Uint32Array {
  const counts = new Uint32Array(GPU_MATERIAL_KERNEL_CLASS_COUNT);
  for (let index = 0; index < materialIndices.length; index++) {
    const material = materials[materialIndices[index]!]!;
    if (!isTransparentMaterial(material)) counts[materialKernelClass(material)]!++;
  }
  return counts;
}

function activeKernelMask(counts: Uint32Array): number {
  let mask = 0;
  for (let kernelClass = 0; kernelClass < counts.length; kernelClass++) {
    if (counts[kernelClass]! > 0) mask |= 1 << kernelClass;
  }
  return mask >>> 0;
}

function restoreOpaqueKernelClassCounts(
  state: PackedSceneClassificationState,
  materials: readonly StandardShadeMaterial[]
): void {
  state.opaqueKernelClassCounts.set(
    countOpaqueKernelClasses(state.materialIndices, materials)
  );
}

function applyMaterialClassificationPatch(
  patch: PackedSceneMaterialPatch | undefined,
  state: PackedSceneClassificationState,
  materials: readonly StandardShadeMaterial[]
): () => void {
  if (patch === undefined) return () => {};
  const previous = new Map<number, number>();
  for (let index = 0; index < patch.indices.length; index++) {
    const instanceIndex = patch.indices[index]!;
    if (instanceIndex >= state.materialIndices.length) {
      throw new RangeError(
        `Packed Scene material patch indices[${index}] is outside the instance set`
      );
    }
    const nextMaterialIndex = patch.materialIndices[index]!;
    const previousMaterialIndex = state.materialIndices[instanceIndex]!;
    if (!previous.has(instanceIndex)) previous.set(instanceIndex, previousMaterialIndex);
    const wasTransparent = isTransparentMaterial(materials[previousMaterialIndex]!);
    const isTransparent = isTransparentMaterial(materials[nextMaterialIndex]!);
    if (!wasTransparent) {
      const previousKernelClass = materialKernelClass(materials[previousMaterialIndex]!);
      const previousCount = state.opaqueKernelClassCounts[previousKernelClass]!;
      if (previousCount === 0) {
        throw new Error("Packed Scene opaque kernel class count underflow");
      }
      state.opaqueKernelClassCounts[previousKernelClass] = previousCount - 1;
    }
    if (!isTransparent) {
      const nextKernelClass = materialKernelClass(materials[nextMaterialIndex]!);
      state.opaqueKernelClassCounts[nextKernelClass]!++;
    }
    if (wasTransparent !== isTransparent) {
      state.transparentInstanceCount += isTransparent ? 1 : -1;
    }
    state.materialIndices[instanceIndex] = nextMaterialIndex;
  }
  return () => {
    for (const [instanceIndex, materialIndex] of previous) {
      state.materialIndices[instanceIndex] = materialIndex;
    }
    state.transparentInstanceCount = countTransparentInstances(
      state.materialIndices,
      materials
    );
    restoreOpaqueKernelClassCounts(state, materials);
  };
}

function isTransparentMaterial(material: StandardShadeMaterial): boolean {
  return material.transparency_mode === ShadeTransparencyMode.Transparent;
}

function toInstancePatchBatch(
  batch: PackedScenePatchBatch,
  materialSlots: readonly number[],
  materialsDictionary: readonly StandardShadeMaterial[]
): InstancePatchBatch {
  const materials = batch.materials;
  if (materials === undefined) {
    return { frameId: batch.frameId, transforms: batch.transforms };
  }
  if (materials.indices.length !== materials.materialIndices.length) {
    throw new RangeError("Packed Scene material patch indices and materialIndices must match");
  }
  const materialHandles = new Uint32Array(materials.materialIndices.length);
  const flags = new Uint32Array(materials.materialIndices.length);
  for (let index = 0; index < materials.materialIndices.length; index++) {
    const dictionaryIndex = materials.materialIndices[index]!;
    if (dictionaryIndex >= materialSlots.length) {
      throw new RangeError(
        `Packed Scene materialIndices[${index}] is outside the material dictionary`
      );
    }
    materialHandles[index] = materialSlots[dictionaryIndex]!;
    flags[index] = materialClassificationFlags(materialsDictionary[dictionaryIndex]!, 0);
  }
  return {
    frameId: batch.frameId,
    transforms: batch.transforms,
    materials: { indices: materials.indices, materialHandles, flags }
  };
}

function materialClassificationFlags(
  material: StandardShadeMaterial,
  sourceFlags: number
): number {
  let flags = (sourceFlags & ~GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK) >>> 0;
  if (material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
    flags |= GPU_INSTANCE_FLAGS.AlphaTested;
  } else if (material.transparency_mode === ShadeTransparencyMode.Transparent) {
    flags |= GPU_INSTANCE_FLAGS.Transparent;
  }
  if (material.draw_side === ShadeDrawSide.Double) flags |= GPU_INSTANCE_FLAGS.DoubleSided;
  return encodeInstanceMaterialKernelClass(flags, materialKernelClass(material));
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
