/** Main render-pipeline owner: feature order, graph recipe, cache, and evidence. */

import { ChangeSignal } from "../../core/Signal.js";
import type {
  Brick4LightMapPackageV1,
  Brick4LightMapPackageValidation
} from "../../assets/Brick4LightMapPackage.js";
import { Vec2 } from "../../core/math/Vec2.js";
import { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPU_MESHLET_RASTER_WORK_ABI_VERSION } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_ABI_VERSION } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_COMPUTE_MATERIAL_ABI_VERSION } from "../../gpu/GpuComputeMaterialAbi.js";
import { GPU_HDR_BYTES_PER_PIXEL } from "../../gpu/GpuHdrAbi.js";
import { THREE_SSR_REVISION } from "../../shaders/ssr_common.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile
} from "../../gpu/GpuComputeMaterialAbi.js";
import { TEXTURE_RESIDENCY_MAX_SIZE } from "../../gpu/TextureResidency.js";
import { captureWebGpuCapabilityRecord } from "../../gpu/WebGpuCapabilityRecord.js";
import { GPUSceneEnvironmentManager } from "../../gpu/GPUSceneEnvironmentManager.js";
import type { GPUSceneEnvironmentContext } from "../../gpu/GPUSceneEnvironmentContext.js";
import type { Brick4LightMapEvidence } from "../../gpu/Brick4LightMap.js";
import { FrameGraph, FrameGraphBindingLayout } from "../../framegraph/FrameGraph.js";
import type { CompiledFrameGraphDump } from "../../framegraph/FrameGraph.js";
import { CompiledFrameGraphCache } from "../../framegraph/CompiledFrameGraphCache.js";
import {
  summarizeFrameGraphResources,
  type FrameResourceSummary
} from "../../framegraph/FrameResourceSummary.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  FrameCoordinator,
  type FrameEncoding
} from "../FrameCoordinator.js";
import { MAIN_COMMAND_LABEL, MAIN_FRAME_GRAPH_NAME } from "../../framegraph/FrameGraphNotes.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { RenderTargets } from "../RenderTargets.js";
import { GPUViewKey, ViewManager } from "../ViewManager.js";
import { GPUCameraStateManager } from "../GPUCameraState.js";
import type { PackedVisibilityDebugSource } from "../passes/PackedVisibilityPass.js";
import { VisibilityCounterPass } from "../passes/VisibilityCounterPass.js";
import {
  VisibilityFeature,
  type PackedVisibilityJob
} from "../features/VisibilityFeature.js";
import { SurfaceFeature } from "../features/SurfaceFeature.js";
import { PackedSurfaceCounterPass } from "../passes/PackedSurfaceCounterPass.js";
import { LightingFeature } from "../features/LightingFeature.js";
import {
  createDisabledShadowVisibilityFrame,
  type ShadowFeature
} from "../features/ShadowFeature.js";
import { ShadowFeatureManager } from "../features/ShadowFeatureManager.js";
import type { LightClusterOutputs } from "../passes/LightClusterPass.js";
import { TransparencyFeature } from "../features/TransparencyFeature.js";
import { RenderDebugViewPass } from "../passes/RenderDebugViewPass.js";
import { OcclusionConfidencePass } from "../passes/OcclusionConfidencePass.js";
import { AOService } from "../features/AOService.js";
import { ScreenSpaceDiffuseService } from "../features/ScreenSpaceDiffuseService.js";
import { ReflectionService } from "../features/ReflectionService.js";
import { GIService, type OpaqueLightingResult } from "../features/GIService.js";
import { TemporalFeature } from "../features/TemporalFeature.js";
import { PostFeature } from "../features/PostFeature.js";
import {
  FINAL_COLOR_PYRAMID_MAX_MIPS,
  OPAQUE_COLOR_PYRAMID_MAX_MIPS,
  SHARED_COLOR_PYRAMID_ABI_VERSION,
  SharedColorPyramidPass
} from "../passes/SharedColorPyramidPass.js";
import {
  NeuralSuperSamplingPass,
  type NssSettings
} from "../passes/NeuralSuperSamplingPass.js";
import { resolveFrameJitter } from "../TemporalJitterController.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import type { FrameGraphContext } from "../../framegraph/FrameGraph.js";
import { FrameProfiler } from "../../debug/FrameProfiler.js";
import type { FrameProfileSnapshot } from "../../debug/FrameProfiler.js";
import {
  captureGpuAdapterIdentity,
  type BenchmarkAdapterIdentity
} from "../../debug/EnvironmentManifest.js";
import type { HierarchicalZBuffer } from "../HierarchicalZBuffer.js";
import { resolveGpuEncoder } from "../../framegraph/FrameGraph.js";
import {
  canonicalFrameGraphKey,
  type FrameGraphKey
} from "../../framegraph/FrameGraphKey.js";
import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { Scene } from "../../scene/Scene.js";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "../STATIC_GRAPHICS_ENGINE_ASSETS.js";
import type { GeometryAssetPackage } from "../../assets/GeometryAssetPackage.js";
import type {
  AssetHandle,
  AssetResidencyEvidence
} from "../../gpu/GpuAssetStore.js";
import type {
  GpuSceneEvidence,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceSetHandle,
  InstanceSource
} from "../../gpu/GpuScene.js";
import { createSceneResidencyManifest } from "../../gpu/GpuSceneResidencyManifest.js";
import type {
  GpuRenderWorldEvidence,
  GpuRenderWorldHandle,
  PackedScenePatchBatch,
  PackedSceneSource
} from "../../gpu/GpuRenderWorld.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import {
  createPackedSceneSourceFromScene,
  type SceneGeometryAssetBinding
} from "../../gpu/GpuSceneAdapter.js";
import {
  RenderDebugView,
  getRenderDebugViewStatus,
  type RenderDebugView as RenderDebugViewT,
  type RenderDebugViewStatus
} from "../../debug/RenderDebugView.js";
import {
  resolveMainFrameFeatureTopology,
  type MainFrameFeatureTopology
} from "../MainFrameFeatureTopology.js";
import { halfToFloat } from "../../loaders/float16.js";
import { TemporalHistoryRegistry } from "../TemporalHistoryRegistry.js";
import {
  DEFAULT_GEOMETRY_WORK_BUDGET,
  GeometryAdaptiveSseController,
  normalizeGeometryWorkBudget,
  type GeometryBudgetMode,
  type GeometryWorkBudget
} from "../GeometryWorkBudget.js";
import type {
  GraphicsMemoryEvidence,
  GraphicsOwnerCreationEvidence
} from "../../gpu/GraphicsContext.js";
import {
  RenderSettings,
  metersToWorldUnits,
  type RenderSettingsChange,
  type RenderSettingsPatch,
  type RenderSettingsValues
} from "./RenderSettings.js";
import {
  diffuseSurfaceLiteFrame,
  LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
  longRangeDiffuseFrame,
  preExposedOpaqueRadianceSourceFrame,
  preExposedOpaqueHdrBaselineFrame,
  temporalReconstructionFrame,
  textureDomain,
  type PreExposureContract,
  type VisibilityFrame
} from "./FrameProducts.js";
import {
  createRendererFramePlan,
  type FramePlanDump
} from "./FramePlan.js";
import {
  DEFAULT_RENDERER_CONFIG,
  mergeRendererConfig,
  rendererConfigSettingsPatch,
  validateRendererConfig,
  type RendererConfig
} from "../RendererConfig.js";
import {
  createRenderFrameContract,
  type RenderFrameContract
} from "../RenderFrameContract.js";
import {
  resolveFrameSceneOwners
} from "./SceneFrameBindings.js";
import {
  createFrameContext,
  type FrameContext
} from "./FrameContext.js";
import { createMainRenderPipelineGraphKey } from "./MainRenderPipelineGraphKey.js";

const HZB_STORAGE_FORMAT_FEATURE: GPUFeatureName = "texture-formats-tier1";

export const RENDER_FRAME_PHASES = [
  "prepare_#Ko",
  "lpv_update_optional",
  "obtain_view",
  "setup_jitter_viewport",
  "view_update",
  "create_command_context_Renderer_main_0",
  "scene_tick_animation",
  "shadows_select_and_draw",
  "framegraph_Shading_begin",
  "visibility_Nb_meshlet_id_buffer",
  "material_graph_viz_gbuffer",
  "velocity_buffer",
  "occlusion_confidence",
  "light_clustering",
  "direct_lighting",
  "screen_space_diffuse_optional",
  "environment_ibl_extra",
  "indirect_lighting_#To_or_fused",
  "transparent_oit",
  "post_taa_nss_mb_sharpen",
  "bloom_exposure",
  "tonemap_to_swapchain",
  "encodeGraph_finish_frame"
] as const;

export type RenderFramePhase = (typeof RENDER_FRAME_PHASES)[number];

export type RendererInitializeOptions = {
  context?: GPUCanvasContext;
  device?: GPUDevice;
  pixelRatio?: number;
  /** 初始化时覆盖构造器配置；只在初始化前应用一次。 */
  config?: RendererConfig;
};

export interface RendererCapabilities {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly record: import("../../gpu/WebGpuCapabilityRecord.js").WebGpuCapabilityRecord;
}

export interface LinearHdrCaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stage?: "lighting" | "post-color-grading";
}

export interface LinearHdrCaptureResult extends LinearHdrCaptureRegion {
  readonly format: "rgba16float";
  readonly rgba: Float32Array;
}

export interface TemporalRuntimeEvidence {
  readonly enabled: boolean;
  readonly taaPasses: number;
  readonly classificationPasses: number;
  readonly historyTextureCount: number;
  readonly historyBytes: number;
  readonly historyValid: boolean;
  readonly historyReadValid: boolean;
  readonly historyGeneration: number;
  readonly historyRevision: number;
  readonly historyInvalidations: number;
  readonly historyInvalidationReason: string;
  readonly internalPixels: number;
  readonly outputPixels: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly internalScale: number;
  readonly reconstructionOwner: "taa" | "nss" | "disabled";
  readonly reconstructionInputDomain: "internal-full" | "disabled";
  readonly reconstructionOutputDomain: "output-full" | "disabled";
  readonly confidenceChannel: "alpha-history-lock" | "nss-feedback" | "disabled";
  readonly preExposureAware: boolean;
  readonly reactiveMaskConsumed: boolean;
  readonly disocclusionConsumed: boolean;
  readonly representationRevision: number;
  readonly drsMode: "fixed" | "adaptive";
  readonly drsScaleBuckets: readonly number[];
  readonly drsMinimumScale: number;
  readonly drsMaximumScale: number;
  readonly drsTargetFrameRate: number;
  readonly drsAcceptedGpuSamples: number;
  readonly drsScaleChanges: number;
  readonly drsLastDecision: string;
  readonly drsLastGpuMs: number;
  readonly drsFeedbackLatencyFrames: number;
}

export interface AmbientOcclusionRuntimeEvidence {
  readonly enabled: boolean;
  readonly algorithm: "three-gtao-r186-oengine-wgsl" | "disabled";
  readonly upstreamRevision: string | null;
  readonly temporalEnabled: boolean;
  readonly resolutionScale: 0.5 | 1;
  readonly radiusMeters: number;
  readonly radiusWorldUnits: number;
  readonly thicknessMeters: number;
  readonly thicknessWorldUnits: number;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly traceDepthSamplesPerPixel: number;
  readonly momentsFormat: GPUTextureFormat | null;
  readonly finalVisibilityFormat: GPUTextureFormat | null;
  readonly bentNormalFormat: GPUTextureFormat | null;
  readonly momentsBytesPerPixel: number;
  readonly finalVisibilityBytesPerPixel: number;
  readonly bentNormalBytesPerPixel: number;
  readonly metersPerWorldUnit: number;
  readonly internalPixels: number;
  readonly aoPixels: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly aoWidth: number;
  readonly aoHeight: number;
  readonly rawPasses: number;
  readonly spatialPasses: number;
  readonly temporalPasses: number;
  readonly compositePasses: number;
  readonly bentNormalUpsamplePasses: number;
  readonly historyTextureCount: number;
  readonly historyBytes: number;
  readonly historyValid: boolean;
  readonly historyRevision: number;
  readonly historyInvalidations: number;
  readonly historyInvalidationReason: string;
}

export interface ScreenSpaceGiRuntimeEvidence {
  readonly enabled: boolean;
  readonly algorithm: "three-ssgi-r186-oengine-wgsl" | "disabled";
  readonly upstreamRevision: string | null;
  readonly resolutionScale: 0.5 | 1;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly traceSamplesPerPixel: number;
  readonly tracePasses: number;
  readonly spatialPasses: number;
  readonly temporalPasses: number;
  readonly resolvePasses: number;
  readonly historyTextureCount: number;
  readonly historyBytes: number;
  readonly historyValid: boolean;
  readonly historyRevision: number;
  readonly historyInvalidations: number;
  readonly historyInvalidationReason: string;
}

export interface ScreenSpaceReflectionsRuntimeEvidence {
  readonly enabled: boolean;
  readonly algorithm: "three-ssr-r186-oengine-hzb-wgsl" | "disabled";
  readonly upstreamRevision: string | null;
  readonly temporalEnabled: boolean;
  readonly resolutionScale: 0.5 | 1;
  readonly mirrorBias: number;
  readonly traceFormat: GPUTextureFormat | null;
  readonly rawSpecularFormat: GPUTextureFormat | null;
  readonly historyFormat: GPUTextureFormat | null;
  readonly rawAlphaSemantic: "specular-dominant-ray-length" | "disabled";
  readonly resolvedAlphaSemantic: "replacement-confidence" | "disabled";
  readonly correctionMode: "confidence-baseline-replacement" | "disabled";
  readonly internalPixels: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly tracePixels: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly tracePasses: number;
  readonly prefilterPasses: number;
  readonly prefilterOwner: "shared-opaque-color-pyramid" | "disabled";
  readonly resolvePasses: number;
  readonly spatialPasses: number;
  readonly recurrentDenoisePasses: number;
  readonly temporalPasses: number;
  readonly compositePasses: number;
  readonly historyTextureCount: number;
  readonly historyBytes: number;
  readonly historyValid: boolean;
  readonly historyRevision: number;
  readonly historyInvalidations: number;
  readonly historyInvalidationReason: string;
}

export interface SharedColorPyramidRuntimeEvidence {
  readonly opaqueBuilds: number;
  readonly opaqueRenderPasses: number;
  readonly opaqueMipLevelCount: number;
  readonly finalBuilds: number;
  readonly finalRenderPasses: number;
  readonly finalMipLevelCount: number;
  readonly allocatedBytes: number;
}

export interface SharedDerivedProductsRuntimeEvidence {
  readonly abiVersion: number;
  readonly pyramids: SharedColorPyramidRuntimeEvidence;
  readonly opaqueStage: "post-screen-space-diffuse-pre-ssr";
  readonly finalStage: "post-transparency-temporal";
  readonly opaqueConsumerCount: number;
  readonly finalConsumerCount: number;
  readonly screenSpaceDiffuseSourcePyramidBuilds: 0;
  readonly bloomReconstructPasses: number;
  readonly bloomConsumedFinalMips: number;
  readonly exposureHistogramPasses: number;
  readonly exposureMeteringMipLevel: number;
  readonly exposureMeteringPixels: number;
  readonly histories: readonly Readonly<{
    name: string;
    semantic: string;
    resolutionDomain: string;
    format: string;
    bufferCount: number;
    preExposure: string;
    active: boolean;
    valid: boolean;
    readValid: boolean;
    generation: number;
    invalidationCount: number;
    lastInvalidationReason: string;
    preExposureScale: number;
  }>[];
}

export interface FinalOutputRuntimeEvidence {
  readonly finalOutputPasses: number;
  readonly bloomFused: boolean;
  readonly colorGradingFused: boolean;
  readonly sharpeningFused: boolean;
  readonly bloomCompositeMaterializationPasses: number;
  readonly colorGradingMaterializationPasses: number;
  readonly standaloneSharpenPasses: number;
  readonly fullResolutionHdrIntermediateCount: number;
  readonly debugBypass: boolean;
  readonly oneShotCaptureMaterialized: boolean;
}

export interface RendererMemoryEvidence extends GraphicsMemoryEvidence {
  readonly historyBytes: number;
  readonly historyOwners: Readonly<Record<string, number>>;
}

export interface VisibilitySurfaceMigrationEvidence {
  readonly schemaVersion: 2;
  readonly visibilityKeyAbiVersion: number;
  readonly meshletRasterWorkAbiVersion: number;
  readonly surfaceAbiVersion: number;
  readonly materialResolveBackend: string;
  readonly materialResolveBackendSelection: Readonly<{
    readonly source: string;
    readonly reason: string;
  }>;
  readonly triangleSetupEnabled: boolean;
  readonly triangleSetupThresholdPixels: number;
  readonly surfaceAbiEvidence: Readonly<{
    readonly status: "insufficient-evidence";
    readonly reason: string;
  }>;
}

export interface MainFrameGraphRuntimeEvidence {
  readonly cacheKey: string;
  readonly dump: CompiledFrameGraphDump;
  /** 编译后资源生命周期摘要；不触发 GPU readback。 */
  readonly resources: FrameResourceSummary;
}

type MainFrameGraphEvidence = MainFrameGraphRuntimeEvidence;

export interface RendererGpuOwnerCreationEvidence extends GraphicsOwnerCreationEvidence {
  readonly scene: Readonly<{
    readonly environmentContextCount: number;
    readonly environmentPrepareCount: number;
  }>;
  readonly shadow: Readonly<{
    readonly featureCount: number;
    readonly atlasCount: number;
    readonly atlasAllocatedBytes: number;
    readonly rasterPassCount: number;
    readonly workSetCount: number;
    readonly workBytes: number;
    readonly shadowViewOwnerCount: number;
    readonly directionalCameraRevision: number;
    readonly directionalCascadeSplits: readonly number[];
    readonly directionalCascadeLayouts: readonly (readonly [number, number, number, number])[];
  }>;
}

type PendingLinearHdrCapture = LinearHdrCaptureRegion & {
  readonly buffer: GPUBuffer;
  readonly bytesPerRow: number;
  readonly resolve: (result: LinearHdrCaptureResult) => void;
  readonly reject: (error: unknown) => void;
};

type MainFrameGeometrySource = Readonly<{
  readonly runtime: GpuRenderWorldRuntime;
  readonly visibilityJob: PackedVisibilityJob;
}>;

type MainFrameGraphBindings = {
  readonly context: FrameContext<
    PerspectiveCamera,
    ReturnType<ViewManager["obtain"]>,
    MainFrameFeatureTopology,
    Readonly<{
      scene: Scene;
      environment: GPUSceneEnvironmentContext;
      geometry: MainFrameGeometrySource;
      shadow: ShadowFeature | null;
      viewHzb: HierarchicalZBuffer;
    }>,
    PendingLinearHdrCapture | null
  >;
  readonly camera: PerspectiveCamera;
  readonly scene: Scene;
  readonly view: ReturnType<ViewManager["obtain"]>;
  readonly environment: GPUSceneEnvironmentContext;
  readonly geometry: MainFrameGeometrySource;
  readonly shadow: ShadowFeature | null;
  readonly viewHzb: HierarchicalZBuffer;
  readonly colorView: GPUTextureView;
  readonly renderTargets: ReturnType<RenderTargets["asImportBundle"]>;
  readonly previousDepth: GPUTextureContext;
  readonly frameIndex: number;
  readonly timeDeltaSeconds: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly gpuCounterBuffer: GPUBuffer | null;
  readonly taaHistoryValidity: number;
  readonly taaHistoryInputIndex: 0 | 1;
  readonly taaHistoryOutputIndex: 0 | 1;
  readonly taaHistoryPreExposureScale: number;
  readonly gtaoHistoryValidity: number;
  readonly gtaoHistoryInputIndex: 0 | 1;
  readonly gtaoHistoryOutputIndex: 0 | 1;
  readonly ssgiHistoryValidity: number;
  readonly ssgiHistoryInputIndex: 0 | 1;
  readonly ssgiHistoryOutputIndex: 0 | 1;
  readonly ssgiHistoryRevision: number;
  readonly ssgiHistoryPreExposureScale: number;
  readonly ssrHistoryValidity: number;
  readonly ssrHistoryInputIndex: 0 | 1;
  readonly ssrHistoryOutputIndex: 0 | 1;
  readonly ssrHistoryPreExposureScale: number;
  readonly nssFeedbackInputIndex: 0 | 1;
  readonly nssFeedbackOutputIndex: 0 | 1;
  readonly exposureHistoryValidity: boolean;
  readonly exposureHistoryInputIndex: 0 | 1;
  readonly exposureHistoryOutputIndex: 0 | 1;
  readonly motionBlurStrength: number;
  readonly nssSettings: NssSettings | null;
  readonly linearHdrCapture: PendingLinearHdrCapture | null;
};

const MAIN_GRAPH_CACHE_LIMIT = 16;
const MAIN_GRAPH_HISTORY_FORMAT_REVISION = 5;
const MAIN_GRAPH_INSTRUMENTATION_REVISION = 7;
const MAIN_HISTORY_REPRESENTATION_REVISION = 1;

/**
 * 渲染器运行时总控。
 *
 * 它负责初始化 WebGPU 资源，并在每一帧依次组织场景同步、GPU 可见性、
 * 材质展开、直接/间接光照、时域处理、后处理以及最终输出。
 */
export class MainRenderPipeline {
  context!: GPUCanvasContext;
  device!: GPUDevice;
  private _frame_count = 0;
  private _hzbCameraRevision = 0;
  private _hzbRenderScaleRevision = 0;
  private _pixel_ratio = window.devicePixelRatio;
  private readonly _renderSettings = new RenderSettings();
  private readonly _render_resolution = new Vec2(1, 1);
  private _width = 1;
  private _height = 1;
  private _renderResolutionDirty = true;
  private _canvasNeedsConfigure = false;
  private _highDynamicRange = false;
  private _peakNits = 1000;
  private _deviceLost = false;
  private _adapterInfo: BenchmarkAdapterIdentity | null = null;
  private _capabilities: RendererCapabilities | null = null;
  private readonly _rendererConfig: RendererConfig;
  private readonly _surfaceLiteProfile: GpuShadingSurfaceLiteProfile;
  private _lastFrameContract: RenderFrameContract | null = null;
  private readonly _profiler = new FrameProfiler();
  private _graphics!: GraphicsContext;
  private _frameCoordinator!: FrameCoordinator;
  private readonly _mainGraphCache = new CompiledFrameGraphCache(
    MAIN_GRAPH_CACHE_LIMIT
  );
  private _lastMainGraphEvidence: MainFrameGraphEvidence | null = null;
  private _environments!: GPUSceneEnvironmentManager;
  private _shadowFeatures!: ShadowFeatureManager;
  private _cameraStates!: GPUCameraStateManager;
  private _views!: ViewManager;
  private readonly _output_resolution = new Vec2(1, 1);
  private _visibilityFeature!: VisibilityFeature;
  private _visibilityCounters: VisibilityCounterPass | null = null;
  private _surfaceFeature!: SurfaceFeature;
  private _packedSurfaceCounters!: PackedSurfaceCounterPass;
  private _lightingFeature!: LightingFeature;
  private _giService!: GIService;
  private _transparencyFeature: TransparencyFeature | null = null;
  private _packedTransparencyOwnerGeneration = 0;
  private _pendingLinearHdrCapture: PendingLinearHdrCapture | null = null;
  private _renderDebug: RenderDebugViewPass | null = null;
  private _occlusionConfidence: OcclusionConfidencePass | null = null;
  private _aoService: AOService | null = null;
  private _gtaoConfigurationKey = "";
  private _gtaoOwnerGeneration = 0;
  private _screenSpaceDiffuseService: ScreenSpaceDiffuseService | null = null;
  private _ssgiConfigurationKey = "";
  private _ssgiOwnerGeneration = 0;
  private _reflectionService: ReflectionService | null = null;
  private _ssrConfigurationKey = "";
  private _ssrOwnerGeneration = 0;
  private readonly _temporalFeature = new TemporalFeature();
  private _nss: NeuralSuperSamplingPass | null = null;
  private _postFeature: PostFeature | null = null;
  private _sharedColorPyramids: SharedColorPyramidPass | null = null;
  private readonly _temporalHistories = new TemporalHistoryRegistry([
    {
      name: "color",
      semantic: "final-temporal-color",
      resolutionDomain: "output-full",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "working-linear-rescale"
    },
    {
      name: "gtao",
      semantic: "gtao-visibility-bent-moments",
      resolutionDomain: "effect-resolution",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "none"
    },
    {
      name: "ssgi",
      semantic: "ssgi-ao-bent-and-incident-diffuse",
      resolutionDomain: "effect-resolution",
      format: "rgba16float+rgba16float",
      bufferCount: 4,
      preExposure: "working-linear-rescale"
    },
    {
      name: "ssr",
      semantic: "ssr-recurrent-specular",
      resolutionDomain: "effect-resolution",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "working-linear-rescale"
    },
    {
      name: "nss-feedback",
      semantic: "nss-network-feedback",
      resolutionDomain: "internal-full",
      format: "rgba16float",
      bufferCount: 2,
      preExposure: "invalidate-on-change"
    },
    {
      name: "exposure",
      semantic: "automatic-exposure-adapted-luminance",
      resolutionDomain: "scalar",
      format: "f32-buffer",
      bufferCount: 2,
      preExposure: "invalidate-on-change"
    }
  ]);
  private _lastFramePlan: FramePlanDump | null = null;
  private _unsubscribeDynamicResolution: (() => void) | null = null;
  private _dynamicResolutionOwnsProfiler = false;
  private _geometrySseController: GeometryAdaptiveSseController | null = null;
  private _geometrySseControllerKey = "";
  private _lastTemporalTaaPassCount = 0;
  private _lastTemporalClassificationPassCount = 0;
  private _renderTargets = new RenderTargets();
  private _format: GPUTextureFormat = "rgba8unorm";
  /** Immutable snapshot; use configure() to update it. */
  get render_settings(): RenderSettingsValues {
    return this._renderSettings.values;
  }

  /**
   * The only render-quality mutation seam. Numeric uniforms do not change the
   * topology revision; resource/domain changes invalidate the affected history.
   */
  configure(patch: RenderSettingsPatch): RenderSettingsChange {
    const change = this._renderSettings.update(patch);
    if (!change.changed) return change;
    if (change.resolutionChanged) this._renderResolutionDirty = true;
    this.synchronizeDynamicResolutionPolicy();
    if (
      change.historiesInvalidated.length > 0 &&
      !change.topologyChanged &&
      !change.resolutionChanged
    ) {
      this._temporalHistories.invalidateNames(
        change.historiesInvalidated,
        "explicit"
      );
    }
    const post = this._renderSettings.values.post;
    this._postFeature?.syncExposure({
      exposureCompensation: post.exposureCompensation,
      exposureSpeedUp: post.exposureSpeedUp,
      exposureSpeedDown: post.exposureSpeedDown
    });
    this._postFeature?.updateTonemap(
      this._format,
      this._highDynamicRange,
      this._peakNits,
      post.exposureCompensation
    );
    return change;
  }
  /** 单一调试视图选择；unsupported 条目不会向 FrameGraph 添加工作。 */
  render_debug_view: RenderDebugViewT = RenderDebugView.None;
  fused_indirect = true;
  upscale_type = 0;
  motion_blur_strength = 1;
  /** R3 production default, matching the minimum three.js quality baseline. */
  packed_visibility_sse_threshold = 4;
  /** Formal benchmarks remain fixed; adaptive mode consumes delayed GPU truth counters. */
  packed_geometry_budget_mode: GeometryBudgetMode = "fixed";
  packed_geometry_work_budget: GeometryWorkBudget = DEFAULT_GEOMETRY_WORK_BUDGET;
  packed_geometry_quality_floor_sse = 16;
  packed_visibility_cone_enabled = true;
  packed_visibility_hzb_enabled = true;
  /** Validation pressure override; zero derives the correctness-safe capacity. */
  packed_meshlet_work_candidate_capacity = 0;
  /** ADR-0008 Step-2 compaction specialization policy. */
  packed_meshlet_work_compaction: "auto" | "portable" | "subgroup" = "auto";
  /** WebGPU 2026 primitive identity specialization; portable is an explicit parity override. */
  packed_primitive_index: "auto" | "portable" = "auto";
  /** Candidate cache remains fallback-only until the M5 evidence gate passes. */
  packed_triangle_setup_enabled = false;
  packed_triangle_setup_threshold_pixels = 32;

  onFrameFinished = new ChangeSignal<number>();
  onFrameDebug = new ChangeSignal<number, any[]>();

  private _debug_frame_budget = 0;
  private readonly _onDynamicRangeChange = (): void => {
    this.updateDynamicRangeState();
  };

  constructor(config: RendererConfig = {}) {
    this._rendererConfig = mergeRendererConfig(DEFAULT_RENDERER_CONFIG, config);
    validateRendererConfig(this._rendererConfig);
    this._surfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE;
    this._renderSettings.update(rendererConfigSettingsPatch(this._rendererConfig));
    this._temporalFeature.dynamicResolution.get_scale = () => this.internal_resolution_scale;
    this._temporalFeature.dynamicResolution.set_scale = (scale) => {
      this.configure({ resolution: { internalScale: scale } });
    };
    this.synchronizeDynamicResolutionPolicy();
    this._unsubscribeDynamicResolution = this._profiler.subscribe((snapshot) => {
      this.consumeDynamicResolutionSnapshot(snapshot);
      this.consumeGeometryBudgetSnapshot(snapshot);
    });
  }

  get frame_count(): number {
    return this._frame_count;
  }

  get canvas(): HTMLCanvasElement | OffscreenCanvas | undefined {
    return this.context?.canvas;
  }

  get pixel_ratio(): number {
    return this._pixel_ratio;
  }
  set pixel_ratio(ratio: number) {
    if (ratio === this._pixel_ratio) return;
    this._pixel_ratio = ratio;
    this.applyFullResolutionChange();
  }

  get internal_resolution_scale(): number {
    return this._renderSettings.values.resolution.internalScale;
  }
  set internal_resolution_scale(v: number) {
    this.configure({ resolution: { mode: "fixed", internalScale: v } });
  }

  get aspect_ratio(): number {
    return this._render_resolution.x / this._render_resolution.y;
  }

  get graphics(): GraphicsContext {
    return this._graphics;
  }

  /** 初始化后公开能力快照；GPU 对象和资源 owner 保持内部。 */
  get capabilities(): RendererCapabilities {
    if (this._capabilities === null) {
      throw new Error("Renderer capabilities are available after initialize()");
    }
    return this._capabilities;
  }

  /** 最近一次提交给 View/FrameGraph 的无 GPU 句柄帧合同。 */
  get frame_contract(): RenderFrameContract | null {
    return this._lastFrameContract;
  }

  /**
   * Encodes validated package residency into a caller-owned command context.
   * The returned handle becomes committed when that command is submitted.
   */
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
   * Uploads already-cooked packages and one compact Instance set as explicit
   * one-shot tool commands. Stable render frames never repeat this work.
   */
  async uploadPackedScene(
    scene: Scene,
    source: PackedSceneSource
  ): Promise<GpuRenderWorldHandle> {
    return this.uploadRenderWorldSource(scene, source);
  }

  /**
   * Registers an ordinary Application Scene through the unified GPU Render
   * World. Geometry must already be cooked; the renderer never cooks in the
   * frame loop and the adapter owns no GPU resources.
   */
  async uploadScene(
    scene: Scene,
    geometryAssets: readonly SceneGeometryAssetBinding[]
  ): Promise<GpuRenderWorldHandle> {
    const adapted = createPackedSceneSourceFromScene(scene, geometryAssets);
    return this.uploadRenderWorldSource(scene, adapted.source, adapted.meshes);
  }

  /**
   * Publishes one validated, already-cooked Brick4 generation for a registered
   * Scene. This explicit tool path is never called from the stable frame loop.
   */
  uploadBrick4LightMap(
    scene: Scene,
    source: Brick4LightMapPackageV1
  ): Brick4LightMapPackageValidation {
    if (this._graphics.render_world.runtime(scene) === null) {
      throw new Error("uploadBrick4LightMap requires an uploaded Scene");
    }
    return this._environments.obtain(scene).volumetric_light_map.upload(source);
  }

  /**
   * Declares a newer Brick4 generation unavailable until the matching package
   * is uploaded; receiver selection falls through without sampling stale data.
   */
  invalidateBrick4LightMap(scene: Scene, nextGeneration?: number): void {
    const environment = this._environments.get(scene);
    if (environment === undefined) {
      throw new Error("invalidateBrick4LightMap requires a registered Brick4 owner");
    }
    environment.volumetric_light_map.invalidate(nextGeneration);
  }

  brick4LightMapEvidence(scene: Scene): Brick4LightMapEvidence | null {
    return this._environments.get(scene)?.volumetric_light_map.evidence() ?? null;
  }

  /** Explicit structural full-resync for add/remove or geometry changes. */
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
      return handle;
    } catch (error) {
      command.abort(error);
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
      if (runtime !== null && this._visibilityFeature) {
        this._visibilityFeature.release(runtime, command);
        this._transparencyFeature?.releasePacked(runtime, command);
        this._shadowFeatures.releaseRenderWorld(scene, runtime, command);
      }
      handles = this._graphics.render_world.release(scene, command);
      this._graphics.assets.releaseMany(handles, command);
      this._views.releaseScene(scene, command);
      this._shadowFeatures.release(scene, command);
      this._environments.release(scene, command);
      command.finish();
      // The release promise is the lifecycle boundary at which retired GPU
      // residency may be reused by a replacement scene. Waiting for queue
      // completion prevents immutable texture segments from becoming stranded
      // or being reused while an earlier frame still references them.
      await command.gpuDone;
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

  /** FX-05 bounded owner/draw evidence; null means the Packed feature owner was never created. */
  packedTransparencyEvidence(): Readonly<{
    rasterStateBinLimit: number;
    drawCount: number;
    momentPasses: number;
    forwardPasses: number;
    compositePasses: number;
    transientBytesPerPixel: number;
    motionContract: "reactive-all-velocity-invalid-v1";
  }> | null {
    const feature = this._transparencyFeature;
    if (feature === null || feature.packed() === null) return null;
    return Object.freeze({
      rasterStateBinLimit: feature.rasterStateBinLimit!,
      drawCount: feature.drawCount,
      momentPasses: feature.momentPasses,
      forwardPasses: feature.forwardPasses,
      compositePasses: feature.compositePasses,
      transientBytesPerPixel: feature.transientBytesPerPixel!,
      motionContract: feature.motionContract!
    });
  }

  /**
   * Requests one scene-linear HDR capture from the next successful main frame.
   * The copy is encoded into that frame's existing command submission; no
   * capture node, buffer, readback or owner exists when this seam is unused.
   */
  requestLinearHdrCapture(
    region: LinearHdrCaptureRegion
  ): Promise<LinearHdrCaptureResult> {
    if (this._pendingLinearHdrCapture !== null) {
      throw new Error("A Linear HDR capture is already pending");
    }
    const validated = Object.freeze({
      ...validateLinearHdrCaptureRegion(
        region,
        this._render_resolution.x,
        this._render_resolution.y
      ),
      stage: region.stage ?? "lighting"
    });
    const bytesPerRow = alignTo(validated.width * 8, 256);
    const buffer = this.device.createBuffer({
      label: "Renderer/one-shot linear HDR capture",
      size: bytesPerRow * validated.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    return new Promise<LinearHdrCaptureResult>((resolve, reject) => {
      this._pendingLinearHdrCapture = {
        ...validated,
        buffer,
        bytesPerRow,
        resolve,
        reject
      };
    });
  }

  /**
   * Frame evidence is disabled by default. Benchmarks enable it explicitly and
   * choose a GPU timestamp sampling cadence through `configure()`.
   */
  get profiler(): FrameProfiler {
    return this._profiler;
  }

  /** Bounded production evidence; no GPU handle or mutable owner escapes. */
  temporalEvidence(): TemporalRuntimeEvidence {
    const history = this._temporalHistories.state("color");
    const drs = this._temporalFeature.dynamicResolution.evidence();
    const topology = this.resolveFeatureTopology();
    const reconstructionOwner = !topology.temporal
      ? "disabled" as const
      : topology.nss ? "nss" as const : "taa" as const;
    return Object.freeze({
      enabled: this._renderSettings.values.features.temporalAntiAliasing,
      taaPasses: this._lastTemporalTaaPassCount,
      classificationPasses: this._lastTemporalClassificationPassCount,
      historyTextureCount: this._temporalFeature.colorHistoryCount(),
      historyBytes: this._temporalFeature.colorHistoryBytes(),
      historyValid: history.valid,
      historyReadValid: history.readValid,
      historyGeneration: history.generation,
      historyRevision: history.revision,
      historyInvalidations: history.invalidationCount,
      historyInvalidationReason: history.lastInvalidationReason,
      internalPixels: this._render_resolution.x * this._render_resolution.y,
      outputPixels: this._output_resolution.x * this._output_resolution.y,
      internalWidth: this._render_resolution.x,
      internalHeight: this._render_resolution.y,
      outputWidth: this._output_resolution.x,
      outputHeight: this._output_resolution.y,
      internalScale: this._renderSettings.values.resolution.internalScale,
      reconstructionOwner,
      reconstructionInputDomain: topology.temporal ? "internal-full" : "disabled",
      reconstructionOutputDomain: topology.temporal ? "output-full" : "disabled",
      confidenceChannel: !topology.temporal
        ? "disabled"
        : topology.nss ? "nss-feedback" : "alpha-history-lock",
      preExposureAware: topology.temporal,
      reactiveMaskConsumed: topology.temporal,
      disocclusionConsumed: topology.temporal,
      representationRevision: MAIN_HISTORY_REPRESENTATION_REVISION +
        (topology.nss ? this._nss?.historyRepresentationRevision ?? 0 : 0),
      drsMode: drs.mode,
      drsScaleBuckets: drs.scaleBuckets,
      drsMinimumScale: drs.minimumScale,
      drsMaximumScale: drs.maximumScale,
      drsTargetFrameRate: drs.targetFrameRate,
      drsAcceptedGpuSamples: drs.acceptedGpuSamples,
      drsScaleChanges: drs.scaleChanges,
      drsLastDecision: drs.lastDecision,
      drsLastGpuMs: drs.lastGpuFrameTimeMs,
      drsFeedbackLatencyFrames: drs.lastFeedbackLatencyFrames
    });
  }

  /** FX-07 bounded AO phase/history evidence; GPU handles remain private. */
  ambientOcclusionEvidence(): AmbientOcclusionRuntimeEvidence {
    const history = this._temporalHistories.state("gtao");
    const pass = this._aoService;
    const internalPixels = this._render_resolution.x * this._render_resolution.y;
    const aoSettings = this._renderSettings.values.ao;
    const aoEnabled =
      this._renderSettings.values.features.screenSpaceDiffuseMode === "gtao";
    const aoWidth = Math.max(1, Math.ceil(this._render_resolution.x * aoSettings.resolutionScale));
    const aoHeight = Math.max(1, Math.ceil(this._render_resolution.y * aoSettings.resolutionScale));
    return Object.freeze({
      enabled: aoEnabled,
      algorithm: aoEnabled ? (pass?.algorithm ?? "three-gtao-r186-oengine-wgsl") : "disabled",
      upstreamRevision: aoEnabled ? (pass?.upstreamRevision ?? null) : null,
      temporalEnabled: aoEnabled && aoSettings.temporalEnabled,
      resolutionScale: aoSettings.resolutionScale,
      radiusMeters: aoSettings.radiusMeters,
      radiusWorldUnits: metersToWorldUnits(
        aoSettings.radiusMeters,
        this._renderSettings.values.physicalScale
      ),
      thicknessMeters: aoSettings.thicknessMeters,
      thicknessWorldUnits: metersToWorldUnits(
        aoSettings.thicknessMeters,
        this._renderSettings.values.physicalScale
      ),
      sliceCount: aoSettings.sliceCount,
      stepCount: aoSettings.stepCount,
      traceDepthSamplesPerPixel: aoEnabled ? aoSettings.sliceCount * aoSettings.stepCount * 2 : 0,
      momentsFormat: aoEnabled ? (pass?.momentsFormat ?? null) : null,
      finalVisibilityFormat: aoEnabled ? (pass?.finalVisibilityFormat ?? null) : null,
      bentNormalFormat: aoEnabled ? (pass?.bentNormalFormat ?? null) : null,
      momentsBytesPerPixel: aoEnabled ? (pass?.momentsBytesPerPixel ?? 0) : 0,
      finalVisibilityBytesPerPixel: aoEnabled ? (pass?.finalVisibilityBytesPerPixel ?? 0) : 0,
      bentNormalBytesPerPixel: aoEnabled ? (pass?.bentNormalBytesPerPixel ?? 0) : 0,
      metersPerWorldUnit: this._renderSettings.values.physicalScale.metersPerWorldUnit,
      internalPixels,
      aoPixels: aoEnabled ? aoWidth * aoHeight : 0,
      internalWidth: this._render_resolution.x,
      internalHeight: this._render_resolution.y,
      aoWidth: aoEnabled ? aoWidth : 0,
      aoHeight: aoEnabled ? aoHeight : 0,
      rawPasses: pass?.lastRawPasses ?? 0,
      spatialPasses: pass?.lastSpatialPasses ?? 0,
      temporalPasses: pass?.lastTemporalPasses ?? 0,
      compositePasses: pass?.lastCompositePasses ?? 0,
      bentNormalUpsamplePasses: pass?.lastBentNormalUpsamplePasses ?? 0,
      historyTextureCount: pass?.historyTextureCount ?? 0,
      historyBytes: pass?.historyBytes ?? 0,
      historyValid: history.valid,
      historyRevision: history.revision,
      historyInvalidations: history.invalidationCount,
      historyInvalidationReason: history.lastInvalidationReason
    });
  }

  /** ADR-0009 Step 5 SSGI phase/history evidence. */
  screenSpaceGiEvidence(): ScreenSpaceGiRuntimeEvidence {
    const history = this._temporalHistories.state("ssgi");
    const pass = this._screenSpaceDiffuseService;
    const settings = this._renderSettings.values.ssgi;
    const enabled =
      this._renderSettings.values.features.screenSpaceDiffuseMode === "ssgi";
    return Object.freeze({
      enabled,
      algorithm: enabled ? "three-ssgi-r186-oengine-wgsl" : "disabled",
      upstreamRevision: enabled ? (pass?.implementation.upstreamRevision ?? null) : null,
      resolutionScale: settings.resolutionScale,
      sliceCount: settings.sliceCount,
      stepCount: settings.stepCount,
      traceSamplesPerPixel: enabled ? settings.sliceCount * settings.stepCount * 2 : 0,
      tracePasses: pass?.lastTracePasses ?? 0,
      spatialPasses: pass?.lastSpatialPasses ?? 0,
      temporalPasses: pass?.lastTemporalPasses ?? 0,
      resolvePasses: pass?.lastResolvePasses ?? 0,
      historyTextureCount: pass?.historyTextureCount ?? 0,
      historyBytes: pass?.historyBytes ?? 0,
      historyValid: history.valid,
      historyRevision: history.revision,
      historyInvalidations: history.invalidationCount,
      historyInvalidationReason: history.lastInvalidationReason
    });
  }

  /** FX-08 bounded SSR phase/history evidence; GPU handles remain private. */
  screenSpaceReflectionsEvidence(): ScreenSpaceReflectionsRuntimeEvidence {
    const history = this._temporalHistories.state("ssr");
    const pass = this._reflectionService;
    const enabled = this._renderSettings.values.features.screenSpaceReflections;
    const resolutionScale = this._renderSettings.values.ssr.resolutionScale;
    const traceWidth = enabled ? Math.max(1, Math.ceil(this._render_resolution.x * resolutionScale)) : 0;
    const traceHeight = enabled ? Math.max(1, Math.ceil(this._render_resolution.y * resolutionScale)) : 0;
    return Object.freeze({
      enabled,
      algorithm: enabled ? "three-ssr-r186-oengine-hzb-wgsl" : "disabled",
      upstreamRevision: enabled ? THREE_SSR_REVISION : null,
      temporalEnabled: enabled && this._renderSettings.values.ssr.temporalEnabled,
      resolutionScale,
      mirrorBias: this._renderSettings.values.ssr.mirrorBias,
      traceFormat: enabled ? "rg32uint" : null,
      rawSpecularFormat: enabled ? "rgba16float" : null,
      historyFormat: enabled && this._renderSettings.values.ssr.temporalEnabled
        ? "rgba16float"
        : null,
      rawAlphaSemantic: enabled ? "specular-dominant-ray-length" : "disabled",
      resolvedAlphaSemantic: enabled ? "replacement-confidence" : "disabled",
      correctionMode: enabled ? "confidence-baseline-replacement" : "disabled",
      internalPixels: enabled
        ? this._render_resolution.x * this._render_resolution.y
        : 0,
      internalWidth: enabled ? this._render_resolution.x : 0,
      internalHeight: enabled ? this._render_resolution.y : 0,
      tracePixels: traceWidth * traceHeight,
      traceWidth,
      traceHeight,
      tracePasses: pass?.lastTracePasses ?? 0,
      prefilterPasses: enabled
        ? this._sharedColorPyramids?.evidence().opaqueBuilds ?? 0
        : 0,
      prefilterOwner: enabled ? "shared-opaque-color-pyramid" : "disabled",
      resolvePasses: pass?.lastResolvePasses ?? 0,
      spatialPasses: pass?.lastSpatialPasses ?? 0,
      recurrentDenoisePasses: pass?.lastSpatialPasses ?? 0,
      temporalPasses: pass?.lastTemporalPasses ?? 0,
      compositePasses:
        this._renderSettings.values.features.screenSpaceReflections && this._reflectionService?.lastCorrectionRan === true ? 1 : 0,
      historyTextureCount: pass?.historyTextureCount ?? 0,
      historyBytes: pass?.historyBytes ?? 0,
      historyValid: history.valid,
      historyRevision: history.revision,
      historyInvalidations: history.invalidationCount,
      historyInvalidationReason: history.lastInvalidationReason
    });
  }

  get frame_plan_evidence(): FramePlanDump | null {
    return this._lastFramePlan;
  }

  /** Q00 resource ownership evidence; values are sampled after graph execution. */
  memoryEvidence(): RendererMemoryEvidence {
    const graphics = this._graphics.memoryEvidence();
    const historyOwners = Object.freeze({
      temporal: this.temporalEvidence().historyBytes,
      ambientOcclusion: this.ambientOcclusionEvidence().historyBytes,
      screenSpaceGi: this.screenSpaceGiEvidence().historyBytes,
      screenSpaceReflections: this.screenSpaceReflectionsEvidence().historyBytes,
      automaticExposure: this._postFeature?.automaticExposureHistoryBytes ?? 0
    });
    const historyBytes = Object.values(historyOwners).reduce(
      (sum, bytes) => sum + bytes,
      0
    );
    return Object.freeze({ ...graphics, historyBytes, historyOwners });
  }

  /** Releases either Packed input or an ordinary Scene adapter registration. */
  async releaseScene(scene: Scene): Promise<void> {
    return this.releasePackedScene(scene);
  }

  /** Architecture gate evidence; reports owner creation without exposing GPU resources. */
  gpuOwnerCreationEvidence(): RendererGpuOwnerCreationEvidence {
    const graphics = this._graphics.ownerCreationEvidence();
    const environment = this._environments.evidence();
    const shadow = this._shadowFeatures.evidence();
    return Object.freeze({
      ...graphics,
      scene: Object.freeze({
        environmentContextCount: environment.contextCount,
        environmentPrepareCount: environment.prepareCount
      }),
      shadow
    });
  }

  /** Machine-readable migration state; does not imply any performance Gate passed. */
  visibilitySurfaceMigrationEvidence(): VisibilitySurfaceMigrationEvidence {
    return Object.freeze({
      schemaVersion: 2,
      visibilityKeyAbiVersion: GPU_VISIBILITY_KEY_ABI_VERSION,
      meshletRasterWorkAbiVersion: GPU_MESHLET_RASTER_WORK_ABI_VERSION,
      surfaceAbiVersion: GPU_COMPUTE_MATERIAL_ABI_VERSION,
      materialResolveBackend: this._surfaceFeature?.materialResolveBackend ?? "uninitialized",
      materialResolveBackendSelection: Object.freeze({
        source: "adr-0009-step2-cutover",
        reason: "MaterialTileWork compute evaluation is the sole production opaque material backend"
      }),
      triangleSetupEnabled: this.packed_triangle_setup_enabled,
      triangleSetupThresholdPixels: this.packed_triangle_setup_threshold_pixels,
      surfaceAbiEvidence: Object.freeze({
        status: "insufficient-evidence",
        reason: "M6 requires complete unified Surface ABI correctness, attachment, and memory evidence before any future ABI change"
      })
    });
  }

  /** Immutable graph topology corresponding to the most recently encoded main view. */
  mainFrameGraphEvidence(): MainFrameGraphRuntimeEvidence | null {
    const evidence = this._lastMainGraphEvidence;
    return evidence === null
      ? null
      : Object.freeze({
        cacheKey: evidence.cacheKey,
        dump: evidence.dump,
        resources: evidence.resources
      });
  }

  get render_debug_view_status(): RenderDebugViewStatus {
    return getRenderDebugViewStatus(this.render_debug_view);
  }

  /** Null when the caller supplied a GPUDevice without its originating adapter. */
  get adapter_info(): BenchmarkAdapterIdentity | null {
    return this._adapterInfo === null ? null : { ...this._adapterInfo };
  }

  get views(): ViewManager {
    return this._views;
  }

  get output_resolution(): Vec2 {
    return this._output_resolution.clone();
  }

  get nss(): NeuralSuperSamplingPass {
    if (!this._nss) {
      this._nss = new NeuralSuperSamplingPass(this._graphics);
      const outputWidth = this._output_resolution.x;
      const renderWidth = this._render_resolution.x;
      if (outputWidth > 0 && renderWidth > 0) {
        this._nss.jitter_sequence_size =
          NeuralSuperSamplingPass.recommended_jitter_sequence_size(
            outputWidth / renderWidth
          );
      }
    }
    return this._nss;
  }

  get texture_depth_current(): GPUTextureContext {
    return this._renderTargets.depthCurrent;
  }

  get texture_depth_previous(): GPUTextureContext {
    return this._renderTargets.depthPrevious;
  }

  async initialize({
    context,
    device,
    pixelRatio = window.devicePixelRatio,
    config
  }: RendererInitializeOptions = {}): Promise<void> {
    if (!("gpu" in navigator)) {
      throw new Error("navigator.gpu not available — WebGPU disabled or unsupported");
    }
    const effectiveConfig = mergeRendererConfig(this._rendererConfig, config);
    validateRendererConfig(effectiveConfig);
    if (config !== undefined) {
      this.configure(rendererConfigSettingsPatch(effectiveConfig));
    }
    this.updateCanvasFormat();
    this.updateDynamicRangeState();

    if (context === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;display:block";
      context = canvas.getContext("webgpu") ?? undefined;
      if (context === undefined) throw new Error("Failed to bind GPUCanvasContext");
    }

    let selectedAdapter: GPUAdapter | undefined;
    if (device === undefined) {
      const gpu = navigator.gpu;
      if (gpu === undefined) throw new Error("navigator.gpu is undefined");
      const adapter = await gpu.requestAdapter({
        powerPreference: "high-performance",
        featureLevel: "core"
      });
      if (adapter === null) throw new Error("Failed to bind GPUAdapter");
      selectedAdapter = adapter;
      this._adapterInfo = captureGpuAdapterIdentity(adapter.info);
      if ((adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter) {
        console.warn(
          "GPU provided a fallback adapter (typically because no other appropriate adapter was available). Fallback adapter is typically a software implementation and will be slow."
        );
      }
      const storageBufferLimit = adapter.limits.maxStorageBuffersPerShaderStage;
      if (storageBufferLimit < 10) {
        throw new Error(
          `Engine requires at least 10 storage buffers per shader stage, actual is ${storageBufferLimit}`
        );
      }
      const requiredFeatures = new Set<GPUFeatureName>([
        "core-features-and-limits",
        "indirect-first-instance",
        "float32-blendable",
        // HZB is a core render path and unconditionally uses rg16float storage.
        HZB_STORAGE_FORMAT_FEATURE
      ]);
      for (const feature of effectiveConfig.requiredFeatures ?? []) {
        requiredFeatures.add(feature);
      }
      const optionalFeatureNames: GPUFeatureName[] = [
        "timestamp-query",
        "subgroups",
        "primitive-index"
      ];
      for (const feature of requiredFeatures) {
        if (!adapter.features.has(feature)) {
          throw new Error(`Adapter does not support required feature '${feature}'`);
        }
      }
      for (const feature of optionalFeatureNames) {
        if (adapter.features.has(feature)) requiredFeatures.add(feature);
      }
      // Texture Package V2 consumes exactly one physical compression family.
      const compressionFeatures: GPUFeatureName[] = [
        "texture-compression-bc",
        "texture-compression-astc",
        "texture-compression-etc2"
      ];
      const compressionFeature = compressionFeatures.find((feature) => adapter.features.has(feature));
      if (compressionFeature !== undefined) requiredFeatures.add(compressionFeature);
      device = await adapter.requestDevice({
        requiredLimits: {
          maxColorAttachmentBytesPerSample: Math.max(
            32,
            effectiveConfig.requiredLimits?.maxColorAttachmentBytesPerSample ?? 0
          ),
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxStorageBuffersPerShaderStage: Math.max(
            10,
            effectiveConfig.requiredLimits?.maxStorageBuffersPerShaderStage ?? 0
          )
        },
        requiredFeatures: [...requiredFeatures] // texture-formats-tier1 必须随请求进入设备。
      });
    }

    validateRendererDevice(device, effectiveConfig);
    const capabilityRecord = captureWebGpuCapabilityRecord(
      navigator.gpu,
      device,
      selectedAdapter
    );
    this._capabilities = Object.freeze({
      features: Object.freeze([...device.features].sort()),
      limits: Object.freeze({
        maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage),
        maxColorAttachmentBytesPerSample: Number(device.limits.maxColorAttachmentBytesPerSample),
        maxBufferSize: Number(device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize)
      }),
      record: capabilityRecord
    });

    device.lost.then((info) => this.onDeviceLost(info));
    this.context = context;
    this.device = device;
    this._pixel_ratio = pixelRatio;
    const canvas = context.canvas as HTMLCanvasElement;
    this._width = canvas.clientWidth;
    this._height = canvas.clientHeight;
    this.recalculateOutputResolution();

    this._profiler.configure({
      gpuTimestampAvailable: device.features.has("timestamp-query")
    });
    this._graphics = new GraphicsContext(
      device,
      this._profiler,
      effectiveConfig.textureMaxResolution ?? TEXTURE_RESIDENCY_MAX_SIZE
    );
    this._frameCoordinator = new FrameCoordinator(this._graphics);
    await this._graphics.initialize();
    this._environments = new GPUSceneEnvironmentManager(this._graphics);
    this._shadowFeatures = new ShadowFeatureManager(this._graphics);
    this._cameraStates = new GPUCameraStateManager(device);
    this._views = new ViewManager(
      this._graphics,
      this._cameraStates
    );
    this._renderTargets.initializeDepth(
      this._graphics.textures,
      this._render_resolution.x,
      this._render_resolution.y
    );
    this.configureCanvas();
    window
      .matchMedia("(dynamic-range: high)")
      .addEventListener("change", this._onDynamicRangeChange);
  }

  destroy(): void {
    this._unsubscribeDynamicResolution?.();
    this._unsubscribeDynamicResolution = null;
    window
      .matchMedia("(dynamic-range: high)")
      .removeEventListener("change", this._onDynamicRangeChange);
    if (this._pendingLinearHdrCapture !== null) {
      const pending = this._pendingLinearHdrCapture;
      this._pendingLinearHdrCapture = null;
      pending.buffer.destroy();
      pending.reject(new Error("Renderer destroyed before Linear HDR capture"));
    }
    this._transparencyFeature?.destroy();
    this._transparencyFeature = null;
    this._aoService?.destroy();
    this._aoService = null;
    this._gtaoConfigurationKey = "";
    this._screenSpaceDiffuseService?.destroy();
    this._screenSpaceDiffuseService = null;
    this._ssgiConfigurationKey = "";
    this._occlusionConfidence?.destroy();
    this._occlusionConfidence = null;
    this._reflectionService?.destroy();
    this._reflectionService = null;
    this._giService?.destroy();
    this._lightingFeature?.destroy();
    this._postFeature?.destroy();
    this._postFeature = null;
    this._sharedColorPyramids?.destroy();
    this._sharedColorPyramids = null;
    this._temporalFeature.destroy();
    this._renderDebug?.destroy();
    this._renderDebug = null;
    this._surfaceFeature?.destroy();
    this._visibilityFeature?.destroy();
    this._nss?.destroy();
    this._nss = null;
    this._views?.destroy();
    this._shadowFeatures?.destroy();
    this._environments?.destroy();
    this._mainGraphCache.destroy();
    this._frameCoordinator?.destroy();
    this._graphics.destroy();
  }

  resize(x: number, y: number): void {
    if (this._width === x && this._height === y) return;
    this._width = x;
    this._height = y;
    this.applyFullResolutionChange();
  }

  /**
   * 渲染一个相机视图。场景数据会先同步到 GPU，再通过帧图统一安排本帧资源和渲染阶段。
   */
  render(
    camera: PerspectiveCamera,
    scene: Scene,
    time_delta_seconds = 0.01666
  ): boolean {
    if (this._deviceLost) return false;
    this.reconcileDynamicResolutionProfiler();
    this._profiler.beginFrame(this._frame_count);
    let activeFrame: FrameEncoding | null = null;
    let frameLinearHdrCapture: PendingLinearHdrCapture | null = null;
    try {
    this._renderTargets.setFrameIndex(this._frame_count);
    this.applyPendingRenderResolutionChange();
    if (this._canvasNeedsConfigure) {
      this.configureCanvas();
      this._canvasNeedsConfigure = false;
    }
    frameLinearHdrCapture = this._pendingLinearHdrCapture;
    this._pendingLinearHdrCapture = null;
    activeFrame = this._frameCoordinator.beginFrame(
      this._frame_count,
      MAIN_COMMAND_LABEL
    );
    const cmd = activeFrame.command;
    this._profiler.measure("graphics-update", () => {
      this._graphics.encodeFrameMaintenance(
        cmd,
        this._profiler.shouldSampleGpuCounters()
      );
    });
    const featureTopology = this.resolveFeatureTopology();
    this.initializeRenderPasses(featureTopology);
    const framePreExposure: PreExposureContract = Object.freeze({
      multiplier: 1,
      generation: 0,
      colorSpace: "working-linear"
    });
    this._temporalHistories.beginFrame(
      this._frame_count,
      {
        outputWidth: this._output_resolution.x,
        outputHeight: this._output_resolution.y,
        internalWidth: this._render_resolution.x,
        internalHeight: this._render_resolution.y,
        camera: this._hzbCameraRevision,
        renderScale: this._hzbRenderScaleRevision,
        feature: featureTopology.enabledFeatureBits,
        format: MAIN_GRAPH_HISTORY_FORMAT_REVISION,
        light: scene.lights.version + scene.light_probe_volume.version,
        scene: scene.id,
        representation: MAIN_HISTORY_REPRESENTATION_REVISION +
          (featureTopology.nss ? this._nss!.historyRepresentationRevision : 0),
        device: 0,
        preExposureGeneration: framePreExposure.generation,
        view: `${camera.id}`
      },
      [
        ...(featureTopology.temporal ? ["color"] : []),
        ...(featureTopology.gtao && featureTopology.screenSpaceDiffuseTemporal
          ? ["gtao"]
          : []),
        ...(featureTopology.ssgi && featureTopology.screenSpaceDiffuseTemporal
          ? ["ssgi"]
          : []),
        ...(featureTopology.ssrTemporal ? ["ssr"] : []),
        ...(featureTopology.nss ? ["nss-feedback"] : []),
        ...(featureTopology.automaticExposure ? ["exposure"] : [])
      ],
      framePreExposure
    );
    const temporalFrameIndex = this._frame_count;
    cmd.onFinished.addOne(() => {
      this._temporalHistories.commitFrame(temporalFrameIndex);
    });
    cmd.onAborted.addOne(() => {
      this._temporalHistories.abortFrame(temporalFrameIndex);
    });
    if (featureTopology.nss) {
      this._nss!.frame_count = this._frame_count;
      this._nss!.frame_index = this._frame_count;
    } else if (featureTopology.temporal) {
      this._temporalFeature.jitter.frame_index = this._frame_count;
    }

    const outputWidth = this._output_resolution.x;
    const outputHeight = this._output_resolution.y;
    const w = this._render_resolution.x;
    const h = this._render_resolution.y;
    const debugFrameIndex =
      this._debug_frame_budget > 0 ? this._frame_count : null;
    if (debugFrameIndex !== null) this._debug_frame_budget--;

    const frameJitter = resolveFrameJitter(
      featureTopology.temporal,
      featureTopology.nss,
      this._temporalFeature.jitter.Jitter,
      this._nss?.Jitter ?? this._temporalFeature.jitter.Jitter
    );
    const viewKey = GPUViewKey.from(camera, scene);
    viewKey.label = "check_assertions";
    this._lastFrameContract = createRenderFrameContract({
      frameIndex: this._frame_count,
      cameraId: camera.id,
      sceneId: scene.id,
      internalWidth: w,
      internalHeight: h,
      outputWidth,
      outputHeight,
      jitter: frameJitter,
      enabledFeatureBits: featureTopology.enabledFeatureBits,
      historyFormatRevision: MAIN_GRAPH_HISTORY_FORMAT_REVISION
    });
    const sceneOwners = resolveFrameSceneOwners<
      GPUSceneEnvironmentContext,
      GpuRenderWorldRuntime
    >(
      scene,
      this._graphics.render_world_if_created,
      this._environments
    );
    const environment = sceneOwners.environment;
    const geometryOwner = sceneOwners.geometry;
    const gpuPacked = geometryOwner.runtime;
    const shadowFeature = this._shadowFeatures.reconcile(
      scene,
      environment,
      featureTopology.shadows,
      cmd
    );
    const view = this.views.obtain(viewKey, environment, cmd);
    const framePlan = createRendererFramePlan(this._frame_count, {
      lpv: false,
      shadows: featureTopology.shadows
    });
    view.setJitter(this._lastFrameContract.jitter[0], this._lastFrameContract.jitter[1]);
    view.setViewportSize(this._lastFrameContract.internalWidth, this._lastFrameContract.internalHeight);
    view.setUpscaleRatio(
      outputWidth / w,
      outputHeight / h
    );
    view.gpu_camera_state.setViewportOffset(
      (2 * frameJitter[0]) / w,
      (2 * frameJitter[1]) / h
    );
    let packedPatchRevision = 0;
    framePlan.execute("scene-update", () => {
      this._profiler.measure("world-and-view-update", () => {
        const patch = this._graphics.render_world_if_created?.encodePendingPatch(scene, cmd);
        if (patch !== null && patch !== undefined) packedPatchRevision = this._frame_count + 1;
        environment.encodeFrame(cmd, this._frame_count, time_delta_seconds);
        view.update(cmd);
      });
    });
    const viewHzb = view.hierarchical_z_buffer;
    viewHzb.resetFrameStatistics();
    viewHzb.beginFrame(this._frame_count, {
      camera: this._hzbCameraRevision,
      renderScale: this._hzbRenderScaleRevision
    });
    const colorView = createNativeTextureView(this.context.getCurrentTexture());

    {
      const sampleGpuCounters = this._profiler.shouldSampleGpuCounters();
      const sampleGpuTimestamps =
        (debugFrameIndex !== null || this._profiler.shouldSampleGpu()) &&
        this.device.features.has("timestamp-query");
      this._profiler.encodeGpuCounterClear(cmd);
      if (sampleGpuTimestamps) {
        cmd.enable_debug_timers((results) => {
          if (debugFrameIndex !== null) {
            this.onFrameDebug.send2(debugFrameIndex, results);
          }
        });
      }
      if (featureTopology.shadows) {
        framePlan.execute("shadow-update", () => {
          this._profiler.measure("shadow-update", () => {
            const shadows = requireShadowFeature(shadowFeature);
            if (sampleGpuCounters) {
              this._profiler.registerGpuCounterFields([
                "shadowCascade0RasterWork",
                "shadowCascade1RasterWork",
                "shadowCascade2RasterWork",
                "shadowAtlasPixelsUpdated",
                "shadowAlphaRasterWork",
                "shadowQueueOverflowMask"
              ]);
            }
            const packedBindings = this._graphics.render_world.bindings();
            const shadowContentRevision = scene.change_revision * 1_048_576 +
              (packedBindings?.scene.contentRevision ?? 0) + packedPatchRevision;
            shadows.encode(cmd, {
              camera,
              frameIndex: this._frame_count,
              resolution: [w, h],
              contentRevision: shadowContentRevision,
              settings: {
                cascadeLambda: this._renderSettings.values.shadows.cascadeLambda,
                maximumDistance: metersToWorldUnits(
                  this._renderSettings.values.shadows.maximumDistanceMeters,
                  this._renderSettings.values.physicalScale
                ),
                texelGuardBand: this._renderSettings.values.shadows.texelGuardBand
              },
              geometry: {
                runtime: gpuPacked,
                assets: packedBindings.assets,
                scene: packedBindings.scene,
                counterBuffer: sampleGpuCounters
                  ? this._profiler.gpuCounterBuffer
                  : null,
                sseThreshold: this.effectivePackedVisibilitySseThreshold()
              }
            });
          });
        });
      }

      const gpuCounterBuffer = sampleGpuCounters
        ? this._profiler.gpuCounterBuffer
        : null;
      if (sampleGpuCounters && gpuCounterBuffer === null) {
        throw new Error("GPU counter sampling has no counter buffer");
      }
      if (featureTopology.gtao) {
        this._aoService!.resize(
          Math.max(1, Math.ceil(w * this._renderSettings.values.ao.resolutionScale)),
          Math.max(1, Math.ceil(h * this._renderSettings.values.ao.resolutionScale))
        );
      }
      if (featureTopology.ssgi) {
        this._screenSpaceDiffuseService!.resize(
          Math.max(1, Math.ceil(w * this._renderSettings.values.ssgi.resolutionScale)),
          Math.max(1, Math.ceil(h * this._renderSettings.values.ssgi.resolutionScale))
        );
      }
      if (featureTopology.ssr) {
        this._reflectionService!.resize(
          Math.max(1, Math.ceil(w * this._renderSettings.values.ssr.resolutionScale)),
          Math.max(1, Math.ceil(h * this._renderSettings.values.ssr.resolutionScale))
        );
      }
      const temporalHistory = this._temporalHistories.state("color");
      const gtaoHistory = this._temporalHistories.state("gtao");
      const ssgiHistory = this._temporalHistories.state("ssgi");
      const ssrHistory = this._temporalHistories.state("ssr");
      const nssFeedbackHistory = this._temporalHistories.state("nss-feedback");
      const exposureHistory = this._temporalHistories.state("exposure");
      const taaHistoryValidity = temporalHistory.valid ? 1 : 0;
      if (featureTopology.taa) {
        this._temporalFeature.jitter.reset_history = false;
      }
      if (sampleGpuCounters && featureTopology.temporal) {
        this._profiler.registerGpuCounterFields([
          "temporalReactivePixels",
          "temporalDisoccludedPixels",
          "temporalHistoryRejectedPixels"
        ]);
      }
      this._temporalFeature.resetFrameEvidence();
      this._reflectionService?.resetFrameEvidence();
      this._screenSpaceDiffuseService?.resetFrameEvidence();
      this._giService.resetFrameEvidence();
      this._sharedColorPyramids?.resetFrameEvidence();
      this._postFeature?.bloom()?.resetFrameEvidence();
      this._postFeature?.automaticExposure()?.resetFrameEvidence();
      this._lastTemporalTaaPassCount = featureTopology.taa ? 1 : 0;
      this._lastTemporalClassificationPassCount =
        (featureTopology.screenSpaceDiffuseTemporal || featureTopology.ssrTemporal ? 1 : 0) +
        (featureTopology.temporal ? 1 : 0);
      const preparedNssSettings = featureTopology.nss
        ? this._nss!.prepareFrame({
            renderResolution: [w, h],
            outputResolution: [outputWidth, outputHeight]
          })
        : null;
      const nssSettings = preparedNssSettings === null ? null : Object.freeze({
        ...preparedNssSettings,
        historyValidity:
          preparedNssSettings.historyValidity > 0 &&
          temporalHistory.valid &&
          nssFeedbackHistory.valid ? 1 : 0,
        historyPreExposureScale:
          preparedNssSettings.historyValidity > 0
            ? temporalHistory.preExposureScale
            : 0
      });
      const registryBindings = this._graphics.render_world.bindings();
      const counters = gpuCounterBuffer ?? gpuPacked.counterSink;
      const prepareJob = {
        runtime: gpuPacked,
        assets: registryBindings.assets,
        scene: registryBindings.scene,
        countersEnabled: gpuCounterBuffer !== null,
        width: w,
        height: h,
        hierarchyView: createPackedHierarchyView(camera, h),
        sseThreshold: this.effectivePackedVisibilitySseThreshold(),
        geometryWorkBudget: this.packed_geometry_work_budget,
        coneEnabled: this.packed_visibility_cone_enabled,
        meshletWorkCandidateCapacity: this.packed_meshlet_work_candidate_capacity,
        meshletWorkCompactionPath: this.packed_meshlet_work_compaction,
        primitiveIndexPath: this.packed_primitive_index,
        triangleSetupEnabled: this.packed_triangle_setup_enabled,
        triangleSetupThresholdPixels: this.packed_triangle_setup_threshold_pixels,
        previousHzb: this.packed_visibility_hzb_enabled
          ? packedPreviousHzb(
            viewHzb,
            view.gpu_previous_camera_state.view_projection_matrix
          )
          : null
      };
      const packedVisibilityJob: PackedVisibilityJob = Object.freeze({
        ...prepareJob,
        prepared: this._visibilityFeature.prepare(
          prepareJob,
          counters,
          view.gpu_camera_state.buffer,
          cmd
        )
      });
      const frameGeometry: MainFrameGeometrySource = Object.freeze({
        runtime: gpuPacked,
        visibilityJob: packedVisibilityJob
      });
      const graphTopology = this.resolveFeatureTopology({
        geometry: frameGeometry,
        scene
      });
      const frameContext = createFrameContext({
        frameIndex: this._frame_count,
        timeDeltaSeconds: time_delta_seconds,
        camera,
        view,
        resolution: {
          internalWidth: w,
          internalHeight: h,
          outputWidth,
          outputHeight
        },
        featureTopology: graphTopology,
        history: {
          formatRevision: MAIN_GRAPH_HISTORY_FORMAT_REVISION,
          color: taaHistoryValidity,
          gtao: gtaoHistory.valid ? 1 : 0,
          ssgi: ssgiHistory.valid ? 1 : 0,
          ssr: ssrHistory.valid ? 1 : 0,
          nssFeedback: nssFeedbackHistory.valid ? 1 : 0,
          exposure: exposureHistory.valid ? 1 : 0
        },
        preExposure: framePreExposure,
        scene: Object.freeze({
          scene,
          environment,
          geometry: frameGeometry,
          shadow: shadowFeature,
          viewHzb
        }),
        instrumentation: {
          sampleGpuTimestamps,
          sampleGpuCounters,
          debugFrameIndex
        },
        capture: frameLinearHdrCapture
      });
      const mainBindings: MainFrameGraphBindings = Object.freeze({
        context: frameContext,
        camera,
        scene,
        view,
        environment,
        geometry: frameGeometry,
        shadow: shadowFeature,
        viewHzb,
        colorView,
        renderTargets: this._renderTargets.asImportBundle(),
        previousDepth: this._renderTargets.depthPrevious,
        frameIndex: this._frame_count,
        timeDeltaSeconds: time_delta_seconds,
        internalWidth: w,
        internalHeight: h,
        outputWidth,
        outputHeight,
        gpuCounterBuffer,
        taaHistoryValidity,
        taaHistoryInputIndex: temporalHistory.readIndex,
        taaHistoryOutputIndex: temporalHistory.writeIndex,
        taaHistoryPreExposureScale: temporalHistory.preExposureScale,
        gtaoHistoryValidity: gtaoHistory.valid ? 1 : 0,
        gtaoHistoryInputIndex: gtaoHistory.readIndex,
        gtaoHistoryOutputIndex: gtaoHistory.writeIndex,
        ssgiHistoryValidity: ssgiHistory.valid ? 1 : 0,
        ssgiHistoryInputIndex: ssgiHistory.readIndex,
        ssgiHistoryOutputIndex: ssgiHistory.writeIndex,
        ssgiHistoryRevision: ssgiHistory.revision,
        ssgiHistoryPreExposureScale: ssgiHistory.preExposureScale,
        ssrHistoryValidity: ssrHistory.valid ? 1 : 0,
        ssrHistoryInputIndex: ssrHistory.readIndex,
        ssrHistoryOutputIndex: ssrHistory.writeIndex,
        ssrHistoryPreExposureScale: ssrHistory.preExposureScale,
        nssFeedbackInputIndex: nssFeedbackHistory.readIndex,
        nssFeedbackOutputIndex: nssFeedbackHistory.writeIndex,
        exposureHistoryValidity: exposureHistory.valid,
        exposureHistoryInputIndex: exposureHistory.readIndex,
        exposureHistoryOutputIndex: exposureHistory.writeIndex,
        motionBlurStrength: this.motion_blur_strength,
        nssSettings,
        linearHdrCapture: frameLinearHdrCapture
      });
      this.reconcilePackedTransparencyOwner(
        graphTopology.transparency,
        gpuPacked,
        cmd
      );
      const graphKey = canonicalFrameGraphKey(this.createMainFrameGraphKey(
        mainBindings,
        graphTopology,
        sampleGpuTimestamps,
        sampleGpuCounters,
        debugFrameIndex !== null,
        frameLinearHdrCapture?.stage ?? null
      ));
      const compiledGraph = this._mainGraphCache.getOrCreate(graphKey, () => {
        this._profiler.recordGraphBuild();
        const finishGraphBuild = this._profiler.beginCpuSection("graph-build");
        const bindingLayout = new FrameGraphBindingLayout<MainFrameGraphBindings>();
        const bind = <TValue extends object>(
          name: string,
          resolve: (bindings: MainFrameGraphBindings) => TValue
        ): TValue => bindingLayout.slot(name, mainBindings, resolve);
        const graph = new FrameGraph(MAIN_FRAME_GRAPH_NAME);

      const swapId = graph.import_resource(
        "swapchain",
        { kind: "imported", label: "swapchain" },
        bind("swapchain", (bindings) => bindings.colorView)
      );

      {
        const rt = mainBindings.renderTargets;
        let depthRes = graph.import_resource(
          "main_depth",
          { kind: "imported", label: "depth32float" },
          bind("target-depth", (bindings) => bindings.renderTargets.depth)
        );
        const previousDepthRes = graph.import_resource(
          "previous_depth",
          { kind: "imported", label: "previous depth32float" },
          bind("target-previous-depth", (bindings) => bindings.previousDepth)
        );
        const currentCameraRes = graph.import_resource(
          "camera_current",
          { kind: "imported", label: "packed current camera Td" },
          bind("camera-current", (bindings) => bindings.view.gpu_camera_state.buffer)
        );
        const previousCameraRes = graph.import_resource(
          "camera_previous",
          { kind: "imported", label: "packed previous camera Td" },
          bind("camera-previous", (bindings) => bindings.view.gpu_previous_camera_state.buffer)
        );
        const viewUniformRes = graph.import_resource(
          "view/Yu",
          { kind: "imported", label: "packed view Yu" },
          bind("view-uniform", (bindings) => bindings.view.uniform_buffer)
        );
        let hzbRes: ResourceId | null = graph.import_resource(
          "hzb_current",
          { kind: "imported", label: "current hierarchical_z rg16float" },
          bind("hzb-current-texture", (bindings) => bindings.viewHzb.getCurrentTexture())
        );
        const previousHzbRes = graph.import_resource(
          "hzb_previous",
          { kind: "imported", label: "previous hierarchical_z rg16float" },
          bind("hzb-previous-texture", (bindings) => bindings.viewHzb.getPreviousTexture())
        );
        let gpuCounterRes: ResourceId | null = null;
        let packedVisibilityFrame: VisibilityFrame | null = null;
        let packedVisibilityDebug: PackedVisibilityDebugSource | null = null;
        if (sampleGpuCounters) {
          gpuCounterRes = graph.import_resource(
            "r0_gpu_frame_counters",
            { kind: "imported", label: "R0 GPU frame counters" },
            bind("gpu-frame-counters", (bindings) => bindings.gpuCounterBuffer!)
          );
        }

        {
          const packedCounterRes = gpuCounterRes ?? graph.import_resource(
            "packed_visibility_counter_sink",
            { kind: "imported", label: "Packed Visibility disabled counter sink" },
            bind("packed-counter-sink", (bindings) =>
              requirePackedGeometryOwner(bindings.geometry).runtime.counterSink)
          );
          const meshletWorkRecords = graph.import_resource(
            "packed_meshlet_work_records",
            { kind: "imported", label: "VisibilityKey V2 MeshletWork queue" },
            bind("packed-meshlet-work-records", (bindings) => {
              const prepared = requirePackedGeometryOwner(bindings.geometry)
                .visibilityJob.prepared.workSet.meshletWorkCandidate;
              if (prepared === null) {
                throw new Error("VisibilityKey V2 requires a prepared MeshletWork queue");
              }
              return prepared.queue;
            })
          );
          const triangleSetupRecords = this.packed_triangle_setup_enabled
            ? graph.import_resource(
                "packed_triangle_setup_records",
                { kind: "imported", label: "TriangleSetup candidate cache" },
                bind("packed-triangle-setup-records", (bindings) => {
                  const buffer = requirePackedGeometryOwner(bindings.geometry)
                    .visibilityJob.prepared.workSet.setupRecords;
                  if (buffer === null) {
                    throw new Error("TriangleSetup graph requires an allocated setup cache");
                  }
                  return buffer;
                })
              )
            : undefined;
          const packedOutput = this._visibilityFeature.addToGraph(
            graph,
            bind("packed-visibility-main-job", (bindings) =>
              requirePackedGeometryOwner(bindings.geometry).visibilityJob),
            {
              camera: currentCameraRes,
              counters: packedCounterRes,
              meshletWorkRecords,
              setupRecords: triangleSetupRecords,
              previousHzb: this.packed_visibility_hzb_enabled
                ? previousHzbRes
                : undefined,
              depth: depthRes
            }
          );
          packedVisibilityFrame = packedOutput.frame;
          depthRes = packedOutput.frame.depth;
          packedVisibilityDebug = packedOutput.debugResolve;
          gpuCounterRes = sampleGpuCounters ? packedOutput.counters : null;
        }

        {
          const hzbBuilder = graph.add(
            "graph_rasterize_triangle_closest",
            bind("hzb-main-job", (bindings) => ({
              depthTex: bindings.renderTargets.depth,
              hzb: bindings.viewHzb
            })),
            (data, _res, ctx: FrameGraphContext) => {
              const enc = resolveGpuEncoder(ctx);
              if (!enc || !data.depthTex) return;
              data.hzb.build(enc, data.depthTex);
            }
          );
          hzbBuilder.read(depthRes);
          hzbRes = hzbBuilder.write(hzbRes!);
        }

        if (gpuCounterRes !== null) {
          this._visibilityCounters ??= new VisibilityCounterPass();
          gpuCounterRes = this._visibilityCounters.addToGraph(
            graph,
            { width: w, height: h },
            {
              visibility: packedVisibilityFrame!.visibilityKey,
              counters: gpuCounterRes
            },
            "visibility-key"
          );
          this._profiler.registerGpuCounterFields([
            "candidateInstances",
            "visibleInstances",
            "visitedBvhNodes",
            "candidateClusters",
            "selectedClusters",
            "rejectedFrustum",
            "rejectedCone",
            "rejectedHzb",
            "shadedPixels",
            "emptyVisibilityPixels",
            "geometryNodesTested",
            "geometryClustersAccepted",
            "geometryMeshletsSelected",
            "geometryMeshletWorksProduced",
            "geometryCandidateTriangles",
            "geometryRiskyTriangles",
            "geometryExactSurvivedTriangles",
            "geometryRasterTriangles",
            "geometryPaddedVertices",
            "geometryVisiblePixels",
            "geometryQueueBytes",
            "meshletQueueAttempted",
            "meshletQueueWritten",
            "meshletQueueConsumed",
            "meshletQueueOverflow",
            "meshletQueueInvalid",
            "meshletBucketNonEmpty",
            "meshletBucketDraws",
            "meshletSubgroupReservations",
            "meshletPortableReservations",
            "meshletIndirectInstances",
            "meshletRasterTriangles",
            "queueOverflowMask"
          ]);
        }

        const needsOcclusionConfidence =
          graphTopology.screenSpaceDiffuseTemporal ||
          graphTopology.ssr ||
          graphTopology.temporal;
        const needsVelocity = needsOcclusionConfidence || graphTopology.motionBlur ||
          this.render_debug_view === RenderDebugView.Velocity;
        const packedResolveOut = this._surfaceFeature.addToGraph(
          graph,
          bind("packed-material-resolve-job", (bindings) => {
            const packed = requirePackedGeometryOwner(bindings.geometry);
            return {
              runtime: packed.visibilityJob.runtime,
              assets: packed.visibilityJob.assets,
              scene: packed.visibilityJob.scene,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              currentCamera: bindings.view.gpu_camera_state.camera,
              previousCamera: bindings.view.gpu_previous_camera_state.camera
            };
          }),
          {
            visibility: packedVisibilityFrame!,
            view: viewUniformRes,
            counters: gpuCounterRes ?? undefined
          },
          { velocity: needsVelocity }
        );
        if (packedResolveOut.counters !== null) {
          gpuCounterRes = packedResolveOut.counters;
          this._profiler.registerGpuCounterFields(["activeMaterials"]);
          this._profiler.registerGpuCounterFields([
            "materialTileRecords",
            "materialTileValidPixels",
            "materialTileShadedPixels",
            "materialTileUnassignedPixels",
            "materialTileDuplicatePixels",
            "materialTileOverflowQueues",
            "materialTileFrameInvalid"
          ]);
        }
        const gPbrRes = packedResolveOut.shading.roughnessFlags;
        const gNormalRes = packedResolveOut.shading.normal;
        const gAlbedoRes = packedResolveOut.evaluation.albedoAo;
        const gEmissiveRes = packedResolveOut.evaluation.material;
        let materialTileDiagnosticControlRes =
          packedResolveOut.tileClassification.control;

        let velocityRes: ResourceId | null = null;
        let occlusionConfidenceRes: ResourceId | null = null;
        let opaqueTemporalValidityRes: ResourceId | null = null;
        if (needsVelocity) {
          velocityRes = packedResolveOut.velocity!;
          if (needsOcclusionConfidence) {
            occlusionConfidenceRes = this._occlusionConfidence!.addToGraph(
              graph,
              {
                width: w,
                height: h
              },
              {
                currentDepth: depthRes,
                previousDepth: previousDepthRes,
                velocity: velocityRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes
              }
            ).occlusionConfidence;
          }
        }

        if (needsOcclusionConfidence && occlusionConfidenceRes !== null) {
          const opaqueMetadataRes = packedResolveOut.shading.roughnessFlags;
          const opaqueValidity = this._temporalFeature.addClassificationToGraph(
            graph,
            bind("opaque-temporal-classification-job", (bindings) => ({
              phase: "opaque" as const,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              metadataAvailable: true,
              transparencyAvailable: false,
              historyValid: true,
              reactiveThreshold: this._renderSettings.values.temporal.reactiveThreshold,
              disocclusionThreshold: this._renderSettings.values.temporal.disocclusionThreshold
            })),
            {
              surfaceMetadata: opaqueMetadataRes,
              transparentReactive: occlusionConfidenceRes,
              disocclusionConfidence: occlusionConfidenceRes
            }
          );
          opaqueTemporalValidityRes = opaqueValidity.classification;
        }

        let hdrRes: ResourceId | null = null;
        let environmentRes: ResourceId | null = null;
        let diffuseIrradianceRes: ResourceId | null = null;
        let lightDatabaseRes: ResourceId | null = null;
        let shadowAtlasRes: ResourceId | null = null;
        let clusters: LightClusterOutputs | null = null;
        let transparentReactiveRes: ResourceId | null = null;

        if (hzbRes !== null) {
          lightDatabaseRes = graph.import_resource(
            "Tl/light database",
            { kind: "imported", label: "Tl paged light database" },
            bind("light-database", (bindings) => bindings.environment.lights.buffer_data)
          );
          environmentRes = graph.import_resource(
            "Ch/sec_radix_passes",
            { kind: "imported", label: "rgba16float environment" },
            bind("environment", (bindings) => bindings.environment.lights.environment.gpu_texture)
          );
          diffuseIrradianceRes = graph.import_resource(
            "FX-03/diffuse irradiance",
            { kind: "imported", label: "rgba16float diffuse irradiance" },
            bind("diffuse-irradiance", (bindings) =>
              bindings.environment.lights.diffuseIrradiance.gpu_texture)
          );
          if (packedResolveOut !== null && gpuCounterRes !== null) {
            gpuCounterRes = this._packedSurfaceCounters.addToGraph(
              graph, w, h,
              { surfaceFlags: packedResolveOut.shading.roughnessFlags, pbr: gPbrRes,
                environment: environmentRes, counters: gpuCounterRes }
            );
            this._profiler.registerGpuCounterFields([
              "gradientFallbackPixels", "reactiveSurfacePixels", "normalTexturePixels",
              "ormTexturePixels", "emissiveTexturePixels", "unlitSurfacePixels",
              "iblSampledPixels", "iblMip0", "iblMip1", "iblMip2", "iblMip3",
              "iblMip4", "iblMip5", "iblMip6", "iblMip7", "iblMip8"
            ]);
          }
          shadowAtlasRes = graphTopology.shadows
            ? graph.import_resource(
                "Ch/pass_descriptor",
                { kind: "imported", label: "depth32float shadow atlas" },
                bind("shadow-atlas", (bindings) =>
                  requireShadowFeature(bindings.shadow).texture.gpu_texture)
              )
            : depthRes;
          const shadowVisibility = graphTopology.shadows
            ? requireShadowFeature(shadowFeature).frame(shadowAtlasRes)
            : createDisabledShadowVisibilityFrame(shadowAtlasRes, w, h);
          const lightingFeatureOutput = this._lightingFeature.addToGraph(
            graph,
            bind("lighting-feature-job", (bindings) => {
              const packed = requirePackedGeometryOwner(bindings.geometry);
              return {
                camera: bindings.camera,
                lights: bindings.environment.lights,
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                materials: packed.visibilityJob.runtime.materialResources.materialRecords
              };
            }),
            {
              material: packedResolveOut.evaluation,
              visibility: packedVisibilityFrame,
              classification: packedResolveOut.tileClassification,
              depth: depthRes,
              lightDatabase: lightDatabaseRes,
              environment: environmentRes,
              hzb: hzbRes,
              camera: currentCameraRes,
              view: viewUniformRes,
              shadow: shadowVisibility,
              counters: gpuCounterRes ?? undefined
            }
          );
          clusters = lightingFeatureOutput.clusters;
          materialTileDiagnosticControlRes =
            lightingFeatureOutput.classification.control;
          if (lightingFeatureOutput.counters !== null) {
            gpuCounterRes = lightingFeatureOutput.counters;
            this._profiler.registerGpuCounterFields([
              "activeLights",
              "candidateLightsAttempted",
              "candidateLightsWritten",
              "activeLightsAttempted",
              "clusterTestedLights",
              "clusterLightIndicesAttempted",
              "clusterLightIndicesWritten",
              "clusterOverflowClusters",
              "clusterFallbackLights",
              "clusterLightReferences",
              "clusterMaxLights",
              "clusterHistogram0",
              "clusterHistogram1",
              "clusterHistogram4",
              "clusterHistogram8",
              "clusterHistogram16",
              "clusterHistogram32",
              "clusterHistogram64",
              "clusterHistogram128",
              "clusterHistogram256"
            ]);
          }
          hdrRes = lightingFeatureOutput.direct.hdr;
        }

        let bentNormalRes = gNormalRes;
        let ambientVisibilityRes: ResourceId | null = null;
        let gtaoRawDebugRes: ResourceId | null = null;
        let gtaoDenoisedDebugRes: ResourceId | null = null;
        let gtaoTemporalDebugRes: ResourceId | null = null;
        let ssrHitMissDebugRes: ResourceId | null = null;
        let ssrResolveDebugRes: ResourceId | null = null;
        let ssrTemporalDebugRes: ResourceId | null = null;
        let ssrHistoryConfidenceDebugRes: ResourceId | null = null;
        let indirectDiffuseDebugRes: ResourceId | null = null;
        let indirectSpecularDebugRes: ResourceId | null = null;
        let gtaoReady = !graphTopology.gtao;
        if (
          graphTopology.gtao &&
          gNormalRes !== null &&
          gAlbedoRes !== null &&
          (!graphTopology.screenSpaceDiffuseTemporal ||
            (velocityRes !== null && occlusionConfidenceRes !== null))
        ) {
          const gtao = this._aoService!.addToGraph(
            graph,
            bind("gtao-job", (bindings) => ({
              samplers: this._graphics.samplers,
              frameIndex: bindings.frameIndex,
              historyValid: bindings.gtaoHistoryValidity >= 0.5,
              historyInputIndex: bindings.gtaoHistoryInputIndex,
              historyOutputIndex: bindings.gtaoHistoryOutputIndex,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              intensity: this._renderSettings.values.ao.intensity,
              radiusWorldUnits: metersToWorldUnits(
                this._renderSettings.values.ao.radiusMeters,
                this._renderSettings.values.physicalScale
              ),
              thicknessWorldUnits: metersToWorldUnits(
                this._renderSettings.values.ao.thicknessMeters,
                this._renderSettings.values.physicalScale
              ),
              sliceCount: this._renderSettings.values.ao.sliceCount,
              stepCount: this._renderSettings.values.ao.stepCount,
              spatialStep: this._renderSettings.values.ao.spatialStep,
              temporalBlend: this._renderSettings.values.ao.temporalBlend
            })),
            {
              depth: depthRes,
              hzb: hzbRes,
              normal: gNormalRes,
              velocity: velocityRes ?? depthRes,
              occlusionConfidence: occlusionConfidenceRes ?? depthRes,
              surfaceValidity: opaqueTemporalValidityRes!,
              camera: currentCameraRes,
              counters: gpuCounterRes ?? undefined
            },
            graphTopology.screenSpaceDiffuseTemporal
              ? {
                  input: bind("gtao-history-input", (bindings) =>
                    this._aoService!.historyTexture(bindings.gtaoHistoryInputIndex)),
                  output: bind("gtao-history-output", (bindings) =>
                    this._aoService!.historyTexture(bindings.gtaoHistoryOutputIndex))
                }
              : undefined
          );
          ambientVisibilityRes = gtao.frame.visibility;
          bentNormalRes = gtao.frame.bentNormal;
          gtaoRawDebugRes = gtao.rawVisibility;
          gtaoDenoisedDebugRes = gtao.denoisedVisibility;
          gtaoTemporalDebugRes = gtao.temporalVisibility;
          if (gtao.counters !== null) gpuCounterRes = gtao.counters;
          gtaoReady = true;
        }

        if (hdrRes !== null && environmentRes !== null) {
          hdrRes = this._lightingFeature.addEnvironmentBackground(graph, {
            hdr: hdrRes,
            depth: depthRes,
            camera: currentCameraRes,
            view: viewUniformRes,
            environment: environmentRes
          }).hdr;
        }

        const resolveSsgi = (
          lighting: OpaqueLightingResult,
          splitSum: ResourceId
        ): ResourceId => {
          if (!graphTopology.ssgi) return lighting.hdr;
          if (
            lighting.resolvedDiffuse === null ||
            lighting.baselineSpecular === null ||
            hzbRes === null ||
            gNormalRes === null ||
            gAlbedoRes === null ||
            gPbrRes === null ||
            (graphTopology.screenSpaceDiffuseTemporal &&
              (velocityRes === null ||
                occlusionConfidenceRes === null ||
                opaqueTemporalValidityRes === null))
          ) {
            throw new Error(
              "SSGI requires materialized long-range diffuse/specular, HZB, DiffuseSurfaceLite and temporal inputs when history is enabled"
            );
          }
          // Logical consumer-driven product. The current packed Surface ABI can
          // alias its channels without creating another physical attachment.
          const receiver = diffuseSurfaceLiteFrame({
            diffuseReflectance: gAlbedoRes,
            materialAo: gAlbedoRes,
            receiverFlags: gPbrRes,
            colorSpace: "working-linear",
            receiverModulation: "unapplied",
            domain: packedResolveOut.shading.domain
          });
          const source = preExposedOpaqueRadianceSourceFrame({
            radiance: lighting.hdr,
            stage: "pre-screen-space-diffuse",
            excludesCurrentFrameSsgi: true,
            excludesScreenAmbientVisibility: true,
            excludesSsrCorrection: true,
            excludesTransparencyAndPost: true,
            preExposure: frameContext.preExposure,
            domain: packedResolveOut.shading.domain
          });
          const longRange = longRangeDiffuseFrame({
            radiance: lighting.resolvedDiffuse,
            providerSelection: lighting.providerSelection,
            counters: gpuCounterRes,
            selection: "receiver-validity",
            precedence: LONG_RANGE_DIFFUSE_PROVIDER_PRECEDENCE,
            generation: Math.max(1, this._ssgiOwnerGeneration),
            preExposure: frameContext.preExposure,
            domain: packedResolveOut.shading.domain
          });
          const settings = this._renderSettings.values.ssgi;
          const ssgi = this._screenSpaceDiffuseService!.addToGraph(
            graph,
            bind("ssgi-job", (bindings) => ({
              samplers: this._graphics.samplers,
              frameIndex: bindings.frameIndex,
              historyValid: bindings.ssgiHistoryValidity >= 0.5,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              radiusWorldUnits: metersToWorldUnits(
                settings.radiusMeters,
                this._renderSettings.values.physicalScale
              ),
              thicknessWorldUnits: metersToWorldUnits(
                settings.thicknessMeters,
                this._renderSettings.values.physicalScale
              ),
              aoIntensity: settings.aoIntensity,
              giIntensity: settings.giIntensity,
              sliceCount: settings.sliceCount,
              stepCount: settings.stepCount,
              spatialStep: settings.spatialStep,
              temporalBlend: settings.temporalBlend,
              backfaceLighting: settings.backfaceLighting,
              historyGeneration: bindings.ssgiHistoryRevision,
              preExposure: bindings.context.preExposure,
              historyPreExposureScale: bindings.ssgiHistoryPreExposureScale
            })),
            {
              depth: depthRes,
              hzb: hzbRes,
              normal: gNormalRes,
              radianceSource: source.radiance,
              // Temporal-disabled SSGI does not allocate velocity/confidence.
              // The evidence reducer still needs a filterable texture binding;
              // historyValid=false makes these fallback samples non-authoritative.
              velocity: velocityRes ?? gAlbedoRes,
              occlusionConfidence: occlusionConfidenceRes ?? gAlbedoRes,
              surfaceValidity: opaqueTemporalValidityRes ?? gAlbedoRes,
              camera: currentCameraRes,
              counters: gpuCounterRes ?? undefined
            },
            graphTopology.screenSpaceDiffuseTemporal
              ? {
                  aoInput: bind("ssgi-ao-history-input", (bindings) =>
                    this._screenSpaceDiffuseService!.historyTexture(bindings.ssgiHistoryInputIndex, "ao")),
                  aoOutput: bind("ssgi-ao-history-output", (bindings) =>
                    this._screenSpaceDiffuseService!.historyTexture(bindings.ssgiHistoryOutputIndex, "ao")),
                  giInput: bind("ssgi-gi-history-input", (bindings) =>
                    this._screenSpaceDiffuseService!.historyTexture(bindings.ssgiHistoryInputIndex, "gi")),
                  giOutput: bind("ssgi-gi-history-output", (bindings) =>
                    this._screenSpaceDiffuseService!.historyTexture(bindings.ssgiHistoryOutputIndex, "gi"))
                }
              : undefined
          );
          ambientVisibilityRes = ssgi.frame.screenAmbientVisibility;
          bentNormalRes = ssgi.frame.bentNormal;
          gtaoRawDebugRes = ssgi.rawAo;
          gtaoDenoisedDebugRes = ssgi.spatialAo;
          gtaoTemporalDebugRes = ssgi.temporalAo;
          if (ssgi.counters !== null) gpuCounterRes = ssgi.counters;
          indirectDiffuseDebugRes = ssgi.frame.incidentDiffuseGi;
          return this._giService.resolveScreenSpaceDiffuse(graph, {
            hdr: source.radiance,
            depth: depthRes,
            normal: gNormalRes,
            bentNormal: ssgi.frame.bentNormal,
            albedoAo: receiver.diffuseReflectance,
            material: gPbrRes,
            metadata: receiver.receiverFlags,
            camera: currentCameraRes,
            splitSum,
            longRangeDiffuse: longRange.radiance,
            baselineSpecular: lighting.baselineSpecular,
            screenVisibility: ssgi.frame.screenAmbientVisibility,
            incidentGi: ssgi.frame.incidentDiffuseGi,
            reflectionCorrectionExpected: graphTopology.ssr
          });
        };

        if (
          gtaoReady &&
          hdrRes !== null &&
          environmentRes !== null &&
          diffuseIrradianceRes !== null &&
          gPbrRes !== null &&
          gNormalRes !== null &&
          gAlbedoRes !== null &&
          bentNormalRes !== null
        ) {
          const stbn = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.stbn_vec2
          );
          const splitSum = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
          );
          const stbnRes = graph.import_resource(
            "LongRangeGI/stbn_vec2",
            { kind: "imported", label: "STBN vec2 3D" },
            stbn.gpu_texture
          );
          const splitSumRes = graph.import_resource(
            "LongRangeGI/split_sum",
            { kind: "imported", label: "rg16float split_sum" },
            splitSum.gpu_texture
          );
          const lightMapRes = graph.import_resource(
            "LongRangeGI/Brick4 storage",
            { kind: "imported", label: "Brick4 Av storage" },
            bind("long-range-brick4", (bindings) =>
              bindings.environment.volumetric_light_map.buffer)
          );
          const atlasDepthRes = graph.import_resource(
            "LongRangeGI/LPV depth atlas",
            { kind: "imported", label: "rg16float LPV depth atlas" },
            bind("long-range-lpv-depth", (bindings) =>
              bindings.environment.light_probe_volume.atlas.texture_depth.texture)
          );
          const lpvMeshBvhRes = graph.import_resource(
            "LongRangeGI/LPV tetra BVH",
            { kind: "imported", label: "LPV tetra BVH" },
            bind("long-range-lpv-bvh", (bindings) =>
              bindings.environment.light_probe_volume.buffer_mesh_bvh)
          );
          const lpvMetadataRes = graph.import_resource(
            "LongRangeGI/LPV metadata",
            { kind: "imported", label: "LPV metadata" },
            bind("long-range-lpv-metadata", (bindings) =>
              bindings.environment.light_probe_volume.buffer_metadata)
          );
          const lpvTetraRes = graph.import_resource(
            "LongRangeGI/LPV tetrahedra",
            { kind: "imported", label: "LPV tetrahedra" },
            bind("long-range-lpv-tetrahedra", (bindings) =>
              bindings.environment.light_probe_volume.buffer_mesh)
          );
          const lpvProbesRes = graph.import_resource(
            "LongRangeGI/LPV probes",
            { kind: "imported", label: "LPV probes" },
            bind("long-range-lpv-probes", (bindings) =>
              bindings.environment.light_probe_volume.buffer_probes)
          );
          const providerCounterRes = gpuCounterRes ?? graph.import_resource(
            "long_range_provider_counter_sink",
            { kind: "imported", label: "Long-range provider disabled counter sink" },
            bind("long-range-counter-sink", (bindings) =>
              requirePackedGeometryOwner(bindings.geometry).runtime.counterSink)
          );
          const selected = this._giService.resolveOpaqueLighting(graph, {
            hdr: hdrRes,
            depth: depthRes,
            normal: gNormalRes,
            bentNormal: bentNormalRes,
            albedoAo: gAlbedoRes,
            pbr: gPbrRes,
            splitSum: splitSumRes,
            camera: currentCameraRes,
            metadata: packedResolveOut.shading.roughnessFlags,
            fallbackDiffuseIrradiance: diffuseIrradianceRes,
            ambientVisibility: ambientVisibilityRes ?? undefined,
            extent: { width: w, height: h },
            reflectionCorrectionExpected: graphTopology.ssr,
            screenSpaceDiffuseCorrectionExpected: graphTopology.ssgi,
            providerJob: bind("long-range-provider-job", (bindings) => {
              const brick = bindings.environment.volumetric_light_map;
              const probe = bindings.environment.light_probe_volume;
              return {
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                countersEnabled: bindings.gpuCounterBuffer !== null,
                brickRegistered: brick.registered,
                brickResident: brick.available,
                brickGeneration: brick.generation,
                brickExpectedGeneration: brick.expected_generation,
                probeRegistered: probe.source.probe_count > 0,
                probeResident: probe.available,
                probeGeneration: probe.generation,
                probeExpectedGeneration: probe.source.version + 1,
                iblResident: true
              };
            }),
            providerInputs: {
              view: viewUniformRes,
              counters: providerCounterRes,
              stbn: stbnRes,
              environmentDiffuse: diffuseIrradianceRes,
              environmentSpecular: environmentRes,
              brick4: lightMapRes,
              lpvMeshBvh: lpvMeshBvhRes,
              lpvMetadata: lpvMetadataRes,
              lpvTetrahedra: lpvTetraRes,
              lpvProbes: lpvProbesRes,
              lpvDepthAtlas: atlasDepthRes
            }
          });
          if (gpuCounterRes !== null && selected.counters !== null) {
            gpuCounterRes = selected.counters;
          }
          indirectDiffuseDebugRes =
            selected.resolvedDiffuse ?? selected.selectedDiffuseIrradiance;
          indirectSpecularDebugRes =
            selected.baselineSpecular ?? selected.selectedSpecularRadiance;
          const resolvedLightingHdr = resolveSsgi(selected, splitSumRes);
          const opaqueBaseline = preExposedOpaqueHdrBaselineFrame({
            hdr: resolvedLightingHdr,
            baselineSpecular: graphTopology.ssr ? selected.baselineSpecular : null,
            stage: "post-screen-space-diffuse-pre-ssr",
            reflectionCorrectionExpected: graphTopology.ssr,
            preExposure: frameContext.preExposure,
            domain: packedResolveOut.shading.domain
          });
          hdrRes = opaqueBaseline.hdr;

          if (
            graphTopology.ssr &&
            hzbRes !== null &&
            velocityRes !== null &&
            occlusionConfidenceRes !== null &&
            selected.baselineSpecular !== null
          ) {
            const completeOpaqueHdr = opaqueBaseline.hdr;
            const opaqueColorPyramid = this._sharedColorPyramids!.addOpaqueToGraph(
              graph,
              opaqueBaseline,
              depthRes,
              {
                width: w,
                height: h,
                mipLevelCount: OPAQUE_COLOR_PYRAMID_MAX_MIPS,
                sourceGeneration: SHARED_COLOR_PYRAMID_ABI_VERSION,
                preExposure: frameContext.preExposure,
                samplers: this._graphics.samplers
              }
            );
            const ssr = this._reflectionService!.addToGraph(
              graph,
              bind("ssr-job", (bindings) => ({
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                frameIndex: bindings.frameIndex,
                historyValid: bindings.ssrHistoryValidity >= 0.5,
                historyInputIndex: bindings.ssrHistoryInputIndex,
                historyOutputIndex: bindings.ssrHistoryOutputIndex,
                samplers: this._graphics.samplers,
                maxDistance: metersToWorldUnits(
                  this._renderSettings.values.ssr.maxDistanceMeters,
                  this._renderSettings.values.physicalScale
                ),
                edgeFade: this._renderSettings.values.ssr.edgeFade,
                maxSteps: this._renderSettings.values.ssr.maxSteps,
                baseThickness: metersToWorldUnits(
                  this._renderSettings.values.ssr.baseThicknessMeters,
                  this._renderSettings.values.physicalScale
                ),
                distanceThicknessScale: this._renderSettings.values.ssr.distanceThicknessScale,
                maxRoughness: this._renderSettings.values.ssr.maxRoughness,
                mirrorBias: this._renderSettings.values.ssr.mirrorBias,
                temporalStrength: this._renderSettings.values.ssr.temporalStrength,
                historyPreExposureScale: bindings.ssrHistoryPreExposureScale
              })),
              {
                depth: depthRes,
                hzb: hzbRes,
                opaqueColorPyramid,
                pbr: gPbrRes,
                normal: gNormalRes,
                velocity: velocityRes,
                occlusionConfidence: occlusionConfidenceRes,
                surfaceValidity: opaqueTemporalValidityRes!,
                albedoAo: gAlbedoRes,
                blueNoise: stbnRes,
                currentCamera: currentCameraRes,
                counters: gpuCounterRes ?? undefined
              },
              {
                input: bind("ssr-history-input", (bindings) =>
                  this._reflectionService!.historyTexture(bindings.ssrHistoryInputIndex)),
                output: bind("ssr-history-output", (bindings) =>
                  this._reflectionService!.historyTexture(bindings.ssrHistoryOutputIndex))
              }
            );
            hdrRes = this._reflectionService!.addCorrection(graph, {
              hdr: completeOpaqueHdr,
              depth: depthRes,
              baselineSpecular: opaqueBaseline.baselineSpecular!,
              resolvedSpecular: ssr.denoised,
              metadata: packedResolveOut.shading.roughnessFlags
            });
            indirectSpecularDebugRes = ssr.denoised;
            ssrHitMissDebugRes = ssr.trace;
            ssrResolveDebugRes = ssr.denoised_1;
            ssrTemporalDebugRes = ssr.temporal;
            ssrHistoryConfidenceDebugRes = ssr.historyConfidence;
            if (ssr.counters !== null) gpuCounterRes = ssr.counters;
          }
        }


        if (graphTopology.transparency && hdrRes !== null &&
          environmentRes !== null && diffuseIrradianceRes !== null) {
          const splitSum = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
          );
          const oitSplitSumRes = graph.import_resource(
            "OIT/split_sum",
            { kind: "imported", label: "OIT rg16float split_sum" },
            splitSum.gpu_texture
          );
          const transparency = this._transparencyFeature?.packed();
          if (transparency === null) {
            throw new Error("Transparency topology has no active owner");
          }
          const output = this._transparencyFeature!.addPackedToGraph(
              graph,
              bind("packed-transparent-oit-job", (bindings) => {
                const registryBindings = this._graphics.render_world.bindings();
                return {
                  runtime: bindings.geometry.runtime,
                  assets: registryBindings.assets,
                  scene: registryBindings.scene,
                  width: bindings.internalWidth,
                  height: bindings.internalHeight,
                  hierarchyView: createPackedHierarchyView(
                    bindings.camera,
                    bindings.internalHeight
                  ),
                  sseThreshold: this.effectivePackedVisibilitySseThreshold()
                };
              }),
              {
                hdr: hdrRes,
                depth: depthRes,
                camera: currentCameraRes,
                view: viewUniformRes,
                environment: environmentRes,
                diffuseIrradiance: diffuseIrradianceRes,
                splitSum: oitSplitSumRes,
                lightDatabase: lightDatabaseRes!,
                clusterParameters: clusters!.parameters,
                clusterLookup: clusters!.lookup,
                clusterData: clusters!.data,
                activeLightList: clusters!.activeLightList,
                shadowAtlas: shadowAtlasRes!,
                counters: gpuCounterRes ?? undefined
              }
          );
          hdrRes = output.hdr;
          transparentReactiveRes = output.reactive;
          if (output.counters !== null) {
            gpuCounterRes = output.counters;
          }
        }

        if (
          mainBindings.linearHdrCapture !== null &&
          mainBindings.linearHdrCapture.stage !== "post-color-grading" &&
          hdrRes !== null
        ) {
          const captureSource = hdrRes;
          let captureBuffer = graph.import_resource(
            "R5 one-shot linear HDR capture buffer",
            { kind: "imported", label: "rgba16float capture readback" },
            bind("linear-hdr-capture-buffer", (bindings) =>
              bindings.linearHdrCapture!.buffer)
          );
          const captureBuilder = graph.add(
            "R5 one-shot linear HDR capture",
            bind("linear-hdr-capture-job", (bindings) =>
              bindings.linearHdrCapture!),
            (capture, resources, context) => {
              const encoder = resolveGpuEncoder(context);
              if (encoder === undefined) {
                throw new Error("Linear HDR capture has no GPU encoder");
              }
              encoder.copyTextureToBuffer(
                {
                  texture: resolveGpuTexture(
                    resources.get(captureSource),
                    "Linear HDR capture source"
                  ),
                  origin: [capture.x, capture.y, 0]
                },
                {
                  buffer: requireGpuBuffer(
                    resources.get(captureBuffer),
                    "Linear HDR capture buffer"
                  ),
                  bytesPerRow: capture.bytesPerRow,
                  rowsPerImage: capture.height
                },
                [capture.width, capture.height, 1]
              );
            }
          );
          captureBuilder.read(captureSource);
          captureBuffer = captureBuilder.write(captureBuffer);
          captureBuilder.make_side_effect();
        }

        if (
          graphTopology.temporal &&
          hdrRes !== null &&
          velocityRes !== null &&
          occlusionConfidenceRes !== null
        ) {
          const temporalInputRes = hdrRes;
          const metadataRes = packedResolveOut.shading.roughnessFlags;
          const classification = this._temporalFeature.addClassificationToGraph(
            graph,
            bind("temporal-classification-job", (bindings) => ({
              phase: "final" as const,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              metadataAvailable: true,
              transparencyAvailable: transparentReactiveRes !== null,
              historyValid: bindings.taaHistoryValidity >= 0.5,
              reactiveThreshold: this._renderSettings.values.temporal.reactiveThreshold,
              disocclusionThreshold: this._renderSettings.values.temporal.disocclusionThreshold
            })),
            {
              surfaceMetadata: metadataRes,
              transparentReactive:
                transparentReactiveRes ?? occlusionConfidenceRes,
              disocclusionConfidence: occlusionConfidenceRes,
              counters: gpuCounterRes ?? undefined
            }
          );
          if (classification.counters !== null) {
            gpuCounterRes = classification.counters;
          }
          const historyInputRes = graph.import_resource(
            "taa_history",
            { kind: "imported", label: "TAA history input rgba16float" },
            bind("taa-history-input", (bindings) =>
              this._temporalFeature.colorHistory(bindings.taaHistoryInputIndex).gpu_texture)
          );
          const historyOutputRes = graph.import_resource(
            "taa_output",
            { kind: "imported", label: "TAA history output rgba16float" },
            bind("taa-history-output", (bindings) =>
              this._temporalFeature.colorHistory(bindings.taaHistoryOutputIndex).gpu_texture)
          );
          if (graphTopology.nss) {
            hdrRes = this._nss!.addToGraph(
              graph,
              {
                renderResolution: [w, h],
                outputResolution: [outputWidth, outputHeight]
              },
              {
                colorCurrent: hdrRes,
                depthCurrent: depthRes,
                velocity: velocityRes,
                disocclusionConfidence: occlusionConfidenceRes,
                colorHistory: historyInputRes,
                output: historyOutputRes
              },
              {
                settings: bind("nss-settings", (bindings) => bindings.nssSettings!),
                feedbackCurrent: bind("nss-feedback-current", (bindings) =>
                  this._nss!.feedbackTexture(bindings.nssFeedbackInputIndex)),
                feedbackNext: bind("nss-feedback-next", (bindings) =>
                  this._nss!.feedbackTexture(bindings.nssFeedbackOutputIndex)),
                bindResource: (name, resolve) => bind(
                  `nss-internal/${name}`,
                  () => resolve()
                )
              }
            );
          } else {
            hdrRes = this._temporalFeature.addTaaToGraph(
              graph,
              bind("taa-job", (bindings) => ({
                historyValidity: bindings.taaHistoryValidity,
                internalResolution: [
                  bindings.internalWidth,
                  bindings.internalHeight
                ],
                outputResolution: [
                  bindings.outputWidth,
                  bindings.outputHeight
                ],
                samplers: this._graphics.samplers,
                historyStrength: this._renderSettings.values.temporal.historyStrength,
                varianceGamma: this._renderSettings.values.temporal.varianceGamma,
                minimumHistoryWeight: this._renderSettings.values.temporal.minimumHistoryWeight,
                maximumHistoryWeight: this._renderSettings.values.temporal.maximumHistoryWeight,
                historyLockStep: this._renderSettings.values.temporal.historyLockStep,
                reactiveThreshold: this._renderSettings.values.temporal.reactiveThreshold,
                disocclusionThreshold: this._renderSettings.values.temporal.disocclusionThreshold,
                motionFadePixels: this._renderSettings.values.temporal.motionFadePixels,
                historyPreExposureScale: bindings.taaHistoryPreExposureScale
              })),
              {
                output: historyOutputRes,
                currentColor: hdrRes,
                historyColor: historyInputRes,
                velocity: velocityRes,
                disocclusionConfidence: occlusionConfidenceRes,
                classification: classification.classification,
                depth: depthRes
              }
            );
          }
          const temporalProduct = temporalReconstructionFrame({
            hdr: hdrRes,
            confidence: graphTopology.nss ? null : hdrRes,
            confidenceEncoding: graphTopology.nss
              ? "nss-feedback-history"
              : "alpha-history-lock",
            owner: graphTopology.nss ? "nss" : "taa",
            stage: "post-transparency-temporal",
            historyGenerationSource: "TemporalHistoryRegistry.color",
            representationRevisionSource: "MainHistoryRevision.representation",
            preExposure: mainBindings.context.preExposure,
            inputDomain: textureDomain("internal-full", w, h, 1),
            domain: textureDomain("output-full", outputWidth, outputHeight, 1)
          });
          if (temporalInputRes === temporalProduct.hdr) {
            throw new Error("Temporal reconstruction must publish a distinct output resource");
          }
          hdrRes = temporalProduct.hdr;
        }

        if (
          graphTopology.motionBlur &&
          hdrRes !== null &&
          velocityRes !== null
        ) {
          hdrRes = this._postFeature!.obtainMotionBlur().addToGraph(
            graph,
            bind("motion-blur-job", (bindings) => ({
              width: bindings.outputWidth,
              height: bindings.outputHeight,
              strength: bindings.motionBlurStrength
            })),
            {
              color: hdrRes,
              velocity: velocityRes,
              depth: depthRes
            }
          );
        }

        // Instrumentation must not change the source observed by debug output.
        // This snapshot is the post-temporal/motion-blur, pre-post-effects HDR.
        const debugLinearHdrRes = hdrRes;
        const finalColorPyramid =
          hdrRes !== null && (graphTopology.automaticExposure || graphTopology.bloom)
            ? this._sharedColorPyramids!.addFinalToGraph(graph, hdrRes, {
                width: outputWidth,
                height: outputHeight,
                mipLevelCount: FINAL_COLOR_PYRAMID_MAX_MIPS,
                sourceGeneration: SHARED_COLOR_PYRAMID_ABI_VERSION,
                preExposure: frameContext.preExposure,
                samplers: this._graphics.samplers
              })
            : null;

        let exposureRes: ResourceId | null = null;
        if (graphTopology.automaticExposure && finalColorPyramid !== null) {
          const exposurePrevious = graph.import_resource(
            "Automatic exposure previous",
            { kind: "imported", label: "automatic exposure previous" },
            bind("automatic-exposure-previous", (bindings) =>
              this._postFeature!.obtainAutomaticExposure().historyBuffer(bindings.exposureHistoryInputIndex))
          );
          const exposureAdapted = graph.import_resource(
            "Automatic exposure adapted",
            { kind: "imported", label: "automatic exposure adapted" },
            bind("automatic-exposure-adapted", (bindings) =>
              this._postFeature!.obtainAutomaticExposure().historyBuffer(bindings.exposureHistoryOutputIndex))
          );
          exposureRes = this._postFeature!.obtainAutomaticExposure().update(
            graph,
            finalColorPyramid,
            {
              previous: exposurePrevious,
              adapted: exposureAdapted,
              job: bind("automatic-exposure-job", (bindings) => ({
                timeDeltaSeconds: bindings.timeDeltaSeconds,
                historyValid: bindings.exposureHistoryValidity
              }))
            }
          );
        }

        const materializePostColor =
          mainBindings.linearHdrCapture?.stage === "post-color-grading";
        let bloomReconstructedRes: ResourceId | null = null;
        let bloomNormalization = 1;
        if (hdrRes !== null && graphTopology.bloom && finalColorPyramid !== null) {
          const bloom = this._postFeature!.addBloomToGraph(
            graph,
            finalColorPyramid,
            bind("bloom-job", () => ({
              intensity: this._renderSettings.values.post.bloomIntensity,
              mipCount: 5,
              samplers: this._graphics.samplers
            })),
            { composite: materializePostColor }
          );
          bloomReconstructedRes = bloom.reconstructed;
          bloomNormalization = bloom.normalization;
          if (materializePostColor) hdrRes = bloom.composited;
        }
        // Normal frames fuse Bloom composite + grading + optional sharpen into
        // Final Output. A one-shot post-grading capture is the only topology
        // that materializes this HDR boundary before the swapchain pass.
        if (hdrRes !== null && materializePostColor) {
          hdrRes = this._postFeature!.addColorGradingToGraph(
            graph,
            hdrRes,
            this._output_resolution.x,
            this._output_resolution.y,
            bind("color-grading-job", () => ({
              lift: this._renderSettings.values.post.colorGradingLift,
              gamma: this._renderSettings.values.post.colorGradingGamma,
              gain: this._renderSettings.values.post.colorGradingGain,
              saturation: this._renderSettings.values.post.colorGradingSaturation,
              contrast: this._renderSettings.values.post.colorGradingContrast
            }))
          );
        }
        if (materializePostColor && hdrRes !== null) {
          const captureSource = hdrRes;
          let captureBuffer = graph.import_resource(
            "R5 one-shot post-color-grading capture buffer",
            { kind: "imported", label: "rgba16float post-color-grading capture" },
            bind("post-color-grading-capture-buffer", (bindings) =>
              bindings.linearHdrCapture!.buffer)
          );
          const captureBuilder = graph.add(
            "R5 one-shot post-color-grading capture",
            bind("post-color-grading-capture-job", (bindings) =>
              bindings.linearHdrCapture!),
            (capture, resources, context) => {
              const encoder = resolveGpuEncoder(context);
              if (encoder === undefined) {
                throw new Error("Post-color-grading capture has no GPU encoder");
              }
              encoder.copyTextureToBuffer(
                {
                  texture: resolveGpuTexture(
                    resources.get(captureSource),
                    "Post-color-grading capture source"
                  ),
                  origin: [capture.x, capture.y, 0]
                },
                {
                  buffer: requireGpuBuffer(
                    resources.get(captureBuffer),
                    "Post-color-grading capture buffer"
                  ),
                  bytesPerRow: capture.bytesPerRow,
                  rowsPerImage: capture.height
                },
                [capture.width, capture.height, 1]
              );
            }
          );
          captureBuilder.read(captureSource);
          captureBuffer = captureBuilder.write(captureBuffer);
          captureBuilder.make_side_effect();
        }
        // Debug 是主管线最终 HDR 的观察覆盖：不经过 TAA/Bloom 等处理，也不
        // 改写它们的历史；关闭或 unsupported 时不创建 Pass、纹理或 readback。
        if (graphTopology.debug) {
          this._renderDebug ??= new RenderDebugViewPass(
            this._graphics,
            this._surfaceLiteProfile
          );
          const linearHdrDebugRes = debugLinearHdrRes;
          hdrRes = this._renderDebug.addToGraph(
            graph,
            this.render_debug_view,
            {
              visibilityKey: packedVisibilityFrame.visibilityKey,
              packedVisibility: packedVisibilityDebug,
              depth: depthRes,
              velocity: velocityRes,
              gPbr: gPbrRes,
              gNormal: gNormalRes,
              gAlbedo: gAlbedoRes,
              gEmissive: gEmissiveRes,
              surfaceFlags: packedResolveOut.shading.roughnessFlags,
              indirectDiffuse: indirectDiffuseDebugRes,
              indirectSpecular: indirectSpecularDebugRes,
              linearHdr: linearHdrDebugRes,
              ambientOcclusionRaw: gtaoRawDebugRes,
              ambientOcclusionDenoised: gtaoDenoisedDebugRes,
              ambientOcclusionTemporal: gtaoTemporalDebugRes,
              screenSpaceReflectionHitMiss: ssrHitMissDebugRes,
              screenSpaceReflectionResolve: ssrResolveDebugRes,
              screenSpaceReflectionTemporal: ssrTemporalDebugRes,
              screenSpaceReflectionHistoryConfidence: ssrHistoryConfidenceDebugRes
            },
            this._output_resolution.x,
            this._output_resolution.y
          );
        }

        if (hdrRes !== null) {
          const fuseScenePost = !graphTopology.debug && !materializePostColor;
          const fuseBloom = fuseScenePost && bloomReconstructedRes !== null;
          this._postFeature!.obtainTonemap(this._format).addToGraph(
            graph,
            {
              swapchain: swapId,
              hdr: hdrRes,
              bloom: fuseBloom ? bloomReconstructedRes! : undefined,
              exposure: exposureRes ?? undefined,
              diagnosticControl: materialTileDiagnosticControlRes
            },
            {
              bloom: fuseBloom,
              sharpening: !graphTopology.debug && graphTopology.sharpening,
              colorGrading: fuseScenePost
            },
            bind("final-output-job", () => ({
              lift: this._renderSettings.values.post.colorGradingLift,
              gamma: this._renderSettings.values.post.colorGradingGamma,
              gain: this._renderSettings.values.post.colorGradingGain,
              saturation: this._renderSettings.values.post.colorGradingSaturation,
              contrast: this._renderSettings.values.post.colorGradingContrast,
              sharpeningStrength: this._renderSettings.values.post.sharpeningStrength,
              bloomIntensity: fuseBloom
                ? this._renderSettings.values.post.bloomIntensity /
                  bloomNormalization
                : 0,
              samplers: this._graphics.samplers
            }))
          );
        }
      }

      finishGraphBuild();
      this._profiler.recordGraphCompile();
      return this._profiler.measure("graph-compile", () => graph.compile());
      }, {
        hit: () => this._profiler.recordGraphCacheHit(),
        miss: () => this._profiler.recordGraphCacheMiss(),
        evict: () => this._profiler.recordGraphCacheEviction()
      });
      this._lastMainGraphEvidence = Object.freeze({
        cacheKey: graphKey,
        dump: compiledGraph.dump(),
        resources: summarizeFrameGraphResources(compiledGraph)
      });
      if (sampleGpuCounters) {
        this._profiler.registerGpuCounterFields([
          "candidateInstances",
          "visibleInstances",
          "visitedBvhNodes",
          "candidateClusters",
          "selectedClusters",
          "rejectedFrustum",
          "rejectedCone",
          "rejectedHzb",
          "shadedPixels",
          "emptyVisibilityPixels",
          "activeMaterials",
          "activeLights",
          "rootStageQueueReservations",
          "traversalQueueReservations",
          "workGenerationDispatchUpdates",
          "workGenerationCasRetries",
          "gradientFallbackPixels",
          "reactiveSurfacePixels",
          "normalTexturePixels",
          "ormTexturePixels",
          "emissiveTexturePixels",
          "unlitSurfacePixels",
          "geometryNodesTested",
          "geometryClustersAccepted",
          "geometryMeshletsSelected",
          "geometryMeshletWorksProduced",
          "geometryCandidateTriangles",
          "geometryRiskyTriangles",
          "geometryExactSurvivedTriangles",
          "geometryRasterTriangles",
          "geometryPaddedVertices",
          "geometryVisiblePixels",
          "geometryQueueBytes",
          "meshletQueueAttempted",
          "meshletQueueWritten",
          "meshletQueueConsumed",
          "meshletQueueOverflow",
          "meshletQueueInvalid",
          "meshletBucketNonEmpty",
          "meshletBucketDraws",
          "meshletSubgroupReservations",
          "meshletPortableReservations",
          "meshletIndirectInstances",
          "meshletRasterTriangles",
          "materialTileRecords",
          "materialTileValidPixels",
          "materialTileShadedPixels",
          "materialTileUnassignedPixels",
          "materialTileDuplicatePixels",
          "materialTileOverflowQueues",
          "materialTileFrameInvalid",
          "candidateLightsAttempted",
          "candidateLightsWritten",
          "activeLightsAttempted",
          "clusterTestedLights",
          "clusterLightIndicesAttempted",
          "clusterLightIndicesWritten",
          "clusterOverflowClusters",
          "clusterFallbackLights",
          "clusterLightReferences",
          "clusterMaxLights",
          "clusterHistogram0",
          "clusterHistogram1",
          "clusterHistogram4",
          "clusterHistogram8",
          "clusterHistogram16",
          "clusterHistogram32",
          "clusterHistogram64",
          "clusterHistogram128",
          "clusterHistogram256",
          "iblSampledPixels",
          "iblMip0",
          "iblMip1",
          "iblMip2",
          "iblMip3",
          "iblMip4",
          "iblMip5",
          "iblMip6",
          "iblMip7",
          "iblMip8",
          "queueOverflowMask",
        ]);
        if (gpuPacked !== null) {
          this._profiler.registerGpuCounterFields(["invalidVisibilityKeys"]);
          if (this.packed_triangle_setup_enabled) {
            this._profiler.registerGpuCounterFields([
              "setupAttempted",
              "setupWritten",
              "setupVisiblePixelHits",
              "setupVisiblePixelFallbacks",
              "setupOverflow"
            ]);
          }
          this._profiler.registerGpuCounterFields([
            "transparentRasterWork",
            "transparentTriangles",
            "transparentReactivePixels",
            "transparentMomentFiniteFailures",
            "transparentQueueOverflowMask"
          ]);
        }
        if (graphTopology.gtao) {
          this._profiler.registerGpuCounterFields([
            "aoEvaluatedPixels",
            "aoHistoryAcceptedPixels",
            "aoHistoryRejectedPixels"
          ]);
        }
        if (graphTopology.ssr) {
          this._profiler.registerGpuCounterFields([
            "ssrTracePixels",
            "ssrHitPixels",
            "ssrTraceSteps",
            "ssrMaxTraceSteps",
            "ssrRoughnessRejectedPixels",
            "ssrDistanceRejectedPixels",
            "ssrHighRoughnessTracePixels",
            "ssrDistanceLimitExceededPixels",
            "ssrValidationRejectedPixels"
          ]);
        }
      }
      framePlan.execute("main-view-graph", () => {
        cmd.encodeCompiledGraph(compiledGraph, mainBindings);
      });
      framePlan.assertComplete();
      this._lastFramePlan = framePlan.dump();
      if (graphTopology.temporal) {
        this._temporalHistories.markProduced("color");
      }
      if (graphTopology.gtao && graphTopology.screenSpaceDiffuseTemporal) {
        this._temporalHistories.markProduced("gtao");
      }
      if (graphTopology.ssgi && this._screenSpaceDiffuseService?.lastTemporalPasses === 1) {
        this._temporalHistories.markProduced("ssgi");
      }
      if (graphTopology.ssr && this._reflectionService?.lastTemporalPasses === 1) {
        this._temporalHistories.markProduced("ssr");
      }
      if (graphTopology.nss) {
        this._temporalHistories.markProduced("nss-feedback");
      }
      if (graphTopology.automaticExposure) {
        this._temporalHistories.markProduced("exposure");
      }
      view.finish_frame(cmd, this._frame_count);
      this.recordFrameCounters(
        viewHzb,
        shadowFeature,
        environment.lights.environmentEvidence
      );
      this._profiler.encodeGpuCounterReadback(cmd);
      if (frameLinearHdrCapture !== null) {
        cmd.recordReadback(
          "linear-hdr-capture",
          frameLinearHdrCapture.buffer.size
        );
      }
      this._frameCoordinator.submitFrame(activeFrame);
      if (frameLinearHdrCapture !== null) {
        void settleLinearHdrCapture(frameLinearHdrCapture, cmd.gpuDone);
        frameLinearHdrCapture = null;
      }
      activeFrame = null;
    }

    this._frame_count++;
    this.onFrameFinished.send1(this._frame_count);
    return true;
    } catch (error) {
      if (activeFrame !== null) {
        this._frameCoordinator.abortFrame(activeFrame, error);
      }
      if (frameLinearHdrCapture !== null) {
        frameLinearHdrCapture.buffer.destroy();
        frameLinearHdrCapture.reject(error);
        frameLinearHdrCapture = null;
      }
      throw error;
    } finally {
      this._profiler.endFrame();
    }
  }

  private createMainFrameGraphKey(
    bindings: MainFrameGraphBindings,
    topology: MainFrameFeatureTopology,
    sampleGpuTimestamps: boolean,
    sampleGpuCounters: boolean,
    debugFrame: boolean,
    linearHdrCaptureStage: "lighting" | "post-color-grading" | null
  ): FrameGraphKey {
    const instrumentationMode = [
      sampleGpuTimestamps ? "timestamps" : "",
      sampleGpuCounters ? "counters" : "",
      debugFrame ? "debug" : "",
      linearHdrCaptureStage === null
        ? ""
        : `linear-hdr-capture-${linearHdrCaptureStage}`
    ].filter(Boolean).join("+") || "none";

    return createMainRenderPipelineGraphKey({
      capability: [...this.device.features].sort().join(","),
      resolution: bindings.context.resolution,
      featureTopology: topology.enabledFeatureBits,
      visibilityConfiguration:
        `hardware-meshlet-visibility-key-v2-cone${this.packed_visibility_cone_enabled ? 1 : 0}` +
        `-hzb${this.packed_visibility_hzb_enabled ? 1 : 0}` +
        `-meshlet-visibility-v2` +
        `-meshlet-capacity${this.packed_meshlet_work_candidate_capacity}` +
        `-meshlet-compact${this.packed_meshlet_work_compaction}` +
        `-primitive-index${this.packed_primitive_index}` +
        `-setup${this.packed_triangle_setup_enabled ? 1 : 0}` +
        `-transparent-owner${this._packedTransparencyOwnerGeneration}` +
        `-gtao-owner${this._gtaoOwnerGeneration}` +
        `-ssgi-owner${this._ssgiOwnerGeneration}` +
        `-ssr-owner${this._ssrOwnerGeneration}`,
      visibilityWorkCapacity: bindings.geometry.visibilityJob.prepared.workSet.meshletWorkCandidate?.capacity ?? 0,
      historyFormat: bindings.context.history.formatRevision,
      outputFormat: this._format,
      instrumentation: instrumentationMode,
      instrumentationRevision: MAIN_GRAPH_INSTRUMENTATION_REVISION
    });
  }

  private resolveFeatureTopology(
    bindings?: Pick<MainFrameGraphBindings, "geometry" | "scene">
  ): MainFrameFeatureTopology {
    return resolveMainFrameFeatureTopology({
      shadows: this._renderSettings.values.features.shadows,
      ssr: this._renderSettings.values.features.screenSpaceReflections,
      ssrTemporal: this._renderSettings.values.ssr.temporalEnabled,
      ssrHalfResolution: this._renderSettings.values.ssr.resolutionScale === 0.5,
      screenSpaceDiffuseMode:
        this._renderSettings.values.features.screenSpaceDiffuseMode,
      screenSpaceDiffuseTemporal:
        this._renderSettings.values.features.screenSpaceDiffuseMode === "ssgi"
          ? this._renderSettings.values.ssgi.temporalEnabled
          : this._renderSettings.values.ao.temporalEnabled,
      screenSpaceDiffuseHalfResolution:
        this._renderSettings.values.features.screenSpaceDiffuseMode === "ssgi"
          ? this._renderSettings.values.ssgi.resolutionScale === 0.5
          : this._renderSettings.values.ao.resolutionScale === 0.5,
      temporal: this._renderSettings.values.features.temporalAntiAliasing,
      bloom: this._renderSettings.values.features.bloom,
      automaticExposure: this._renderSettings.values.features.automaticExposure,
      motionBlur: this._renderSettings.values.features.motionBlur,
      sharpening: this._renderSettings.values.features.sharpening,
      fusedIndirect: this.fused_indirect,
      upscaleType: this.upscale_type,
      debugView: this.render_debug_view,
      transparency: bindings === undefined
        ? false
        : bindings.geometry.runtime.transparentInstanceCount > 0,
      highDynamicRange: this._highDynamicRange
    });
  }

  private reconcilePackedTransparencyOwner(
    enabled: boolean,
    runtime: GpuRenderWorldRuntime | null,
    command: ShadeGPUCommandContext
  ): void {
    if (runtime !== null && enabled) {
      if (this._transparencyFeature === null) {
        this._transparencyFeature = new TransparencyFeature(this._graphics);
      }
      if (this._transparencyFeature.packed() === null) {
        this._transparencyFeature.obtainPacked();
        this._packedTransparencyOwnerGeneration++;
      }
      return;
    }
    const feature = this._transparencyFeature;
    if (feature === null || feature.packed() === null) return;
    // previous.retire(command) 由 TransparencyFeature 在统一 owner 内执行。
    feature.retirePacked(command);
  }

  private initializeRenderPasses(
    topology: MainFrameFeatureTopology
  ): void {
    this._temporalFeature.attachGraphics(this._graphics);
    this._visibilityFeature ??= new VisibilityFeature(this._graphics);
    // 透明度统一 owner 延迟创建具体 OIT pass，feature-off 时不分配 GPU 资源。
    this._transparencyFeature ??= new TransparencyFeature(this._graphics);
    this._surfaceFeature ??= new SurfaceFeature(this._graphics);
    this._packedSurfaceCounters ??= new PackedSurfaceCounterPass(this._graphics);
    this._lightingFeature ??= new LightingFeature(this._graphics, this._surfaceLiteProfile);
    this._giService ??= new GIService(this._graphics, this._surfaceLiteProfile);
    this._profiler.registerGpuCounterFields([
      "longRangeBrick4Receivers",
      "longRangeProbeReceivers",
      "longRangeIblReceivers",
      "longRangeBlackReceivers",
      "longRangeInvalidGeneration",
      "longRangeNonresidentFallbacks",
      "longRangeProviderUnassigned",
      "longRangeProviderDuplicates"
    ]);
    const needsOcclusionConfidence =
      topology.screenSpaceDiffuseTemporal || topology.ssr || topology.temporal;
    if (needsOcclusionConfidence) {
      this._occlusionConfidence ??= new OcclusionConfidencePass(this._graphics);
    } else if (this._occlusionConfidence !== null) {
      this.retireAfterSubmittedWork(this._occlusionConfidence);
      this._occlusionConfidence = null;
    }
    if (topology.gtao) {
      const configurationKey = `${topology.screenSpaceDiffuseTemporal ? 1 : 0}/${topology.screenSpaceDiffuseHalfResolution ? 1 : 0}`;
      if (this._aoService === null || this._gtaoConfigurationKey !== configurationKey) {
        if (this._aoService !== null) this.retireAfterSubmittedWork(this._aoService);
        this._aoService = new AOService(
          this._graphics,
          topology.screenSpaceDiffuseTemporal,
          topology.screenSpaceDiffuseHalfResolution ? 0.5 : 1,
          this._surfaceLiteProfile
        );
        this._gtaoOwnerGeneration++;
        this._gtaoConfigurationKey = configurationKey;
      }
    } else if (this._aoService !== null) {
      this.retireAfterSubmittedWork(this._aoService);
      this._aoService = null;
      this._gtaoConfigurationKey = "";
    }
    if (topology.ssgi) {
      const configurationKey = `${topology.screenSpaceDiffuseTemporal ? 1 : 0}/${topology.screenSpaceDiffuseHalfResolution ? 1 : 0}`;
      if (this._screenSpaceDiffuseService === null || this._ssgiConfigurationKey !== configurationKey) {
        if (this._screenSpaceDiffuseService !== null) {
          this.retireAfterSubmittedWork(this._screenSpaceDiffuseService);
        }
        this._profiler.registerGpuCounterFields([
          "ssgiEvaluatedPixels",
          "ssgiTraceSamples",
          "ssgiHistoryAcceptedPixels",
          "ssgiHistoryRejectedPixels"
        ]);
        this._screenSpaceDiffuseService = new ScreenSpaceDiffuseService(
          this._graphics,
          topology.screenSpaceDiffuseTemporal,
          topology.screenSpaceDiffuseHalfResolution ? 0.5 : 1,
          this._surfaceLiteProfile
        );
        this._ssgiOwnerGeneration++;
        this._ssgiConfigurationKey = configurationKey;
      }
    } else if (this._screenSpaceDiffuseService !== null) {
      this.retireAfterSubmittedWork(this._screenSpaceDiffuseService);
      this._screenSpaceDiffuseService = null;
      this._ssgiConfigurationKey = "";
    }
    if (topology.ssr) {
      const configurationKey = `${topology.ssrTemporal ? 1 : 0}/${topology.ssrHalfResolution ? 1 : 0}`;
      if (this._reflectionService === null || this._ssrConfigurationKey !== configurationKey) {
        if (this._reflectionService !== null) this.retireAfterSubmittedWork(this._reflectionService);
        this._reflectionService = new ReflectionService(
          this._graphics,
          topology.ssrTemporal,
          topology.ssrHalfResolution ? 0.5 : 1,
          this._surfaceLiteProfile
        );
        this._ssrOwnerGeneration++;
        this._ssrConfigurationKey = configurationKey;
      }
    } else if (this._reflectionService !== null) {
      this.retireAfterSubmittedWork(this._reflectionService);
      this._reflectionService = null;
      this._ssrConfigurationKey = "";
    }
    if (topology.taa) {
      this._temporalFeature.obtainTaa();
    } else if (this._temporalFeature.taa() !== null) {
      this._temporalFeature.retireTaa();
      this._lastTemporalTaaPassCount = 0;
    }
    if (
      topology.temporal ||
      topology.screenSpaceDiffuseTemporal ||
      topology.ssrTemporal
    ) {
      this._temporalFeature.obtainClassification();
    } else if (this._temporalFeature.classification() !== null) {
      this._temporalFeature.retireClassification();
      this._lastTemporalClassificationPassCount = 0;
    }
    if (topology.nss) {
      void this.nss;
    } else if (this._nss !== null) {
      this.retireAfterSubmittedWork(this._nss);
      this._nss = null;
    }
    if (topology.temporal) {
      this._temporalFeature.ensureColorHistory(
        this._output_resolution.x,
        this._output_resolution.y
      );
    } else if (this._temporalFeature.colorHistoryCount() > 0) {
      this._temporalFeature.retireColorHistory();
    }
    this._postFeature ??= new PostFeature(this._graphics);
    if (topology.ssr || topology.bloom || topology.automaticExposure) {
      this._sharedColorPyramids ??= new SharedColorPyramidPass(this._graphics);
    } else if (this._sharedColorPyramids !== null) {
      this.retireAfterSubmittedWork(this._sharedColorPyramids);
      this._sharedColorPyramids = null;
    }
    // Final Output owns normal-frame grading/sharpen. A ColorGradingPass owner,
    // once lazily created by capture instrumentation, is retained because a
    // cached capture graph closes over it. It owns no persistent GPU resource
    // and contributes no normal-frame pass, allocation, readback or submit.
    if (topology.motionBlur) {
      this._postFeature.obtainMotionBlur();
    } else if (this._postFeature.motionBlur() !== null) {
      this._postFeature.retireMotionBlur();
    }
    if (this._postFeature.sharpen() !== null) {
      this._postFeature.retireSharpen();
    }
    if (topology.bloom) {
      this._postFeature.obtainBloom();
    } else if (this._postFeature.bloom() !== null) {
      this._postFeature.retireBloom();
    }
    if (topology.automaticExposure) {
      this._postFeature.obtainAutomaticExposure();
      this._postFeature.syncExposure({
        exposureCompensation: this._renderSettings.values.post.exposureCompensation,
        exposureSpeedUp: this._renderSettings.values.post.exposureSpeedUp,
        exposureSpeedDown: this._renderSettings.values.post.exposureSpeedDown
      });
    } else if (this._postFeature.automaticExposure() !== null) {
      this._postFeature.retireAutomaticExposure();
    }
    if (!topology.debug && this._renderDebug !== null) {
      this.retireAfterSubmittedWork(this._renderDebug);
      this._renderDebug = null;
    }
    this._postFeature.obtainTonemap(this._format);
    this._postFeature.updateTonemap(
      this._format,
      this._highDynamicRange,
      this._peakNits,
      this._renderSettings.values.post.exposureCompensation
    );
  }

  private retireAfterSubmittedWork(resource: { destroy(): void }): void {
    const destroy = (): void => resource.destroy();
    void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
  }

  private recordFrameCounters(
    hzb: HierarchicalZBuffer,
    shadows: {
      readonly lastHzbBuildCount: number;
      readonly lastHzbComputePassCount: number;
      readonly lastHzbDispatchCount: number;
      readonly lastHzbOutputPixels: number;
      readonly atlas_allocated_bytes: number;
      readonly packed_cascade_draw_count: number;
      readonly packed_atlas_pixels_updated: number;
      readonly lastDirectionalCameraUpdates: number;
      readonly lastDirectionalCameraCacheHits: number;
      readonly lastDirectionalRasterDraws: number;
      readonly lastDirectionalRasterSkips: number;
    } | null,
    environment: {
      specularAllocatedBytes: number;
      diffuseAllocatedBytes: number;
      specularMipLevelCount: number;
    }
  ): void {
    const profiler = this._profiler;
    profiler.recordCounter(
        "packed.visibility.meshletWorkCapacity",
        this._visibilityFeature.lastMeshletWorkCapacity
      );
      profiler.recordCounter(
        "packed.visibility.drawIndirect",
        this._visibilityFeature.lastDrawIndirect ? 1 : 0
      );
      profiler.recordCounter(
        "packed.visibility.verticesPerTriangle",
        this._visibilityFeature.lastVerticesPerTriangle
      );
      profiler.recordCounter(
        "packed.visibility.keyAttachmentBytes",
        this._visibilityFeature.lastVisibilityKeyAttachmentBytes
      );
      profiler.recordCounter(
        "packed.visibility.hierarchy",
        this._visibilityFeature.lastImplementation === "hierarchy" ? 1 : 0
      );
    profiler.recordCounter(
      "hzb.computeBuilds",
      hzb.lastBuildCount + (shadows?.lastHzbBuildCount ?? 0)
    );
    profiler.recordCounter(
      "hzb.computePasses",
      hzb.lastComputePassCount + (shadows?.lastHzbComputePassCount ?? 0)
    );
    profiler.recordCounter(
      "hzb.dispatches",
      hzb.lastDispatchCount + (shadows?.lastHzbDispatchCount ?? 0)
    );
    profiler.recordCounter(
      "hzb.outputPixels",
      hzb.lastOutputPixels + (shadows?.lastHzbOutputPixels ?? 0)
    );
    profiler.recordCounter("hzb.historyValid", hzb.historyValid ? 1 : 0);
    profiler.recordCounter("hzb.historyInvalidations", hzb.historyInvalidationCount);
    profiler.recordCounter("shadow.atlasBytes", shadows?.atlas_allocated_bytes ?? 0);
    profiler.recordCounter("shadow.packedCascadeDraws", shadows?.packed_cascade_draw_count ?? 0);
    profiler.recordCounter("shadow.atlasPixelsUpdated", shadows?.packed_atlas_pixels_updated ?? 0);
    profiler.recordCounter("shadow.directionalCameraUpdates", shadows?.lastDirectionalCameraUpdates ?? 0);
    profiler.recordCounter("shadow.directionalCameraCacheHits", shadows?.lastDirectionalCameraCacheHits ?? 0);
    profiler.recordCounter("shadow.directionalRasterDraws", shadows?.lastDirectionalRasterDraws ?? 0);
    profiler.recordCounter("shadow.directionalRasterSkips", shadows?.lastDirectionalRasterSkips ?? 0);
    {
      const geometry = this._graphics.assets_if_created?.evidence();
      profiler.recordCounter("packed.geometry.residentAssets", geometry?.residentAssetCount ?? 0);
      profiler.recordCounter("packed.geometry.logicalBytes", geometry?.logicalBytes ?? 0);
      profiler.recordCounter("packed.geometry.residentBytes", geometry?.residentBytes ?? 0);
      profiler.recordCounter("packed.geometry.allocatedBytes", geometry?.allocatedBytes ?? 0);
      profiler.recordCounter("packed.geometry.retiringBytes", geometry?.retiringBytes ?? 0);
      profiler.recordCounter("packed.geometry.uploadSourceBytes", geometry?.uploadSourceBytes ?? 0);
      profiler.recordCounter("packed.geometry.uploadedBytes", geometry?.uploadedBytes ?? 0);
    }
    {
      const sceneOwner = this._graphics.gpu_scene_if_created;
      const scene = sceneOwner?.evidence();
      const patchBytes = sceneOwner?.profilePatchByteDeltas();
      profiler.recordCounter("packed.instance.recordStride", scene?.recordStride ?? 0);
      profiler.recordCounter("packed.instance.staticRecordStride", scene?.staticRecordStride ?? 0);
      profiler.recordCounter("packed.instance.dynamicRecordStride", scene?.dynamicRecordStride ?? 0);
      profiler.recordCounter("packed.instance.cpuShadowBytes", scene?.cpuShadowBytes ?? 0);
      profiler.recordCounter("packed.instance.cpuStaticShadowBytes", scene?.cpuStaticShadowBytes ?? 0);
      profiler.recordCounter("packed.instance.cpuDynamicShadowBytes", scene?.cpuDynamicShadowBytes ?? 0);
      profiler.recordCounter("packed.instance.staticPatchBytes", patchBytes?.staticPatchBytes ?? 0);
      profiler.recordCounter("packed.instance.transformPatchBytes", patchBytes?.transformPatchBytes ?? 0);
      profiler.recordCounter("packed.instance.materialPatchBytes", patchBytes?.materialPatchBytes ?? 0);
      profiler.recordCounter("packed.instance.visibilityPatchBytes", patchBytes?.visibilityPatchBytes ?? 0);
    }
    {
      const materialEvidence = this._graphics.material_store_if_created?.evidence();
      const textureEvidence = this._graphics.texture_residency_if_created?.evidence();
      profiler.recordCounter(
        "packed.material.activeMaterials",
        this._surfaceFeature.lastActiveMaterialCount
      );
      profiler.recordCounter(
        "packed.material.surfaceBytesPerPixel",
        this._surfaceFeature.surfaceBytesPerPixel
      );
      profiler.recordCounter(
        "packed.material.surfaceAttachmentBytes",
        this._render_resolution.x * this._render_resolution.y *
          this._surfaceFeature.surfaceBytesPerPixel
      );
      profiler.recordCounter(
        "packed.material.residentTextures",
        textureEvidence?.residentTextureCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureFallbacks",
        materialEvidence?.textureFallbackCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.samplerFallbacks",
        materialEvidence?.samplerFallbackCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.residentTextureBytes",
        textureEvidence?.residentTextureBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.retiringTextureBytes",
        textureEvidence?.retiringTextureBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureAllocatedBytes",
        textureEvidence?.allocatedBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureTransactionPeakBytes",
        textureEvidence?.transactionPeakBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureLogicalResidentBytes",
        textureEvidence?.logicalResidentBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureUploadBytes",
        textureEvidence?.uploadBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureCopyBytes",
        textureEvidence?.copyBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureTranscodeBytes",
        textureEvidence?.transcodeBytes ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureRuntimeMipGenerations",
        textureEvidence?.runtimeMipGenerationCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.cookedResidentTextures",
        textureEvidence?.cookedResidentTextureCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.compressedResidentTextures",
        textureEvidence?.compressedResidentTextureCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.cookedRuntimeMipGenerations",
        textureEvidence?.cookedRuntimeMipGenerationCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureBankCopyOperations",
        textureEvidence?.bankCopyOperationCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureSegmentCount",
        textureEvidence?.segmentCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureBindingSetPreflightFailures",
        textureEvidence?.bindingSetPreflightFailures ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureBindingSetCount",
        textureEvidence?.bindingSetCount ?? 0
      );
      profiler.recordCounter(
        "packed.material.textureBindingSlotUtilization",
        textureEvidence?.bindingSlotUtilization ?? 0
      );
    }
    profiler.recordCounter(
      "lighting.clusterCount",
      this._lightingFeature.lastClusterCount
    );
    profiler.recordCounter(
      "lighting.localLightCount",
      this._lightingFeature.lastLocalLightCount
    );
    profiler.recordCounter("lighting.hdrBytesPerPixel", GPU_HDR_BYTES_PER_PIXEL);
    profiler.recordCounter(
      "lighting.baselineSpecularResources",
      this._lastMainGraphEvidence?.dump.resources.filter(
        (resource) => resource.name === "pre-exposed-baseline-specular"
      ).length ?? 0
    );
    profiler.recordCounter("lighting.environment.specularAllocatedBytes", environment.specularAllocatedBytes);
    profiler.recordCounter("lighting.environment.diffuseAllocatedBytes", environment.diffuseAllocatedBytes);
    profiler.recordCounter("lighting.environment.specularMipLevelCount", environment.specularMipLevelCount);
    const temporal = this.temporalEvidence();
    profiler.recordCounter("temporal.taaPasses", temporal.taaPasses);
    profiler.recordCounter(
      "temporal.classificationPasses",
      temporal.classificationPasses
    );
    profiler.recordCounter(
      "temporal.historyValid",
      temporal.historyValid ? 1 : 0
    );
    profiler.recordCounter(
      "temporal.historyReadValid",
      temporal.historyReadValid ? 1 : 0
    );
    profiler.recordCounter(
      "temporal.historyRevision",
      temporal.historyRevision
    );
    profiler.recordCounter(
      "temporal.historyInvalidations",
      temporal.historyInvalidations
    );
    profiler.recordCounter("temporal.historyBytes", temporal.historyBytes);
    profiler.recordCounter("temporal.internalPixels", temporal.internalPixels);
    profiler.recordCounter("temporal.outputPixels", temporal.outputPixels);
    profiler.recordCounter("temporal.drsGpuMs", temporal.drsLastGpuMs);
    profiler.recordCounter(
      "temporal.drsAdaptive",
      temporal.drsMode === "adaptive" ? 1 : 0
    );
    profiler.recordCounter(
      "temporal.drsAcceptedGpuSamples",
      temporal.drsAcceptedGpuSamples
    );
    profiler.recordCounter("temporal.drsScaleChanges", temporal.drsScaleChanges);
    profiler.recordCounter(
      "temporal.drsFeedbackLatencyFrames",
      temporal.drsFeedbackLatencyFrames
    );
    const ao = this.ambientOcclusionEvidence();
    profiler.recordCounter("ao.rawPasses", ao.rawPasses);
    profiler.recordCounter("ao.spatialPasses", ao.spatialPasses);
    profiler.recordCounter("ao.temporalPasses", ao.temporalPasses);
    profiler.recordCounter("ao.compositePasses", ao.compositePasses);
    profiler.recordCounter("ao.bentNormalUpsamplePasses", ao.bentNormalUpsamplePasses);
    profiler.recordCounter("ao.internalPixels", ao.internalPixels);
    profiler.recordCounter("ao.pixels", ao.aoPixels);
    profiler.recordCounter("ao.traceDepthSamplesPerPixel", ao.traceDepthSamplesPerPixel);
    profiler.recordCounter("ao.momentsBytesPerPixel", ao.momentsBytesPerPixel);
    profiler.recordCounter("ao.finalVisibilityBytesPerPixel", ao.finalVisibilityBytesPerPixel);
    profiler.recordCounter("ao.bentNormalBytesPerPixel", ao.bentNormalBytesPerPixel);
    profiler.recordCounter("ao.historyBytes", ao.historyBytes);
    profiler.recordCounter("ao.historyValid", ao.historyValid ? 1 : 0);
    profiler.recordCounter("ao.historyRevision", ao.historyRevision);
    const ssgi = this.screenSpaceGiEvidence();
    profiler.recordCounter("ssgi.tracePasses", ssgi.tracePasses);
    profiler.recordCounter("ssgi.spatialPasses", ssgi.spatialPasses);
    profiler.recordCounter("ssgi.temporalPasses", ssgi.temporalPasses);
    profiler.recordCounter("ssgi.resolvePasses", ssgi.resolvePasses);
    profiler.recordCounter("ssgi.traceSamplesPerPixel", ssgi.traceSamplesPerPixel);
    profiler.recordCounter("ssgi.historyBytes", ssgi.historyBytes);
    profiler.recordCounter("ssgi.historyValid", ssgi.historyValid ? 1 : 0);
    const ssr = this.screenSpaceReflectionsEvidence();
    profiler.recordCounter("ssr.tracePasses", ssr.tracePasses);
    profiler.recordCounter("ssr.prefilterPasses", ssr.prefilterPasses);
    profiler.recordCounter("ssr.resolvePasses", ssr.resolvePasses);
    profiler.recordCounter("ssr.spatialPasses", ssr.spatialPasses);
    profiler.recordCounter("ssr.temporalPasses", ssr.temporalPasses);
    profiler.recordCounter("ssr.compositePasses", ssr.compositePasses);
    profiler.recordCounter("ssr.internalPixels", ssr.internalPixels);
    profiler.recordCounter("ssr.historyBytes", ssr.historyBytes);
    profiler.recordCounter("ssr.historyValid", ssr.historyValid ? 1 : 0);
    profiler.recordCounter("ssr.historyRevision", ssr.historyRevision);
    const shared = this.sharedDerivedProductsEvidence();
    profiler.recordCounter("sharedPyramid.opaqueBuilds", shared.pyramids.opaqueBuilds);
    profiler.recordCounter("sharedPyramid.opaqueRenderPasses", shared.pyramids.opaqueRenderPasses);
    profiler.recordCounter("sharedPyramid.opaqueMips", shared.pyramids.opaqueMipLevelCount);
    profiler.recordCounter("sharedPyramid.finalBuilds", shared.pyramids.finalBuilds);
    profiler.recordCounter("sharedPyramid.finalRenderPasses", shared.pyramids.finalRenderPasses);
    profiler.recordCounter("sharedPyramid.finalMips", shared.pyramids.finalMipLevelCount);
    profiler.recordCounter("sharedPyramid.allocatedBytes", shared.pyramids.allocatedBytes);
    profiler.recordCounter(
      "sharedPyramid.screenSpaceDiffuseSourceBuilds",
      shared.screenSpaceDiffuseSourcePyramidBuilds
    );
    profiler.recordCounter("sharedPyramid.bloomReconstructPasses", shared.bloomReconstructPasses);
    profiler.recordCounter("sharedPyramid.bloomConsumedMips", shared.bloomConsumedFinalMips);
    profiler.recordCounter("sharedPyramid.exposureHistogramPasses", shared.exposureHistogramPasses);
    profiler.recordCounter("sharedPyramid.exposureMeteringMip", shared.exposureMeteringMipLevel);
    profiler.recordCounter("sharedPyramid.exposureMeteringPixels", shared.exposureMeteringPixels);
    const finalOutput = this.finalOutputEvidence();
    profiler.recordCounter("post.finalOutputPasses", finalOutput.finalOutputPasses);
    profiler.recordCounter("post.bloomFused", finalOutput.bloomFused ? 1 : 0);
    profiler.recordCounter("post.colorGradingFused", finalOutput.colorGradingFused ? 1 : 0);
    profiler.recordCounter("post.sharpeningFused", finalOutput.sharpeningFused ? 1 : 0);
    profiler.recordCounter(
      "post.fullResolutionHdrIntermediates",
      finalOutput.fullResolutionHdrIntermediateCount
    );
    profiler.recordCounter("gpu.residentBytes", this._graphics.gpu_memory_usage);
  }

  private reconcileDynamicResolutionProfiler(): void {
    this._temporalFeature.dynamicResolution.consume_delayed_gpu_timing(this._frame_count);
    const dynamicResolutionNeedsProfiler =
      this._temporalFeature.dynamicResolution.adaptive &&
      this.device.features.has("timestamp-query");
    const geometryBudgetNeedsProfiler = this.packed_geometry_budget_mode === "adaptive";
    if (dynamicResolutionNeedsProfiler || geometryBudgetNeedsProfiler) {
      if (!this._profiler.enabled) {
        this._profiler.configure({
          enabled: true,
          gpuSampleInterval: 4,
          gpuCounterSampleInterval: 4
        });
        this._dynamicResolutionOwnsProfiler = true;
      }
      return;
    }
    if (this._dynamicResolutionOwnsProfiler) {
      this._profiler.configure({ enabled: false });
      this._dynamicResolutionOwnsProfiler = false;
    }
  }

  private consumeDynamicResolutionSnapshot(snapshot: FrameProfileSnapshot): void {
    if (
      !this._temporalFeature.dynamicResolution.adaptive ||
      !snapshot.gpu.sampled ||
      snapshot.gpu.pending ||
      snapshot.gpu.segments.length === 0
    ) return;
    const gpuFrameTimeMs = snapshot.gpu.segments.reduce(
      (sum, segment) => sum + segment.durationMs,
      0
    );
    this._temporalFeature.dynamicResolution.notify_gpu_timing({
      sampleFrameIndex: snapshot.frameIndex,
      currentFrameIndex: this._frame_count,
      gpuFrameTimeMs
    });
  }

  /** ADR-0009 Step 7 logical-product, consumer and history-lifecycle evidence. */
  sharedDerivedProductsEvidence(): SharedDerivedProductsRuntimeEvidence {
    const topology = this.resolveFeatureTopology();
    const pyramids = this._sharedColorPyramids?.evidence() ?? Object.freeze({
      opaqueBuilds: 0,
      opaqueRenderPasses: 0,
      opaqueMipLevelCount: 0,
      finalBuilds: 0,
      finalRenderPasses: 0,
      finalMipLevelCount: 0,
      allocatedBytes: 0
    });
    const bloom = this._postFeature?.bloom();
    const exposure = this._postFeature?.automaticExposure();
    return Object.freeze({
      abiVersion: SHARED_COLOR_PYRAMID_ABI_VERSION,
      pyramids,
      opaqueStage: "post-screen-space-diffuse-pre-ssr",
      finalStage: "post-transparency-temporal",
      opaqueConsumerCount: topology.ssr ? 1 : 0,
      finalConsumerCount: Number(topology.bloom) + Number(topology.automaticExposure),
      screenSpaceDiffuseSourcePyramidBuilds: 0,
      bloomReconstructPasses: bloom?.lastReconstructPasses ?? 0,
      bloomConsumedFinalMips: bloom?.lastConsumedPyramidMips ?? 0,
      exposureHistogramPasses: exposure?.lastHistogramPasses ?? 0,
      exposureMeteringMipLevel: exposure?.lastMeteringMipLevel ?? 0,
      exposureMeteringPixels: exposure?.lastMeteringPixels ?? 0,
      histories: Object.freeze(this._temporalHistories.descriptors().map((descriptor) => {
        const state = this._temporalHistories.state(descriptor.name);
        return Object.freeze({
          name: descriptor.name,
          semantic: descriptor.semantic,
          resolutionDomain: descriptor.resolutionDomain,
          format: descriptor.format,
          bufferCount: descriptor.bufferCount,
          preExposure: descriptor.preExposure,
          active: state.active,
          valid: state.valid,
          readValid: state.readValid,
          generation: state.revision,
          invalidationCount: state.invalidationCount,
          lastInvalidationReason: state.lastInvalidationReason,
          preExposureScale: state.preExposureScale
        });
      }))
    });
  }

  /** ADR-0009 Step 9 full-resolution HDR roundtrip and fusion evidence. */
  finalOutputEvidence(): FinalOutputRuntimeEvidence {
    const passes = this._lastMainGraphEvidence?.dump.passes
      .filter((entry) => !entry.culled)
      .map((entry) => entry.name) ?? [];
    const resources = this._lastMainGraphEvidence?.dump.resources
      .map((entry) => entry.name) ?? [];
    const countPass = (name: string): number =>
      passes.filter((candidate) => candidate === name).length;
    const tonemap = this._postFeature?.tonemap();
    const fullResolutionIntermediates = new Set([
      "Bloom composited",
      "Color graded color",
      "Sharpened color"
    ]);
    const colorGradingMaterializationPasses = countPass("Color Grading");
    return Object.freeze({
      finalOutputPasses:
        countPass("Final Output SDR") + countPass("Final Output HDR"),
      bloomFused: tonemap?.lastBloomFused ?? false,
      colorGradingFused: tonemap?.lastColorGradingFused ?? false,
      sharpeningFused: tonemap?.lastSharpeningFused ?? false,
      bloomCompositeMaterializationPasses: countPass("Bloom composite shared pyramid"),
      colorGradingMaterializationPasses,
      standaloneSharpenPasses: countPass("Sharpen XE"),
      fullResolutionHdrIntermediateCount: resources.filter((name) =>
        fullResolutionIntermediates.has(name)
      ).length,
      debugBypass: this.resolveFeatureTopology().debug,
      oneShotCaptureMaterialized: colorGradingMaterializationPasses > 0
    });
  }

  private effectivePackedVisibilitySseThreshold(): number {
    if (this.packed_geometry_budget_mode === "fixed") {
      return this.packed_visibility_sse_threshold;
    }
    const budget = normalizeGeometryWorkBudget(this.packed_geometry_work_budget);
    const key = JSON.stringify([
      this.packed_visibility_sse_threshold,
      this.packed_geometry_quality_floor_sse,
      ...Object.values(budget)
    ]);
    if (this._geometrySseController === null || key !== this._geometrySseControllerKey) {
      this._geometrySseController = new GeometryAdaptiveSseController(
        this.packed_visibility_sse_threshold,
        budget,
        { qualityFloorSse: this.packed_geometry_quality_floor_sse }
      );
      this._geometrySseControllerKey = key;
    }
    return this._geometrySseController.value;
  }

  private consumeGeometryBudgetSnapshot(snapshot: FrameProfileSnapshot): void {
    if (this.packed_geometry_budget_mode !== "adaptive" ||
      !snapshot.gpuCounters.sampled || snapshot.gpuCounters.pending ||
      snapshot.gpuCounters.dropped) return;
    this.effectivePackedVisibilitySseThreshold();
    const values = snapshot.gpuCounters.values;
    const rasterTriangles = values.geometryRasterTriangles;
    const paddedVertices = values.geometryPaddedVertices;
    if (values.geometryNodesTested === undefined ||
      values.geometryMeshletWorksProduced === undefined ||
      rasterTriangles === undefined || paddedVertices === undefined ||
      values.geometryRiskyTriangles === undefined) return;
    this._geometrySseController!.update({
      testedHierarchyNodes: values.geometryNodesTested,
      meshletWork: values.geometryMeshletWorksProduced,
      rasterVertices: rasterTriangles * 3 + paddedVertices,
      riskyTriangles: values.geometryRiskyTriangles
    });
  }

  add_debug_frame(count = 1): void {
    this._debug_frame_budget += count;
  }

  indicate_view_change(): void {
    this._hzbCameraRevision++;
    this._geometrySseController?.resetForCameraCut();
    this._temporalFeature.jitter.reset_history = true;
    if (this._nss) this._nss.reset_history = true;
  }

  private recalculateOutputResolution(): void {
    const limit = this.device.limits.maxTextureDimension2D;
    const width = clampInteger(
      Math.ceil(this._width * this._pixel_ratio),
      1,
      limit
    );
    const height = clampInteger(
      Math.ceil(this._height * this._pixel_ratio),
      1,
      limit
    );
    this._output_resolution.set(width, height);
    this._renderResolutionDirty = true;
  }

  private synchronizeDynamicResolutionPolicy(): void {
    const resolution = this._renderSettings.values.resolution;
    this._temporalFeature.dynamicResolution.configure({
      mode: resolution.mode,
      targetFrameRate: resolution.adaptiveTargetFrameRate,
      minimumScale: resolution.adaptiveMinimumScale,
      maximumScale: resolution.adaptiveMaximumScale,
      tolerance: resolution.adaptiveTolerance,
      settleFrames: resolution.adaptiveSettleFrames
    });
  }

  private recalculateRenderResolution(): void {
    this._hzbRenderScaleRevision++;
    const limit = this.device.limits.maxTextureDimension2D;
    const width = clampInteger(
      Math.floor(this._output_resolution.x * this._renderSettings.values.resolution.internalScale),
      1,
      limit
    );
    const height = clampInteger(
      Math.floor(this._output_resolution.y * this._renderSettings.values.resolution.internalScale),
      1,
      limit
    );
    this._render_resolution.set(width, height);
    this._temporalFeature.configureJitterSequence(
      width,
      height,
      this._output_resolution.x,
      this._output_resolution.y
    );
    if (this._nss) {
      const areaRatio = Math.max(
        1,
        (this._output_resolution.x / width) *
          (this._output_resolution.y / height)
      );
      this._nss.jitter_sequence_size = Math.ceil(
        NeuralSuperSamplingPass.recommended_jitter_sequence_size(
          1 / this._renderSettings.values.resolution.internalScale
        ) * areaRatio
      );
    }
    this._renderTargets.resize(width, height);
    this._renderResolutionDirty = false;
  }

  private applyFullResolutionChange(): void {
    this.recalculateOutputResolution();
    if (this._renderResolutionDirty) this.recalculateRenderResolution();
    this.resizeColorHistories();
    this._temporalFeature.jitter.reset_history = true;
    if (this._nss) this._nss.reset_history = true;
  }

  private applyPendingRenderResolutionChange(): void {
    if (!this._renderResolutionDirty) return;
    this.recalculateRenderResolution();
  }

  private resizeColorHistories(): void {
    this._temporalFeature.resizeColorHistory(
      this._output_resolution.x,
      this._output_resolution.y
    );
    this._canvasNeedsConfigure = true;
  }

  private configureCanvas(): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = this._output_resolution.x;
    canvas.height = this._output_resolution.y;
    canvas.style.width = `${this._width}px`;
    canvas.style.height = `${this._height}px`;
    const configuration: GPUCanvasConfiguration = {
      device: this.device,
      format: this._format,
      alphaMode: "opaque",
      colorSpace: "display-p3",
      toneMapping: {
        mode: this._highDynamicRange ? "extended" : "standard"
      }
    };
    try {
      this.context.configure(configuration);
    } catch {
      this.context.configure({ ...configuration, colorSpace: "srgb" });
    }
  }

  private updateDynamicRangeState(): void {
    const highDynamicRange = window.matchMedia("(dynamic-range: high)").matches;
    const changed = this._highDynamicRange !== highDynamicRange;
    this._highDynamicRange = highDynamicRange;
    this._peakNits = highDynamicRange ? 1000 : 80;
    if (changed) this.updateCanvasFormat();
    this._postFeature?.updateTonemap(
      this._format,
      highDynamicRange,
      this._peakNits,
      this._renderSettings.values.post.exposureCompensation
    );
    if (changed) this._canvasNeedsConfigure = true;
  }

  private updateCanvasFormat(): void {
    const format = this._highDynamicRange
      ? "rgba16float"
      : navigator.gpu.getPreferredCanvasFormat();
    if (format !== this._format) {
      this._format = format;
      this._canvasNeedsConfigure = true;
    }
  }

  private onDeviceLost(info: GPUDeviceLostInfo): void {
    this._deviceLost = true;
    if (info.reason !== "destroyed") console.error("GPUDevice lost", info);
  }
}

function createPackedHierarchyView(
  camera: PerspectiveCamera,
  viewportHeight: number
): GeometryHierarchyView {
  const matrix = camera.transform.matrix;
  const planes: [number, number, number, number][] = [];
  for (let index = 0; index < 6; index++) {
    const offset = index * 4;
    planes.push([
      camera.frustum[offset]!,
      camera.frustum[offset + 1]!,
      camera.frustum[offset + 2]!,
      camera.frustum[offset + 3]!
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

function requirePackedGeometryOwner(
  source: MainFrameGeometrySource
): MainFrameGeometrySource {
  return source;
}

function requireShadowFeature(feature: ShadowFeature | null): ShadowFeature {
  if (feature === null) {
    throw new Error("Shadow graph consumer received a feature-off frame");
  }
  return feature;
}

function packedPreviousHzb(
  hzb: HierarchicalZBuffer,
  previousWorldToClip: ArrayLike<number>
): Readonly<{
  view: GPUTextureView;
  width: number;
  height: number;
  mipLevelCount: number;
  worldToClipMatrix: ArrayLike<number>;
}> | null {
  const view = hzb.obtainPreviousView();
  return view === null ? null : {
    view,
    width: hzb.width,
    height: hzb.height,
    mipLevelCount: hzb.mipLevelCount,
    worldToClipMatrix: previousWorldToClip
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function validateLinearHdrCaptureRegion(
  region: LinearHdrCaptureRegion,
  renderWidth: number,
  renderHeight: number
): LinearHdrCaptureRegion {
  for (const [name, value] of Object.entries(region).filter(([name]) => name !== "stage")) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Linear HDR capture ${name} must be an integer`);
    }
  }
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new RangeError("Linear HDR capture region must be positive and in bounds");
  }
  if (region.x + region.width > renderWidth || region.y + region.height > renderHeight) {
    throw new RangeError(
      `Linear HDR capture ${region.x},${region.y} ${region.width}x${region.height} ` +
      `exceeds ${renderWidth}x${renderHeight}`
    );
  }
  return Object.freeze({ ...region });
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function resolveGpuTexture(resource: unknown, label: string): GPUTexture {
  if (resource && typeof resource === "object") {
    if ("gpu_texture" in resource) {
      return (resource as { gpu_texture: GPUTexture }).gpu_texture;
    }
    if ("createView" in resource &&
      typeof (resource as GPUTexture).createView === "function") {
      return resource as GPUTexture;
    }
  }
  throw new Error(`${label} is not a GPUTexture`);
}

function requireGpuBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object" && "mapAsync" in resource) {
    return resource as GPUBuffer;
  }
  throw new Error(`${label} is not a GPUBuffer`);
}

async function settleLinearHdrCapture(
  capture: PendingLinearHdrCapture,
  gpuDone: Promise<void>
): Promise<void> {
  let mapped = false;
  try {
    await gpuDone;
    await capture.buffer.mapAsync(GPUMapMode.READ);
    mapped = true;
    const source = new Uint16Array(capture.buffer.getMappedRange());
    const sourceStride = capture.bytesPerRow / 2;
    const output = new Float32Array(capture.width * capture.height * 4);
    for (let y = 0; y < capture.height; y++) {
      const sourceBegin = y * sourceStride;
      const outputBegin = y * capture.width * 4;
      for (let component = 0; component < capture.width * 4; component++) {
        output[outputBegin + component] = halfToFloat(
          source[sourceBegin + component]!
        );
      }
    }
    capture.resolve({
      x: capture.x,
      y: capture.y,
      width: capture.width,
      height: capture.height,
      format: "rgba16float",
      rgba: output
    });
  } catch (error) {
    capture.reject(error);
  } finally {
    if (mapped) capture.buffer.unmap();
    capture.buffer.destroy();
  }
}

function validateRendererDevice(
  device: GPUDevice,
  config: RendererConfig
): void {
  const requiredFeatures = new Set<GPUFeatureName>([
    "core-features-and-limits",
    "indirect-first-instance",
    "float32-blendable",
    HZB_STORAGE_FORMAT_FEATURE,
    ...(config.requiredFeatures ?? [])
  ]);
  for (const feature of requiredFeatures) {
    if (!device.features.has(feature)) {
      throw new Error(`Device does not support required feature '${feature}'`);
    }
  }
  const requiredLimits = {
    maxStorageBuffersPerShaderStage: Math.max(
      10,
      config.requiredLimits?.maxStorageBuffersPerShaderStage ?? 0
    ),
    maxColorAttachmentBytesPerSample: Math.max(
      32,
      config.requiredLimits?.maxColorAttachmentBytesPerSample ?? 0
    )
  };
  for (const [name, required] of Object.entries(requiredLimits)) {
    const actual = Number(device.limits[name as keyof GPUSupportedLimits]);
    if (!Number.isFinite(actual) || actual < required) {
      throw new Error(
        `Device limit '${name}' is ${actual}, but renderer requires at least ${required}`
      );
    }
  }
}
