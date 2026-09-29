import { ChangeSignal } from "../../core/Signal.js";
import { Vec2 } from "../../core/math/Vec2.js";
import { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { captureWebGpuCapabilityRecord } from "../../gpu/WebGpuCapabilityRecord.js";
import { preflightResidentSurfaceLimits } from "../../gpu/PhysicalSamplingProfile.js";
import { GPUSceneEnvironmentManager } from "../../gpu/GPUSceneEnvironmentManager.js";
import type { CompiledFrameGraphDump } from "../../framegraph/FrameGraph.js";
import { summarizeFrameGraphResources, type FrameResourceSummary } from "../../framegraph/FrameResourceSummary.js";
import { CompiledFrameGraphCache } from "../../framegraph/CompiledFrameGraphCache.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { FrameCoordinator } from "../FrameCoordinator.js";
import { RenderTargets } from "../RenderTargets.js";
import { GPUViewKey, ViewManager } from "../ViewManager.js";
import { GPUCameraStateManager } from "../GPUCameraState.js";
import { VisibilityFeature, type PackedVisibilityJob } from "../features/VisibilityFeature.js";
import { SurfaceMaterialPass } from "../surface/SurfaceMaterialPass.js";
import { surfaceExceptionLane } from "../surface/SurfaceExecutionAbi.js";
import { XeGtaoPreparationPass } from "../ao/XeGtaoPreparationPass.js";
import { XeGtaoMainPass } from "../ao/XeGtaoMainPass.js";
import { XeGtaoDenoisePass } from "../ao/XeGtaoDenoisePass.js";
import { SurfacePresentPass } from "../surface/SurfacePresentPass.js";
import { LightClusterPass } from "../passes/LightClusterPass.js";
import { PhysicalSkyPass } from "../passes/PhysicalSkyPass.js";
import { AerialPerspectivePass } from "../passes/AerialPerspectivePass.js";
import { FrameProgramCache, type FrameProgram } from "../program/FrameProgram.js";
import { assertFrameProgramBindings, type SceneFrameBindings, type EmptyFrameBindings } from "../program/FrameProgramBindings.js";
import { lowerFrameProgram, type FrameProgramOwners } from "../program/FrameProgramLowering.js";
import { FrameProfiler } from "../../debug/FrameProfiler.js";
import { TemporalFabric } from "../TemporalFabric.js";
import { TemporalFactsPass } from "../temporal/TemporalFactsPass.js";
import { GpuRadiometryPass } from "../temporal/GpuRadiometryPass.js";
import { BloomPass } from "../passes/BloomPass.js";
import { RenderDebugViewPass } from "../passes/RenderDebugViewPass.js";
import { RenderDebugView as RenderDebugViewValue, type RenderDebugView } from "../../debug/RenderDebugView.js";
import { captureGpuAdapterIdentity, type BenchmarkAdapterIdentity } from "../../debug/EnvironmentManifest.js";
import type { HierarchicalZBuffer } from "../HierarchicalZBuffer.js";
import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { Scene } from "../../scene/Scene.js";
import type { GPUViewContext } from "../ViewContext.js";
import type { ShadeTexture } from "../../texture/ShadeTexture.js";
import type { GeometryAssetPackage } from "../../assets/GeometryAssetPackage.js";
import type { GeometryProductRevisionSourceV1 } from "../../assets/geometry-product/GeometryProductV1.js";
import type { AssetHandle, AssetResidencyEvidence } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneEvidence, InstancePatchBatch, InstancePatchResult, InstanceSetHandle, InstanceSource } from "../../gpu/GpuScene.js";
import { createSceneResidencyManifest } from "../../gpu/GpuSceneResidencyManifest.js";
import type { GpuRenderWorldEvidence, GpuRenderWorldHandle, GpuRenderWorldRuntime, PackedScenePatchBatch, PackedSceneSource, VirtualGeometrySceneSource } from "../../gpu/GpuRenderWorld.js";
import { VirtualGeometryResidency, VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE } from "../../gpu/VirtualGeometryResidency.js";
import type { VirtualGeometryResidencyOptionsV1 } from "../../gpu/VirtualGeometryResidency.js";
import { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import { GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1, GeometryProductMultiRuntimeV1, type GeometryProductShardHandleV1 } from "../../gpu/GeometryProductMultiRuntime.js";
import { GeometryProductAdmissionController } from "../../gpu/GeometryProductAdmission.js";
import type { GeometryProductAdmissionTransaction } from "../../gpu/GeometryProductAdmission.js";
import type { WebCookRuntimeAsset } from "../../assets/web-cook/WebCookRuntimeAsset.js";
import type { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import { createWebCookSceneSourceAsync, type WebCookSceneMappingTiming } from "../../assets/web-cook/WebCookSceneSource.js";
import { webCookCatalogSceneFraming, type WebCookCatalogSceneFramingV1 } from "../../assets/web-cook/WebCookSceneBounds.js";
import { createOegPackSceneSource } from "../../assets/geometry-product/OegPackSceneSourceV1.js";
import { buildVirtualGeometrySceneSourceV1, mergeVirtualGeometryProductSceneSourcesV1, type VirtualGeometryProductScenePartV1 } from "../../assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import type { CookedSceneGeometryProductV1 } from "../../assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import type { OegPackProductAsset } from "../../assets/geometry-product/OegPackProductAsset.js";
import type { GeometryProductDescriptorV1, GeometryProductProviderV1 } from "../../assets/geometry-product/GeometryProductV1.js";
import type { VirtualGeometrySceneSourceResultV1 } from "../../assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { createPackedSceneSourceFromScene, type SceneGeometryAssetBinding } from "../../gpu/GpuSceneAdapter.js";
import { DEFAULT_GEOMETRY_WORK_BUDGET, type GeometryWorkBudget } from "../GeometryWorkBudget.js";
import { DEFAULT_RENDERER_CONFIG, mergeRendererConfig, validateRendererConfig, type RendererConfig } from "../RendererConfig.js";
import { TEXTURE_RESIDENCY_MAX_SIZE } from "../../gpu/TextureResidency.js";
import type { GraphicsMemoryEvidence, GraphicsOwnerCreationEvidence } from "../../gpu/GraphicsContext.js";
import { PhysicalEnvironmentRuntime } from "../environment/PhysicalEnvironmentRuntime.js";
import { Fsr3UpscalerRuntime } from "../passes/fsr3/Fsr3UpscalerRuntime.js";
import { RadiometryRuntime, type PreExposureContract } from "../RadiometryContract.js";
import { negotiateVsmCapabilities } from "../vsm/VsmCapabilities.js";
import { VsmResources, type VsmDiagnostics } from "../vsm/VsmResources.js";
import { buildVsmDirectionalFrameConstants, VsmReceiverDemandPass } from "../vsm/VsmReceiverDemandPass.js";
import { VsmAllocatePagesPass } from "../vsm/VsmAllocatePagesPass.js";
import { VsmCasterRecordPass } from "../vsm/VsmCasterRecordPass.js";
import { VsmAtlasRasterPass } from "../vsm/VsmAtlasRasterPass.js";
import { VsmInvalidationPass } from "../vsm/VsmInvalidationPass.js";
import { VsmGeneration } from "../vsm/VsmGeneration.js";

export interface RendererInitializeOptions {
  context?: GPUCanvasContext;
  adapter?: GPUAdapter;
  device?: GPUDevice;
  config?: RendererConfig;
}

function createPackedHierarchyView(camera: PerspectiveCamera, viewportHeight: number): GeometryHierarchyView {
  const matrix = camera.transform.matrix;
  const planes: [number, number, number, number][] = [];
  for (let index = 0; index < 6; index++) {
    const offset = index * 4;
    planes.push([
      camera.frustum[offset]!, camera.frustum[offset + 1]!,
      camera.frustum[offset + 2]!, camera.frustum[offset + 3]!
    ]);
  }
  return {
    kind: "perspective",
    cameraPosition: [matrix[12]!, matrix[13]!, matrix[14]!],
    viewportHeight,
    verticalFovRadians: camera.fov,
    nearPlane: camera.near,
    frustumPlanes: planes
  };
}

function packedPreviousHzb(hzb: HierarchicalZBuffer, previousWorldToClip: ArrayLike<number>) {
  const view = hzb.obtainPreviousView();
  return view === null ? null : {
    view, width: hzb.width, height: hzb.height,
    mipLevelCount: hzb.mipLevelCount,
    worldToClipMatrix: previousWorldToClip
  };
}

async function waitForActiveProduct(controller: GeometryProductAdmissionController, signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("Product admission aborted");
    if (controller.active?.state === "active") return;
    const evidence = controller.evidence();
    if (["failed", "cancelled", "complete"].includes(evidence.state)) {
      throw new Error(evidence.failure ?? evidence.lastRejection ?? "Product admission did not activate");
    }
    await new Promise(resolve => setTimeout(resolve, 8));
  }
}

function refreshProductSceneSourceForRecovery(scene: Scene, source: VirtualGeometrySceneSource): VirtualGeometrySceneSource {
  const meshes = source.meshes;
  if (!meshes) return source;
  scene.updateMatrices();
  if (meshes.length !== source.count) throw new Error("Product recovery mesh count changed");
  const currentTransforms = new Float32Array(source.count * 16);
  const materialIndices = new Uint32Array(source.count);
  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index]!;
    currentTransforms.set(mesh.transform_global.matrix, index * 16);
    const materialIndex = source.materials.indexOf(mesh.material as StandardShadeMaterial);
    if (materialIndex < 0) throw new Error("Product recovery material is outside the published dictionary");
    materialIndices[index] = materialIndex;
  }
  return Object.freeze({
    ...source, meshes, materialIndices,
    currentTransforms,
    previousTransforms: currentTransforms.slice()
  });
}
export interface RendererCapabilities {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly record: import("../../gpu/WebGpuCapabilityRecord.js").WebGpuCapabilityRecord;
}

export interface ProductSceneSourceMapper {
  (revision: Readonly<{ residency: VirtualGeometryResidency; descriptor: GeometryProductDescriptorV1; source: GeometryProductRevisionSourceV1 }>): VirtualGeometrySceneSourceResultV1 | Promise<VirtualGeometrySceneSourceResultV1>;
}

export interface ProductSceneOptions {
  readonly signal?: AbortSignal;
  readonly stream?: boolean;
  /** Physical residency profile; Product/Page ABI and cook output are unchanged. */
  readonly residency?: VirtualGeometryResidencyOptionsV1;
  /** Runs after the revision is mapped and before GPU publication. */
  readonly onMaterials?: (materials: readonly StandardShadeMaterial[]) => void;
  /**
   * Explicit uniform scale applied to every instance transform.
   *
   * Prefer this over `fitHeight` whenever the scene must not change size between
   * revisions. `fitHeight` is resolved against the instances of whichever
   * revision is being mapped, so a bootstrap subset and the richer revision that
   * replaces it receive different scales and the geometry visibly resizes at the
   * commit. Resolving the fit once from the whole catalog and passing the result
   * as `scale`/`offset` makes the transform revision-independent.
   */
  readonly scale?: number;
  /** World translation applied after `scale`. Must accompany a revision-independent fit. */
  readonly offset?: readonly [number, number, number];
}

export interface ProductSceneState {
  residency: VirtualGeometryResidency;
  streaming: GeometryPageStreamingRuntimeV1 | null;
  source: VirtualGeometrySceneSource;
  materials: readonly StandardShadeMaterial[];
}

export interface ProductSceneHandles {
  readonly handle: GpuRenderWorldHandle;
  readonly admission: GeometryProductAdmissionController;
  /** Resolves once any queued richer-revision swap has settled. */
  readonly settled: () => Promise<void>;
  /** Live view of the currently published Product revision. */
  readonly current: () => Readonly<ProductSceneState>;
  readonly residency: VirtualGeometryResidency;
  readonly streaming: GeometryPageStreamingRuntimeV1 | null;
  readonly source: VirtualGeometrySceneSource;
  readonly materials: readonly StandardShadeMaterial[];
}

export interface WebCookedSceneOptions extends ProductSceneOptions {
  /** Skip authored image/material mapping for geometry inspection. */
  readonly geometryOnly?: boolean;
  /** Publish all geometry with one lit material for diagnosis. */
  readonly singleLitMaterial?: boolean;
  /** Preserve authored material factors without reading textures for diagnosis. */
  readonly skipAuthoredTextures?: boolean;
  /**
   * Framing resolved once against the complete Web Cook catalog, then applied
   * unchanged to every Product revision and shard.
   */
  readonly fitHeight?: number;
  readonly fitBase?: readonly [number, number, number];
  /** Fixed combined metadata heap used by the Product-per-Shard production route. */
  readonly multiProductMetadataBytes?: number;
  /** Product Table capacity override; otherwise estimated from the scene catalog. */
  readonly multiProductSlotCapacity?: number;
  /** Optional per-shard diagnostic timing; called after a successful Scene publication. */
  readonly onProductPublicationTiming?: (timing: WebCookProductPublicationTiming) => void;
}

export interface WebCookProductPublicationTiming {
  readonly shardIndex: number;
  readonly sourceWaitMs: number;
  readonly runtimeLoadMs: number;
  readonly sceneMapMs: number;
  readonly sourceMergeMs: number;
  readonly scenePublishMs: number;
  readonly mapping: WebCookSceneMappingTiming;
  readonly append?: WebCookAppendPublicationTiming;
}

export interface WebCookAppendPublicationTiming {
  readonly stageMs: number;
  readonly scenePrepareMs: number;
  readonly submitMs: number;
  readonly commitMs: number;
}

export interface MultiProductSceneState {
  readonly source: VirtualGeometrySceneSource;
  readonly shardCount: number;
  readonly firstResidency: VirtualGeometryResidency;
  readonly streaming: GeometryPageStreamingRuntimeV1 | null;
}

export interface MultiProductSceneHandles {
  readonly runtime: GeometryProductMultiRuntimeV1;
  readonly streaming: GeometryPageStreamingRuntimeV1 | null;
  readonly settled: () => Promise<void>;
  readonly current: () => Readonly<MultiProductSceneState>;
  readonly release: () => Promise<void>;
}

export interface OegPackSceneOptions extends ProductSceneOptions {
  /**
   * Framing applied by the Offline scene manifest mapper.
   *
   * Same revision dependence as `WebCookedSceneOptions.fitHeight`; prefer
   * `scale`/`offset` when a replacement revision must not resize the scene.
   */
  readonly fitHeight?: number;
  readonly fitBase?: readonly [number, number, number];
}

/**
 * 渲染器始终按 CSS 像素分辨率渲染。
 *

/** Single Renderer composition root; Phase 2 material evaluation is being rebuilt in place. */
export class Renderer {
  context!: GPUCanvasContext;
  device!: GPUDevice;
  private _graphics!: GraphicsContext;
  private _frameCoordinator!: FrameCoordinator;
  private _environments!: GPUSceneEnvironmentManager;
  private _cameraStates!: GPUCameraStateManager;
  private _views!: ViewManager;
  private _visibilityFeature!: VisibilityFeature;
  private _surfaceMaterial!: SurfaceMaterialPass;
  private _xeGtaoPreparation!: XeGtaoPreparationPass;
  private _xeGtaoMain!: XeGtaoMainPass;
  private _xeGtaoDenoise!: XeGtaoDenoisePass;
  private _lightCluster: LightClusterPass | null = null;
  private _physicalSky: PhysicalSkyPass | null = null;
  private _aerialPerspective: AerialPerspectivePass | null = null;
  private _present!: SurfacePresentPass;
  private _environmentRuntime: PhysicalEnvironmentRuntime | null = null;
  private readonly _temporal = new TemporalFabric();
  private _temporalFacts!: TemporalFactsPass;
  private _gpuRadiometry!: GpuRadiometryPass;
  private _bloom!: BloomPass;
  private _renderDebugViewPass!: RenderDebugViewPass;
  private _fsr3!: Fsr3UpscalerRuntime;
  private _historyRuntime: GpuRenderWorldRuntime | null = null;
  private _sceneHistoryEpoch = 0;
  private readonly _radiometry = new RadiometryRuntime();
  private readonly _renderTargets = new RenderTargets();
  private readonly _profiler = new FrameProfiler();
  private readonly _virtualProductScenes = new Map<Scene, {
    readonly residency: VirtualGeometryResidency;
    readonly streamingRuntime: GeometryPageStreamingRuntimeV1 | null;
    readonly source: GeometryProductRevisionSourceV1;
    readonly sceneSource: VirtualGeometrySceneSource;
    readonly streamingEnabled: boolean;
    readonly multiRuntime?: GeometryProductMultiRuntimeV1;
  }>();
  private readonly _streamingCameraMatrices = new Map<Scene, Float32Array>();
  private readonly _previousViewMatrices = new WeakMap<GPUViewContext, Float32Array>();
  private _activeCamera: PerspectiveCamera | null = null;
  private _cameraRevision = 0;
  private readonly _rendererConfig: RendererConfig;
  private _initializationConfig: RendererConfig | null = null;
  private _capabilities: RendererCapabilities | null = null;
  private _adapterInfo: BenchmarkAdapterIdentity | null = null;
  private _frame_count = 0;
  private _width = 1;
  private _height = 1;
  private _output_resolution = new Vec2(1, 1);
  private _render_resolution = new Vec2(1, 1);
  private _format: GPUTextureFormat = "bgra8unorm";
  private _displayProfile: "sdr" | "hdr" = "sdr";
  private _deviceLost = false;
  private _destroyed = false;
  private _explicitlyDestroyed = false;
  private _ownsDevice = false;
  private _recoveryPromise: Promise<Renderer> | null = null;
  private _recoveryAttempts = 0;
  private _recoveryCheckpoint: ReturnType<Renderer["checkpointRecovery"]> | null = null;
  private _streamingGpuFrameTimeMs = 0;
  private _vsm: VsmResources | null = null;
  private _vsmReceiverDemand!: VsmReceiverDemandPass;
  private _vsmAllocatePages!: VsmAllocatePagesPass;
  private _vsmCasterRecords!: VsmCasterRecordPass;
  private _vsmAtlasRaster!: VsmAtlasRasterPass;
  private _vsmInvalidation!: VsmInvalidationPass;
  private readonly _vsmGeneration = new VsmGeneration();
  private _vsmCasterPublicationRevision = 0;
  private _shadowVisibilityEnabled = true;
  private _render_debug_view: RenderDebugView = RenderDebugViewValue.None;
  private _lastFrameGraph: Readonly<{ cacheKey: string; dump: CompiledFrameGraphDump;
    resources: FrameResourceSummary; program: Pick<FrameProgram, "products" | "facts" | "stages" | "bindingRoles"> }> | null = null;
  private readonly _graphCache = new CompiledFrameGraphCache(8);
  private readonly _programCache = new FrameProgramCache(8);
  protected deviceEpoch = 1;
  packed_visibility_sse_threshold = 4;
  /** Showcase/debug hosts can disable subpixel jitter while inspecting geometry. */
  temporal_jitter_enabled = true;
  packed_geometry_work_budget: GeometryWorkBudget = DEFAULT_GEOMETRY_WORK_BUDGET;
  packed_visibility_cone_enabled = true;
  packed_visibility_hzb_enabled = true;
  xe_gtao_enabled = true;
  /** Perf-host diagnostic profile; production keeps both post stages enabled. */
  fsr3_enabled = true;
  bloom_enabled = true;
  /** Diagnostic counter sampling; the normal production frame keeps shader atomics off. */
  perf_gpu_counters_enabled = false;
  packed_visibility_current_hzb_late_recheck_enabled = false;
  packed_meshlet_work_candidate_capacity: number | undefined;
  packed_meshlet_work_compaction: "auto" | "portable" | "subgroup" = "auto";
  packed_primitive_index: "auto" | "portable" = "auto";
  /** Deprecated diagnostic knob; Module A forces full-rate Surface until Surface v2. */
  onFrameFinished = new ChangeSignal<number>();

  constructor(config: RendererConfig = {}) {
    this._rendererConfig = mergeRendererConfig(DEFAULT_RENDERER_CONFIG, config);
    validateRendererConfig(this._rendererConfig);
  }
  get graphics(): GraphicsContext { return this._graphics; }
  get profiler(): FrameProfiler { return this._profiler; }
  get frame_count(): number { return this._frame_count; }
  get canvas(): HTMLCanvasElement | OffscreenCanvas | undefined { return this.context?.canvas; }
  get capabilities(): RendererCapabilities {
    if (this._capabilities === null) throw new Error("Renderer must be initialized");
    return this._capabilities;
  }
  get adapter_info(): BenchmarkAdapterIdentity | null { return this._adapterInfo; }
  get displayProfile(): "sdr" | "hdr" { return this._displayProfile; }
  get vsmCapabilities() { return this._vsm?.capabilities ?? null; }
  /** GPU-resident VSM diagnostic locations; never a CPU work-control input. */
  vsmDiagnostics(): VsmDiagnostics | null { return this._vsm?.diagnostics() ?? null; }
  /** GPU-driven geometry residency evidence for a published Scene. */
  geometryStreamingEvidence(scene: Scene): ReturnType<GeometryPageStreamingRuntimeV1["evidence"]> | null {
    return this._virtualProductScenes.get(scene)?.streamingRuntime?.evidence() ?? null;
  }
  /** Drops temporal/exposure history after a diagnostic feature or camera cut changes. */
  invalidateTemporalHistory(): void {
    this._temporal.invalidate();
    this._fsr3.invalidate();
  }
  get shadowVisibilityEnabled(): boolean { return this._shadowVisibilityEnabled; }
  set shadowVisibilityEnabled(enabled: boolean) {
    if (this._shadowVisibilityEnabled === enabled) return;
    this._shadowVisibilityEnabled = enabled;
    if (enabled) this._vsmGeneration.invalidate();
  }
  get render_debug_view(): RenderDebugView { return this._render_debug_view; }
  set render_debug_view(view: RenderDebugView) {
    if (this._render_debug_view === view) return;
    this._render_debug_view = view;
    this._programCache.clear();
    this._temporal.invalidate();
    this._fsr3?.invalidate();
  }
  get views(): ViewManager { return this._views; }
  get output_resolution(): Vec2 { return this._output_resolution.clone(); }
  get texture_depth_current() { return this._renderTargets.depthCurrent; }
  get texture_depth_previous() { return this._renderTargets.depthPrevious; }
  get internal_resolution_scale(): number { return this._render_resolution.x / this._output_resolution.x; }
  set internal_resolution_scale(scale: number) { this.setResolutionScale(scale); }
  get aspect_ratio(): number { return this._render_resolution.x / this._render_resolution.y; }
  get pixel_ratio(): number { return 1; }
  private resolutionScale = 1;
  setResolutionScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new RangeError("internal scale must be in (0, 1]");
    if (scale === this.resolutionScale) return;
    this.resolutionScale = scale;
    if (this.device) this.resize(this._width, this._height, true);
  }
  residentGeometryAsset(
    asset: GeometryAssetPackage,
    command: ShadeGPUCommandContext
  ): AssetHandle {
    return this._graphics.assets.resident(asset, command);
  }

  /** Invalidates a resident handle in command order; stale handles then fail. */
  releaseGeometryAsset(
    handle: AssetHandle,
    command: ShadeGPUCommandContext
  ): void {
    this._graphics.assets.release(handle, command);
  }

  /** Returns counters only; GPU buffers and byte offsets remain internal. */
  geometryAssetResidencyEvidence(): AssetResidencyEvidence {
    return this._graphics.assets.evidence();
  }

  /** Bulk-creates one Packed Instance Set in the caller-owned command. */
  instantiateInstances(
    source: InstanceSource,
    command: ShadeGPUCommandContext
  ): InstanceSetHandle {
    return this._graphics.gpu_scene.instantiate(source, command);
  }

  /** Applies one explicit transform/material batch without scanning the source set. */
  patchInstances(
    handle: InstanceSetHandle,
    batch: InstancePatchBatch,
    command: ShadeGPUCommandContext
  ): InstancePatchResult {
    return this._graphics.gpu_scene.patch(handle, batch, command);
  }

  /** Invalidates a Packed Instance Set in command order. */
  releaseInstances(
    handle: InstanceSetHandle,
    command: ShadeGPUCommandContext
  ): void {
    this._graphics.gpu_scene.release(handle, command);
  }

  /** Returns compact Instance table counters without exposing its GPUBuffer. */
  gpuSceneEvidence(): GpuSceneEvidence {
    return this._graphics.gpu_scene.evidence();
  }

  /**
   * @internal Legacy V2 oracle/tool route. Production callers must use
   * uploadProductScene(), uploadWebCookedScene(), or uploadOegPackScene().
   */
  async uploadPackedScene(
    scene: Scene,
    source: PackedSceneSource
  ): Promise<GpuRenderWorldHandle> {
    return this.uploadRenderWorldSource(scene, source);
  }

  /**
   * @internal Legacy V2 compatibility/oracle route. Ordinary production
   * Scenes must be cooked with cookSceneGeometryProductV1() and published via
   * uploadCookedSceneProduct().
   */
  async uploadScene(
    scene: Scene,
    geometryAssets: readonly SceneGeometryAssetBinding[]
  ): Promise<GpuRenderWorldHandle> {
    const adapted = createPackedSceneSourceFromScene(scene, geometryAssets);
    return this.uploadRenderWorldSource(scene, adapted.source, adapted.meshes);
  }

  /**
   * Publishes an ordinary CPU Scene that has already been canonicalized and
   * cooked by the Product WASM path. This is the replacement for the old
   * GeometryAssetPackage Scene adapter; admission, residency, shadow and
   * recovery remain the same Product path used by Web and OEGPACK producers.
   */
  async uploadCookedSceneProduct(
    scene: Scene,
    cooked: CookedSceneGeometryProductV1,
    options: Readonly<{ fitHeight?: number; fitBase?: readonly [number, number, number]; signal?: AbortSignal }> = {}
  ): Promise<ProductSceneHandles> {
    const sourceMapper: ProductSceneSourceMapper = ({ descriptor }) => {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const mapped = buildVirtualGeometrySceneSourceV1(
        descriptor.assetRecords,
        cooked.canonicalization.profiles,
        cooked.canonicalization.instances,
        cooked.canonicalization.materials,
        { fitHeight: options.fitHeight, fitBase: options.fitBase }
      );
      return Object.freeze({
        materials: mapped.materials,
        source: Object.freeze({
          ...mapped.source,
          meshes: Object.freeze([...scene.instances.instances])
        })
      });
    };
    return this.uploadProductScene(scene, cooked.provider, sourceMapper, { signal: options.signal });
  }

  /**
   * Publishes a Product-backed virtual geometry scene through the same
   * GpuRenderWorld, hierarchy and VisibilityKey pipeline.
   * Product residency is admitted by the caller; this method only publishes
   * its immutable GPU bindings and instance/material truth.
   */
  async uploadVirtualGeometryScene(
    scene: Scene,
    source: VirtualGeometrySceneSource,
    residency: VirtualGeometryResidency,
    streamingRuntime: GeometryPageStreamingRuntimeV1 | null = null,
    beforeSubmit?: () => void,
    publication: Readonly<{
      readonly bindings: ReturnType<VirtualGeometryResidency["bindings"]>;
      readonly assetCount: number;
      readonly registerStreaming?: boolean;
      readonly multiRuntime?: GeometryProductMultiRuntimeV1;
    }> = { bindings: residency.bindings(), assetCount: residency.descriptor.assetRecords.byteLength / 128 }
  ): Promise<GpuRenderWorldHandle> {
    const storageBufferLimit = Number(this.device.limits.maxStorageBuffersPerShaderStage);
    if (!Number.isFinite(storageBufferLimit) ||
        storageBufferLimit < VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE) {
      throw new Error(
        `Virtual Geometry Product consumer requires maxStorageBuffersPerShaderStage >= ` +
        `${VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE}; ` +
        `initialize Renderer with requiredLimits.maxStorageBuffersPerShaderStage before admission (device permits ${storageBufferLimit})`
      );
    }
    if (publication.assetCount !== source.assetCount) {
      throw new RangeError("Virtual Product source assetCount does not match its descriptor");
    }
    if (streamingRuntime !== null && publication.registerStreaming !== false) {
      streamingRuntime.registerProduct(residency.sourceForStreaming());
    }
    const command = ShadeGPUCommandContext.create(
      this._graphics,
      "Renderer/GpuRenderWorld/residency-transaction"
    );
    try {
      const handle = this._graphics.render_world.stageVirtualProduct(
        scene,
        source,
        publication.bindings,
        command
      );
      beforeSubmit?.();
      command.finish();
      await command.submitted;
      const runtime = this._graphics.render_world.runtime(scene);
      if (runtime === null) throw new Error("Virtual Product upload committed without publishing its runtime");
      this._virtualProductScenes.set(scene, Object.freeze({
        residency,
        streamingRuntime,
        source: residency.sourceForStreaming(),
        sceneSource: source,
        streamingEnabled: streamingRuntime !== null,
        ...(publication.multiRuntime === undefined ? {} : { multiRuntime: publication.multiRuntime })
      }));
      return handle;
    } catch (error) {
      if (!command.closed) command.abort(error);
      throw error;
    }
  }

  /** Removes the Scene publication while leaving Product admission ownership to the caller. */
  async releaseVirtualGeometryScene(scene: Scene): Promise<void> {
    await this.releasePackedScene(scene);
    this._virtualProductScenes.delete(scene);
  }

  /**
   * Publishes a Geometry Product Scene from any producer.
   *
   * This is the single entry shared by the Web Runtime Cooker route and the
   * Native Offline (OEGPACK) route: the fork between producers happens in the
   * provider and the mapper, never in admission, residency, streaming, visibility
   * or the swap/lifecycle machinery. The Promise resolves once the activation
   * cut is resident; later Product revisions refine in place.
   */
  async uploadProductScene(
    scene: Scene,
    provider: GeometryProductProviderV1,
    mapSource: ProductSceneSourceMapper,
    options: ProductSceneOptions = {}
  ): Promise<ProductSceneHandles> {
    let state: ProductSceneState | undefined;
    let firstHandle: GpuRenderWorldHandle | undefined;
    const retirementBoundaries = new Map<number, { previousGeneration: number; completion: Promise<void> }>();
    let retirementTail: Promise<void> = Promise.resolve();
    let publicationTail: Promise<void> = Promise.resolve();
    const admission = new GeometryProductAdmissionController(this.device, async (candidate, previous) => {
      if (previous === undefined) {
        const residency = candidate.residency;
        const streaming = options.stream === false ? null : new GeometryPageStreamingRuntimeV1(this.device, residency);
        try {
          const mapped = await mapSource({ residency, descriptor: residency.descriptor, source: candidate.source });
          options.onMaterials?.(mapped.materials);
          candidate.publishGpuRecord();
          firstHandle = await this.uploadVirtualGeometryScene(scene, mapped.source, residency, streaming, () => {
            if (candidate.state !== "ready-to-activate") throw new Error("Product candidate was cancelled before Scene submit");
          });
          candidate.markSceneSubmitted();
          state = { residency, streaming, source: mapped.source, materials: mapped.materials };
        } catch (error) {
          streaming?.destroy();
          if (this._graphics.render_world.runtime(scene) !== null) {
            try { await this.releaseVirtualGeometryScene(scene); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], "Initial Product publication and rollback failed"); }
          }
          throw error;
        }
      } else {
        if (!state) throw new Error("Product replacement has no published Scene state");
        const previousGeneration = state.residency.productGeneration;
        const publication = publicationTail.then(() => this.swapProductScene(scene, state!, candidate, mapSource, options, (completion) => {
          retirementBoundaries.set(candidate.generation, { previousGeneration, completion });
        }));
        publicationTail = publication;
        await publication;
      }
    }, options.residency);
    admission.onActivated((transaction) => {
      const retirement = retirementBoundaries.get(transaction.generation);
      if (!retirement) return;
      retirementBoundaries.delete(transaction.generation);
      retirementTail = retirementTail.then(() => retirement.completion).then(
        () => admission.retireReplaced(retirement.previousGeneration),
        () => admission.retireReplaced(retirement.previousGeneration)
      );
    });
    const consuming = admission.consume(provider, options.signal);
    consuming.catch(() => undefined);
    await waitForActiveProduct(admission, options.signal);
    const active = admission.active;
    if (!active || active.state !== "active") throw new Error("Geometry Product admission did not activate");
    if (!state || !firstHandle) throw new Error("Geometry Product admission activated without a Scene publication");
    const published = state;
    const settlePublished = async (): Promise<void> => {
      const initialEvidence = admission.evidence();
      if (initialEvidence.replacements > 0 || initialEvidence.state === "failed" || initialEvidence.state === "cancelled") {
        await publicationTail;
        await retirementTail;
        return;
      }
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        const evidence = admission.evidence();
        if (evidence.replacements > initialEvidence.replacements || evidence.state === "complete" || evidence.state === "failed" || evidence.state === "cancelled") {
          await publicationTail;
          await retirementTail;
          return;
        }
      }
    };
    return Object.freeze({
      handle: firstHandle,
      admission,
      settled: settlePublished,
      current: () => Object.freeze({ residency: published.residency, streaming: published.streaming, source: published.source, materials: published.materials }),
      get residency() { return published.residency; },
      get streaming() { return published.streaming; },
      get source() { return published.source; },
      get materials() { return published.materials; }
    });
  }

  /**
   * Runtime-first `load(scene.glb)` route: opens a Web CookSession, admits the
   * first complete Product revision, and publishes it through the shared
   * GpuRenderWorld/Visibility path.
   */
  async uploadWebCookedScene(
    scene: Scene,
    asset: WebCookRuntimeAsset,
    options: WebCookedSceneOptions = {}
  ): Promise<ProductSceneHandles> {
    // One cache for the whole scene lifetime. A replacement revision maps the
    // same authored images while the outgoing revision is still resident; sharing
    // the decoded textures keeps a size class from having to hold both copies.
    const textureCache = new Map<string, Promise<ShadeTexture>>();
    let framing: WebCookCatalogSceneFramingV1 | undefined;
    return this.uploadProductScene(scene, asset, async (revision) => {
      const catalog = asset.catalog;
      if (!catalog) throw new Error("Web Cook catalog is unavailable before Product activation");
      if (options.fitHeight !== undefined && framing === undefined) {
        framing = webCookCatalogSceneFraming(catalog, { fitHeight: options.fitHeight, fitBase: options.fitBase });
        if (framing.unknownBoundPrimitives > 0) throw new Error("Web Cook catalog fit cannot cover primitives with unknown bounds");
      }
      return createWebCookSceneSourceAsync(catalog, revision.descriptor, (imageIndex, signal) => asset.readImageSource(imageIndex, signal), options.signal, { scale: framing?.scale ?? options.scale, offset: framing?.offset ?? options.offset, sceneAssetIndices: revision.source.sceneAssetIndices, textureCache, geometryOnly: options.geometryOnly, singleLitMaterial: options.singleLitMaterial, skipAuthoredTextures: options.skipAuthoredTextures, maxImageDimension: Math.min(Number(this.device.limits.maxTextureDimension2D), this._initializationConfig?.textureMaxResolution ?? TEXTURE_RESIDENCY_MAX_SIZE) });
    }, options);
  }

  /**
   * Product-per-Shard Web route used by ADR-0018. The first complete shard is
   * visible immediately; later shards are appended to the immutable instance
   * publication while all per-frame visibility and raster work remains GPU
   * generated through the same production pipeline.
   */
  async uploadWebCookedMultiProductScene(
    scene: Scene,
    asset: WebCookRuntimeAsset,
    options: WebCookedSceneOptions = {}
  ): Promise<MultiProductSceneHandles> {
    let runtime: GeometryProductMultiRuntimeV1 | undefined;
    const textureCache = new Map<string, Promise<ShadeTexture>>();
    let framing: WebCookCatalogSceneFramingV1 | undefined;
    const parts: VirtualGeometryProductScenePartV1[] = [];
    const shardHandles: GeometryProductShardHandleV1[] = [];
    let streaming: GeometryPageStreamingRuntimeV1 | null = null;
    let state: MultiProductSceneState | undefined;
    let released = false;
    let lastPublishedAt = performance.now();
    let resolveFirst!: () => void;
    let rejectFirst!: (error: unknown) => void;
    const firstReady = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const consuming = (async (): Promise<void> => {
      try {
        for await (const source of asset.revisions(options.signal)) {
          if (released) break;
          const sourceArrivedAt = performance.now();
          const sourceWaitMs = sourceArrivedAt - lastPublishedAt;
          const catalog = asset.catalog;
          if (!catalog) throw new Error("Web Cook catalog is unavailable before Product activation");
          runtime ??= new GeometryProductMultiRuntimeV1(this.device, {
            residency: options.residency,
            metadataBytes: options.multiProductMetadataBytes,
            slotCapacity: options.multiProductSlotCapacity ?? Math.max(
              GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1,
              catalog.primitiveCount + catalog.primitives.reduce(
                (extra, primitive) => extra + Math.max(0, Math.ceil(primitive.triangleCount / 131_072) - 1), 0
              )
            )
          });
          if (options.fitHeight !== undefined && framing === undefined) {
            framing = webCookCatalogSceneFraming(catalog, { fitHeight: options.fitHeight, fitBase: options.fitBase });
            if (framing.unknownBoundPrimitives > 0) throw new Error("Web Cook catalog fit cannot cover primitives with unknown bounds");
          }
          const shard = await runtime.load(source);
          const loadedAt = performance.now();
          shardHandles.push(shard);
          let mapping: WebCookSceneMappingTiming | undefined;
          const mapped = await createWebCookSceneSourceAsync(
            catalog,
            source.descriptor,
            (imageIndex, signal) => asset.readImageSource(imageIndex, signal),
            options.signal,
            {
              scale: framing?.scale ?? options.scale,
              offset: framing?.offset ?? options.offset,
              sceneAssetIndices: source.sceneAssetIndices,
              textureCache,
              geometryOnly: options.geometryOnly,
              singleLitMaterial: options.singleLitMaterial,
              skipAuthoredTextures: options.skipAuthoredTextures,
              maxImageDimension: Math.min(Number(this.device.limits.maxTextureDimension2D), this._initializationConfig?.textureMaxResolution ?? TEXTURE_RESIDENCY_MAX_SIZE),
              onMappingTiming: options.onProductPublicationTiming ? timing => { mapping = timing; } : undefined
            }
          );
          const mappedAt = performance.now();
          parts.push(Object.freeze({
            source: mapped.source,
            productTableSlot: shard.productTableSlot,
            productGeneration: shard.productGeneration,
            assetReferenceBegin: shard.assetReferenceBegin
          }));
          const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
          const mergedAt = performance.now();
          if (streaming === null && options.stream !== false) streaming = new GeometryPageStreamingRuntimeV1(this.device, shard.residency);
          streaming?.registerProduct(source, shard.residency);
          let appendTiming: WebCookAppendPublicationTiming | undefined;
          if (parts.length === 1) {
            options.onMaterials?.(mapped.materials);
            await this.uploadVirtualGeometryScene(scene, combined, shard.residency, streaming, undefined, {
              bindings: runtime.bindings(),
              assetCount: combined.assetCount,
              registerStreaming: false,
              multiRuntime: runtime
            });
            state = Object.freeze({ source: combined, shardCount: 1, firstResidency: shard.residency, streaming });
            resolveFirst();
          } else {
            await this.replaceMultiProductScenePublication(scene, combined, runtime,
              options.onProductPublicationTiming ? timing => { appendTiming = timing; } : undefined);
            state = Object.freeze({ source: combined, shardCount: parts.length, firstResidency: shardHandles[0]!.residency, streaming });
            this._virtualProductScenes.set(scene, Object.freeze({
              residency: shardHandles[0]!.residency,
              streamingRuntime: streaming,
              source: shardHandles[0]!.residency.sourceForStreaming(),
              sceneSource: combined,
              streamingEnabled: streaming !== null,
              multiRuntime: runtime
            }));
          }
          lastPublishedAt = performance.now();
          if (options.onProductPublicationTiming) options.onProductPublicationTiming({
            shardIndex: parts.length,
            sourceWaitMs,
            runtimeLoadMs: loadedAt - sourceArrivedAt,
            sceneMapMs: mappedAt - loadedAt,
            sourceMergeMs: mergedAt - mappedAt,
            scenePublishMs: lastPublishedAt - mergedAt,
            mapping: mapping!,
            ...(appendTiming === undefined ? {} : { append: appendTiming })
          });
        }
        if (state === undefined) throw new Error("Web Cook provider completed without an admissible Product shard");
      } catch (error) {
        if (state === undefined) {
          streaming?.destroy();
          runtime?.destroy();
          rejectFirst(error);
        }
        throw error;
      }
    })();
    consuming.catch(() => undefined);
    await firstReady;
    return Object.freeze({
      runtime: runtime!,
      get streaming() { return streaming; },
      settled: () => consuming,
      current: () => {
        if (state === undefined) throw new Error("Multi-Product Scene has no active shard");
        return state;
      },
      release: async () => {
        if (released) return;
        released = true;
        if (this._graphics.render_world.runtime(scene) !== null) await this.releaseVirtualGeometryScene(scene);
        streaming?.destroy();
        runtime?.destroy();
      }
    });
  }

  private async replaceMultiProductScenePublication(
    scene: Scene,
    source: VirtualGeometrySceneSource,
    runtime: GeometryProductMultiRuntimeV1,
    onTiming?: (timing: WebCookAppendPublicationTiming) => void
  ): Promise<void> {
    const previous = this._graphics.render_world.runtime(scene);
    if (previous === null) throw new Error("Multi-Product append requires an active Scene publication");
    const started = onTiming ? performance.now() : 0;
    const command = ShadeGPUCommandContext.create(this._graphics, "Renderer/GpuRenderWorld/multi-product-append");
    try {
      this._visibilityFeature.release(previous, command);
      const handle = this._graphics.render_world.stageVirtualProductAppend(
        scene, source, runtime.bindings(), command
      );
      const stagedAt = onTiming ? performance.now() : 0;
      const preparedAt = onTiming ? performance.now() : 0;
      command.finish();
      await command.submitted;
      const submittedAt = onTiming ? performance.now() : 0;
      onTiming?.({
        stageMs: stagedAt - started,
        scenePrepareMs: preparedAt - stagedAt,
        submitMs: submittedAt - preparedAt,
        commitMs: performance.now() - submittedAt
      });
    } catch (error) {
      if (!command.closed) command.abort(error);
      throw error;
    }
  }

  /**
   * Offline second route: admits a pre-cooked OEGPACK Product and publishes it
   * through the same admission, residency, streaming and visibility path as the
   * Web route. Only the provider and the scene mapper differ.
   */
  async uploadOegPackScene(
    scene: Scene,
    asset: OegPackProductAsset,
    options: OegPackSceneOptions = {}
  ): Promise<ProductSceneHandles> {
    return this.uploadProductScene(scene, asset, () => createOegPackSceneSource(asset, { fitHeight: options.fitHeight, fitBase: options.fitBase, scale: options.scale, offset: options.offset }), options);
  }

  /**
   * Encodes release and candidate stage in one submission. Until finish, frame
   * lookup still points at the previous runtime; abort restores its ownership.
   */
  private async swapProductScene(
    scene: Scene,
    state: ProductSceneState,
    next: GeometryProductAdmissionTransaction,
    mapSource: ProductSceneSourceMapper,
    options: ProductSceneOptions,
    onCommitted: (retirementCompletion: Promise<void>) => void
  ): Promise<void> {
    const previous = { residency: state.residency, streaming: state.streaming };
    const nextResidency = next.residency;
    const oldRuntime = this._graphics.render_world.runtime(scene);
    if (!oldRuntime) throw new Error("Product replacement requires the old Scene publication");
    const mapped = await mapSource({ residency: nextResidency, descriptor: nextResidency.descriptor, source: next.source });
    options.onMaterials?.(mapped.materials);
    const nextStreaming = options.stream === false ? null : new GeometryPageStreamingRuntimeV1(this.device, nextResidency);
    const command = ShadeGPUCommandContext.create(this._graphics, "Renderer/GpuRenderWorld/residency-transaction");
    try {
      nextStreaming?.registerProduct(nextResidency.sourceForStreaming());
      this._visibilityFeature.release(oldRuntime, command);
      const handles = this._graphics.render_world.release(scene, command);
      this._graphics.assets.releaseMany(handles, command);
      this._views.releaseScene(scene, command);
      this._environments.release(scene, command);
      const handle = this._graphics.render_world.stageVirtualProduct(
        scene, mapped.source, nextResidency.bindings(), command, true
      );
      if (next.state !== "ready-to-activate") throw new Error("Product replacement was cancelled before Scene submit");
      next.publishGpuRecord();
      command.finish();
      await command.submitted;
      next.markSceneSubmitted();
      this._virtualProductScenes.set(scene, Object.freeze({
        residency: nextResidency,
        streamingRuntime: nextStreaming,
        source: nextResidency.sourceForStreaming(),
        sceneSource: mapped.source,
        streamingEnabled: nextStreaming !== null
      }));
      state.residency = nextResidency;
      state.streaming = nextStreaming;
      state.source = mapped.source;
      state.materials = mapped.materials;
      // The previous Product's page banks remain charged until queue idle.
      onCommitted(command.gpuDone.then(
        () => { previous.streaming?.destroy(); },
        () => { previous.streaming?.destroy(); }
      ));
    } catch (error) {
      if (!command.closed) command.abort(error);
      nextStreaming?.destroy();
      throw error;
    }
  }

  /**
   * Publishes one validated, already-cooked Brick4 generation for a registered
   * Scene. This explicit tool path is never called from the stable frame loop.
   */
  async resyncScene(
    scene: Scene,
    geometryAssets: readonly SceneGeometryAssetBinding[]
  ): Promise<GpuRenderWorldHandle> {
    const adapted = createPackedSceneSourceFromScene(scene, geometryAssets);
    // Validate the replacement before retiring the current runtime. GPU
    // allocation still happens only after the explicit release commits.
    createSceneResidencyManifest(adapted.source, {
      maxBufferSize: Number(this.device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(this.device.limits.maxStorageBufferBindingSize)
    });
    await this.releaseScene(scene);
    return this.uploadRenderWorldSource(scene, adapted.source, adapted.meshes);
  }

  private async uploadRenderWorldSource(
    scene: Scene,
    source: PackedSceneSource,
    ordinaryMeshes?: readonly import("../../scene/Mesh.js").Mesh[]
  ): Promise<GpuRenderWorldHandle> {
    const manifest = createSceneResidencyManifest(source, {
      maxBufferSize: Number(this.device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(this.device.limits.maxStorageBufferBindingSize)
    });
    const command = ShadeGPUCommandContext.create(
      this._graphics,
      "Renderer/GpuRenderWorld/residency-transaction"
    );
    let uploadCommitted = false;
    try {
      const handles = this._graphics.assets.residentMany(
        manifest.packages,
        command
      );
      const handle = ordinaryMeshes === undefined
        ? this._graphics.render_world.stage(scene, manifest, handles, command)
        : this._graphics.render_world.stageOrdinaryScene(
            scene,
            manifest,
            handles,
            ordinaryMeshes,
            command
          );
      command.finish();
      await command.submitted;
      uploadCommitted = true;
      const runtime = this._graphics.render_world.runtime(scene);
      if (runtime === null) {
        throw new Error("GpuRenderWorld upload committed without publishing its runtime");
      }
      return handle;
    } catch (error) {
      if (!command.closed) command.abort(error);
      if (uploadCommitted && this._graphics.render_world.runtime(scene) !== null) {
        try {
          await this.releasePackedScene(scene);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "GpuRenderWorld upload failed and its committed residency rollback also failed"
          );
        }
      }
      throw error;
    }
  }

  /** Releases one Packed Scene and all Geometry residency owned by its upload. */
  async releasePackedScene(scene: Scene): Promise<void> {
    const command = ShadeGPUCommandContext.create(
      this._graphics,
      "Renderer/GpuRenderWorld/release-transaction"
    );
    let handles: readonly AssetHandle[];
    try {
      const runtime = this._graphics.render_world.runtime(scene);
      if (runtime !== null) {
        this._visibilityFeature.release(runtime, command);
      }
      handles = this._graphics.render_world.release(scene, command);
      this._graphics.assets.releaseMany(handles, command);
      this._views.releaseScene(scene, command);
      this._environments.release(scene, command);
      command.finish();
      // The release promise is the lifecycle boundary at which retired GPU
      // residency may be reused by a replacement scene. Waiting for queue
      // completion prevents immutable texture segments from becoming stranded
      // or being reused while an earlier frame still references them.
      await command.gpuDone;
      this._virtualProductScenes.delete(scene);
      this._streamingCameraMatrices.delete(scene);
    } catch (error) {
      command.abort(error);
      throw error;
    }
  }

  /** Queues one explicit patch batch for the next main frame command. */
  queuePackedScenePatch(scene: Scene, batch: PackedScenePatchBatch): void {
    this._graphics.render_world.queuePatch(scene, batch);
  }

  gpuRenderWorldEvidence(): GpuRenderWorldEvidence {
    return this._graphics.render_world.evidence();
  }

  packedTransparentInstanceCount(scene: Scene): number {
    return this._graphics.render_world.transparentInstanceCount(scene);
  }

  async releaseScene(scene: Scene): Promise<void> {
    await this.releasePackedScene(scene);
  }

  gpuOwnerCreationEvidence(): GraphicsOwnerCreationEvidence { return this._graphics.ownerCreationEvidence(); }
  memoryEvidence(): GraphicsMemoryEvidence { return this._graphics.memoryEvidence(); }
  mainFrameGraphEvidence() { return this._lastFrameGraph; }

  async initialize(options: RendererInitializeOptions = {}): Promise<void> {
    if (this._destroyed) throw new Error("Destroyed Renderer cannot initialize");
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable");
    const config = mergeRendererConfig(this._rendererConfig, options.config);
    validateRendererConfig(config);
    this._initializationConfig = config;
    this.resolutionScale = config.renderScale ?? 1;
    let context = options.context;
    if (!context) {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block";
      context = canvas.getContext("webgpu") ?? undefined;
      if (!context) throw new Error("Cannot obtain a WebGPU canvas context");
    }
    if (options.device && !options.adapter) {
      throw new Error("A caller-owned GPUDevice requires its originating GPUAdapter");
    }
    const adapter = options.adapter ?? await gpu.requestAdapter({ powerPreference: "high-performance", featureLevel: "core" });
    if (!adapter) throw new Error("No WebGPU adapter");
    if (!gpu.wgslLanguageFeatures.has("unrestricted_pointer_parameters")) {
      throw new Error("Next Surface requires WGSL unrestricted_pointer_parameters");
    }
    const requiredFeatures = new Set<GPUFeatureName>([
      "core-features-and-limits", "indirect-first-instance", "texture-formats-tier1",
      ...(config.requiredFeatures ?? [])
    ]);
    const minStorageBuffers = Math.max(
      VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE,
      config.requiredLimits?.maxStorageBuffersPerShaderStage ?? 0
    );
    const limits = {
      maxStorageBuffersPerShaderStage: minStorageBuffers,
      ...(config.requiredLimits?.maxColorAttachmentBytesPerSample === undefined
        ? {} : { maxColorAttachmentBytesPerSample: config.requiredLimits.maxColorAttachmentBytesPerSample })
    };
    for (const feature of ["primitive-index", "subgroups", "timestamp-query"] as const) {
      if (adapter.features.has(feature)) requiredFeatures.add(feature);
    }
    const compression = (["texture-compression-bc", "texture-compression-astc", "texture-compression-etc2"] as const)
      .find(feature => adapter.features.has(feature));
    if (compression) requiredFeatures.add(compression);
    for (const feature of requiredFeatures) {
      if (!adapter.features.has(feature)) throw new Error(`Required WebGPU feature '${feature}' is unavailable`);
    }
    if (Number(adapter.limits.maxStorageBuffersPerShaderStage) < minStorageBuffers) {
      throw new Error(`Visibility requires ${minStorageBuffers} storage buffers per shader stage`);
    }
    preflightResidentSurfaceLimits(adapter.limits);
    const device = options.device ?? await adapter.requestDevice({
      requiredFeatures: [...requiredFeatures], requiredLimits: limits
    });
    for (const feature of requiredFeatures) {
      if (!device.features.has(feature)) throw new Error(`Caller device lacks '${feature}'`);
    }
    if (Number(device.limits.maxStorageBuffersPerShaderStage) < minStorageBuffers) {
      throw new Error("Caller device lacks the visibility storage-buffer limit");
    }
    preflightResidentSurfaceLimits(device.limits);
    this._ownsDevice = options.device === undefined;
    this.device = device;
    this.context = context;
    this._adapterInfo = captureGpuAdapterIdentity(adapter.info);
    this._capabilities = Object.freeze({
      features: Object.freeze([...device.features].sort()),
      limits: Object.freeze({
        maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage),
        maxColorAttachmentBytesPerSample: Number(device.limits.maxColorAttachmentBytesPerSample),
        maxBufferSize: Number(device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize)
      }),
      record: captureWebGpuCapabilityRecord(gpu, device, adapter)
    });
    // E2 freezes the device-epoch profile and owns persistent resources. E4/E5
    // publish demand and residency work through the same Frame Program submit.
    if (config.enableVsm !== false) {
      this._vsm = VsmResources.create(device, negotiateVsmCapabilities(device));
      this._vsmReceiverDemand = new VsmReceiverDemandPass(device);
      this._vsmAllocatePages = new VsmAllocatePagesPass(device);
      this._vsmCasterRecords = new VsmCasterRecordPass(device);
      this._vsmAtlasRaster = new VsmAtlasRasterPass(device);
      this._vsmInvalidation = new VsmInvalidationPass();
    }
    device.lost.then(info => {
      if (!this._destroyed) {
        this._deviceLost = true;
        if (info.reason !== "destroyed") console.error("GPUDevice lost", info);
      }
    });
    this._graphics = new GraphicsContext(
      device, this._profiler,
      config.textureMaxResolution ?? TEXTURE_RESIDENCY_MAX_SIZE,
      config.geometryResidency, config.textureBankMaxCapacities
    );
    await this._graphics.initialize();
    this._frameCoordinator = new FrameCoordinator(this._graphics);
    this._environments = new GPUSceneEnvironmentManager(this._graphics);
    this._cameraStates = new GPUCameraStateManager(device);
    this._views = new ViewManager(this._graphics, this._cameraStates);
    this._visibilityFeature = new VisibilityFeature(this._graphics);
    this._format = gpu.getPreferredCanvasFormat();
    this._displayProfile = "sdr";
    if (config.displayProfile === "hdr-auto" &&
        globalThis.matchMedia?.("(dynamic-range: high)").matches) {
      try {
        this.context.configure({ device, format: "rgba16float", alphaMode: "opaque",
          colorSpace: "display-p3", toneMapping: { mode: "extended" } });
        const actual = this.context.getConfiguration();
        if (actual?.format === "rgba16float" && actual.colorSpace === "display-p3" &&
            actual.toneMapping?.mode === "extended") {
          this._format = "rgba16float";
          this._displayProfile = "hdr";
        }
      } catch {
        // The SDR configure in resize is the fallback on unsupported devices.
      }
    }
    this._surfaceMaterial = new SurfaceMaterialPass(device, config.surfaceVirtualUnlitFallback === true);
    this._xeGtaoPreparation = new XeGtaoPreparationPass(device);
    this._xeGtaoMain = new XeGtaoMainPass(device, "high");
    this._xeGtaoDenoise = new XeGtaoDenoisePass(device, 1);
    this._present = new SurfacePresentPass(device, this._format, this._displayProfile);
    this._temporalFacts = new TemporalFactsPass(device);
    this._gpuRadiometry = new GpuRadiometryPass(device, config.autoExposure, config.fixedExposure);
    this._bloom = new BloomPass(device);
    this._renderDebugViewPass = new RenderDebugViewPass(this._graphics);
    this._fsr3 = new Fsr3UpscalerRuntime(device);
    // The pinned Takram LUT profile is device-local and recorded into the
    // first frame submission; consumers can bind its immutable views by
    // generation without owning the LUT lifetime.
    if (config.enablePhysicalEnvironment !== false) {
      this._environmentRuntime = new PhysicalEnvironmentRuntime(device);
      this._physicalSky = new PhysicalSkyPass(this._graphics);
      this._aerialPerspective = new AerialPerspectivePass(device);
    }
    const canvas = context.canvas as HTMLCanvasElement;
    this._width = Math.max(1, canvas.clientWidth || canvas.width);
    this._height = Math.max(1, canvas.clientHeight || canvas.height);
    this._renderTargets.initializeDepth(this._graphics.textures, 1, 1);
    this.resize(this._width, this._height, true);
  }

  resize(width: number, height: number, force = false): void {
    if (!force && width === this._width && height === this._height) return;
    this._width = Math.max(1, Math.floor(width));
    this._height = Math.max(1, Math.floor(height));
    const maxDimension = Number(this.device.limits.maxTextureDimension2D);
    const outputWidth = Math.min(this._width, maxDimension);
    const outputHeight = Math.min(this._height, maxDimension);
    this._output_resolution.set(outputWidth, outputHeight);
    this._render_resolution.set(
      Math.max(1, Math.floor(outputWidth * this.resolutionScale)),
      Math.max(1, Math.floor(outputHeight * this.resolutionScale))
    );
    this._renderTargets.resize(this._render_resolution.x, this._render_resolution.y);
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    if (canvas.style) {
      canvas.style.width = `${this._width}px`;
      canvas.style.height = `${this._height}px`;
    }
    this.context.configure({ device: this.device, format: this._format, alphaMode: "opaque",
      ...(this._displayProfile === "hdr"
        ? { colorSpace: "display-p3" as const, toneMapping: { mode: "extended" as const } }
        : {}) });
  }

  private frameProgramOwners(): FrameProgramOwners {
    return {
      visibility: this._visibilityFeature,
      surface: this._surfaceMaterial,
      temporalFacts: this._temporalFacts,
      radiometry: this._gpuRadiometry,
      bloom: this._bloom,
      debug: this._renderDebugViewPass,
      xeGtaoPreparation: this._xeGtaoPreparation,
      xeGtaoMain: this._xeGtaoMain,
      xeGtaoDenoise: this._xeGtaoDenoise,
      present: this._present,
      sky: this._physicalSky,
      aerial: this._aerialPerspective,
      lightCluster: () => (this._lightCluster ??= new LightClusterPass(this._graphics)),
      vsmReceiverDemand: this._vsmReceiverDemand,
      vsmAllocatePages: this._vsmAllocatePages,
      vsmCasterRecords: this._vsmCasterRecords,
      vsmAtlasRaster: this._vsmAtlasRaster,
      vsmInvalidation: this._vsmInvalidation
    };
  }

  render(camera: PerspectiveCamera, scene: Scene, timeDeltaSeconds = 1 / 60): boolean {
    if (this._deviceLost || this._destroyed) return false;
    const runtime = this._graphics.render_world_if_created?.runtime(scene);
    if (!runtime) {
      if (scene.instance_count !== 0) throw new Error("Scene has no GPU Render World publication");
      return this.renderEmptyScene();
    }
    if (this._historyRuntime !== runtime) {
      this._historyRuntime = runtime;
      this._sceneHistoryEpoch++;
    }
    const frameIndex = this._frame_count;
    const streaming = this._virtualProductScenes.get(scene)?.streamingRuntime;
    if (streaming) {
      const previous = this._streamingCameraMatrices.get(scene);
      const current = Float32Array.from(camera.view_projection_matrix);
      let delta = previous === undefined ? Infinity : 0;
      if (previous) for (let i = 0; i < 16; i++) delta = Math.max(delta, Math.abs(current[i]! - previous[i]!));
      this._streamingCameraMatrices.set(scene, current);
      const frameTimeMs = Math.max(0, timeDeltaSeconds * 1000);
      const lastPoll = streaming.evidence().lastPoll;
      streaming.updatePressure({
        cameraState: delta > 0.25 ? "cut" : delta > 1e-5 ? "moving" : "stable",
        ioThroughputBytesPerSecond: lastPoll === null || frameTimeMs === 0
          ? undefined : lastPoll.uploadedBytes * 1000 / frameTimeMs,
        gpuPressure: Math.max(0, Math.min(1, this._streamingGpuFrameTimeMs / 16.67 - 1)),
        frameTimeMs, targetFrameTimeMs: 16.67
      });
    }
    this._profiler.beginFrame(frameIndex);
    const frame = this._frameCoordinator.beginFrame(frameIndex, "Renderer/visibility-frame");
    const command = frame.command;
    const sampleGeometryCounters = this.perf_gpu_counters_enabled &&
      this._profiler.shouldSampleGpuCounters();
    if (sampleGeometryCounters) this._profiler.encodeGpuCounterClear(command);
    let temporalActive = false;
    let activeHzb: HierarchicalZBuffer | null = null;
    let environmentGeneration: number | null | undefined;
    let cameraCut = false;
    let cameraChanged = false;
    try {
      const finishScenePrepare = this._profiler.beginCpuSection("scene-prepare");
      if (this._fsr3.canRetainHistory(this._render_resolution.x, this._render_resolution.y,
          this._output_resolution.x, this._output_resolution.y) === false) {
        this._temporal.histories.invalidateNames(["color"], "internal-resize");
      }
      const preExposure: PreExposureContract = this._radiometry.beginFrame(
        this._environmentRuntime === null ? 0 :
          scene.physical_environment.revision + 1
      );
      if (this._activeCamera !== camera) {
        cameraChanged = true;
        this._activeCamera = camera;
        this._cameraRevision++;
      }
      const frameJitter = this._temporal.begin({
        frameIndex, output: [this._output_resolution.x, this._output_resolution.y],
        internal: [this._render_resolution.x, this._render_resolution.y],
        cameraRevision: this._cameraRevision, sceneRevision: this._sceneHistoryEpoch,
        // Local Product/LOD/material changes are published as GPU facts; render
        // scale has its own domain and does not describe scene replacement.
        representationRevision: 0,
        lightRevision: `environment:${scene.physical_environment.revision}`, view: "main", renderScale: this.resolutionScale,
        featureRevision: Number(this.packed_visibility_hzb_enabled), formatRevision: 1,
        deviceRevision: this.deviceEpoch,
        preExposure,
        temporalEnabled: true, nssEnabled: false,
        taaJitter: this.temporal_jitter_enabled && this._render_debug_view === RenderDebugViewValue.None
          ? undefined : [0, 0]
      });
      temporalActive = true;
      this._graphics.encodeFrameMaintenance(command);
      this._renderTargets.setFrameIndex(frameIndex);
      environmentGeneration = this._environmentRuntime?.record(command.gpu_encoder,
        scene.physical_environment.snapshot(),
        [camera.transform.matrix[12]!, camera.transform.matrix[13]!, camera.transform.matrix[14]!]);
      if (environmentGeneration !== undefined && environmentGeneration !== null) {
        this._environmentRuntime!.writeParameters((buffer, data) =>
          command.writeBuffer(buffer, 0, data, 0, data.byteLength));
      }
      const environment = this._environments.obtain(scene);
      const activeSets = Array.from({ length: 4 }, (_, setId) => setId)
        .filter(setId => runtime.activeShadingSummary.binRefCounts
          .slice(setId * 16, setId * 16 + 16).some(count => count > 0));
      const activeExceptionLanes = activeSets.flatMap(setId => [
        ...(setId !== 0 && runtime.activeShadingSummary.standardSetRefCounts[setId]! > 0
          ? [surfaceExceptionLane(setId, false)] : []),
        ...(runtime.activeShadingSummary.coatedSetRefCounts[setId]! > 0
          ? [surfaceExceptionLane(setId, true)] : [])
      ]);
      const textureBankMask = activeSets.reduce((mask, setId) => {
        const set = runtime.materialResources.bindingSets.find(candidate => candidate.id === setId);
        if (!set) throw new Error(`Active texture set ${setId} is not resident`);
        return mask | set.textureBankMask;
      }, 0) || 1;
      const hasLit = runtime.activeShadingSummary.binRefCounts
        .some((count, classId) => count > 0 && (classId & 15) >= 4);
      if (hasLit) {
        environment.lights.updateDirectRecords(command);
      }
      finishScenePrepare();
      const finishViewPrepare = this._profiler.beginCpuSection("view-prepare");
      const view = this._views.obtain(GPUViewKey.from(camera, scene), environment);
      const width = this._render_resolution.x;
      const height = this._render_resolution.y;
      view.setJitter(frameJitter[0], frameJitter[1]);
      view.setViewportSize(width, height);
      view.setUpscaleRatio(this._output_resolution.x / width, this._output_resolution.y / height);
      const patchResult = this._graphics.render_world.encodePendingPatch(scene, command);
      if (patchResult !== null && patchResult.dirtyInstanceCount > 0) {
        const previousCasterRevision = this._vsmCasterPublicationRevision;
        this._vsmCasterPublicationRevision = previousCasterRevision >= 0xfffffffe
          ? 1 : previousCasterRevision + 1;
        command.onAborted.addOne(() => {
          this._vsmCasterPublicationRevision = previousCasterRevision;
        });
      }
      view.update(command);
      const hzb = view.hierarchical_z_buffer;
      activeHzb = hzb;
      hzb.resetFrameStatistics();
      const currentViewMatrix = Float32Array.from(camera.view_projection_matrix);
      const previousViewMatrix = this._previousViewMatrices.get(view);
      if (previousViewMatrix) {
        let matrixDelta = 0;
        for (let index = 0; index < 16; index++) {
          matrixDelta = Math.max(matrixDelta, Math.abs(currentViewMatrix[index]! - previousViewMatrix[index]!));
        }
        // The current WebGPU visibility path has one previous-HZB producer
        // and no Nyx-style current-view recovery pass.  A moving camera can
        // therefore make newly exposed geometry look occluded by the old
        // view.  Invalidate HZB for every real matrix change; the next stable
        // frame rebuilds it and restores the fast path without dropping work.
        if (matrixDelta > 1e-5) {
          hzb.invalidate("camera-cut");
        }
        // Camera motion invalidates temporal data, but never changes graph topology.
        if (matrixDelta > 0.25) {
          cameraCut = true;
          hzb.invalidate("camera-cut");
          this._temporal.histories.invalidate("camera-cut");
          this._fsr3.invalidate();
        }
      }
      const identityHistory = this._temporal.histories.state("identity");
      const colorHistory = this._temporal.histories.state("color");
      const cameraPosition: [number, number, number] = [
        camera.transform.matrix[12]!, camera.transform.matrix[13]!, camera.transform.matrix[14]!
      ];
      const sunDirection = scene.physical_environment.snapshot().sunDirectionWorld;
      const vsmEnabled = hasLit && this._shadowVisibilityEnabled &&
        this._vsm !== null && this._vsm.profile !== "shadow-disabled";
      const vsmPreview = vsmEnabled
        ? buildVsmDirectionalFrameConstants(
            sunDirection, cameraPosition, camera.far, this._vsm!, this._vsmGeneration.currentGeneration)
        : null;
      const vsmGeneration = this._vsmGeneration.begin({
        deviceEpoch: this.deviceEpoch,
        scene,
        sceneRevision: runtime.shadingPublication.revision,
        casterRevision: this._vsmCasterPublicationRevision,
        sunRevision: scene.physical_environment.revision,
        sunDirection,
        cameraCut: cameraCut || cameraChanged,
        clipOriginExtent: vsmPreview?.clipOriginExtent ?? [],
        width,
        height
      });
      if (vsmGeneration.temporalInvalidate) this._temporalFacts.invalidate();
      this._gpuRadiometry.prepareFrame(colorHistory.readIndex, colorHistory.writeIndex,
        colorHistory.readValid, timeDeltaSeconds);
      this._temporalFacts.prepareFrame(width, height, identityHistory.readIndex,
        identityHistory.writeIndex, identityHistory.readValid);
      this._fsr3.prepareFrame(command, {
        renderWidth: width, renderHeight: height,
        outputWidth: this._output_resolution.x, outputHeight: this._output_resolution.y,
        jitter: frameJitter, cameraNear: camera.near, cameraFar: camera.far,
        cameraFovY: camera.fov, cameraInfiniteFar: camera.isInfiniteFar,
        frameTimeMs: Math.max(0, timeDeltaSeconds * 1000),
        reset: !this._temporal.histories.state("color").readValid,
        historyReadIndex: this._temporal.histories.state("color").readIndex
      });
      hzb.beginFrame(frameIndex, {
        renderScale: Math.round(this.resolutionScale * 1_000_000),
        feature: Number(this.packed_visibility_hzb_enabled) |
          (Number(this.packed_visibility_current_hzb_late_recheck_enabled) << 1)
      });
      const bindings = this._graphics.render_world.bindings();
      const prepareJob = {
        runtime,
        assets: bindings.assets,
        scene: bindings.scene,
        countersEnabled: sampleGeometryCounters,
        width, height,
        hierarchyView: createPackedHierarchyView(camera, height),
        virtualGeometry: runtime.virtualGeometry ?? undefined,
        sseThreshold: this.packed_visibility_sse_threshold,
        geometryWorkBudget: this.packed_geometry_work_budget,
        coneEnabled: this.packed_visibility_cone_enabled,
        meshletWorkCandidateCapacity: this.packed_meshlet_work_candidate_capacity,
        meshletWorkCompactionPath: this.packed_meshlet_work_compaction,
        primitiveIndexPath: this.packed_primitive_index,
        executionMode: "none" as const,
        previousHzb: this.packed_visibility_hzb_enabled
          ? packedPreviousHzb(hzb, view.gpu_previous_camera_state.view_projection_matrix) : null,
        demandFrameRevisionLow: frameIndex >>> 0,
        streamingRuntime: streaming ?? undefined,
        demandFrameIndex: frameIndex,
        currentHzbLateRecheck: this.packed_visibility_current_hzb_late_recheck_enabled &&
          runtime.virtualGeometry !== null
          ? { width: hzb.width, height: hzb.height, mipLevelCount: hzb.mipLevelCount }
          : null
      };
      const job: PackedVisibilityJob = {
        ...prepareJob,
        prepared: this._visibilityFeature.prepare(prepareJob,
          sampleGeometryCounters ? this._profiler.gpuCounterBuffer! : runtime.counterSink,
          view.gpu_camera_state.buffer, command)
      };
      const graphBindings: SceneFrameBindings = {
        kind: "scene",
        deviceEpoch: this.deviceEpoch,
        job, camera, view, hzb, depth: this._renderTargets.depth,
        swapchain: this.context.getCurrentTexture().createView(), runtime, preExposure,
         fsr3: this._fsr3, temporalFacts: this._temporalFacts, radiometry: this._gpuRadiometry,
        environment: this._environmentRuntime,
        vsm: this._vsm,
        vsmFrame: vsmEnabled
          ? buildVsmDirectionalFrameConstants(
              sunDirection, cameraPosition, camera.far, this._vsm!, vsmGeneration.generation
            ) : null,
        vsmGeneration
      };
      finishViewPrepare();
      const program = this._programCache.getOrCreate({
        kind: "scene", intent: "present", viewFamily: "main", outputWidth: this._output_resolution.x,
        outputHeight: this._output_resolution.y, outputFormat: this._format,
        capabilityProfile: String(this.deviceEpoch), internalWidth: width, internalHeight: height,
        virtualGeometry: runtime.virtualGeometry !== null,
        virtualBankCount: runtime.virtualGeometry?.banks.length ?? 0,
        previousHzb: this.packed_visibility_hzb_enabled,
        currentHzbLateRecheck: job.prepared.currentHzbLateRecheck !== null,
        activeSets, activeExceptionLanes, textureBankMask, hasLit,
        aoProfile: this.xe_gtao_enabled && hasLit && activeSets.length > 0
          ? "scalar-high" : "off",
        shadowProfile: vsmEnabled
          ? this._vsm!.profile : hasLit ? "shadow-disabled" : "off",
        physicalEnvironment: this._environmentRuntime !== null,
        fsr3Enabled: this.fsr3_enabled,
        bloomEnabled: this.bloom_enabled,
        debugView: this._render_debug_view
      });
      assertFrameProgramBindings(program, graphBindings);
      const graphKey = program.key;
      const compiled = this._graphCache.getOrCreate(
        graphKey,
        () => lowerFrameProgram(program, graphBindings, this.frameProgramOwners()),
        {
          hit: () => this._profiler.recordGraphCacheHit(),
          miss: () => this._profiler.recordGraphCacheMiss(),
          evict: () => this._profiler.recordGraphCacheEviction()
        }
      );
      this._lastFrameGraph = Object.freeze({
        cacheKey: graphKey,
        dump: compiled.dump(),
        resources: summarizeFrameGraphResources(compiled),
        program: { products: program.products, facts: program.facts,
          stages: program.stages, bindingRoles: program.bindingRoles }
      });
      command.encodeCompiledGraph(compiled, graphBindings);
      if (sampleGeometryCounters) {
        this._profiler.registerGpuCounterFields([
          "geometryNodesTested", "geometryClustersAccepted", "geometryMeshletsSelected",
          "geometryMeshletWorksProduced", "geometryRasterTriangles", "geometryPaddedVertices",
          "meshletQueueAttempted", "meshletQueueWritten", "meshletQueueConsumed",
          "meshletQueueOverflow", "meshletQueueInvalid", "meshletRasterTriangles",
          "queueOverflowMask"
        ]);
        this._profiler.encodeGpuCounterReadback(command);
      }
      this._temporal.markProduced("color");
      this._temporal.markProduced("identity");
      view.finish_frame(command, frameIndex);
      command.onFinished.addOne(() => this._previousViewMatrices.set(view, currentViewMatrix));
      this._profiler.measure("submit", () => this._frameCoordinator.submitFrame(frame));
      this._fsr3.commit(command.gpuDone);
      this._temporalFacts.commit(command.gpuDone);
      this._gpuRadiometry.commit(command.gpuDone);
      this._temporal.commit(frameIndex);
      temporalActive = false;
      if (environmentGeneration !== undefined && environmentGeneration !== null) this._environmentRuntime?.commit(environmentGeneration, command.gpuDone);
      if (environmentGeneration !== undefined && environmentGeneration !== null) {
        this._environmentRuntime?.luts.retireCompleted(command.gpuDone);
      }
      if (streaming) {
        void streaming.consumeAfterCompletion(frameIndex, command.gpuDone, Date.now()).catch(() => undefined);
      }
      this._frame_count++;
      this.onFrameFinished.send1(this._frame_count);
      return true;
    } catch (error) {
      if (!command.closed) this._frameCoordinator.abortFrame(frame, error);
      if (temporalActive) {
        try { this._temporal.abort(frameIndex); }
        catch (abortError) { console.error("Temporal abort failed after render error", abortError); }
      }
      activeHzb?.invalidate("explicit");
      this._fsr3.invalidate();
      this._temporalFacts.abort();
      this._gpuRadiometry.abort();
      if (environmentGeneration !== undefined && environmentGeneration !== null) {
        try { this._environmentRuntime?.abort(environmentGeneration); }
        catch (abortError) { console.error("Environment abort failed after render error", abortError); }
      }
      this._frame_count++;
      this.onFrameFinished.send1(this._frame_count);
      throw error;
    } finally {
      this._profiler.endFrame();
    }
  }

  private renderEmptyScene(): boolean {
    // The empty Frame Program does not write FSR3 or identity histories.
    // Returning to a scene must not consume a slot from before this gap.
    if (this._historyRuntime !== null) {
      this._historyRuntime = null;
      this._temporal.invalidate();
      this._fsr3.invalidate();
    }
    const frameIndex = this._frame_count;
    this._profiler.beginFrame(frameIndex);
    const frame = this._frameCoordinator.beginFrame(frameIndex, "Renderer/visibility-frame");
    const command = frame.command;
    try {
      this._graphics.encodeFrameMaintenance(command);
      const bindings: EmptyFrameBindings = {
        kind: "empty",
        deviceEpoch: this.deviceEpoch,
        swapchain: this.context.getCurrentTexture().createView()
      };
      const program = this._programCache.getOrCreate({ kind: "empty", intent: "present", viewFamily: "main", outputWidth: this._output_resolution.x,
        outputHeight: this._output_resolution.y, outputFormat: this._format,
        capabilityProfile: String(this.deviceEpoch) });
      assertFrameProgramBindings(program, bindings);
      const graphKey = program.key;
      const compiled = this._graphCache.getOrCreate(graphKey,
        () => lowerFrameProgram(program, bindings), {
          hit: () => this._profiler.recordGraphCacheHit(),
          miss: () => this._profiler.recordGraphCacheMiss(),
          evict: () => this._profiler.recordGraphCacheEviction()
        });
      this._lastFrameGraph = Object.freeze({
        cacheKey: graphKey,
        dump: compiled.dump(),
        resources: summarizeFrameGraphResources(compiled),
        program: { products: program.products, facts: program.facts,
          stages: program.stages, bindingRoles: program.bindingRoles }
      });
      command.encodeCompiledGraph(compiled, bindings);
      this._frameCoordinator.submitFrame(frame);
      this._frame_count++;
      this.onFrameFinished.send1(this._frame_count);
      return true;
    } catch (error) {
      if (!command.closed) this._frameCoordinator.abortFrame(frame, error);
      this._frame_count++;
      this.onFrameFinished.send1(this._frame_count);
      throw error;
    } finally {
      this._profiler.endFrame();
    }
  }

  destroy(): void {
    this._explicitlyDestroyed = true;
    this._recoveryCheckpoint = null;
    this.shutdown();
  }

  private shutdown(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._deviceLost = true;
    this._visibilityFeature?.destroy();
    this._surfaceMaterial?.destroy();
    this._xeGtaoMain?.destroy();
    this._xeGtaoPreparation?.destroy();
    this._physicalSky?.destroy();
    this._aerialPerspective?.destroy();
    this._fsr3?.destroy();
      this._present?.destroy();
      this._temporalFacts?.destroy();
    this._gpuRadiometry?.destroy();
    this._bloom?.destroy();
    this._renderDebugViewPass?.destroy();
    this._vsm?.destroy();
    this._vsm = null;
    this._vsmReceiverDemand?.destroy();
    this._vsmAllocatePages?.destroy();
    this._vsmCasterRecords?.destroy();
    this._vsmAtlasRaster?.destroy();
    this._views?.destroy();
    this._environments?.destroy();
    this._environmentRuntime?.destroy();
    this._environmentRuntime = null;
    this._frameCoordinator?.destroy();
    this._graphCache.destroy();
    this._programCache.clear();
    this._renderTargets.destroy();
    this._graphics?.destroy();
    this._virtualProductScenes.clear();
    this._streamingCameraMatrices.clear();
    if (this._ownsDevice) this.device?.destroy();
  }

  /** Rebuild GPU owners from CPU Product and Scene truth after a lost device. */
  recoverAfterDeviceLoss(): Promise<Renderer> {
    if (this._recoveryPromise) return this._recoveryPromise;
    if (this._explicitlyDestroyed) return Promise.reject(new Error("Destroyed Renderer cannot recover"));
    if (!this._deviceLost || !this._initializationConfig) {
      return Promise.reject(new Error("Recovery requires an initialized lost device"));
    }
    if (this._recoveryAttempts >= 2) return Promise.reject(new Error("Recovery attempt limit exceeded"));
    try {
      this._recoveryCheckpoint ??= this.checkpointRecovery();
    } catch (error) {
      return Promise.reject(error);
    }
    const checkpoint = this._recoveryCheckpoint;
    this._recoveryAttempts++;
    this.shutdown();
    const replacement = new Renderer(checkpoint.config);
    replacement.deviceEpoch = this.deviceEpoch + 1;
    this._recoveryPromise = (async () => {
      try {
        await replacement.initialize({ context: checkpoint.context, config: checkpoint.config });
        replacement.resize(checkpoint.width, checkpoint.height);
        replacement.setResolutionScale(checkpoint.resolutionScale);
        for (const entry of checkpoint.scenes) {
          if (entry.ordinaryMeshes) {
            const bindings = entry.ordinaryMeshes.map((mesh, index) => ({
              geometry: mesh.geometry,
              asset: entry.source.geometries[entry.source.geometryIndices[index]!]!
            }));
            await replacement.uploadScene(entry.scene, [...new Map(bindings.map(binding => [binding.geometry, binding])).values()]);
          } else {
            await replacement.uploadPackedScene(entry.scene, entry.source);
            if (entry.queuedPatch) replacement.queuePackedScenePatch(entry.scene, entry.queuedPatch);
          }
        }
        for (const entry of checkpoint.products) {
          const residency = await VirtualGeometryResidency.create(
            replacement.device, entry.source, entry.generation, entry.slot, undefined, entry.residency
          );
          residency.activatePublication();
          const streaming = entry.streamingEnabled
            ? new GeometryPageStreamingRuntimeV1(replacement.device, residency) : null;
          try {
            await replacement.uploadVirtualGeometryScene(entry.scene, entry.sceneSource, residency, streaming);
          } catch (error) {
            streaming?.destroy();
            residency.destroy();
            throw error;
          }
        }
        if (this._explicitlyDestroyed) {
          replacement.destroy();
          throw new Error("Renderer destroyed during recovery");
        }
        this._recoveryCheckpoint = null;
        return replacement;
      } catch (error) {
        replacement.destroy();
        this._recoveryPromise = null;
        throw error;
      }
    })();
    return this._recoveryPromise;
  }

  private checkpointRecovery() {
    const products = [...this._virtualProductScenes.entries()].map(([scene, state]) => {
      if (state.multiRuntime && state.multiRuntime.evidence().active > 1) {
        throw new Error("Multi-shard Product recovery requires source replay by the application");
      }
      const product = {
        scene, source: state.source,
        generation: state.residency.productGeneration,
        slot: state.residency.productTableSlot,
        sceneSource: refreshProductSceneSourceForRecovery(scene, state.sceneSource),
        streamingEnabled: state.streamingEnabled,
        residency: {
          requestedProfile: state.residency.residencyProfile.profile === "Disabled"
            ? "Portable" as const : state.residency.residencyProfile.profile,
          configuredCapacityBytes: state.residency.residencyProfile.capacityBytes
        } satisfies VirtualGeometryResidencyOptionsV1
      };
      state.residency.abandonForDeviceLoss();
      state.streamingRuntime?.destroy();
      return product;
    });
    return {
      context: this.context,
      config: this._initializationConfig!,
      width: this._width,
      height: this._height,
      resolutionScale: this.resolutionScale,
      scenes: this._graphics.render_world.recoveryScenes(),
      products
    };
  }

}
