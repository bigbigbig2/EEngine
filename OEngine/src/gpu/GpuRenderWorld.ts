import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import { computeIndexedPackedHierarchyWorkCapacity } from "../geometry/GeometryHierarchy.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { ShadeDrawSide, ShadeTransparencyMode } from "../material/enums.js";
import {
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK,
  encodeInstanceShadingBinId
} from "./GpuInstanceAbi.js";
import type {
  ActiveShadingSummary,
  GpuShadingBulkPublication,
  GpuShadingGeometryPublication,
  GpuShadingInstancePublication,
  GpuShadingMaterialPublication
} from "./GpuShadingPublicationPlan.js";
import {
  deriveGpuShadingIdentity,
  GPU_SHADING_DEPENDENCY,
  GPU_SHADING_DEPENDENCY_COUNT,
  ShadingIdentityPublicationError,
  type GpuShadingGeometryProfile,
  type GpuShadingMaterialProfile
} from "./GpuShadingProgramAbi.js";
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
  GpuMaterialAssociationSource,
  GpuMaterialStageHandle
} from "./GpuMaterialStore.js";
import type {
  GpuSceneBindings,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceSetHandle,
  InstanceSource,
  InstanceStaticPatch,
  InstanceVisibilityPatch,
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
  readonly staticInstances?: InstanceStaticPatch;
  readonly transforms?: InstanceTransformPatch;
  readonly materials?: PackedSceneMaterialPatch;
  readonly visibility?: InstanceVisibilityPatch;
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

export const GPU_RENDER_WORLD_SHADING_PUBLICATION_SCHEMA_VERSION = 1;

/**
 * Device-independent scene truth consumed by the renderer-side sparse-shading
 * revision owner. Extent, output dependencies and capability specialization
 * are deliberately absent because they are render-context state.
 */
export interface GpuRenderWorldShadingPublication {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly materialPublicationRevision: number;
  readonly summary: Readonly<ActiveShadingSummary>;
  readonly source: Readonly<GpuShadingBulkPublication>;
}

export interface GpuRenderWorldRuntime {
  readonly handle: GpuRenderWorldHandle;
  readonly scene: Scene;
  readonly sourceKind: "packed" | "ordinary-scene";
  readonly assetHandles: readonly AssetHandle[];
  readonly instanceHandle: InstanceSetHandle;
  readonly materials: readonly StandardShadeMaterial[];
  /** Frozen association-record population addressable by opaque shading. */
  readonly opaqueMaterialCount: number;
  readonly materialPublication: GpuMaterialStageHandle;
  /** material-major [materialIndex * 64 + ShadingBinId] GPU association slots. */
  readonly materialBinSlots: Readonly<Uint32Array>;
  readonly materialDictionaryCount: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly materialPublicationRevision: number;
  readonly materialResources: GpuPackedMaterialBindings;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  /** Number of resident instances whose current material class is BLEND. */
  readonly transparentInstanceCount: number;
  /** Incremental possible-bin truth; it never contains per-view visible counts. */
  readonly activeShadingSummary: Readonly<ActiveShadingSummary>;
  /** Atomic CPU scene publication used to derive one immutable GPU revision. */
  readonly shadingPublication: Readonly<GpuRenderWorldShadingPublication>;
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
  readonly geometryIndices: Uint32Array;
  readonly active: Uint8Array;
  readonly binIds: Uint8Array;
  readonly dependencyMasks: Uint16Array;
  readonly binRefCounts: Uint32Array;
  readonly dependencyRefCounts: Uint32Array;
  readonly materialBindingSetIds: readonly number[];
  readonly geometryProfiles: readonly Readonly<GpuShadingGeometryProfile>[];
  geometryPublicationIds: readonly number[];
  transparentInstanceCount: number;
  opaqueLitReceiverCount: number;
  opaqueUnlitReceiverCount: number;
  transparentLitReceiverCount: number;
  revision: number;
  summary: Readonly<ActiveShadingSummary>;
  materialPublications: readonly Readonly<GpuShadingMaterialPublication>[];
  geometryPublications: readonly Readonly<GpuShadingGeometryPublication>[];
  instancePublications: readonly Readonly<GpuShadingInstancePublication>[];
  publication: Readonly<GpuRenderWorldShadingPublication> | null;
}

interface PackedSceneMaterialAssociationPlan {
  readonly sources: readonly GpuMaterialAssociationSource[];
  /** material-major indices into sources; 0xffffffff denotes an invalid association. */
  readonly sourceIndexByMaterialBin: Uint32Array;
}

const INVALID_MATERIAL_ASSOCIATION = 0xffffffff;

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
  private readonly recoveryGeometry = new Map<Scene, readonly GeometryAssetPackage[]>();
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
    const classification = createPackedSceneClassificationState(
      source,
      source.materials.map((material) => textureStage.materialBindingSetIds.get(material)!)
    );
    const associationPlan = createPackedSceneMaterialAssociationPlan(
      source.materials,
      classification.geometryProfiles,
      classification.materialBindingSetIds
    );
    const materialStage = this.graphics.material_store.stage(
      associationPlan.sources,
      textureStage.materialTextureRoutingRefs,
      command
    );
    initializeRenderWorldShadingPublication(
      classification,
      source,
      assetHandles.map((handle) => this.graphics.assets.publicationIdentity(handle)),
      materialStage.materialGeneration,
      materialStage.textureGeneration,
      materialStage.publicationRevision
    );
    const materialBinSlots = mapMaterialAssociationSlots(
      associationPlan,
      materialStage.associationSlots
    );
    const geometryHandles = Object.freeze([...assetHandles]);
    const materialHandles = new Uint32Array(source.count);
    for (let index = 0; index < source.count; index++) {
      materialHandles[index] = materialAssociationSlot(
        materialBinSlots,
        source.materials.length,
        source.materialIndices[index]!,
        classification.binIds[index]!
      );
    }
    const normalizedFlags = new Uint32Array(source.count);
    for (let index = 0; index < source.count; index++) {
      const material = source.materials[source.materialIndices[index]!]!;
      normalizedFlags[index] = materialClassificationFlags(
        material,
        classification.binIds[index]!,
        source.flags?.[index] ?? 0
      );
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
      opaqueMaterialCount: associationPlan.sources.filter(
        (association) => association.material.transparency_mode !== ShadeTransparencyMode.Transparent
      ).length,
      materialPublication: materialStage.handle,
      materialBinSlots,
      materialDictionaryCount: source.materials.length,
      materialGeneration: materialStage.materialGeneration,
      textureGeneration: materialStage.textureGeneration,
      materialPublicationRevision: materialStage.publicationRevision,
      materialResources: composeGpuPackedMaterialBindings(
        materialStage.bindings,
        textureStage.bindings
      ),
      instanceBegin: range.start,
      instanceCount: range.count,
      get transparentInstanceCount() {
        return classification.transparentInstanceCount;
      },
      get activeShadingSummary() {
        return requireShadingPublication(classification).summary;
      },
      get shadingPublication() {
        return requireShadingPublication(classification);
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
      this.recoveryGeometry.set(scene, Object.freeze([...source.geometries]));
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

  /**
   * Returns the immutable shading publication that the next main command will
   * commit. This read-only preview lets the async sparse-pipeline owner finish
   * before GpuScene records the corresponding GPU patch; it neither consumes
   * the queued patch nor changes the live classification truth.
   */
  previewNextShadingPublication(
    scene: Scene
  ): Readonly<GpuRenderWorldShadingPublication> {
    const runtime = this.byScene.get(scene);
    const current = this.classificationByScene.get(scene);
    if (runtime === undefined || current === undefined) {
      throw new Error("Scene has no GPU Render World registration");
    }
    let batch = this.pendingPatches.get(scene)?.batch;
    const adapter = this.ordinaryAdapters.get(scene);
    if (batch === undefined && adapter !== undefined) {
      const snapshot = scene.changesSince(adapter.lastRevision);
      if (snapshot.fullResyncRequired || snapshot.instanceStructureChanged) {
        throw new Error(
          `Ordinary Scene ${scene.id} requires explicit resyncScene() after a structural change`
        );
      }
      const materialIndices: number[] = [];
      const materialDictionaryIndices: number[] = [];
      for (const mesh of snapshot.changedMeshMaterials) {
        const index = adapter.instanceIndexByMesh.get(mesh);
        if (index === undefined) continue;
        const material = mesh.material as StandardShadeMaterial;
        const dictionaryIndex = adapter.materialIndexByMaterial.get(material);
        if (dictionaryIndex === undefined) {
          throw new Error(
            `Ordinary Scene ${scene.id} requires explicit resyncScene() for a new material`
          );
        }
        materialIndices.push(index);
        materialDictionaryIndices.push(dictionaryIndex);
      }
      if (materialIndices.length !== 0) {
        batch = {
          frameId: snapshot.revision,
          materials: {
            indices: Uint32Array.from(materialIndices),
            materialIndices: Uint32Array.from(materialDictionaryIndices)
          }
        };
      }
    }
    if (batch === undefined) return runtime.shadingPublication;
    const preview = clonePackedSceneClassificationState(current);
    applyClassificationPatch(batch, preview, runtime.materials);
    return requireShadingPublication(preview);
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
      this.graphics.material_store.release(runtime.materialPublication, command);
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
      this.recoveryGeometry.delete(scene);
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

  /** Device-independent committed checkpoint; queued patches remain queued. */
  recoveryScenes() {
    return [...this.byScene.values()].map((runtime) => {
      const classification = this.classificationByScene.get(runtime.scene)!;
      const geometries = this.recoveryGeometry.get(runtime.scene)!;
      const adapter = this.ordinaryAdapters.get(runtime.scene);
      return {
        scene: runtime.scene,
        source: {
          geometries,
          materials: runtime.materials,
          count: runtime.instanceCount,
          geometryIndices: classification.geometryIndices.slice(),
          materialIndices: classification.materialIndices.slice(),
          ...this.graphics.gpu_scene.recoveryInstances(runtime.instanceHandle)
        } satisfies PackedSceneSource,
        ordinaryMeshes: adapter?.meshes,
        queuedPatch: this.pendingPatches.get(runtime.scene)?.batch
      };
    });
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
      runtime.materialBinSlots,
      runtime.materialDictionaryCount,
      runtime.materials,
      this.classificationByScene.get(scene)!
    );
    const result = this.graphics.gpu_scene.patch(
      runtime.instanceHandle,
      batch,
      command
    );
    const rollbackClassification = applyClassificationPatch(
      pending.batch,
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
      toInstancePatchBatch(
        batch,
        runtime.materialBinSlots,
        runtime.materialDictionaryCount,
        runtime.materials,
        this.classificationByScene.get(scene)!
      ),
      command
    );
    const rollbackClassification = applyClassificationPatch(
      batch,
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
    this.recoveryGeometry.clear();
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

function createPackedSceneClassificationState(
  source: PackedSceneSource,
  materialBindingSetIds: readonly number[]
): PackedSceneClassificationState {
  const state: PackedSceneClassificationState = {
    materialIndices: source.materialIndices.slice(),
    geometryIndices: source.geometryIndices.slice(),
    active: new Uint8Array(source.count).fill(1),
    binIds: new Uint8Array(source.count),
    dependencyMasks: new Uint16Array(source.count),
    binRefCounts: new Uint32Array(64),
    dependencyRefCounts: new Uint32Array(GPU_SHADING_DEPENDENCY_COUNT),
    materialBindingSetIds: Object.freeze([...materialBindingSetIds]),
    geometryProfiles: Object.freeze(source.geometries.map(shadingGeometryProfile)),
    geometryPublicationIds: Object.freeze([]),
    transparentInstanceCount: 0,
    opaqueLitReceiverCount: 0,
    opaqueUnlitReceiverCount: 0,
    transparentLitReceiverCount: 0,
    revision: 1,
    summary: EMPTY_ACTIVE_SHADING_SUMMARY,
    materialPublications: Object.freeze([]),
    geometryPublications: Object.freeze([]),
    instancePublications: Object.freeze([]),
    publication: null
  };
  for (let instanceIndex = 0; instanceIndex < source.count; instanceIndex++) {
    resolveInstanceShadingIdentity(state, instanceIndex, source.materials);
    addClassificationContribution(state, instanceIndex, source.materials);
  }
  state.summary = freezeActiveShadingSummary(state);
  return state;
}

function clonePackedSceneClassificationState(
  source: PackedSceneClassificationState
): PackedSceneClassificationState {
  return {
    materialIndices: source.materialIndices.slice(),
    geometryIndices: source.geometryIndices.slice(),
    active: source.active.slice(),
    binIds: source.binIds.slice(),
    dependencyMasks: source.dependencyMasks.slice(),
    binRefCounts: source.binRefCounts.slice(),
    dependencyRefCounts: source.dependencyRefCounts.slice(),
    materialBindingSetIds: source.materialBindingSetIds,
    geometryProfiles: source.geometryProfiles,
    geometryPublicationIds: source.geometryPublicationIds,
    transparentInstanceCount: source.transparentInstanceCount,
    opaqueLitReceiverCount: source.opaqueLitReceiverCount,
    opaqueUnlitReceiverCount: source.opaqueUnlitReceiverCount,
    transparentLitReceiverCount: source.transparentLitReceiverCount,
    revision: source.revision,
    summary: source.summary,
    materialPublications: source.materialPublications,
    geometryPublications: source.geometryPublications,
    instancePublications: source.instancePublications,
    publication: source.publication
  };
}

function initializeRenderWorldShadingPublication(
  state: PackedSceneClassificationState,
  source: PackedSceneSource,
  geometryIdentities: readonly Readonly<{ readonly slot: number; readonly generation: number }>[],
  materialGeneration: number,
  textureGeneration: number,
  materialPublicationRevision: number
): void {
  if (state.publication !== null) {
    throw new Error("GPU Render World shading publication is already initialized");
  }
  if (geometryIdentities.length !== state.geometryProfiles.length) {
    throw new Error("GPU Render World geometry publication identities do not match its dictionary");
  }
  state.geometryPublicationIds = Object.freeze(geometryIdentities.map(({ slot }) => slot));
  state.materialPublications = Object.freeze(source.materials.map((material, id) =>
    Object.freeze({
      id,
      profile: Object.freeze(shadingMaterialProfile(
        material,
        state.materialBindingSetIds[id]!
      )),
      generation: materialGeneration,
      textureGeneration
    })
  ));
  state.geometryPublications = Object.freeze(state.geometryProfiles.map((profile, index) =>
    Object.freeze({
      id: geometryIdentities[index]!.slot,
      profile,
      generation: geometryIdentities[index]!.generation
    })
  ));
  state.instancePublications = Object.freeze(Array.from(
    { length: state.materialIndices.length },
    (_, instanceIndex) => freezeRenderWorldInstancePublication(
      state,
      source.materials,
      instanceIndex,
      state.revision
    )
  ));
  state.publication = freezeRenderWorldShadingPublication(
    state,
    materialGeneration,
    textureGeneration,
    materialPublicationRevision
  );
}

function freezeRenderWorldInstancePublication(
  state: PackedSceneClassificationState,
  materials: readonly StandardShadeMaterial[],
  instanceIndex: number,
  generation: number
): Readonly<GpuShadingInstancePublication> {
  return Object.freeze({
    id: instanceIndex,
    materialId: state.materialIndices[instanceIndex]!,
    geometryId: state.geometryPublicationIds[state.geometryIndices[instanceIndex]!]!,
    active: state.active[instanceIndex] !== 0,
    transparent: isTransparentMaterial(materials[state.materialIndices[instanceIndex]!]!),
    generation
  });
}

function freezeRenderWorldShadingPublication(
  state: PackedSceneClassificationState,
  materialGeneration: number,
  textureGeneration: number,
  materialPublicationRevision: number
): Readonly<GpuRenderWorldShadingPublication> {
  if (state.summary.revision !== state.revision) {
    throw new Error("GPU Render World shading summary revision is not atomic");
  }
  return Object.freeze({
    schemaVersion: GPU_RENDER_WORLD_SHADING_PUBLICATION_SCHEMA_VERSION as 1,
    revision: state.revision,
    materialGeneration,
    textureGeneration,
    materialPublicationRevision,
    summary: state.summary,
    source: Object.freeze({
      materials: state.materialPublications,
      geometries: state.geometryPublications,
      instances: state.instancePublications
    })
  });
}

function requireShadingPublication(
  state: PackedSceneClassificationState
): Readonly<GpuRenderWorldShadingPublication> {
  if (state.publication === null) {
    throw new Error("GPU Render World shading publication is not initialized");
  }
  return state.publication;
}

/**
 * Publishes every valid association reachable by an existing geometry and
 * material dictionary. Invalid unused pairs remain explicit sentinels, while
 * any pair referenced by the source has already failed in classification.
 * Records are deduplicated only when material identity and ProgramId match;
 * geometry attributes that do not change the program remain shader data.
 */
function createPackedSceneMaterialAssociationPlan(
  materials: readonly StandardShadeMaterial[],
  geometryProfiles: readonly Readonly<GpuShadingGeometryProfile>[],
  materialBindingSetIds: readonly number[]
): PackedSceneMaterialAssociationPlan {
  const sourceIndexByMaterialBin = new Uint32Array(materials.length * 64);
  sourceIndexByMaterialBin.fill(INVALID_MATERIAL_ASSOCIATION);
  const sources: GpuMaterialAssociationSource[] = [];
  const uniqueGeometryProfiles = new Map<number, Readonly<GpuShadingGeometryProfile>>();
  for (const profile of geometryProfiles) {
    uniqueGeometryProfiles.set(shadingGeometryProfileKey(profile), profile);
  }
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
    for (const geometryProfile of uniqueGeometryProfiles.values()) {
      const material = materials[materialIndex]!;
      let identity;
      try {
        identity = deriveGpuShadingIdentity(
          shadingMaterialProfile(material, materialBindingSetIds[materialIndex]!),
          geometryProfile
        );
      } catch (error) {
        if (error instanceof ShadingIdentityPublicationError &&
            (error.code === "MISSING_UV0" || error.code === "MISSING_UV1" ||
             error.code === "MISSING_UV2" || error.code === "MISSING_NORMAL" ||
             error.code === "MISSING_TANGENT")) {
          continue;
        }
        throw error;
      }
      const lookupIndex = materialBinSlotIndex(materialIndex, identity.binId);
      if (sourceIndexByMaterialBin[lookupIndex] === INVALID_MATERIAL_ASSOCIATION) {
        const sourceIndex = sources.length;
        sourceIndexByMaterialBin[lookupIndex] = sourceIndex;
        sources.push(Object.freeze({
          material,
          programId: identity.programId,
          textureBindingSetId: identity.textureBindingSetId
        }));
      }
    }
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    sourceIndexByMaterialBin
  });
}

function mapMaterialAssociationSlots(
  plan: PackedSceneMaterialAssociationPlan,
  gpuSlots: readonly number[]
): Uint32Array {
  if (gpuSlots.length !== plan.sources.length) {
    throw new Error("GpuMaterialStore association slots do not match the publication plan");
  }
  const result = new Uint32Array(plan.sourceIndexByMaterialBin.length);
  for (let index = 0; index < result.length; index++) {
    const sourceIndex = plan.sourceIndexByMaterialBin[index]!;
    result[index] = sourceIndex === INVALID_MATERIAL_ASSOCIATION
      ? INVALID_MATERIAL_ASSOCIATION
      : gpuSlots[sourceIndex]!;
  }
  return result;
}

function materialAssociationSlot(
  slots: Readonly<Uint32Array>,
  materialCount: number,
  materialIndex: number,
  binId: number
): number {
  if (materialIndex >= materialCount || slots.length !== materialCount * 64) {
    throw new RangeError("Material association table shape is invalid");
  }
  const slot = slots[materialBinSlotIndex(materialIndex, binId)];
  if (slot === undefined || slot === INVALID_MATERIAL_ASSOCIATION) {
    throw new ShadingIdentityPublicationError(
      "INVALID_DEPENDENCY_MASK",
      `Material ${materialIndex} has no published association for ShadingBinId ${binId}`
    );
  }
  return slot;
}

function materialBinSlotIndex(materialIndex: number, binId: number): number {
  if (!Number.isInteger(materialIndex) || materialIndex < 0 ||
      !Number.isInteger(binId) || binId < 0 || binId >= 64) {
    throw new RangeError("Material/bin association index is invalid");
  }
  return materialIndex * 64 + binId;
}

function shadingGeometryProfileKey(profile: Readonly<GpuShadingGeometryProfile>): number {
  return (profile.hasAuthoredVertexColor ? 1 : 0) |
    (profile.hasUv0 ? 2 : 0) |
    (profile.hasNormal ? 4 : 0) |
    (profile.hasTangent ? 8 : 0) |
    (profile.hasUv1 ? 16 : 0) |
    (profile.hasUv2 ? 32 : 0);
}

interface ClassificationPatchEntry {
  readonly materialIndex: number;
  readonly active: number;
  readonly binId: number;
  readonly dependencyMask: number;
}

function applyClassificationPatch(
  batch: PackedScenePatchBatch,
  state: PackedSceneClassificationState,
  materials: readonly StandardShadeMaterial[]
): () => void {
  if (batch.materials === undefined && batch.visibility === undefined) return () => {};
  const previousEntries = new Map<number, ClassificationPatchEntry>();
  const nextMaterialIndices = new Map<number, number>();
  const nextActive = new Map<number, number>();
  if (batch.materials !== undefined) {
    for (let patchIndex = 0; patchIndex < batch.materials.indices.length; patchIndex++) {
      const instanceIndex = batch.materials.indices[patchIndex]!;
      assertInstanceIndex(instanceIndex, state, `material patch indices[${patchIndex}]`);
      nextMaterialIndices.set(instanceIndex, batch.materials.materialIndices[patchIndex]!);
    }
  }
  if (batch.visibility !== undefined) {
    if (batch.visibility.indices.length !== batch.visibility.flags.length) {
      throw new RangeError("Packed Scene visibility patch indices and flags must match");
    }
    for (let patchIndex = 0; patchIndex < batch.visibility.indices.length; patchIndex++) {
      const instanceIndex = batch.visibility.indices[patchIndex]!;
      assertInstanceIndex(instanceIndex, state, `visibility patch indices[${patchIndex}]`);
      nextActive.set(
        instanceIndex,
        (batch.visibility.flags[patchIndex]! & GPU_INSTANCE_FLAGS.Active) === 0 ? 0 : 1
      );
    }
  }
  const touched = new Set([...nextMaterialIndices.keys(), ...nextActive.keys()]);
  for (const instanceIndex of touched) {
    previousEntries.set(instanceIndex, {
      materialIndex: state.materialIndices[instanceIndex]!,
      active: state.active[instanceIndex]!,
      binId: state.binIds[instanceIndex]!,
      dependencyMask: state.dependencyMasks[instanceIndex]!
    });
  }
  const previousSummary = state.summary;
  const previousBinRefCounts = state.binRefCounts.slice();
  const previousDependencyRefCounts = state.dependencyRefCounts.slice();
  const previousTransparentInstanceCount = state.transparentInstanceCount;
  const previousOpaqueLitReceiverCount = state.opaqueLitReceiverCount;
  const previousOpaqueUnlitReceiverCount = state.opaqueUnlitReceiverCount;
  const previousTransparentLitReceiverCount = state.transparentLitReceiverCount;
  const previousRevision = state.revision;
  const previousInstancePublications = state.instancePublications;
  const previousPublication = state.publication;
  let changed = false;
  const changedInstances: number[] = [];
  for (const instanceIndex of touched) {
    const materialIndex = nextMaterialIndices.get(instanceIndex) ?? state.materialIndices[instanceIndex]!;
    const active = nextActive.get(instanceIndex) ?? state.active[instanceIndex]!;
    const identity = deriveGpuShadingIdentity(
      shadingMaterialProfile(materials[materialIndex]!, state.materialBindingSetIds[materialIndex]!),
      shadingGeometryProfileFromState(state, instanceIndex)
    );
    if (materialIndex === state.materialIndices[instanceIndex] && active === state.active[instanceIndex] &&
        identity.binId === state.binIds[instanceIndex] &&
        identity.dependencyMask === state.dependencyMasks[instanceIndex]) {
      continue;
    }
    removeClassificationContribution(state, instanceIndex, materials);
    state.materialIndices[instanceIndex] = materialIndex;
    state.active[instanceIndex] = active;
    state.binIds[instanceIndex] = identity.binId;
    state.dependencyMasks[instanceIndex] = identity.dependencyMask;
    addClassificationContribution(state, instanceIndex, materials);
    changed = true;
    changedInstances.push(instanceIndex);
  }
  if (changed) {
    state.revision = nextRevision(state.revision);
    state.summary = freezeActiveShadingSummary(state);
    const publications = [...state.instancePublications];
    for (const instanceIndex of changedInstances) {
      publications[instanceIndex] = freezeRenderWorldInstancePublication(
        state,
        materials,
        instanceIndex,
        state.revision
      );
    }
    state.instancePublications = Object.freeze(publications);
    const current = requireShadingPublication(state);
    state.publication = freezeRenderWorldShadingPublication(
      state,
      current.materialGeneration,
      current.textureGeneration,
      current.materialPublicationRevision
    );
  }
  return () => {
    for (const [instanceIndex, previous] of previousEntries) {
      state.materialIndices[instanceIndex] = previous.materialIndex;
      state.active[instanceIndex] = previous.active;
      state.binIds[instanceIndex] = previous.binId;
      state.dependencyMasks[instanceIndex] = previous.dependencyMask;
    }
    state.binRefCounts.set(previousBinRefCounts);
    state.dependencyRefCounts.set(previousDependencyRefCounts);
    state.transparentInstanceCount = previousTransparentInstanceCount;
    state.opaqueLitReceiverCount = previousOpaqueLitReceiverCount;
    state.opaqueUnlitReceiverCount = previousOpaqueUnlitReceiverCount;
    state.transparentLitReceiverCount = previousTransparentLitReceiverCount;
    state.revision = previousRevision;
    state.summary = previousSummary;
    state.instancePublications = previousInstancePublications;
    state.publication = previousPublication;
  };
}

function resolveInstanceShadingIdentity(
  state: PackedSceneClassificationState,
  instanceIndex: number,
  materials: readonly StandardShadeMaterial[]
): void {
  const materialIndex = state.materialIndices[instanceIndex]!;
  const identity = deriveGpuShadingIdentity(
    shadingMaterialProfile(materials[materialIndex]!, state.materialBindingSetIds[materialIndex]!),
    shadingGeometryProfileFromState(state, instanceIndex)
  );
  state.binIds[instanceIndex] = identity.binId;
  state.dependencyMasks[instanceIndex] = identity.dependencyMask;
}

function shadingMaterialProfile(
  material: StandardShadeMaterial,
  textureBindingSetId: number
): GpuShadingMaterialProfile {
  const hasBaseTexture = material.texture_albedo !== undefined;
  const hasOrmTexture = !material.is_unlit && material.texture_orm !== undefined;
  const hasNormalTexture = !material.is_unlit && material.texture_normal !== undefined;
  const hasEmissiveTexture = !material.is_unlit && material.texture_emissive !== undefined;
  const hasOcclusionTexture = !material.is_unlit && material.texture_occlusion !== undefined;
  let requiredUvSetsMask = 0;
  if (hasBaseTexture) requiredUvSetsMask |= uvSetMask(material.base_color_uv_set, material.name);
  if (hasOrmTexture) requiredUvSetsMask |= uvSetMask(material.orm_uv_set, material.name);
  if (hasNormalTexture) requiredUvSetsMask |= uvSetMask(material.normal_uv_set, material.name);
  if (hasEmissiveTexture) requiredUvSetsMask |= uvSetMask(material.emissive_uv_set, material.name);
  if (hasOcclusionTexture) requiredUvSetsMask |= uvSetMask(material.occlusion_uv_set, material.name);
  return {
    shadingModel: material.is_unlit ? "unlit" : "standard-pbr",
    hasBaseTexture,
    hasOrmTexture,
    hasNormalTexture,
    hasEmissiveTexture,
    hasOcclusionTexture,
    requiredUvSetsMask,
    textureBindingSetId
  };
}

function uvSetMask(uvSet: number, materialName: string): number {
  if (!Number.isInteger(uvSet) || uvSet < 0 || uvSet > 2) {
    throw new RangeError(`Material '${materialName}' requests unsupported TEXCOORD_${uvSet}`);
  }
  return 1 << uvSet;
}

function shadingGeometryProfile(
  geometry: GeometryAssetPackage
): Readonly<GpuShadingGeometryProfile> {
  const semantics = new Set(
    geometry.vertexStreamDescriptors.map((descriptor) => descriptor.semantic.toLowerCase())
  );
  return Object.freeze({
    hasAuthoredVertexColor: semantics.has("color"),
    hasUv0: semantics.has("uv0"),
    hasUv1: semantics.has("uv1"),
    hasUv2: semantics.has("uv2"),
    hasNormal: semantics.has("normal"),
    hasTangent: semantics.has("tangent")
  });
}

function shadingGeometryProfileFromState(
  state: PackedSceneClassificationState,
  instanceIndex: number
): Readonly<GpuShadingGeometryProfile> {
  return state.geometryProfiles[state.geometryIndices[instanceIndex]!]!;
}

function addClassificationContribution(
  state: PackedSceneClassificationState,
  instanceIndex: number,
  materials: readonly StandardShadeMaterial[]
): void {
  const material = materials[state.materialIndices[instanceIndex]!]!;
  const transparent = isTransparentMaterial(material);
  if (transparent) state.transparentInstanceCount = incrementU32(
    state.transparentInstanceCount,
    "Transparent instance count"
  );
  if (state.active[instanceIndex] === 0) return;
  const dependencyMask = state.dependencyMasks[instanceIndex]!;
  updateDependencyRefCounts(state.dependencyRefCounts, dependencyMask, 1);
  const lit = (dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0;
  if (transparent) {
    if (lit) state.transparentLitReceiverCount = incrementU32(
      state.transparentLitReceiverCount,
      "Transparent lit receiver count"
    );
    return;
  }
  const binId = state.binIds[instanceIndex]!;
  state.binRefCounts[binId] = incrementU32(state.binRefCounts[binId]!, `Bin ${binId} refcount`);
  if (lit) {
    state.opaqueLitReceiverCount = incrementU32(
      state.opaqueLitReceiverCount,
      "Opaque lit receiver count"
    );
  } else {
    state.opaqueUnlitReceiverCount = incrementU32(
      state.opaqueUnlitReceiverCount,
      "Opaque unlit receiver count"
    );
  }
}

function removeClassificationContribution(
  state: PackedSceneClassificationState,
  instanceIndex: number,
  materials: readonly StandardShadeMaterial[]
): void {
  const material = materials[state.materialIndices[instanceIndex]!]!;
  const transparent = isTransparentMaterial(material);
  if (transparent) state.transparentInstanceCount = decrementU32(
    state.transparentInstanceCount,
    "Transparent instance count"
  );
  if (state.active[instanceIndex] === 0) return;
  const dependencyMask = state.dependencyMasks[instanceIndex]!;
  updateDependencyRefCounts(state.dependencyRefCounts, dependencyMask, -1);
  const lit = (dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0;
  if (transparent) {
    if (lit) state.transparentLitReceiverCount = decrementU32(
      state.transparentLitReceiverCount,
      "Transparent lit receiver count"
    );
    return;
  }
  const binId = state.binIds[instanceIndex]!;
  state.binRefCounts[binId] = decrementU32(state.binRefCounts[binId]!, `Bin ${binId} refcount`);
  if (lit) {
    state.opaqueLitReceiverCount = decrementU32(
      state.opaqueLitReceiverCount,
      "Opaque lit receiver count"
    );
  } else {
    state.opaqueUnlitReceiverCount = decrementU32(
      state.opaqueUnlitReceiverCount,
      "Opaque unlit receiver count"
    );
  }
}

function updateDependencyRefCounts(
  counts: Uint32Array,
  dependencyMask: number,
  delta: 1 | -1
): void {
  for (let bit = 0; bit < counts.length; bit++) {
    if ((dependencyMask & (1 << bit)) === 0) continue;
    counts[bit] = delta === 1
      ? incrementU32(counts[bit]!, `Dependency ${bit} refcount`)
      : decrementU32(counts[bit]!, `Dependency ${bit} refcount`);
  }
}

function freezeActiveShadingSummary(
  state: PackedSceneClassificationState
): Readonly<ActiveShadingSummary> {
  let activeBinMaskLo = 0;
  let activeBinMaskHi = 0;
  for (let binId = 0; binId < state.binRefCounts.length; binId++) {
    if (state.binRefCounts[binId] === 0) continue;
    if (binId < 32) activeBinMaskLo = (activeBinMaskLo | (1 << binId)) >>> 0;
    else activeBinMaskHi = (activeBinMaskHi | (1 << (binId - 32))) >>> 0;
  }
  let dependencyMask = 0;
  for (let bit = 0; bit < state.dependencyRefCounts.length; bit++) {
    if (state.dependencyRefCounts[bit] !== 0) dependencyMask |= 1 << bit;
  }
  return Object.freeze({
    binRefCounts: state.binRefCounts.slice(),
    activeBinMaskLo,
    activeBinMaskHi,
    opaqueLitReceiverCount: state.opaqueLitReceiverCount,
    opaqueUnlitReceiverCount: state.opaqueUnlitReceiverCount,
    transparentLitReceiverCount: state.transparentLitReceiverCount,
    dependencyMask,
    revision: state.revision
  });
}

const EMPTY_ACTIVE_SHADING_SUMMARY: Readonly<ActiveShadingSummary> = Object.freeze({
  binRefCounts: new Uint32Array(64),
  activeBinMaskLo: 0,
  activeBinMaskHi: 0,
  opaqueLitReceiverCount: 0,
  opaqueUnlitReceiverCount: 0,
  transparentLitReceiverCount: 0,
  dependencyMask: 0,
  revision: 0
});

function incrementU32(value: number, label: string): number {
  if (value >= 0xffffffff) throw new RangeError(`${label} overflow`);
  return value + 1;
}

function decrementU32(value: number, label: string): number {
  if (value === 0) throw new Error(`${label} underflow`);
  return value - 1;
}

function nextRevision(value: number): number {
  return value >= 0xffffffff ? 1 : value + 1;
}

function assertInstanceIndex(
  instanceIndex: number,
  state: PackedSceneClassificationState,
  label: string
): void {
  if (instanceIndex >= state.materialIndices.length) {
    throw new RangeError(`Packed Scene ${label} is outside the instance set`);
  }
}

function isTransparentMaterial(material: StandardShadeMaterial): boolean {
  return material.transparency_mode === ShadeTransparencyMode.Transparent;
}

function toInstancePatchBatch(
  batch: PackedScenePatchBatch,
  materialBinSlots: Readonly<Uint32Array>,
  materialDictionaryCount: number,
  materialsDictionary: readonly StandardShadeMaterial[],
  state: PackedSceneClassificationState
): InstancePatchBatch {
  const materials = batch.materials;
  if (materials === undefined) {
    return {
      frameId: batch.frameId,
      staticInstances: batch.staticInstances,
      transforms: batch.transforms,
      visibility: batch.visibility
    };
  }
  if (materials.indices.length !== materials.materialIndices.length) {
    throw new RangeError("Packed Scene material patch indices and materialIndices must match");
  }
  const materialHandles = new Uint32Array(materials.materialIndices.length);
  const flags = new Uint32Array(materials.materialIndices.length);
  for (let index = 0; index < materials.materialIndices.length; index++) {
    const instanceIndex = materials.indices[index]!;
    assertInstanceIndex(instanceIndex, state, `material patch indices[${index}]`);
    const dictionaryIndex = materials.materialIndices[index]!;
    if (dictionaryIndex >= materialDictionaryCount) {
      throw new RangeError(
        `Packed Scene materialIndices[${index}] is outside the material dictionary`
      );
    }
    const identity = deriveGpuShadingIdentity(
      shadingMaterialProfile(
        materialsDictionary[dictionaryIndex]!,
        state.materialBindingSetIds[dictionaryIndex]!
      ),
      shadingGeometryProfileFromState(state, instanceIndex)
    );
    materialHandles[index] = materialAssociationSlot(
      materialBinSlots,
      materialDictionaryCount,
      dictionaryIndex,
      identity.binId
    );
    flags[index] = materialClassificationFlags(
      materialsDictionary[dictionaryIndex]!,
      identity.binId,
      0
    );
  }
  return {
    frameId: batch.frameId,
    staticInstances: batch.staticInstances,
    transforms: batch.transforms,
    materials: { indices: materials.indices, materialHandles, flags },
    visibility: batch.visibility
  };
}

function materialClassificationFlags(
  material: StandardShadeMaterial,
  shadingBinId: number,
  sourceFlags: number
): number {
  let flags = (sourceFlags & ~GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK) >>> 0;
  if (material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
    flags |= GPU_INSTANCE_FLAGS.AlphaTested;
  } else if (material.transparency_mode === ShadeTransparencyMode.Transparent) {
    flags |= GPU_INSTANCE_FLAGS.Transparent;
  }
  if (material.draw_side === ShadeDrawSide.Double) flags |= GPU_INSTANCE_FLAGS.DoubleSided;
  return encodeInstanceShadingBinId(flags, shadingBinId);
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
