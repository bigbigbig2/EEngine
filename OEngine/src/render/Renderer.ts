/**
 * 渲染器主入口：编排 GPU 场景、可见性、材质展开、光照、时域后处理和色调映射管线。
 */

import { ChangeSignal } from "../core/Signal.js";
import { Vec2 } from "../core/math/Vec2.js";
import { GraphicsContext } from "../gpu/GraphicsContext.js";
import { MeshletDrawList } from "../gpu/MeshletDrawList.js";
import { GPUSceneManager } from "../gpu/GPUSceneManager.js";
import { SceneSdf } from "../gpu/SceneSdf.js";
import { GPULightProbeVolumeRenderer } from "../gpu/GPULightProbeVolumeRenderer.js";
import { FrameGraph, FrameGraphBindingLayout } from "../framegraph/FrameGraph.js";
import type { CompiledFrameGraphDump } from "../framegraph/FrameGraph.js";
import { CompiledFrameGraphCache } from "../framegraph/CompiledFrameGraphCache.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  FrameCoordinator,
  type FrameEncoding
} from "./FrameCoordinator.js";
import { MAIN_COMMAND_LABEL, MAIN_FRAME_GRAPH_NAME } from "../framegraph/FrameGraphNotes.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";
import { RenderTargets } from "./RenderTargets.js";
import { GPUViewKey, ViewManager } from "./ViewManager.js";
import { GPUCameraStateManager } from "./GPUCameraState.js";
import { VisibilityPass } from "./passes/VisibilityPass.js";
import {
  PackedVisibilityPass,
  type PackedVisibilityDebugSource
} from "./passes/PackedVisibilityPass.js";
import { VisibilityCounterPass } from "./passes/VisibilityCounterPass.js";
import { MaterialExpandPass } from "./passes/MaterialExpandPass.js";
import { PackedMaterialResolvePass } from "./passes/PackedMaterialResolvePass.js";
import { PackedSurfaceCounterPass } from "./passes/PackedSurfaceCounterPass.js";
import { LightingPass } from "./passes/LightingPass.js";
import {
  LightClusterPass,
  type LightClusterOutputs
} from "./passes/LightClusterPass.js";
import { EnvironmentBackgroundPass } from "./passes/EnvironmentBackgroundPass.js";
import { LpvIndirectDiffusePass } from "./passes/LpvIndirectDiffusePass.js";
import { TransparentOitPass } from "./passes/TransparentOitPass.js";
import { PackedTransparentOitPass } from "./passes/PackedTransparentOitPass.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import { PathTracer } from "./passes/PathTracer.js";
import {
  Brick4DiffusePass,
  Brick4FusedIndirectPass,
  Brick4SpecularPass
} from "./passes/Brick4IndirectPass.js";
import { VelocityPass } from "./passes/VelocityPass.js";
import { RenderDebugViewPass } from "./passes/RenderDebugViewPass.js";
import { OcclusionConfidencePass } from "./passes/OcclusionConfidencePass.js";
import { ScreenSpaceAmbientOcclusionPass } from "./passes/ScreenSpaceAmbientOcclusionPass.js";
import { ScreenSpaceReflectionsPass } from "./passes/ScreenSpaceReflectionsPass.js";
import { SpecularCorrectionPass } from "./passes/SpecularCorrectionPass.js";
import { TemporalAntiAliasingPass } from "./passes/TemporalAntiAliasingPass.js";
import { TemporalClassificationPass } from "./passes/TemporalClassificationPass.js";
import {
  NeuralSuperSamplingPass,
  type NssSettings
} from "./passes/NeuralSuperSamplingPass.js";
import { MotionBlurPass } from "./passes/MotionBlurPass.js";
import { SharpenPass } from "./passes/SharpenPass.js";
import { BloomPass } from "./passes/BloomPass.js";
import { AutomaticExposurePass } from "./passes/AutomaticExposurePass.js";
import {
  TemporalJitterController,
  recommendedTaaJitterSequenceSize,
  resolveFrameJitter
} from "./TemporalJitterController.js";
import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { createNativeTextureView, id } from "../gpu/GPUTextureDescriptors.js";
import { TonemapPass } from "./passes/TonemapPass.js";
import type { FrameGraphContext } from "../framegraph/FrameGraph.js";
import { FrameProfiler } from "../debug/FrameProfiler.js";
import type { FrameProfileSnapshot } from "../debug/FrameProfiler.js";
import {
  captureGpuAdapterIdentity,
  type BenchmarkAdapterIdentity
} from "../debug/EnvironmentManifest.js";
import type { HierarchicalZBuffer } from "./HierarchicalZBuffer.js";
import { resolveGpuEncoder } from "../framegraph/FrameGraph.js";
import {
  canonicalFrameGraphKey,
  type FrameGraphKey
} from "../framegraph/FrameGraphKey.js";
import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import type { GeometryHierarchyView } from "../geometry/GeometryHierarchy.js";
import type { Scene } from "../scene/Scene.js";
import {
  ShadeIndirectLightingMode,
  type ShadeIndirectLightingMode as ShadeIndirectLightingModeT
} from "./ShadeIndirectLightingMode.js";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "./STATIC_GRAPHICS_ENGINE_ASSETS.js";
import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import type {
  AssetHandle,
  AssetResidencyEvidence
} from "../gpu/GpuAssetStore.js";
import type {
  GpuSceneEvidence,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceSetHandle,
  InstanceSource
} from "../gpu/GpuScene.js";
import { createSceneResidencyManifest } from "../gpu/GpuSceneResidencyManifest.js";
import type {
  PackedSceneEvidence,
  PackedSceneHandle,
  PackedScenePatchBatch,
  PackedSceneSource
} from "../gpu/GpuPackedSceneRegistry.js";
import type { PackedSceneRuntime } from "../gpu/GpuPackedSceneRegistry.js";
import {
  RenderDebugView,
  getRenderDebugViewStatus,
  type RenderDebugView as RenderDebugViewT,
  type RenderDebugViewStatus
} from "../debug/RenderDebugView.js";
import {
  resolveMainFrameFeatureTopology,
  type MainFrameFeatureTopology
} from "./MainFrameFeatureTopology.js";
import { halfToFloat } from "../loaders/float16.js";
import { TemporalHistoryRegistry } from "./TemporalHistoryRegistry.js";
import { DynamicResolutionScaling } from "./DynamicResolutionScaling.js";
import type { GraphicsMemoryEvidence } from "../gpu/GraphicsContext.js";
import {
  RenderSettings,
  metersToWorldUnits,
  type RenderSettingsChange,
  type RenderSettingsPatch,
  type RenderSettingsValues
} from "./pipeline/RenderSettings.js";
import { OpaqueLightingPipeline } from "./pipeline/OpaqueLightingPipeline.js";
import {
  createRendererFramePlan,
  type FramePlanDump
} from "./pipeline/FramePlan.js";

export {
  ShadeIndirectLightingMode
} from "./ShadeIndirectLightingMode.js";

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
  "ssao_optional",
  "environment_ibl_extra",
  "indirect_lighting_#To_or_fused",
  "transparent_oit",
  "post_taa_nss_mb_sharpen",
  "bloom_exposure",
  "tonemap_to_swapchain",
  "encodeGraph_finish_frame"
] as const;

export type RenderFramePhase = (typeof RENDER_FRAME_PHASES)[number];

export const MAIN_RENDER_TARGET_LAYOUT = {
  color0: { format: "r32uint", role: "viz_triangle_id" },
  color1: { format: "r32uint", role: "viz_mesh_id" },
  depth: { format: "depth32float", role: "main_depth_double_buffered" }
} as const;

export const GBUFFER_AFTER_VIZ = {
  g_pbr: "rg8unorm",
  g_normal: "rgba16uint",
  g_albedo: "/* package format TP */",
  g_emissive: "/* package format */"
} as const;

export type RendererInitializeOptions = {
  context?: GPUCanvasContext;
  device?: GPUDevice;
  pixelRatio?: number;
};

export interface LinearHdrCaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  readonly drsEnabled: boolean;
  readonly drsLastGpuMs: number;
  readonly drsFeedbackLatencyFrames: number;
}

export interface AmbientOcclusionRuntimeEvidence {
  readonly enabled: boolean;
  readonly temporalEnabled: boolean;
  readonly resolutionScale: 0.5 | 1;
  readonly radiusMeters: number;
  readonly radiusWorldUnits: number;
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

export interface ScreenSpaceReflectionsRuntimeEvidence {
  readonly enabled: boolean;
  readonly resolutionScale: 0.5 | 1;
  readonly internalPixels: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly tracePixels: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  readonly tracePasses: number;
  readonly prefilterPasses: number;
  readonly resolvePasses: number;
  readonly spatialPasses: number;
  readonly temporalPasses: number;
  readonly compositePasses: number;
  readonly historyTextureCount: number;
  readonly historyBytes: number;
  readonly historyValid: boolean;
  readonly historyRevision: number;
  readonly historyInvalidations: number;
  readonly historyInvalidationReason: string;
}

export interface RendererMemoryEvidence extends GraphicsMemoryEvidence {
  readonly historyBytes: number;
  readonly historyOwners: Readonly<Record<string, number>>;
}

export interface MainFrameGraphRuntimeEvidence {
  readonly cacheKey: string;
  readonly dump: CompiledFrameGraphDump;
}

type PendingLinearHdrCapture = LinearHdrCaptureRegion & {
  readonly buffer: GPUBuffer;
  readonly bytesPerRow: number;
  readonly resolve: (result: LinearHdrCaptureResult) => void;
  readonly reject: (error: unknown) => void;
};

type MainFrameGraphBindings = {
  readonly camera: PerspectiveCamera;
  readonly scene: Scene;
  readonly view: ReturnType<ViewManager["obtain"]>;
  readonly gpuScene: ReturnType<GPUSceneManager["obtain"]>;
  readonly gpuPacked: PackedSceneRuntime | null;
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
  readonly taaJitter: readonly [number, number];
  readonly taaHistoryValidity: number;
  readonly taaHistoryInputIndex: 0 | 1;
  readonly taaHistoryOutputIndex: 0 | 1;
  readonly ssaoHistoryValidity: number;
  readonly ssaoHistoryInputIndex: 0 | 1;
  readonly ssaoHistoryOutputIndex: 0 | 1;
  readonly ssrHistoryValidity: number;
  readonly ssrHistoryInputIndex: 0 | 1;
  readonly ssrHistoryOutputIndex: 0 | 1;
  readonly motionBlurStrength: number;
  readonly nssSettings: NssSettings | null;
  readonly linearHdrCapture: PendingLinearHdrCapture | null;
};

const MAIN_GRAPH_CACHE_LIMIT = 16;
const MAIN_GRAPH_HISTORY_FORMAT_REVISION = 3;
const MAIN_GRAPH_INSTRUMENTATION_REVISION = 5;

/**
 * 渲染器运行时总控。
 *
 * 它负责初始化 WebGPU 资源，并在每一帧依次组织场景同步、GPU 可见性、
 * 材质展开、直接/间接光照、时域处理、后处理以及最终输出。
 */
export class Renderer {
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
  private readonly _profiler = new FrameProfiler();
  private _graphics!: GraphicsContext;
  private _frameCoordinator!: FrameCoordinator;
  private readonly _mainGraphCache = new CompiledFrameGraphCache(
    MAIN_GRAPH_CACHE_LIMIT
  );
  private _lastMainGraphEvidence: MainFrameGraphRuntimeEvidence | null = null;
  private _scenes!: GPUSceneManager;
  private _cameraStates!: GPUCameraStateManager;
  private _meshletDrawList!: MeshletDrawList;
  private _views!: ViewManager;
  private readonly _output_resolution = new Vec2(1, 1);
  private _visibility!: VisibilityPass;
  private _packedVisibility!: PackedVisibilityPass;
  private _visibilityCounters: VisibilityCounterPass | null = null;
  private _materialExpand: MaterialExpandPass | null = null;
  private _packedMaterialResolve!: PackedMaterialResolvePass;
  private _packedSurfaceCounters!: PackedSurfaceCounterPass;
  private _lighting!: LightingPass;
  private _lightCluster!: LightClusterPass;
  private _environmentBackground!: EnvironmentBackgroundPass;
  private _opaqueLighting!: OpaqueLightingPipeline;
  private _lpvIndirectDiffuse!: LpvIndirectDiffusePass;
  private _transparentOit: TransparentOitPass | null = null;
  private _packedTransparentOit: PackedTransparentOitPass | null = null;
  private _packedTransparencyOwnerGeneration = 0;
  private _pendingLinearHdrCapture: PendingLinearHdrCapture | null = null;
  private _pathTracer: PathTracer | undefined;
  private _brick4Diffuse!: Brick4DiffusePass;
  private _brick4Specular!: Brick4SpecularPass;
  private _brick4Fused!: Brick4FusedIndirectPass;
  private _velocity: VelocityPass | null = null;
  private _renderDebug: RenderDebugViewPass | null = null;
  private _occlusionConfidence: OcclusionConfidencePass | null = null;
  private _ssao: ScreenSpaceAmbientOcclusionPass | null = null;
  private _ssaoConfigurationKey = "";
  private _ssaoOwnerGeneration = 0;
  private _ssr: ScreenSpaceReflectionsPass | null = null;
  private _ssrConfigurationKey = "";
  private _specularCorrection: SpecularCorrectionPass | null = null;
  private _ssrOwnerGeneration = 0;
  private _taa: TemporalAntiAliasingPass | null = null;
  private _temporalClassification: TemporalClassificationPass | null = null;
  private _nss: NeuralSuperSamplingPass | null = null;
  private _motionBlur: MotionBlurPass | null = null;
  private _sharpen: SharpenPass | null = null;
  private _bloom: BloomPass | null = null;
  private _automaticExposure: AutomaticExposurePass | null = null;
  private readonly _taaJitter = new TemporalJitterController();
  private _taaHistory: [GPUTextureContext, GPUTextureContext] | null = null;
  private readonly _temporalHistories = new TemporalHistoryRegistry(["color", "ssao", "ssr"]);
  private readonly _dynamicResolution = new DynamicResolutionScaling();
  private _lastFramePlan: FramePlanDump | null = null;
  private _unsubscribeDynamicResolution: (() => void) | null = null;
  private _dynamicResolutionOwnsProfiler = false;
  private _lastTemporalTaaPassCount = 0;
  private _lastTemporalClassificationPassCount = 0;
  private _tonemap!: TonemapPass;
  private _renderTargets = new RenderTargets();
  private _format: GPUTextureFormat = "rgba8unorm";
  private readonly _sceneSdfs = new Map<Scene, SceneSdf>();
  private readonly _probeRenderers = new Map<
    Scene,
    GPULightProbeVolumeRenderer
  >();
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
    if (change.historiesInvalidated.length > 0) {
      this._temporalHistories.invalidate("explicit");
    }
    const post = this._renderSettings.values.post;
    if (this._automaticExposure !== null) {
      this._automaticExposure.exposure_compensation = post.exposureCompensation;
      this._automaticExposure.adaptation_speed_up = post.exposureSpeedUp;
      this._automaticExposure.adaptation_speed_down = post.exposureSpeedDown;
    }
    return change;
  }
  /** 单一调试视图选择；unsupported 条目不会向 FrameGraph 添加工作。 */
  render_debug_view: RenderDebugViewT = RenderDebugView.None;
  fused_indirect = true;
  indirect_lighting_mode: ShadeIndirectLightingModeT = ShadeIndirectLightingMode.IBL;
  upscale_type = 0;
  motion_blur_strength = 1;
  /** R3 production default, matching the minimum three.js quality baseline. */
  packed_visibility_sse_threshold = 4;
  packed_visibility_cone_enabled = true;
  packed_visibility_hzb_enabled = true;

  onFrameFinished = new ChangeSignal<number>();
  onFrameDebug = new ChangeSignal<number, any[]>();

  private _debug_frame_budget = 0;
  private readonly _onDynamicRangeChange = (): void => {
    this.updateDynamicRangeState();
  };

  constructor() {
    this._dynamicResolution.get_scale = () => this.internal_resolution_scale;
    this._dynamicResolution.set_scale = (scale) => {
      this.internal_resolution_scale = scale;
    };
    this._unsubscribeDynamicResolution = this._profiler.subscribe((snapshot) => {
      this.consumeDynamicResolutionSnapshot(snapshot);
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
    this.configure({ resolution: { internalScale: v } });
  }

  get aspect_ratio(): number {
    return this._render_resolution.x / this._render_resolution.y;
  }

  get graphics(): GraphicsContext {
    return this._graphics;
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
  ): Promise<PackedSceneHandle> {
    const manifest = createSceneResidencyManifest(source, {
      maxBufferSize: Number(this.device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(this.device.limits.maxStorageBufferBindingSize)
    });
    const command = ShadeGPUCommandContext.create(
      this._graphics,
      "Renderer/PackedScene/residency-transaction"
    );
    try {
      const handles = this._graphics.assets.residentMany(
        manifest.packages,
        command
      );
      const handle = this._graphics.packed_scenes.stage(
        scene,
        manifest,
        handles,
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
      "Renderer/PackedScene/release-transaction"
    );
    let handles: readonly AssetHandle[];
    try {
      const runtime = this._graphics.packed_scenes.runtime(scene);
      if (runtime !== null && this._packedVisibility) {
        this._packedVisibility.release(runtime, command);
        this._packedTransparentOit?.release(runtime, command);
        this._scenes.obtain(scene).lights.shadow_context.releasePackedScene(
          runtime,
          command
        );
      }
      handles = this._graphics.packed_scenes.release(scene, command);
      this._graphics.assets.releaseMany(handles, command);
      command.finish();
      await command.submitted;
    } catch (error) {
      command.abort(error);
      throw error;
    }
  }

  /** Queues one explicit patch batch for the next main frame command. */
  queuePackedScenePatch(scene: Scene, batch: PackedScenePatchBatch): void {
    this._graphics.packed_scenes.queuePatch(scene, batch);
  }

  packedSceneEvidence(): PackedSceneEvidence {
    return this._graphics.packed_scenes.evidence();
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
    const pass = this._packedTransparentOit;
    if (pass === null) return null;
    return Object.freeze({
      rasterStateBinLimit: pass.rasterStateBinLimit,
      drawCount: pass.lastDrawCount,
      momentPasses: pass.lastMomentPasses,
      forwardPasses: pass.lastForwardPasses,
      compositePasses: pass.lastCompositePasses,
      transientBytesPerPixel: pass.transientBytesPerPixel,
      motionContract: pass.motionContract
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
    const validated = validateLinearHdrCaptureRegion(
      region,
      this._render_resolution.x,
      this._render_resolution.y
    );
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

  /** FX-06 delayed GPU timing controller; disabled until explicitly enabled. */
  get dynamic_resolution_scaling(): DynamicResolutionScaling {
    return this._dynamicResolution;
  }

  /** Bounded production evidence; no GPU handle or mutable owner escapes. */
  temporalEvidence(): TemporalRuntimeEvidence {
    const history = this._temporalHistories.state("color");
    return Object.freeze({
      enabled: this._renderSettings.values.features.temporalAntiAliasing,
      taaPasses: this._lastTemporalTaaPassCount,
      classificationPasses: this._lastTemporalClassificationPassCount,
      historyTextureCount: this._taaHistory?.length ?? 0,
      historyBytes: this._taaHistory?.reduce(
        (sum, texture) => sum + texture.gpu_memory_usage,
        0
      ) ?? 0,
      historyValid: history.valid,
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
      drsEnabled: this._dynamicResolution.enabled,
      drsLastGpuMs: this._dynamicResolution.last_gpu_frame_time_ms,
      drsFeedbackLatencyFrames:
        this._dynamicResolution.last_feedback_latency_frames
    });
  }

  /** FX-07 bounded AO phase/history evidence; GPU handles remain private. */
  ambientOcclusionEvidence(): AmbientOcclusionRuntimeEvidence {
    const history = this._temporalHistories.state("ssao");
    const pass = this._ssao;
    const internalPixels = this._render_resolution.x * this._render_resolution.y;
    const aoSettings = this._renderSettings.values.ao;
    const aoEnabled = this._renderSettings.values.features.ambientOcclusion;
    const aoWidth = Math.max(1, Math.ceil(this._render_resolution.x * aoSettings.resolutionScale));
    const aoHeight = Math.max(1, Math.ceil(this._render_resolution.y * aoSettings.resolutionScale));
    return Object.freeze({
      enabled: aoEnabled,
      temporalEnabled: aoEnabled && aoSettings.temporalEnabled,
      resolutionScale: aoSettings.resolutionScale,
      radiusMeters: aoSettings.radiusMeters,
      radiusWorldUnits: metersToWorldUnits(
        aoSettings.radiusMeters,
        this._renderSettings.values.physicalScale
      ),
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

  /** FX-08 bounded SSR phase/history evidence; GPU handles remain private. */
  screenSpaceReflectionsEvidence(): ScreenSpaceReflectionsRuntimeEvidence {
    const history = this._temporalHistories.state("ssr");
    const pass = this._ssr;
    const enabled = this._renderSettings.values.features.screenSpaceReflections;
    const resolutionScale = this._renderSettings.values.ssr.resolutionScale;
    const traceWidth = enabled ? Math.max(1, Math.ceil(this._render_resolution.x * resolutionScale)) : 0;
    const traceHeight = enabled ? Math.max(1, Math.ceil(this._render_resolution.y * resolutionScale)) : 0;
    return Object.freeze({
      enabled,
      resolutionScale,
      internalPixels: enabled
        ? this._render_resolution.x * this._render_resolution.y
        : 0,
      internalWidth: enabled ? this._render_resolution.x : 0,
      internalHeight: enabled ? this._render_resolution.y : 0,
      tracePixels: traceWidth * traceHeight,
      traceWidth,
      traceHeight,
      tracePasses: pass?.lastTracePasses ?? 0,
      prefilterPasses: pass?.lastPrefilterPasses ?? 0,
      resolvePasses: pass?.lastResolvePasses ?? 0,
      spatialPasses: pass?.lastSpatialPasses ?? 0,
      temporalPasses: pass?.lastTemporalPasses ?? 0,
      compositePasses:
        this._renderSettings.values.features.screenSpaceReflections && this._specularCorrection?.lastRan === true ? 1 : 0,
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
      screenSpaceReflections: this.screenSpaceReflectionsEvidence().historyBytes,
      automaticExposure: this._automaticExposure?.historyBytes ?? 0
    });
    const historyBytes = Object.values(historyOwners).reduce(
      (sum, bytes) => sum + bytes,
      0
    );
    return Object.freeze({ ...graphics, historyBytes, historyOwners });
  }

  /** Immutable graph topology corresponding to the most recently encoded main view. */
  mainFrameGraphEvidence(): MainFrameGraphRuntimeEvidence | null {
    const evidence = this._lastMainGraphEvidence;
    return evidence === null
      ? null
      : Object.freeze({ cacheKey: evidence.cacheKey, dump: evidence.dump });
  }

  get render_debug_view_status(): RenderDebugViewStatus {
    return getRenderDebugViewStatus(this.render_debug_view);
  }

  /** Null when the caller supplied a GPUDevice without its originating adapter. */
  get adapter_info(): BenchmarkAdapterIdentity | null {
    return this._adapterInfo === null ? null : { ...this._adapterInfo };
  }

  get scenes(): GPUSceneManager {
    return this._scenes;
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

  get path_tracer(): PathTracer {
    this._pathTracer ??= new PathTracer(this._graphics);
    return this._pathTracer;
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
    pixelRatio = window.devicePixelRatio
  }: RendererInitializeOptions = {}): Promise<void> {
    if (!("gpu" in navigator)) {
      throw new Error("navigator.gpu not available — WebGPU disabled or unsupported");
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

    if (device === undefined) {
      const gpu = navigator.gpu;
      if (gpu === undefined) throw new Error("navigator.gpu is undefined");
      const adapter = await gpu.requestAdapter({
        powerPreference: "high-performance"
      });
      if (adapter === null) throw new Error("Failed to bind GPUAdapter");
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
      const requiredFeatures: GPUFeatureName[] = [
        "indirect-first-instance",
        "float32-blendable",
        // HZB is a core render path and unconditionally uses rg16float storage.
        "texture-formats-tier1"
      ];
      const optionalFeatures: GPUFeatureName[] = [
        "timestamp-query",
        "subgroups"
      ];
      for (const feature of requiredFeatures) {
        if (!adapter.features.has(feature)) {
          throw new Error(`Adapter does not support required feature '${feature}'`);
        }
      }
      for (const feature of optionalFeatures) {
        if (adapter.features.has(feature)) requiredFeatures.push(feature);
      }
      device = await adapter.requestDevice({
        requiredLimits: {
          maxColorAttachmentBytesPerSample: 32,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxStorageBuffersPerShaderStage: 10
        },
        requiredFeatures
      });
    }

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
    this._graphics = new GraphicsContext(device, this._profiler);
    this._frameCoordinator = new FrameCoordinator(this._graphics);
    await this._graphics.initialize();
    this._meshletDrawList = new MeshletDrawList(this._graphics);
    this._scenes = new GPUSceneManager(this._graphics);
    this._cameraStates = new GPUCameraStateManager(device);
    this._views = new ViewManager(
      this._graphics,
      this._cameraStates,
      this._scenes
    );
    this._renderTargets.initializeDepth(
      this._graphics.textures,
      this._render_resolution.x,
      this._render_resolution.y
    );
    this.configureCanvas();
    this.init_render_targets();
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
    this._transparentOit?.destroy();
    this._transparentOit = null;
    this._packedTransparentOit?.destroy();
    this._packedTransparentOit = null;
    this._ssao?.destroy();
    this._ssao = null;
    this._ssaoConfigurationKey = "";
    this._occlusionConfidence?.destroy();
    this._occlusionConfidence = null;
    this._ssr?.destroy();
    this._ssr = null;
    this._specularCorrection?.destroy();
    this._specularCorrection = null;
    this._opaqueLighting?.destroy();
    this._automaticExposure?.destroy();
    this._automaticExposure = null;
    this._taaHistory?.forEach((history) => history.destroy());
    this._taaHistory = null;
    this._taa?.destroy();
    this._taa = null;
    this._temporalClassification = null;
    this._motionBlur?.destroy();
    this._motionBlur = null;
    this._sharpen?.destroy();
    this._sharpen = null;
    this._bloom?.destroy();
    this._bloom = null;
    this._renderDebug?.destroy();
    this._renderDebug = null;
    this._materialExpand?.destroy();
    this._materialExpand = null;
    this._velocity?.destroy();
    this._velocity = null;
    this._packedMaterialResolve?.destroy();
    this._packedVisibility?.destroy();
    this._meshletDrawList?.destroy();
    this._nss?.destroy();
    this._nss = null;
    this._views?.destroy();
    this._scenes?.destroy();
    this._probeRenderers.clear();
    this._mainGraphCache.destroy();
    this._frameCoordinator?.destroy();
    this._graphics.destroy();
  }

  obtains_scene_sdf(scene: Scene): SceneSdf {
    let sdf = this._sceneSdfs.get(scene);
    if (!sdf) {
      sdf = new SceneSdf(this._graphics);
      this._sceneSdfs.set(scene, sdf);
    }
    return sdf;
  }

  getProbeRendererForScene(scene: Scene): GPULightProbeVolumeRenderer {
    const gpuScene = this._scenes.obtain(scene);
    let renderer = this._probeRenderers.get(scene);
    if (!renderer) {
      renderer = new GPULightProbeVolumeRenderer(this._graphics, gpuScene);
      this._probeRenderers.set(scene, renderer);
    }
    return renderer;
  }

  update_lpv(scene: Scene, command: ShadeGPUCommandContext): void {
    const gpuScene = this._scenes.obtain(scene);
    command.recordGraphBuild();
    const graph = new FrameGraph("LPV");
    gpuScene.light_probe_volume.atlas.graph_update({
      graph,
      scene: gpuScene,
      graphics: this._graphics,
      command,
      update_ray_count: 100000
    });
    command.encodeGraph(graph);
  }

  init_render_targets(): void {
    this._renderTargets.initializeVisibility(
      this._graphics.textures,
      this._render_resolution.x,
      this._render_resolution.y
    );
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
    this.initializeRenderPasses(this.device, featureTopology);
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
        view: `${camera.id}/${scene.id}`
      },
      [
        ...(featureTopology.temporal ? ["color"] : []),
        ...(featureTopology.ssaoTemporal ? ["ssao"] : []),
        ...(featureTopology.ssrTemporal ? ["ssr"] : [])
      ]
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
      this._taaJitter.frame_index = this._frame_count;
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
      this._taaJitter.Jitter,
      this._nss?.Jitter ?? this._taaJitter.Jitter
    );
    const viewKey = GPUViewKey.from(camera, scene);
    viewKey.label = "check_assertions";
    const view = this.views.obtain(viewKey, cmd);
    const gpuScene = view.scene;
    const gpuPacked =
      this._graphics.packed_scenes_if_created?.runtime(scene) ?? null;
    const framePlan = createRendererFramePlan(this._frame_count, {
      lpv: this.indirect_lighting_mode === ShadeIndirectLightingMode.LPV,
      shadows: featureTopology.shadows
    });
    gpuScene.lights.shadow_context.setEnabled(featureTopology.shadows, cmd);
    view.setJitter(frameJitter[0], frameJitter[1]);
    view.setViewportSize(w, h);
    view.setUpscaleRatio(
      outputWidth / w,
      outputHeight / h
    );
    view.gpu_camera_state.setViewportOffset(
      (2 * frameJitter[0]) / w,
      (2 * frameJitter[1]) / h
    );
    framePlan.execute("scene-update", () => {
      this._profiler.measure("world-and-view-update", () => {
        this._graphics.packed_scenes_if_created?.encodePendingPatch(scene, cmd);
        gpuScene.encodeFrame(cmd, this._frame_count, time_delta_seconds);
        view.update(cmd);
      });
    });
    if (this.indirect_lighting_mode === ShadeIndirectLightingMode.LPV) {
      framePlan.execute("lpv-update", () => this.update_lpv(scene, cmd));
    }
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
        const shadows = gpuScene.lights.shadow_context;
        if (sampleGpuCounters && gpuPacked !== null) {
          this._profiler.registerGpuCounterFields([
            "shadowCascade0RasterWork",
            "shadowCascade1RasterWork",
            "shadowCascade2RasterWork",
            "shadowAtlasPixelsUpdated",
            "shadowAlphaRasterWork",
            "shadowQueueOverflowMask"
          ]);
        }
        shadows.directional_cascade_lambda = this._renderSettings.values.shadows.cascadeLambda;
        shadows.directional_maximum_distance = metersToWorldUnits(
          this._renderSettings.values.shadows.maximumDistanceMeters,
          this._renderSettings.values.physicalScale
        );
        shadows.directional_texel_guard_band = this._renderSettings.values.shadows.texelGuardBand;
        shadows.select_for_draw(camera, this._frame_count, [w, h]);
        const packedBindings = gpuPacked === null
          ? null
          : this._graphics.packed_scenes.bindings();
        shadows.draw(
          cmd,
          gpuScene,
          gpuScene.lights.database,
          this._meshletDrawList,
          gpuPacked === null || packedBindings === null
            ? null
            : {
                runtime: gpuPacked,
                assets: packedBindings.assets,
                scene: packedBindings.scene,
                counterBuffer: sampleGpuCounters
                  ? this._profiler.gpuCounterBuffer
                  : null,
                sseThreshold: this.packed_visibility_sse_threshold
              }
        );
        });
      }

      const gpuCounterBuffer = sampleGpuCounters
        ? this._profiler.gpuCounterBuffer
        : null;
      if (sampleGpuCounters && gpuCounterBuffer === null) {
        throw new Error("GPU counter sampling has no counter buffer");
      }
      if (featureTopology.ssao) {
        this._ssao!.resize(
          Math.max(1, Math.ceil(w * this._renderSettings.values.ao.resolutionScale)),
          Math.max(1, Math.ceil(h * this._renderSettings.values.ao.resolutionScale))
        );
      }
      if (featureTopology.ssr) {
        this._ssr!.resize(
          Math.max(1, Math.ceil(w * this._renderSettings.values.ssr.resolutionScale)),
          Math.max(1, Math.ceil(h * this._renderSettings.values.ssr.resolutionScale))
        );
      }
      const temporalHistory = this._temporalHistories.state("color");
      const ssaoHistory = this._temporalHistories.state("ssao");
      const ssrHistory = this._temporalHistories.state("ssr");
      const taaHistoryValidity = temporalHistory.valid ? 1 : 0;
      if (featureTopology.taa) {
        this._taaJitter.reset_history = false;
      }
      if (sampleGpuCounters && featureTopology.temporal) {
        this._profiler.registerGpuCounterFields([
          "temporalReactivePixels",
          "temporalDisoccludedPixels",
          "temporalHistoryRejectedPixels"
        ]);
      }
      this._taa?.resetFrameEvidence();
      this._ssr?.resetFrameEvidence();
      this._opaqueLighting.resetFrameEvidence();
      if (this._specularCorrection !== null) this._specularCorrection.lastRan = false;
      this._lastTemporalTaaPassCount = featureTopology.taa ? 1 : 0;
      this._lastTemporalClassificationPassCount =
        (featureTopology.ssaoTemporal || featureTopology.ssrTemporal ? 1 : 0) +
        (featureTopology.temporal ? 1 : 0);
      const nssSettings = featureTopology.nss
        ? this._nss!.prepareFrame({
            renderResolution: [w, h],
            outputResolution: [outputWidth, outputHeight]
          })
        : null;
      const mainBindings: MainFrameGraphBindings = {
        camera,
        scene,
        view,
        gpuScene,
        gpuPacked,
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
        taaJitter: [frameJitter[0], frameJitter[1]],
        taaHistoryValidity,
        taaHistoryInputIndex: temporalHistory.readIndex,
        taaHistoryOutputIndex: temporalHistory.writeIndex,
        ssaoHistoryValidity: ssaoHistory.valid ? 1 : 0,
        ssaoHistoryInputIndex: ssaoHistory.readIndex,
        ssaoHistoryOutputIndex: ssaoHistory.writeIndex,
        ssrHistoryValidity: ssrHistory.valid ? 1 : 0,
        ssrHistoryInputIndex: ssrHistory.readIndex,
        ssrHistoryOutputIndex: ssrHistory.writeIndex,
        motionBlurStrength: this.motion_blur_strength,
        nssSettings,
        linearHdrCapture: frameLinearHdrCapture
      };
      const graphTopology = this.resolveFeatureTopology(mainBindings);
      this.reconcilePackedTransparencyOwner(
        graphTopology.transparency,
        mainBindings.gpuPacked,
        cmd
      );
      const graphKey = canonicalFrameGraphKey(this.createMainFrameGraphKey(
        mainBindings,
        graphTopology,
        sampleGpuTimestamps,
        sampleGpuCounters,
        debugFrameIndex !== null,
        frameLinearHdrCapture !== null
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

      const packedPath = mainBindings.gpuPacked !== null;
      const sceneDatabaseRes = packedPath
        ? null
        : graph.import_resource(
            "scene_database_buffer",
            { kind: "imported", label: "scene_database" },
            bind("scene-database", (bindings) =>
              bindings.gpuScene.scene_database_buffer!)
          );

      {
        const rt = mainBindings.renderTargets;
        const meshIdRes = packedPath ? null : graph.import_resource(
          "texture_viz_mesh",
          { kind: "imported", label: "r32uint mesh id" },
          bind("target-mesh-id", (bindings) => bindings.renderTargets.meshId)
        );
        const triIdRes = packedPath ? null : graph.import_resource(
          "texture_viz_triangle",
          { kind: "imported", label: "r32uint triangle id" },
          bind("target-triangle-id", (bindings) => bindings.renderTargets.triangleId)
        );
        const depthRes = graph.import_resource(
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
        let packedVisibilityKeyRes: ResourceId | null = null;
        let packedVisibilityDebug: PackedVisibilityDebugSource | null = null;
        if (sampleGpuCounters) {
          gpuCounterRes = graph.import_resource(
            "r0_gpu_frame_counters",
            { kind: "imported", label: "R0 GPU frame counters" },
            bind("gpu-frame-counters", (bindings) => bindings.gpuCounterBuffer!)
          );
        }

        if (packedPath) {
          const packedCounterRes = gpuCounterRes ?? graph.import_resource(
            "packed_visibility_counter_sink",
            { kind: "imported", label: "Packed Visibility disabled counter sink" },
            bind("packed-counter-sink", (bindings) =>
              bindings.gpuPacked!.counterSink)
          );
          const packedOutput = this._packedVisibility.addToGraph(
            graph,
            bind("packed-visibility-main-job", (bindings) => {
              const registryBindings =
                this._graphics.packed_scenes.bindings();
              return {
                runtime: bindings.gpuPacked!,
                assets: registryBindings.assets,
                scene: registryBindings.scene,
                countersEnabled: bindings.gpuCounterBuffer !== null,
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                hierarchyView: createPackedHierarchyView(
                  bindings.camera,
                  bindings.internalHeight
                ),
                sseThreshold: this.packed_visibility_sse_threshold,
                coneEnabled: this.packed_visibility_cone_enabled,
                previousHzb: this.packed_visibility_hzb_enabled
                  ? packedPreviousHzb(
                    bindings.viewHzb,
                    bindings.view.gpu_previous_camera_state.view_projection_matrix
                  )
                  : null
              };
            }),
            {
              camera: currentCameraRes,
              counters: packedCounterRes,
              previousHzb: this.packed_visibility_hzb_enabled
                ? previousHzbRes
                : undefined,
              depth: depthRes
            }
          );
          packedVisibilityKeyRes = packedOutput.visibilityKey;
          packedVisibilityDebug = packedOutput.debugResolve;
          gpuCounterRes = sampleGpuCounters ? packedOutput.counters : null;
        } else {
          gpuCounterRes = this._visibility.addToGraph(
            graph,
            bind("visibility-main-job", (bindings) => ({
              camera: bindings.camera,
              gpuCameraBuffer: bindings.view.gpu_camera_state.buffer,
              gpuPreviousCameraBuffer:
                bindings.view.gpu_previous_camera_state.buffer,
              gpuViewBuffer: bindings.view.uniform_buffer,
              scene: bindings.scene,
              targets: this._renderTargets,
              meshCount: bindings.gpuScene.mesh_count,
              meshlets: bindings.gpuScene.meshlets,
              drawList: this._meshletDrawList,
              meshTable: bindings.gpuScene.meshSlice,
              transformTable: bindings.gpuScene.transformSlice,
              sceneDatabase: bindings.gpuScene.scene_database,
              materialMetadata: bindings.gpuScene.material_metadata,
              enableFrustumCull: true,
              hzbView: bindings.viewHzb.obtainPreviousView(),
              viewportWidth: bindings.internalWidth,
              viewportHeight: bindings.internalHeight,
              enableHzbCull: true,
              enableInstanceCull: true,
              clearTargets: true,
              secondChance: false
            })),
            {
              meshId: meshIdRes!,
              triangleId: triIdRes!,
              depth: depthRes,
              hzb: previousHzbRes,
              counters: gpuCounterRes ?? undefined
            },
            "Visibility"
          ) ?? gpuCounterRes;
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

        {
          const sameFrameHzbView = packedPath
            ? null
            : viewHzb.obtainCurrentView();
          if (sameFrameHzbView) {
            gpuCounterRes = this._visibility.addToGraph(
              graph,
              bind("visibility-second-chance-job", (bindings) => ({
                camera: bindings.camera,
                gpuCameraBuffer: bindings.view.gpu_camera_state.buffer,
                gpuPreviousCameraBuffer:
                  bindings.view.gpu_previous_camera_state.buffer,
                gpuViewBuffer: bindings.view.uniform_buffer,
                scene: bindings.scene,
                targets: this._renderTargets,
                meshCount: bindings.gpuScene.mesh_count,
                meshlets: bindings.gpuScene.meshlets,
                drawList: this._meshletDrawList,
                meshTable: bindings.gpuScene.meshSlice,
                transformTable: bindings.gpuScene.transformSlice,
                sceneDatabase: bindings.gpuScene.scene_database,
                materialMetadata: bindings.gpuScene.material_metadata,
                enableFrustumCull: false,
                hzbView: bindings.viewHzb.obtainCurrentView(),
                viewportWidth: bindings.internalWidth,
                viewportHeight: bindings.internalHeight,
                enableHzbCull: true,
                enableInstanceCull: true,
                clearTargets: false,
                secondChance: true
              })),
              {
                meshId: meshIdRes!,
                triangleId: triIdRes!,
                depth: depthRes,
                hzb: hzbRes!,
                counters: gpuCounterRes ?? undefined
              },
              "Visibility/second-chance"
            ) ?? gpuCounterRes;

            const hzb2Builder = graph.add(
              "graph_rasterize_triangle_closest/second",
              bind("hzb-second-chance-job", (bindings) => ({
                depthTex: bindings.renderTargets.depth,
                hzb: bindings.viewHzb
              })),
              (data, _res, ctx: FrameGraphContext) => {
                const enc = resolveGpuEncoder(ctx);
                if (!enc || !data.depthTex) return;
                data.hzb.build(enc, data.depthTex);
              }
            );
            hzb2Builder.read(depthRes);
            hzbRes = hzb2Builder.write(hzbRes!);
          }
        }

        const hasAlphaTested = !packedPath &&
          this._visibility.hasAlphaTestedMaterials(scene);
        if (hasAlphaTested) {
          gpuCounterRes = this._visibility.addToGraph(
            graph,
            bind("visibility-alpha-tested-job", (bindings) => ({
              camera: bindings.camera,
              gpuCameraBuffer: bindings.view.gpu_camera_state.buffer,
              gpuPreviousCameraBuffer:
                bindings.view.gpu_previous_camera_state.buffer,
              gpuViewBuffer: bindings.view.uniform_buffer,
              scene: bindings.scene,
              targets: this._renderTargets,
              meshCount: bindings.gpuScene.mesh_count,
              meshlets: bindings.gpuScene.meshlets,
              drawList: this._meshletDrawList,
              meshTable: bindings.gpuScene.meshSlice,
              transformTable: bindings.gpuScene.transformSlice,
              sceneDatabase: bindings.gpuScene.scene_database,
              materialMetadata: bindings.gpuScene.material_metadata,
              materialRegistry: bindings.gpuScene.materials ?? this._graphics.materials,
              enableFrustumCull: true,
              hzbView: bindings.viewHzb.obtainCurrentView(),
              viewportWidth: bindings.internalWidth,
              viewportHeight: bindings.internalHeight,
              enableHzbCull: true,
              enableInstanceCull: true,
              clearTargets: false,
              secondChance: false,
              alphaTestedPass: true
            })),
            {
              meshId: meshIdRes!,
              triangleId: triIdRes!,
              depth: depthRes,
              hzb: hzbRes!,
              counters: gpuCounterRes ?? undefined
            },
            "Visibility/alpha-tested"
          ) ?? gpuCounterRes;

          {
            const hzbABuilder = graph.add(
              "graph_rasterize_triangle_closest/alpha",
              bind("hzb-alpha-tested-job", (bindings) => ({
                depthTex: bindings.renderTargets.depth,
                hzb: bindings.viewHzb
              })),
              (data, _res, ctx: FrameGraphContext) => {
                const enc = resolveGpuEncoder(ctx);
                if (!enc || !data.depthTex) return;
                data.hzb.build(enc, data.depthTex);
              }
            );
            hzbABuilder.read(depthRes);
            hzbRes = hzbABuilder.write(hzbRes!);
          }
        }

        if (gpuCounterRes !== null) {
          this._visibilityCounters ??= new VisibilityCounterPass();
          gpuCounterRes = this._visibilityCounters.addToGraph(
            graph,
            { width: w, height: h },
            {
              visibility: (packedVisibilityKeyRes ?? meshIdRes)!,
              counters: gpuCounterRes
            },
            packedVisibilityKeyRes === null
              ? "legacy-id"
              : "visibility-key"
          );
          this._profiler.registerGpuCounterFields([
            "candidateInstances",
            "visibleInstances",
            "visitedBvhNodes",
            "candidateClusters",
            "selectedClusters",
            "hwClusters",
            "alphaClusters",
            "hwTriangles",
            "rejectedFrustum",
            "rejectedCone",
            "rejectedHzb",
            "shadedPixels",
            "emptyVisibilityPixels",
            "queueOverflowMask"
          ]);
        }

        const geometryMetaRes = packedPath
          ? null
          : graph.import_resource(
              "geometries/Jg",
              { kind: "imported", label: "geometry metadata Jg" },
              bind("geometry-metadata", (bindings) =>
                bindings.gpuScene.meshlets.meshMetaBuffer!)
            );
        const meshletHeadersRes = packedPath
          ? null
          : graph.import_resource(
              "meshlets/ki",
              { kind: "imported", label: "meshlet headers ki" },
              bind("meshlet-headers", (bindings) =>
                bindings.gpuScene.meshlets.headerBuffer)
            );
        const meshletDataRes = packedPath
          ? null
          : graph.import_resource(
              "meshlets/data",
              { kind: "imported", label: "meshlet data" },
              bind("meshlet-data", (bindings) =>
                bindings.gpuScene.meshlets.dataBuffer)
            );

        const needsOcclusionConfidence =
          graphTopology.ssaoTemporal || graphTopology.ssr || graphTopology.temporal;
        const needsVelocity = needsOcclusionConfidence || graphTopology.motionBlur ||
          this.render_debug_view === RenderDebugView.Velocity;
        const packedResolveOut = packedPath
          ? this._packedMaterialResolve.addToGraph(
              graph,
              bind("packed-material-resolve-job", (bindings) => {
                const registryBindings =
                  this._graphics.packed_scenes.bindings();
                return {
                  runtime: bindings.gpuPacked!,
                  assets: registryBindings.assets,
                  scene: registryBindings.scene,
                  visibility: packedVisibilityDebug!,
                  width: bindings.internalWidth,
                  height: bindings.internalHeight,
                  currentCamera: bindings.view.gpu_camera_state.camera,
                  previousCamera: bindings.view.gpu_previous_camera_state.camera
                };
              }),
              {
                visibilityKey: packedVisibilityKeyRes!,
                view: viewUniformRes,
                counters: gpuCounterRes ?? undefined
              },
              { velocity: needsVelocity }
            )
          : null;
        const matOut = packedResolveOut ?? this.obtainLegacyMaterialExpand().addToGraph(
              graph,
              bind("material-expand-job", (bindings) => ({
                scene: bindings.scene,
                materials: bindings.gpuScene.materials,
                width: bindings.internalWidth,
                height: bindings.internalHeight
              })),
              {
                meshId: meshIdRes!,
                triangleId: triIdRes!,
                sceneDatabase: sceneDatabaseRes!,
                geometries: geometryMetaRes!,
                meshletHeaders: meshletHeadersRes!,
                meshletData: meshletDataRes!,
                view: viewUniformRes,
                camera: currentCameraRes,
                counters: gpuCounterRes ?? undefined
              }
            );
        if (matOut.counters !== null) {
          gpuCounterRes = matOut.counters;
          this._profiler.registerGpuCounterFields(["activeMaterials"]);
        }
        if (packedResolveOut !== null && packedResolveOut.counters !== null) {
          this._profiler.registerGpuCounterFields([
            "kernelBaseFactorPixels",
            "kernelBaseTexturePixels",
            "kernelBaseOrmPixels",
            "kernelBaseOrmNormalPixels",
            "kernelBaseOrmNormalEmissivePixels",
            "kernelUnlitPixels",
            "kernelGenericFallbackPixels",
            "shadeWorkOverflow"
          ]);
        }
        let gPbrRes = matOut.gPbr;
        let gNormalRes = matOut.gNormal;
        let gAlbedoRes = matOut.gAlbedo;
        const gEmissiveRes = matOut.gEmissive;
        const gMetadataRes = packedResolveOut?.surfaceFlags ?? gEmissiveRes;

        let velocityRes: ResourceId | null = null;
        let occlusionConfidenceRes: ResourceId | null = null;
        let opaqueTemporalValidityRes: ResourceId | null = null;
        if (needsVelocity) {
          const previousOffsetsBuffer =
            gpuScene.skinning.prev_position_offsets_buffer;
          const previousPositionsBuffer =
            gpuScene.skinning.prev_positions_buffer;
          const previousOffsetsRes = previousOffsetsBuffer
            ? graph.import_resource(
                "velocity/previous-position offsets",
                { kind: "imported", label: "previous-position offsets" },
                bind("previous-position-offsets", (bindings) =>
                  bindings.gpuScene.skinning.prev_position_offsets_buffer!)
              )
            : null;
          const previousPositionsRes = previousPositionsBuffer
            ? graph.import_resource(
                "velocity/previous positions",
                { kind: "imported", label: "previous positions" },
                bind("previous-positions", (bindings) =>
                  bindings.gpuScene.skinning.prev_positions_buffer!)
              )
            : null;
          velocityRes = packedResolveOut !== null
            ? packedResolveOut.velocity!
            : this.obtainLegacyVelocity().addToGraph(
                graph,
                bind("velocity-job", (bindings) => ({
                  width: bindings.internalWidth,
                  height: bindings.internalHeight,
                  currentCamera: bindings.view.gpu_camera_state.camera,
                  previousCamera:
                    bindings.view.gpu_previous_camera_state.camera
                })),
                {
                  depth: depthRes,
                  meshId: meshIdRes!,
                  triangleId: triIdRes!,
                  sceneDatabase: sceneDatabaseRes!,
                  meshletHeaders: meshletHeadersRes!,
                  meshletData: meshletDataRes!,
                  previousPositionOffsets: previousOffsetsRes,
                  previousPositions: previousPositionsRes
                }
              ).velocity;
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
          const opaqueMetadataRes =
            packedResolveOut?.surfaceFlags ?? packedVisibilityKeyRes ?? meshIdRes;
          if (opaqueMetadataRes === null) {
            throw new Error("Opaque temporal validity has no uint metadata fallback");
          }
          const opaqueValidity = this._temporalClassification!.addToGraph(
            graph,
            bind("opaque-temporal-classification-job", (bindings) => ({
              phase: "opaque" as const,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              metadataAvailable: bindings.gpuPacked !== null,
              transparencyAvailable: false,
              historyValid: true
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
            bind("light-database", (bindings) => bindings.gpuScene.lights.buffer_data)
          );
          environmentRes = graph.import_resource(
            "Ch/sec_radix_passes",
            { kind: "imported", label: "rgba16float environment" },
            bind("environment", (bindings) => bindings.gpuScene.lights.environment.gpu_texture)
          );
          diffuseIrradianceRes = graph.import_resource(
            "FX-03/diffuse irradiance",
            { kind: "imported", label: "rgba16float diffuse irradiance" },
            bind("diffuse-irradiance", (bindings) =>
              bindings.gpuScene.lights.diffuseIrradiance.gpu_texture)
          );
          if (packedResolveOut !== null && gpuCounterRes !== null) {
            gpuCounterRes = this._packedSurfaceCounters.addToGraph(
              graph, w, h,
              { surfaceFlags: packedResolveOut.surfaceFlags, pbr: gPbrRes,
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
                  bindings.gpuScene.lights.shadow_context.texture.gpu_texture)
              )
            : depthRes;
          clusters = this._lightCluster.addToGraph(
            graph,
            bind("light-cluster-job", (bindings) => ({
              camera: bindings.camera,
              lights: bindings.gpuScene.lights,
              width: bindings.internalWidth,
              height: bindings.internalHeight
            })),
            {
              camera: currentCameraRes,
              lightDatabase: lightDatabaseRes,
              hzb: hzbRes,
              counters: gpuCounterRes ?? undefined
            }
          );
          if (clusters.counters !== null) {
            gpuCounterRes = clusters.counters;
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
          const lightOut = this._lighting.addToGraph(
            graph,
            {
              width: w,
              height: h,
              surfaceMetadataAvailable: packedResolveOut !== null
            },
            {
              gPbr: gPbrRes,
              gNormal: gNormalRes,
              gAlbedo: gAlbedoRes,
              gEmissive: gEmissiveRes,
              gMetadata: gMetadataRes,
              depth: depthRes,
              lightDatabase: lightDatabaseRes,
              environment: environmentRes,
              clusterParameters: clusters.parameters,
              clusterLookup: clusters.lookup,
              clusterData: clusters.data,
              activeLightList: clusters.activeLightList,
              shadowAtlas: shadowAtlasRes,
              camera: currentCameraRes,
              view: viewUniformRes
            }
          );
          hdrRes = lightOut.hdr;
        }

        let bentNormalRes = gNormalRes;
        let ambientVisibilityRes: ResourceId | null = null;
        let ssaoRawDebugRes: ResourceId | null = null;
        let ssaoDenoisedDebugRes: ResourceId | null = null;
        let ssaoTemporalDebugRes: ResourceId | null = null;
        let ssrHitMissDebugRes: ResourceId | null = null;
        let ssrResolveDebugRes: ResourceId | null = null;
        let ssrTemporalDebugRes: ResourceId | null = null;
        let ssrHistoryConfidenceDebugRes: ResourceId | null = null;
        let indirectDiffuseDebugRes: ResourceId | null = null;
        let indirectSpecularDebugRes: ResourceId | null = null;
        let ssaoReady = !graphTopology.ssao;
        if (
          graphTopology.ssao &&
          gNormalRes !== null &&
          gAlbedoRes !== null &&
          (!graphTopology.ssaoTemporal ||
            (velocityRes !== null && occlusionConfidenceRes !== null))
        ) {
          const ssao = this._ssao!.addToGraph(
            graph,
            bind("ssao-job", (bindings) => ({
              samplers: this._graphics.samplers,
              frameIndex: bindings.frameIndex,
              historyValid: bindings.ssaoHistoryValidity >= 0.5,
              historyInputIndex: bindings.ssaoHistoryInputIndex,
              historyOutputIndex: bindings.ssaoHistoryOutputIndex,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              intensity: this._renderSettings.values.ao.intensity,
              radiusWorldUnits: metersToWorldUnits(
                this._renderSettings.values.ao.radiusMeters,
                this._renderSettings.values.physicalScale
              ),
              falloffWorldUnits: metersToWorldUnits(
                this._renderSettings.values.ao.falloffMeters,
                this._renderSettings.values.physicalScale
              ),
              sliceCount: this._renderSettings.values.ao.sliceCount,
              stepCount: this._renderSettings.values.ao.stepCount,
              spatialStep: this._renderSettings.values.ao.spatialStep,
              temporalBlend: this._renderSettings.values.ao.temporalBlend
            })),
            {
              depth: depthRes,
              normal: gNormalRes,
              velocity: velocityRes ?? depthRes,
              occlusionConfidence: occlusionConfidenceRes ?? depthRes,
              surfaceValidity: opaqueTemporalValidityRes!,
              camera: currentCameraRes,
              counters: gpuCounterRes ?? undefined
            },
            graphTopology.ssaoTemporal
              ? {
                  input: bind("ssao-history-input", (bindings) =>
                    this._ssao!.historyTexture(bindings.ssaoHistoryInputIndex)),
                  output: bind("ssao-history-output", (bindings) =>
                    this._ssao!.historyTexture(bindings.ssaoHistoryOutputIndex))
                }
              : undefined
          );
          ambientVisibilityRes = ssao.visibility;
          bentNormalRes = ssao.bentNormals;
          ssaoRawDebugRes = ssao.rawVisibility;
          ssaoDenoisedDebugRes = ssao.denoisedVisibility;
          ssaoTemporalDebugRes = ssao.temporalVisibility;
          if (ssao.counters !== null) gpuCounterRes = ssao.counters;
          ssaoReady = true;
        }

        if (hdrRes !== null && environmentRes !== null) {
          hdrRes = this._environmentBackground.addToGraph(graph, {
            hdr: hdrRes,
            depth: depthRes,
            camera: currentCameraRes,
            view: viewUniformRes,
            environment: environmentRes
          }).hdr;
        }

        if (
          this.indirect_lighting_mode === ShadeIndirectLightingMode.IBL &&
          ssaoReady &&
          hdrRes !== null &&
          environmentRes !== null &&
          diffuseIrradianceRes !== null &&
          gPbrRes !== null &&
          gNormalRes !== null &&
          gAlbedoRes !== null &&
          bentNormalRes !== null
        ) {
          const splitSum = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
          );
          const splitSumRes = graph.import_resource(
            "split_sum",
            { kind: "imported", label: "rg16float split_sum" },
            splitSum.gpu_texture
          );
          const opaqueLighting = this._opaqueLighting.addIblBaseline(
            graph,
            { width: w, height: h },
            {
            hdr: hdrRes,
            depth: depthRes,
            normal: gNormalRes,
            bentNormal: bentNormalRes,
            albedoAo: gAlbedoRes,
            pbr: gPbrRes,
            environment: environmentRes,
            diffuseIrradiance: diffuseIrradianceRes,
            splitSum: splitSumRes,
            camera: currentCameraRes,
            metadata: packedResolveOut?.surfaceFlags,
            ambientOcclusion: ambientVisibilityRes === null
              ? undefined
              : { visibility: ambientVisibilityRes }
            }
          );
          const baselineSpecularRes = opaqueLighting.iblSpecular;
          indirectDiffuseDebugRes = opaqueLighting.indirectDiffuse;
          indirectSpecularDebugRes = baselineSpecularRes;
          hdrRes = opaqueLighting.hdr;

          if (graphTopology.ssr) {
            const blueNoise = this._graphics.textures.obtain(
              STATIC_GRAPHICS_ENGINE_ASSETS.stbn_vec2
            );
            const blueNoiseRes = graph.import_resource(
              "SSR/stbn_vec2",
              { kind: "imported", label: "STBN vec2 3D" },
              blueNoise.gpu_texture
            );
            const ssr = this._ssr!.addToGraph(
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
                temporalStrength: this._renderSettings.values.ssr.temporalStrength
              })),
              {
                depth: depthRes,
                hzb: hzbRes!,
                sceneColor: hdrRes,
                pbr: gPbrRes,
                normal: gNormalRes,
                velocity: velocityRes!,
                occlusionConfidence: occlusionConfidenceRes!,
                surfaceValidity: opaqueTemporalValidityRes!,
                albedoAo: gAlbedoRes,
                environment: environmentRes,
                blueNoise: blueNoiseRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes,
                counters: gpuCounterRes ?? undefined
              },
              {
                input: bind("ssr-history-input", (bindings) =>
                  this._ssr!.historyTexture(bindings.ssrHistoryInputIndex)),
                output: bind("ssr-history-output", (bindings) =>
                  this._ssr!.historyTexture(bindings.ssrHistoryOutputIndex))
              }
            );
            hdrRes = this._specularCorrection!.addToGraph(graph, {
              hdr: hdrRes,
              depth: depthRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes,
              baselineSpecular: baselineSpecularRes,
              resolvedSpecular: ssr.denoised,
              ambientVisibility: ambientVisibilityRes ?? undefined,
              camera: currentCameraRes,
              metadata: packedResolveOut?.surfaceFlags
            });
            indirectSpecularDebugRes = ssr.denoised;
            ssrHitMissDebugRes = ssr.trace;
            ssrResolveDebugRes = ssr.denoised_1;
            ssrTemporalDebugRes = ssr.temporal;
            ssrHistoryConfidenceDebugRes = ssr.historyConfidence;
            if (ssr.counters !== null) gpuCounterRes = ssr.counters;
          }
        }

        if (
          this.indirect_lighting_mode === ShadeIndirectLightingMode.Brick4 &&
          ssaoReady &&
          hdrRes !== null &&
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
            "Brick4/stbn_vec2",
            { kind: "imported", label: "STBN vec2 3D" },
            stbn.gpu_texture
          );
          const splitSumRes = graph.import_resource(
            "Brick4/split_sum",
            { kind: "imported", label: "rg16float split_sum" },
            splitSum.gpu_texture
          );
          const lightMapRes = graph.import_resource(
            "Brick4/volumetric light map",
            { kind: "imported", label: "Brick4 Av storage" },
            bind("brick4-light-map", (bindings) =>
              bindings.gpuScene.volumetric_light_map.buffer)
          );
          const base = {
            depth: depthRes,
            stbn: stbnRes,
            view: viewUniformRes,
            camera: currentCameraRes,
            lightMap: lightMapRes
          };
          if (this.fused_indirect && !graphTopology.ssr) {
            hdrRes = this._brick4Fused.addToGraph(graph, {
              ...base,
              hdr: hdrRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes
            });
          } else {
            const indirectSpecular = this._brick4Specular.addToGraph(
              graph,
              { width: w, height: h },
              { ...base, normal: gNormalRes, pbr: gPbrRes }
            );
            const indirectDiffuse = this._brick4Diffuse.addToGraph(
              graph,
              { width: w, height: h },
              { ...base, normal: bentNormalRes, albedoAo: gAlbedoRes }
            );
            hdrRes = this._opaqueLighting.composeIndirect(graph, {
              hdr: hdrRes,
              depth: depthRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes,
              indirectDiffuse,
              indirectSpecular,
              ambientVisibility: ambientVisibilityRes ?? undefined,
              camera: currentCameraRes,
              metadata: packedResolveOut?.surfaceFlags
            });
          }
        }

        if (
          this.indirect_lighting_mode === ShadeIndirectLightingMode.LPV &&
          ssaoReady &&
          hdrRes !== null &&
          environmentRes !== null &&
          gPbrRes !== null &&
          gNormalRes !== null &&
          gAlbedoRes !== null &&
          bentNormalRes !== null
        ) {
          const atlasRadianceRes = graph.import_resource(
            "LPV/radiance atlas",
            { kind: "imported", label: "r32uint LPV radiance atlas" },
            bind("lpv-radiance-atlas", (bindings) =>
              bindings.gpuScene.light_probe_volume.atlas.texture_radiance.texture)
          );
          const atlasDepthRes = graph.import_resource(
            "LPV/depth atlas",
            { kind: "imported", label: "rg16float LPV depth atlas" },
            bind("lpv-depth-atlas", (bindings) =>
              bindings.gpuScene.light_probe_volume.atlas.texture_depth.texture)
          );
          const lpvMeshBvhRes = graph.import_resource(
            "LPV/tetra BVH",
            { kind: "imported", label: "LPV tetra BVH" },
            bind("lpv-mesh-bvh", (bindings) =>
              bindings.gpuScene.light_probe_volume.buffer_mesh_bvh)
          );
          const lpvMetadataRes = graph.import_resource(
            "LPV/metadata",
            { kind: "imported", label: "LPV metadata" },
            bind("lpv-metadata", (bindings) =>
              bindings.gpuScene.light_probe_volume.buffer_metadata)
          );
          const lpvTetraRes = graph.import_resource(
            "LPV/tetrahedra",
            { kind: "imported", label: "LPV tetrahedra" },
            bind("lpv-tetrahedra", (bindings) =>
              bindings.gpuScene.light_probe_volume.buffer_mesh)
          );
          const lpvProbesRes = graph.import_resource(
            "LPV/probes",
            { kind: "imported", label: "LPV probes" },
            bind("lpv-probes", (bindings) =>
              bindings.gpuScene.light_probe_volume.buffer_probes)
          );
          const splitSum = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
          );
          const splitSumRes = graph.import_resource(
            "split_sum",
            { kind: "imported", label: "rg16float split_sum" },
            splitSum.gpu_texture
          );

          const baselineSpecularRes = this._opaqueLighting.addBaselineSpecular(
            graph,
            { width: w, height: h },
            {
              bentNormal: bentNormalRes,
              normal: gNormalRes,
              environment: environmentRes,
              pbr: gPbrRes,
              depth: depthRes,
              camera: currentCameraRes
            }
          );
          const diffuse = this._lpvIndirectDiffuse.addToGraph(
            graph,
            bind("lpv-indirect-diffuse-job", (bindings) => ({
              camera: bindings.camera,
              samplers: this._graphics.samplers,
              width: bindings.internalWidth,
              height: bindings.internalHeight
            })),
            {
              depth: depthRes,
              normal: gNormalRes,
              albedoAo: gAlbedoRes,
              atlasRadiance: atlasRadianceRes,
              atlasDepth: atlasDepthRes,
              meshBvh: lpvMeshBvhRes,
              metadata: lpvMetadataRes,
              tetrahedra: lpvTetraRes,
              probes: lpvProbesRes
            }
          );
          hdrRes = this._opaqueLighting.composeIndirect(graph, {
            hdr: hdrRes,
            depth: depthRes,
            normal: gNormalRes,
            bentNormal: bentNormalRes,
            albedoAo: gAlbedoRes,
            pbr: gPbrRes,
            splitSum: splitSumRes,
            indirectDiffuse: diffuse.indirectDiffuse,
            indirectSpecular: baselineSpecularRes,
            ambientVisibility: ambientVisibilityRes ?? undefined,
            camera: currentCameraRes,
            metadata: packedResolveOut?.surfaceFlags
          });

          if (
            graphTopology.ssr &&
            hzbRes !== null &&
            velocityRes !== null &&
            occlusionConfidenceRes !== null
          ) {
            const blueNoise = this._graphics.textures.obtain(
              STATIC_GRAPHICS_ENGINE_ASSETS.stbn_vec2
            );
            const blueNoiseRes = graph.import_resource(
              "SSR/stbn_vec2",
              { kind: "imported", label: "STBN vec2 3D" },
              blueNoise.gpu_texture
            );
            const ssr = this._ssr!.addToGraph(
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
                temporalStrength: this._renderSettings.values.ssr.temporalStrength
              })),
              {
                depth: depthRes,
                hzb: hzbRes,
                sceneColor: hdrRes,
                pbr: gPbrRes,
                normal: gNormalRes,
                velocity: velocityRes,
                occlusionConfidence: occlusionConfidenceRes,
                surfaceValidity: opaqueTemporalValidityRes!,
                albedoAo: gAlbedoRes,
                environment: environmentRes,
                blueNoise: blueNoiseRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes,
                counters: gpuCounterRes ?? undefined,
                lpv: {
                  atlasRadiance: atlasRadianceRes,
                  atlasDepth: atlasDepthRes,
                  meshBvh: lpvMeshBvhRes,
                  metadata: lpvMetadataRes,
                  tetrahedra: lpvTetraRes,
                  probes: lpvProbesRes
                }
              },
              {
                input: bind("ssr-history-input", (bindings) =>
                  this._ssr!.historyTexture(bindings.ssrHistoryInputIndex)),
                output: bind("ssr-history-output", (bindings) =>
                  this._ssr!.historyTexture(bindings.ssrHistoryOutputIndex))
              }
            );
            hdrRes = this._specularCorrection!.addToGraph(graph, {
              hdr: hdrRes,
              depth: depthRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes,
              baselineSpecular: baselineSpecularRes,
              resolvedSpecular: ssr.denoised,
              ambientVisibility: ambientVisibilityRes ?? undefined,
              camera: currentCameraRes,
              metadata: packedResolveOut?.surfaceFlags
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
          if (packedPath) {
            const packedTransparency = this._packedTransparentOit;
            if (packedTransparency === null) {
              throw new Error("Packed transparency topology has no active owner");
            }
            const output = packedTransparency.addToGraph(
              graph,
              bind("packed-transparent-oit-job", (bindings) => {
                const registryBindings = this._graphics.packed_scenes.bindings();
                return {
                  runtime: bindings.gpuPacked!,
                  assets: registryBindings.assets,
                  scene: registryBindings.scene,
                  width: bindings.internalWidth,
                  height: bindings.internalHeight,
                  hierarchyView: createPackedHierarchyView(
                    bindings.camera,
                    bindings.internalHeight
                  ),
                  sseThreshold: this.packed_visibility_sse_threshold
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
          } else if (hzbRes !== null && lightDatabaseRes !== null &&
            shadowAtlasRes !== null && clusters !== null) {
            this._transparentOit ??= new TransparentOitPass(this._graphics);
            const brick4LightMapRes =
              this.indirect_lighting_mode === ShadeIndirectLightingMode.Brick4
                ? graph.import_resource(
                    "OIT/Brick4 volumetric light map",
                    { kind: "imported", label: "OIT Brick4 Av storage" },
                    bind("oit-brick4-light-map", (bindings) =>
                      bindings.gpuScene.volumetric_light_map.buffer)
                  )
                : undefined;
            hdrRes = this._transparentOit.addToGraph(
              graph,
              bind("transparent-oit-job", (bindings) => ({
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                scene: bindings.scene,
                materials: bindings.gpuScene.materials,
                drawList: this._meshletDrawList,
                indirectLightingMode: this.indirect_lighting_mode
              })),
              {
                hdr: hdrRes,
                depth: depthRes,
                hzb: hzbRes,
                camera: currentCameraRes,
                view: viewUniformRes,
                sceneDatabase: sceneDatabaseRes!,
                geometryMetadata: geometryMetaRes!,
                meshletHeaders: meshletHeadersRes!,
                meshletData: meshletDataRes!,
                lightDatabase: lightDatabaseRes,
                environment: environmentRes,
                clusterParameters: clusters.parameters,
                clusterLookup: clusters.lookup,
                clusterData: clusters.data,
                shadowAtlas: shadowAtlasRes,
                splitSum: oitSplitSumRes,
                brick4LightMap: brick4LightMapRes
              }
            );
          }
        }

        if (mainBindings.linearHdrCapture !== null && hdrRes !== null) {
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
          const metadataRes =
            packedResolveOut?.surfaceFlags ?? packedVisibilityKeyRes ?? meshIdRes;
          if (metadataRes === null) {
            throw new Error("FX-06 Temporal has no uint metadata fallback");
          }
          const classification = this._temporalClassification!.addToGraph(
            graph,
            bind("temporal-classification-job", (bindings) => ({
              phase: "final" as const,
              width: bindings.internalWidth,
              height: bindings.internalHeight,
              metadataAvailable: bindings.gpuPacked !== null,
              transparencyAvailable: transparentReactiveRes !== null,
              historyValid: bindings.taaHistoryValidity >= 0.5
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
              this._taaHistory![bindings.taaHistoryInputIndex]!.gpu_texture)
          );
          const historyOutputRes = graph.import_resource(
            "taa_output",
            { kind: "imported", label: "TAA history output rgba16float" },
            bind("taa-history-output", (bindings) =>
              this._taaHistory![bindings.taaHistoryOutputIndex]!.gpu_texture)
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
                  this._nss!.feedbackTexture(bindings.frameIndex, false)),
                feedbackNext: bind("nss-feedback-next", (bindings) =>
                  this._nss!.feedbackTexture(bindings.frameIndex, true)),
                bindResource: (name, resolve) => bind(
                  `nss-internal/${name}`,
                  () => resolve()
                )
              }
            );
          } else {
            hdrRes = this._taa!.addToGraph(
              graph,
              bind("taa-job", (bindings) => ({
                jitter: bindings.taaJitter,
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
                motionFadePixels: this._renderSettings.values.temporal.motionFadePixels
              })),
              {
                output: historyOutputRes,
                currentColor: hdrRes,
                historyColor: historyInputRes,
                velocity: velocityRes,
                disocclusionConfidence: occlusionConfidenceRes,
                classification: classification.classification
                ,depth: depthRes
              }
            );
          }
        }

        if (
          graphTopology.motionBlur &&
          hdrRes !== null &&
          velocityRes !== null
        ) {
          hdrRes = this._motionBlur!.addToGraph(
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

        let exposureRes: ResourceId | null = null;
        const exposureSourceHdr = hdrRes;
        if (graphTopology.automaticExposure && exposureSourceHdr !== null) {
          const exposurePrevious = graph.import_resource(
            "Automatic exposure previous",
            { kind: "imported", label: "automatic exposure previous" },
            bind("automatic-exposure-previous", (bindings) =>
              this._automaticExposure!.historyBuffer(bindings.frameIndex, false))
          );
          const exposureAdapted = graph.import_resource(
            "Automatic exposure adapted",
            { kind: "imported", label: "automatic exposure adapted" },
            bind("automatic-exposure-adapted", (bindings) =>
              this._automaticExposure!.historyBuffer(bindings.frameIndex, true))
          );
          exposureRes = this._automaticExposure!.update(
            graph,
            exposureSourceHdr,
            time_delta_seconds,
            {
              previous: exposurePrevious,
              adapted: exposureAdapted,
              job: bind("automatic-exposure-job", (bindings) => ({
                timeDeltaSeconds: bindings.timeDeltaSeconds
              }))
            }
          );
        }

        if (hdrRes !== null && graphTopology.bloom) {
          const bloom = this._bloom!.addToGraph(
            graph,
            hdrRes,
            bind("bloom-job", () => ({
              width: this._output_resolution.x,
              height: this._output_resolution.y,
              intensity: this._renderSettings.values.post.bloomIntensity,
              mipCount: 5,
              samplers: this._graphics.samplers
            }))
          );
          hdrRes = bloom.composited;
        }
        if (graphTopology.sharpening && hdrRes !== null) {
          hdrRes = this._sharpen!.addToGraph(
            graph,
            hdrRes,
            this._output_resolution.x,
            this._output_resolution.y,
            bind("sharpen-job", () => ({
              sharpness: this._renderSettings.values.post.sharpeningStrength
            }))
          );
        }

        // Debug 是主管线最终 HDR 的观察覆盖：不经过 TAA/Bloom 等处理，也不
        // 改写它们的历史；关闭或 unsupported 时不创建 Pass、纹理或 readback。
        if (graphTopology.debug) {
          this._renderDebug ??= new RenderDebugViewPass(this._graphics);
          const linearHdrDebugRes = hdrRes;
          hdrRes = this._renderDebug.addToGraph(
            graph,
            this.render_debug_view,
            {
              meshId: meshIdRes,
              triangleId: triIdRes,
              visibilityKey: packedVisibilityKeyRes,
              packedVisibility: packedVisibilityDebug,
              depth: depthRes,
              velocity: velocityRes,
              gPbr: gPbrRes,
              gNormal: gNormalRes,
              gAlbedo: gAlbedoRes,
              gEmissive: gEmissiveRes,
              surfaceFlags: packedResolveOut?.surfaceFlags ?? null,
              indirectDiffuse: indirectDiffuseDebugRes,
              indirectSpecular: indirectSpecularDebugRes,
              linearHdr: linearHdrDebugRes,
              ambientOcclusionRaw: ssaoRawDebugRes,
              ambientOcclusionDenoised: ssaoDenoisedDebugRes,
              ambientOcclusionTemporal: ssaoTemporalDebugRes,
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
          this._tonemap.addToGraph(graph, {
            swapchain: swapId,
            hdr: hdrRes,
            exposure: exposureRes ?? undefined
          });
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
        dump: compiledGraph.dump()
      });
      if (sampleGpuCounters) {
        this._profiler.registerGpuCounterFields([
          "candidateInstances",
          "visibleInstances",
          "visitedBvhNodes",
          "candidateClusters",
          "selectedClusters",
          "hwClusters",
          "alphaClusters",
          "hwTriangles",
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
          "queueOverflowMask"
        ]);
        if (gpuPacked !== null) {
          this._profiler.registerGpuCounterFields(["invalidVisibilityKeys"]);
          this._profiler.registerGpuCounterFields([
            "transparentRasterWork",
            "transparentTriangles",
            "transparentReactivePixels",
            "transparentMomentFiniteFailures",
            "transparentQueueOverflowMask"
          ]);
        }
        if (graphTopology.ssao) {
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
      if (graphTopology.ssaoTemporal) {
        this._temporalHistories.markProduced("ssao");
      }
      if (graphTopology.ssr && this._ssr?.lastTemporalPasses === 1) {
        this._temporalHistories.markProduced("ssr");
      }
      view.finish_frame(cmd, this._frame_count);
      this.recordFrameCounters(
        viewHzb,
        gpuScene.lights.shadow_context,
        gpuPacked !== null,
        gpuScene.lights.environmentEvidence
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
    linearHdrCapture: boolean
  ): FrameGraphKey {
    const instrumentationMode = [
      sampleGpuTimestamps ? "timestamps" : "",
      sampleGpuCounters ? "counters" : "",
      debugFrame ? "debug" : "",
      linearHdrCapture ? "linear-hdr-capture" : ""
    ].filter(Boolean).join("+") || "none";

    return {
      capabilityProfile: [...this.device.features].sort().join(","),
      internalWidth: bindings.internalWidth,
      internalHeight: bindings.internalHeight,
      outputWidth: bindings.outputWidth,
      outputHeight: bindings.outputHeight,
      viewCount: 1,
      sampleCount: 1,
      enabledFeatureBits: topology.enabledFeatureBits,
      visibilityImplementation: bindings.gpuPacked === null
        ? `hardware-object-visibility-ssao-owner${this._ssaoOwnerGeneration}` +
          `-ssr-owner${this._ssrOwnerGeneration}`
        : `hardware-packed-exact-visibility-key-cone${this.packed_visibility_cone_enabled ? 1 : 0}` +
          `-hzb${this.packed_visibility_hzb_enabled ? 1 : 0}` +
          `-transparent-owner${this._packedTransparencyOwnerGeneration}` +
          `-ssao-owner${this._ssaoOwnerGeneration}` +
          `-ssr-owner${this._ssrOwnerGeneration}`,
      historyFormatRevision: MAIN_GRAPH_HISTORY_FORMAT_REVISION,
      outputFormat: this._format,
      instrumentationMode,
      instrumentationRevision: MAIN_GRAPH_INSTRUMENTATION_REVISION
    };
  }

  private resolveFeatureTopology(
    bindings?: MainFrameGraphBindings
  ): MainFrameFeatureTopology {
    return resolveMainFrameFeatureTopology({
      shadows: this._renderSettings.values.features.shadows,
      ssr: this._renderSettings.values.features.screenSpaceReflections,
      ssrTemporal: this._renderSettings.values.ssr.temporalEnabled,
      ssrHalfResolution: this._renderSettings.values.ssr.resolutionScale === 0.5,
      ssao: this._renderSettings.values.features.ambientOcclusion,
      ssaoTemporal: this._renderSettings.values.ao.temporalEnabled,
      ssaoHalfResolution: this._renderSettings.values.ao.resolutionScale === 0.5,
      temporal: this._renderSettings.values.features.temporalAntiAliasing,
      bloom: this._renderSettings.values.features.bloom,
      automaticExposure: this._renderSettings.values.features.automaticExposure,
      motionBlur: this._renderSettings.values.features.motionBlur,
      sharpening: this._renderSettings.values.features.sharpening,
      fusedIndirect: this.fused_indirect,
      upscaleType: this.upscale_type,
      debugView: this.render_debug_view,
      indirectLightingMode: this.indirect_lighting_mode,
      alphaTested: bindings === undefined
        ? false
        : this._visibility.hasAlphaTestedMaterials(bindings.scene),
      previousSkinOffsets: bindings !== undefined &&
        bindings.gpuScene.skinning.prev_position_offsets_buffer !== null,
      previousSkinPositions: bindings !== undefined &&
        bindings.gpuScene.skinning.prev_positions_buffer !== null,
      transparency: bindings === undefined
        ? false
        : bindings.gpuPacked === null
          ? hasLegacyTransparentMaterials(bindings.scene)
          : bindings.gpuPacked.transparentInstanceCount > 0,
      highDynamicRange: this._highDynamicRange
    });
  }

  private reconcilePackedTransparencyOwner(
    enabled: boolean,
    runtime: PackedSceneRuntime | null,
    command: ShadeGPUCommandContext
  ): void {
    if (runtime !== null && enabled) {
      if (this._packedTransparentOit === null) {
        this._packedTransparentOit = new PackedTransparentOitPass(this._graphics);
        this._packedTransparencyOwnerGeneration++;
      }
      return;
    }
    const previous = this._packedTransparentOit;
    if (previous === null) return;
    this._packedTransparentOit = null;
    previous.retire(command);
  }

  private initializeRenderPasses(
    device: GPUDevice,
    topology: MainFrameFeatureTopology
  ): void {
    if (!this._visibility) {
      this._visibility = new VisibilityPass(this._graphics);
      this._visibility.init();
    }
    this._packedVisibility ??= new PackedVisibilityPass(this._graphics);
    this._packedMaterialResolve ??= new PackedMaterialResolvePass(this._graphics);
    this._packedSurfaceCounters ??= new PackedSurfaceCounterPass(this._graphics);
    if (!this._lighting) {
      this._lighting = new LightingPass(this._graphics);
      this._lighting.init();
    }
    this._lightCluster ??= new LightClusterPass(this._graphics);
    this._environmentBackground ??= new EnvironmentBackgroundPass(this._graphics);
    this._opaqueLighting ??= new OpaqueLightingPipeline(this._graphics);
    this._lpvIndirectDiffuse ??= new LpvIndirectDiffusePass(this._graphics);
    this._brick4Diffuse ??= new Brick4DiffusePass(this._graphics);
    this._brick4Specular ??= new Brick4SpecularPass(this._graphics);
    this._brick4Fused ??= new Brick4FusedIndirectPass(this._graphics);
    const needsOcclusionConfidence = topology.ssaoTemporal || topology.ssr || topology.temporal;
    if (needsOcclusionConfidence) {
      this._occlusionConfidence ??= new OcclusionConfidencePass(this._graphics);
    } else if (this._occlusionConfidence !== null) {
      this.retireAfterSubmittedWork(this._occlusionConfidence);
      this._occlusionConfidence = null;
    }
    if (topology.ssao) {
      const configurationKey = `${topology.ssaoTemporal ? 1 : 0}/${topology.ssaoHalfResolution ? 1 : 0}`;
      if (this._ssao === null || this._ssaoConfigurationKey !== configurationKey) {
        if (this._ssao !== null) this.retireAfterSubmittedWork(this._ssao);
        this._ssao = new ScreenSpaceAmbientOcclusionPass(
          this._graphics,
          topology.ssaoTemporal,
          topology.ssaoHalfResolution ? 0.5 : 1
        );
        this._ssaoOwnerGeneration++;
        this._ssaoConfigurationKey = configurationKey;
      }
    } else if (this._ssao !== null) {
      this.retireAfterSubmittedWork(this._ssao);
      this._ssao = null;
      this._ssaoConfigurationKey = "";
    }
    if (topology.ssr) {
      const configurationKey = `${topology.ssrTemporal ? 1 : 0}/${topology.ssrHalfResolution ? 1 : 0}`;
      if (this._ssr === null || this._ssrConfigurationKey !== configurationKey) {
        if (this._ssr !== null) this.retireAfterSubmittedWork(this._ssr);
        this._ssr = new ScreenSpaceReflectionsPass(
          this._graphics,
          topology.ssrTemporal,
          topology.ssrHalfResolution ? 0.5 : 1
        );
        this._ssrOwnerGeneration++;
        this._ssrConfigurationKey = configurationKey;
      }
      this._specularCorrection ??= new SpecularCorrectionPass(this._graphics);
    } else if (this._ssr !== null) {
      this.retireAfterSubmittedWork(this._ssr);
      this._ssr = null;
      this._ssrConfigurationKey = "";
      if (this._specularCorrection !== null) {
        this.retireAfterSubmittedWork(this._specularCorrection);
        this._specularCorrection = null;
      }
    }
    if (topology.taa) {
      this._taa ??= new TemporalAntiAliasingPass(this._graphics);
    } else if (this._taa !== null) {
      this.retireAfterSubmittedWork(this._taa);
      this._taa = null;
      this._lastTemporalTaaPassCount = 0;
    }
    if (topology.temporal || topology.ssaoTemporal || topology.ssrTemporal) {
      this._temporalClassification ??= new TemporalClassificationPass(
        this._graphics
      );
    } else if (this._temporalClassification !== null) {
      this.retireAfterSubmittedWork(this._temporalClassification);
      this._temporalClassification = null;
      this._lastTemporalClassificationPassCount = 0;
    }
    if (topology.nss) {
      void this.nss;
    } else if (this._nss !== null) {
      this.retireAfterSubmittedWork(this._nss);
      this._nss = null;
    }
    if (topology.temporal) {
      this.ensureTemporalColorHistory();
    } else if (this._taaHistory !== null) {
      for (const history of this._taaHistory) {
        this.retireAfterSubmittedWork(history);
      }
      this._taaHistory = null;
      this._taaJitter.reset_history = true;
    }
    if (topology.motionBlur) {
      this._motionBlur ??= new MotionBlurPass(this._graphics);
    } else if (this._motionBlur !== null) {
      this.retireAfterSubmittedWork(this._motionBlur);
      this._motionBlur = null;
    }
    if (topology.sharpening) {
      this._sharpen ??= new SharpenPass(this._graphics);
    } else if (this._sharpen !== null) {
      this.retireAfterSubmittedWork(this._sharpen);
      this._sharpen = null;
    }
    if (topology.bloom) {
      this._bloom ??= new BloomPass(this._graphics);
    } else if (this._bloom !== null) {
      this.retireAfterSubmittedWork(this._bloom);
      this._bloom = null;
    }
    if (topology.automaticExposure) {
      this._automaticExposure ??= new AutomaticExposurePass(device);
      this._automaticExposure.exposure_compensation = this._renderSettings.values.post.exposureCompensation;
      this._automaticExposure.adaptation_speed_up = this._renderSettings.values.post.exposureSpeedUp;
      this._automaticExposure.adaptation_speed_down = this._renderSettings.values.post.exposureSpeedDown;
    } else if (this._automaticExposure !== null) {
      this.retireAfterSubmittedWork(this._automaticExposure);
      this._automaticExposure = null;
    }
    if (!topology.debug && this._renderDebug !== null) {
      this.retireAfterSubmittedWork(this._renderDebug);
      this._renderDebug = null;
    }
    if (!this._tonemap) {
      this._tonemap = new TonemapPass(device, this._format);
      this._tonemap.hdrEnabled = this._highDynamicRange;
      this._tonemap.peakNits = this._peakNits;
      this._tonemap.init();
    }
  }

  private obtainLegacyMaterialExpand(): MaterialExpandPass {
    if (this._materialExpand === null) {
      this._materialExpand = new MaterialExpandPass(
        this._graphics,
        this._graphics.materials
      );
      this._materialExpand.init();
    }
    return this._materialExpand;
  }

  private obtainLegacyVelocity(): VelocityPass {
    this._velocity ??= new VelocityPass(this._graphics);
    return this._velocity;
  }

  private ensureTemporalColorHistory(): void {
    if (this._taaHistory !== null) return;
    const historyDescriptor = id.from({
      label: "Renderer/temporal-color-history",
      size: this._output_resolution.asArray(),
      format: "rgba16float",
      mipLevelCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC
    });
    this._taaHistory = [
      this._graphics.textures.contextFromDescriptor(
        new id().copy(historyDescriptor)
      ),
      this._graphics.textures.contextFromDescriptor(
        new id().copy(historyDescriptor)
      )
    ];
    this._taaJitter.reset_history = true;
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
    },
    packedPath: boolean,
    environment: {
      specularAllocatedBytes: number;
      diffuseAllocatedBytes: number;
      specularMipLevelCount: number;
    }
  ): void {
    const profiler = this._profiler;
    if (packedPath) {
      profiler.recordCounter(
        "packed.visibility.rasterWorkCapacity",
        this._packedVisibility.lastCandidateCapacity
      );
      profiler.recordCounter(
        "packed.visibility.drawIndirect",
        this._packedVisibility.lastDrawIndirect ? 1 : 0
      );
      profiler.recordCounter(
        "packed.visibility.verticesPerTriangle",
        this._packedVisibility.lastVerticesPerTriangle
      );
      profiler.recordCounter(
        "packed.visibility.keyAttachmentBytes",
        this._packedVisibility.lastVisibilityKeyAttachmentBytes
      );
      profiler.recordCounter(
        "packed.visibility.hierarchy",
        this._packedVisibility.lastImplementation === "hierarchy" ? 1 : 0
      );
    } else {
      const visibility = this._visibility;
      profiler.recordCounter(
        "legacy.instances.candidate",
        visibility.lastFrustumCulled + visibility.lastFrustumUnculled
      );
      profiler.recordCounter(
        "legacy.instances.frustumCulled",
        visibility.lastFrustumCulled
      );
      profiler.recordCounter(
        "legacy.instances.frustumUnculled",
        visibility.lastFrustumUnculled
      );
      profiler.recordCounter(
        "legacy.visibility.drawCount",
        visibility.lastDrawCount
      );
      profiler.recordCounter(
        "legacy.visibility.bucketPasses",
        visibility.lastBucketPasses
      );
      profiler.recordCounter(
        "legacy.visibility.activeMaterialBuckets",
        visibility.lastActiveBucketCount
      );
      profiler.recordCounter(
        "legacy.visibility.secondChance",
        visibility.lastSecondChance ? 1 : 0
      );
    }
    profiler.recordCounter(
      "hzb.computeBuilds",
      hzb.lastBuildCount + shadows.lastHzbBuildCount
    );
    profiler.recordCounter(
      "hzb.computePasses",
      hzb.lastComputePassCount + shadows.lastHzbComputePassCount
    );
    profiler.recordCounter(
      "hzb.dispatches",
      hzb.lastDispatchCount + shadows.lastHzbDispatchCount
    );
    profiler.recordCounter(
      "hzb.outputPixels",
      hzb.lastOutputPixels + shadows.lastHzbOutputPixels
    );
    profiler.recordCounter("hzb.historyValid", hzb.historyValid ? 1 : 0);
    profiler.recordCounter("hzb.historyInvalidations", hzb.historyInvalidationCount);
    profiler.recordCounter("shadow.atlasBytes", shadows.atlas_allocated_bytes);
    profiler.recordCounter("shadow.packedCascadeDraws", shadows.packed_cascade_draw_count);
    profiler.recordCounter("shadow.atlasPixelsUpdated", shadows.packed_atlas_pixels_updated);
    profiler.recordCounter(
      packedPath
        ? "packed.material.kernelDraws"
        : "legacy.material.fullscreenDraws",
      packedPath
        ? this._packedMaterialResolve.lastKernelDrawCount
        : this._materialExpand!.lastDrawCount
    );
    if (packedPath) {
      const materialEvidence = this._graphics.material_store_if_created?.evidence();
      const textureEvidence = this._graphics.texture_residency_if_created?.evidence();
      profiler.recordCounter(
        "packed.material.activeMaterials",
        this._packedMaterialResolve.lastActiveMaterialCount
      );
      profiler.recordCounter(
        "packed.material.surfaceBytesPerPixel",
        this._packedMaterialResolve.surfaceBytesPerPixel
      );
      profiler.recordCounter(
        "packed.material.surfaceAttachmentBytes",
        this._render_resolution.x * this._render_resolution.y *
          this._packedMaterialResolve.surfaceBytesPerPixel
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
    }
    profiler.recordCounter(
      "lighting.clusterCount",
      this._lightCluster.lastClusterCount
    );
    profiler.recordCounter(
      "lighting.localLightCount",
      this._lightCluster.lastLocalLightCount
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
    profiler.recordCounter("ao.historyBytes", ao.historyBytes);
    profiler.recordCounter("ao.historyValid", ao.historyValid ? 1 : 0);
    profiler.recordCounter("ao.historyRevision", ao.historyRevision);
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
    profiler.recordCounter("gpu.residentBytes", this._graphics.gpu_memory_usage);
  }

  private reconcileDynamicResolutionProfiler(): void {
    this._dynamicResolution.consume_delayed_gpu_timing(this._frame_count);
    const supported = this.device.features.has("timestamp-query");
    if (this._dynamicResolution.enabled && supported) {
      if (!this._profiler.enabled) {
        this._profiler.configure({ enabled: true, gpuSampleInterval: 4 });
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
      !this._dynamicResolution.enabled ||
      !snapshot.gpu.sampled ||
      snapshot.gpu.pending ||
      snapshot.gpu.segments.length === 0
    ) return;
    const gpuFrameTimeMs = snapshot.gpu.segments.reduce(
      (sum, segment) => sum + segment.durationMs,
      0
    );
    this._dynamicResolution.notify_gpu_timing({
      sampleFrameIndex: snapshot.frameIndex,
      currentFrameIndex: this._frame_count,
      gpuFrameTimeMs
    });
  }

  add_debug_frame(count = 1): void {
    this._debug_frame_budget += count;
  }

  indicate_view_change(): void {
    this._hzbCameraRevision++;
    this._taaJitter.reset_history = true;
    if (this._pathTracer !== undefined) this._pathTracer.clear_history = true;
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
    this._taaJitter.jitter_sequence_size = recommendedTaaJitterSequenceSize(
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
    this._taaJitter.reset_history = true;
    if (this._pathTracer !== undefined) this._pathTracer.clear_history = true;
    if (this._nss) this._nss.reset_history = true;
  }

  private applyPendingRenderResolutionChange(): void {
    if (!this._renderResolutionDirty) return;
    this.recalculateRenderResolution();
  }

  private resizeColorHistories(): void {
    this._taaHistory?.forEach((history) => {
      history.resize(
        this._output_resolution.x,
        this._output_resolution.y
      );
    });
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
    if (this._tonemap) {
      this._tonemap.hdrEnabled = highDynamicRange;
      this._tonemap.peakNits = this._peakNits;
      this._tonemap.setCanvasFormat(this._format);
    }
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

function hasLegacyTransparentMaterials(scene: Scene): boolean {
  return scene.instances.materials.some(
    (material) => material.transparency_mode === ShadeTransparencyMode.Transparent
  );
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
  for (const [name, value] of Object.entries(region)) {
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
