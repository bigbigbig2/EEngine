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
import { IblSpecularPass } from "./passes/IblSpecularPass.js";
import { IblDiffusePass } from "./passes/IblDiffusePass.js";
import { LpvIndirectDiffusePass } from "./passes/LpvIndirectDiffusePass.js";
import { IndirectCompositePass } from "./passes/IndirectCompositePass.js";
import { TransparentOitPass } from "./passes/TransparentOitPass.js";
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
import { TemporalAntiAliasingPass } from "./passes/TemporalAntiAliasingPass.js";
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
  readonly motionBlurStrength: number;
  readonly nssSettings: NssSettings | null;
};

const MAIN_GRAPH_CACHE_LIMIT = 16;
const MAIN_GRAPH_HISTORY_FORMAT_REVISION = 1;
const MAIN_GRAPH_INSTRUMENTATION_REVISION = 3;

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
  private _internal_resolution_scale = 1;
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
  private _iblSpecular!: IblSpecularPass;
  private _iblDiffuse!: IblDiffusePass;
  private _lpvIndirectDiffuse!: LpvIndirectDiffusePass;
  private _indirectComposite!: IndirectCompositePass;
  private _transparentOit!: TransparentOitPass;
  private _pathTracer: PathTracer | undefined;
  private _brick4Diffuse!: Brick4DiffusePass;
  private _brick4Specular!: Brick4SpecularPass;
  private _brick4Fused!: Brick4FusedIndirectPass;
  private _velocity: VelocityPass | null = null;
  private _renderDebug: RenderDebugViewPass | null = null;
  private _occlusionConfidence!: OcclusionConfidencePass;
  private _ssao: ScreenSpaceAmbientOcclusionPass | null = null;
  private _ssr: ScreenSpaceReflectionsPass | null = null;
  private _taa: TemporalAntiAliasingPass | null = null;
  private _nss: NeuralSuperSamplingPass | null = null;
  private _motionBlur: MotionBlurPass | null = null;
  private _sharpen: SharpenPass | null = null;
  private _bloom: BloomPass | null = null;
  private _automaticExposure: AutomaticExposurePass | null = null;
  private readonly _taaJitter = new TemporalJitterController();
  private _taaHistory: [GPUTextureContext, GPUTextureContext] | null = null;
  private _tonemap!: TonemapPass;
  private _renderTargets = new RenderTargets();
  private _format: GPUTextureFormat = "rgba8unorm";
  private readonly _sceneSdfs = new Map<Scene, SceneSdf>();
  private readonly _probeRenderers = new Map<
    Scene,
    GPULightProbeVolumeRenderer
  >();
  feature_shadows_enabled = true;
  feature_ssr_enabled = false;
  feature_ssao_enabled = true;
  feature_taa_enabled = true;
  feature_bloom_enabled = true;
  feature_automatic_exposure_enabled = true;
  feature_motion_blur_enabled = false;
  feature_sharpening_enabled = true;
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
    return this._internal_resolution_scale;
  }
  set internal_resolution_scale(v: number) {
    if (v === this._internal_resolution_scale) return;
    this._internal_resolution_scale = v;
    this._renderResolutionDirty = true;
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
    const handles: AssetHandle[] = [];
    try {
      for (let index = 0; index < source.geometries.length; index++) {
        const command = ShadeGPUCommandContext.create(
          this._graphics,
          "Renderer/PackedScene/resident"
        );
        try {
          const handle = this._graphics.assets.resident(
            source.geometries[index]!,
            command
          );
          command.finish();
          await command.submitted;
          handles.push(handle);
        } catch (error) {
          command.abort(error);
          throw error;
        }
      }
      const command = ShadeGPUCommandContext.create(
        this._graphics,
        "Renderer/PackedScene/instantiate"
      );
      try {
        const handle = this._graphics.packed_scenes.stage(
          scene,
          source,
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
    } catch (error) {
      await this.releasePackedAssetHandles(handles);
      throw error;
    }
  }

  /** Releases one Packed Scene and all Geometry residency owned by its upload. */
  async releasePackedScene(scene: Scene): Promise<void> {
    const command = ShadeGPUCommandContext.create(
      this._graphics,
      "Renderer/PackedScene/release-instances"
    );
    let handles: readonly AssetHandle[];
    try {
      const runtime = this._graphics.packed_scenes.runtime(scene);
      if (runtime !== null && this._packedVisibility) {
        this._packedVisibility.release(runtime, command);
      }
      handles = this._graphics.packed_scenes.release(scene, command);
      command.finish();
      await command.submitted;
    } catch (error) {
      command.abort(error);
      throw error;
    }
    await this.releasePackedAssetHandles(handles);
  }

  /** Queues one explicit patch batch for the next main frame command. */
  queuePackedScenePatch(scene: Scene, batch: PackedScenePatchBatch): void {
    this._graphics.packed_scenes.queuePatch(scene, batch);
  }

  packedSceneEvidence(): PackedSceneEvidence {
    return this._graphics.packed_scenes.evidence();
  }

  private async releasePackedAssetHandles(
    handles: readonly AssetHandle[]
  ): Promise<void> {
    for (let index = handles.length - 1; index >= 0; index--) {
      const command = ShadeGPUCommandContext.create(
        this._graphics,
        "Renderer/PackedScene/release-asset"
      );
      try {
        this._graphics.assets.release(handles[index]!, command);
        command.finish();
        await command.submitted;
      } catch (error) {
        command.abort(error);
        throw error;
      }
    }
  }

  /**
   * Frame evidence is disabled by default. Benchmarks enable it explicitly and
   * choose a GPU timestamp sampling cadence through `configure()`.
   */
  get profiler(): FrameProfiler {
    return this._profiler;
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
    window
      .matchMedia("(dynamic-range: high)")
      .removeEventListener("change", this._onDynamicRangeChange);
    this._transparentOit?.destroy();
    this._ssao?.destroy();
    this._ssao = null;
    this._ssr?.destroy();
    this._ssr = null;
    this._automaticExposure?.destroy();
    this._automaticExposure = null;
    this._taaHistory?.forEach((history) => history.destroy());
    this._taaHistory = null;
    this._taa?.destroy();
    this._taa = null;
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
    this._profiler.beginFrame(this._frame_count);
    let activeFrame: FrameEncoding | null = null;
    try {
    this._renderTargets.setFrameIndex(this._frame_count);
    this.applyPendingRenderResolutionChange();
    if (this._canvasNeedsConfigure) {
      this.configureCanvas();
      this._canvasNeedsConfigure = false;
    }
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
    gpuScene.lights.shadow_context.enabled = featureTopology.shadows;
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
    this._profiler.measure("world-and-view-update", () => {
      this._graphics.packed_scenes_if_created?.encodePendingPatch(scene, cmd);
      gpuScene.encodeFrame(cmd, this._frame_count, time_delta_seconds);
      view.update(cmd);
    });
    if (this.indirect_lighting_mode === ShadeIndirectLightingMode.LPV) {
      this.update_lpv(scene, cmd);
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
        const shadows = gpuScene.lights.shadow_context;
        shadows.select_for_draw(camera, this._frame_count, [w, h]);
        shadows.draw(
          cmd,
          gpuScene,
          gpuScene.lights.database,
          this._meshletDrawList
        );
      }

      const gpuCounterBuffer = sampleGpuCounters
        ? this._profiler.gpuCounterBuffer
        : null;
      if (sampleGpuCounters && gpuCounterBuffer === null) {
        throw new Error("GPU counter sampling has no counter buffer");
      }
      if (featureTopology.ssao) this._ssao!.resize(w, h);
      if (featureTopology.ssr) this._ssr!.resize(w, h);
      const taaHistoryValidity = this._taaJitter.reset_history ? 0 : 1;
      if (featureTopology.taa) {
        this._taaJitter.reset_history = false;
      }
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
        motionBlurStrength: this.motion_blur_strength,
        nssSettings
      };
      const graphTopology = this.resolveFeatureTopology(mainBindings);
      const graphKey = canonicalFrameGraphKey(this.createMainFrameGraphKey(
        mainBindings,
        graphTopology,
        sampleGpuTimestamps,
        sampleGpuCounters,
        debugFrameIndex !== null
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
              : "visibility-key-v1"
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
              }
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
        if (packedResolveOut !== null && gpuCounterRes !== null) {
          gpuCounterRes = this._packedSurfaceCounters.addToGraph(
            graph,
            w,
            h,
            {
              surfaceFlags: packedResolveOut.surfaceFlags,
              counters: gpuCounterRes
            }
          );
          this._profiler.registerGpuCounterFields([
            "gradientFallbackPixels",
            "reactiveSurfacePixels",
            "normalTexturePixels",
            "ormTexturePixels",
            "emissiveTexturePixels",
            "unlitSurfacePixels"
          ]);
        }
        let gPbrRes = matOut.gPbr;
        let gNormalRes = matOut.gNormal;
        let gAlbedoRes = matOut.gAlbedo;
        const gEmissiveRes = matOut.gEmissive;
        const gMetadataRes = packedResolveOut?.surfaceFlags ?? gEmissiveRes;

        let velocityRes: ResourceId | null = null;
        let occlusionConfidenceRes: ResourceId | null = null;
        {
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
            ? packedResolveOut.velocity
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

        let hdrRes: ResourceId | null = null;
        let environmentRes: ResourceId | null = null;
        let lightDatabaseRes: ResourceId | null = null;
        let shadowAtlasRes: ResourceId | null = null;
        let clusters: LightClusterOutputs | null = null;

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
        let ssaoReady = !graphTopology.ssao;
        if (
          graphTopology.ssao &&
          velocityRes !== null &&
          occlusionConfidenceRes !== null &&
          gNormalRes !== null &&
          gAlbedoRes !== null
        ) {
          const ssao = this._ssao!.addToGraph(
            graph,
            bind("ssao-job", (bindings) => ({
              samplers: this._graphics.samplers,
              frameIndex: bindings.frameIndex,
              width: bindings.internalWidth,
              height: bindings.internalHeight
            })),
            {
              depth: depthRes,
              normal: gNormalRes,
              velocity: velocityRes,
              occlusionConfidence: occlusionConfidenceRes,
              albedoAo: gAlbedoRes,
              camera: currentCameraRes
            },
            {
              input: bind("ssao-history-input", (bindings) =>
                this._ssao!.historyTexture(bindings.frameIndex, false)),
              output: bind("ssao-history-output", (bindings) =>
                this._ssao!.historyTexture(bindings.frameIndex, true))
            }
          );
          gAlbedoRes = ssao.occlusion;
          bentNormalRes = ssao.bentNormals;
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
          let indirectSpecularRes: ResourceId;
          if (graphTopology.ssr) {
            const blueNoise = this._graphics.textures.obtain(
              STATIC_GRAPHICS_ENGINE_ASSETS.stbn_vec2
            );
            const blueNoiseRes = graph.import_resource(
              "SSR/stbn_vec2",
              { kind: "imported", label: "STBN vec2 3D" },
              blueNoise.gpu_texture
            );
            indirectSpecularRes = this._ssr!.addToGraph(
              graph,
              bind("ssr-job", (bindings) => ({
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                frameIndex: bindings.frameIndex,
                samplers: this._graphics.samplers
              })),
              {
                depth: depthRes,
                hzb: hzbRes!,
                sceneColor: hdrRes,
                pbr: gPbrRes,
                normal: gNormalRes,
                velocity: velocityRes!,
                occlusionConfidence: occlusionConfidenceRes!,
                albedoAo: gAlbedoRes,
                environment: environmentRes,
                blueNoise: blueNoiseRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes
              },
              {
                input: bind("ssr-history-input", (bindings) =>
                  this._ssr!.historyTexture(bindings.frameIndex, false)),
                output: bind("ssr-history-output", (bindings) =>
                  this._ssr!.historyTexture(bindings.frameIndex, true))
              }
            ).denoised;
          } else {
            indirectSpecularRes = this._iblSpecular.addToGraph(
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
            ).indirectSpecular;
          }
          const indirectDiffuseRes = this._iblDiffuse.addToGraph(
            graph,
            { width: w, height: h },
            {
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              environment: environmentRes,
              depth: depthRes
            }
          ).indirectDiffuse;
          hdrRes = this._indirectComposite.addToGraph(graph, {
            hdr: hdrRes,
            depth: depthRes,
            normal: gNormalRes,
            bentNormal: bentNormalRes,
            albedoAo: gAlbedoRes,
            pbr: gPbrRes,
            splitSum: splitSumRes,
            indirectDiffuse: indirectDiffuseRes,
            indirectSpecular: indirectSpecularRes,
            camera: currentCameraRes
          }).hdr;
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
            hdrRes = this._indirectComposite.addToGraph(graph, {
              hdr: hdrRes,
              depth: depthRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes,
              indirectDiffuse,
              indirectSpecular,
              camera: currentCameraRes
            }).hdr;
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

          let indirectSpecularRes: ResourceId;
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
            indirectSpecularRes = this._ssr!.addToGraph(
              graph,
              bind("ssr-job", (bindings) => ({
                width: bindings.internalWidth,
                height: bindings.internalHeight,
                frameIndex: bindings.frameIndex,
                samplers: this._graphics.samplers
              })),
              {
                depth: depthRes,
                hzb: hzbRes,
                sceneColor: hdrRes,
                pbr: gPbrRes,
                normal: gNormalRes,
                velocity: velocityRes,
                occlusionConfidence: occlusionConfidenceRes,
                albedoAo: gAlbedoRes,
                environment: environmentRes,
                blueNoise: blueNoiseRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes,
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
                  this._ssr!.historyTexture(bindings.frameIndex, false)),
                output: bind("ssr-history-output", (bindings) =>
                  this._ssr!.historyTexture(bindings.frameIndex, true))
              }
            ).denoised;
          } else {
            indirectSpecularRes = this._iblSpecular.addToGraph(
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
            ).indirectSpecular;
          }
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
          hdrRes = this._indirectComposite.addToGraph(graph, {
              hdr: hdrRes,
              depth: depthRes,
              normal: gNormalRes,
              bentNormal: bentNormalRes,
              albedoAo: gAlbedoRes,
              pbr: gPbrRes,
              splitSum: splitSumRes,
              indirectDiffuse: diffuse.indirectDiffuse,
              indirectSpecular: indirectSpecularRes,
              camera: currentCameraRes
            }).hdr;
        }

        if (
          this._transparentOit.hasTransparentMaterials(scene) &&
          hdrRes !== null &&
          hzbRes !== null &&
          lightDatabaseRes !== null &&
          environmentRes !== null &&
          shadowAtlasRes !== null &&
          clusters !== null
        ) {
          const splitSum = this._graphics.textures.obtain(
            STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
          );
          const oitSplitSumRes = graph.import_resource(
            "OIT/split_sum",
            { kind: "imported", label: "OIT rg16float split_sum" },
            splitSum.gpu_texture
          );
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

        if (
          graphTopology.temporal &&
          hdrRes !== null &&
          velocityRes !== null &&
          occlusionConfidenceRes !== null
        ) {
          const historyInputRes = graph.import_resource(
            "taa_history",
            { kind: "imported", label: "TAA history input rgba16float" },
            bind("taa-history-input", (bindings) =>
              this._taaHistory![bindings.frameIndex % 2]!.gpu_texture)
          );
          const historyOutputRes = graph.import_resource(
            "taa_output",
            { kind: "imported", label: "TAA history output rgba16float" },
            bind("taa-history-output", (bindings) =>
              this._taaHistory![(bindings.frameIndex + 1) % 2]!.gpu_texture)
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
                samplers: this._graphics.samplers
              })),
              {
                output: historyOutputRes,
                currentColor: hdrRes,
                historyColor: historyInputRes,
                velocity: velocityRes,
                occlusionConfidence: occlusionConfidenceRes,
                currentCamera: currentCameraRes,
                previousCamera: previousCameraRes
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

        if (graphTopology.sharpening && hdrRes !== null) {
          hdrRes = this._sharpen!.addToGraph(
            graph,
            hdrRes,
            this._output_resolution.x,
            this._output_resolution.y,
            0.8
          );
        }

        let exposureRes: ResourceId | null = null;
        let exposureInput = hdrRes;
        if (hdrRes !== null && graphTopology.bloom) {
          const bloom = this._bloom!.addToGraph(graph, hdrRes, {
            width: this._output_resolution.x,
            height: this._output_resolution.y,
            intensity: 1,
            mipCount: 5,
            samplers: this._graphics.samplers
          });
          hdrRes = bloom.composited;
          exposureInput = bloom.downsampled;
        }
        if (graphTopology.automaticExposure && exposureInput !== null) {
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
            exposureInput,
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

        // Debug 是主管线最终 HDR 的观察覆盖：不经过 TAA/Bloom 等处理，也不
        // 改写它们的历史；关闭或 unsupported 时不创建 Pass、纹理或 readback。
        if (graphTopology.debug) {
          this._renderDebug ??= new RenderDebugViewPass(this._graphics);
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
              surfaceFlags: packedResolveOut?.surfaceFlags ?? null
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
          "queueOverflowMask"
        ]);
        if (gpuPacked !== null) {
          this._profiler.registerGpuCounterFields(["invalidVisibilityKeys"]);
        }
      }
      cmd.encodeCompiledGraph(compiledGraph, mainBindings);
      view.finish_frame(cmd, this._frame_count);
      this.recordFrameCounters(
        viewHzb,
        gpuScene.lights.shadow_context,
        gpuPacked !== null
      );
      this._profiler.encodeGpuCounterReadback(cmd);
      this._frameCoordinator.submitFrame(activeFrame);
      activeFrame = null;
    }

    this._frame_count++;
    this.onFrameFinished.send1(this._frame_count);
    return true;
    } catch (error) {
      if (activeFrame !== null) {
        this._frameCoordinator.abortFrame(activeFrame, error);
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
    debugFrame: boolean
  ): FrameGraphKey {
    const instrumentationMode = [
      sampleGpuTimestamps ? "timestamps" : "",
      sampleGpuCounters ? "counters" : "",
      debugFrame ? "debug" : ""
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
        ? "hardware-legacy-v1"
        : `hardware-packed-r4-visibility-key-v1-cone${this.packed_visibility_cone_enabled ? 1 : 0}` +
          `-hzb${this.packed_visibility_hzb_enabled ? 1 : 0}`,
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
      shadows: this.feature_shadows_enabled,
      ssr: this.feature_ssr_enabled,
      ssao: this.feature_ssao_enabled,
      temporal: this.feature_taa_enabled,
      bloom: this.feature_bloom_enabled,
      automaticExposure: this.feature_automatic_exposure_enabled,
      motionBlur: this.feature_motion_blur_enabled,
      sharpening: this.feature_sharpening_enabled,
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
        : this._transparentOit.hasTransparentMaterials(bindings.scene),
      highDynamicRange: this._highDynamicRange
    });
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
    this._iblSpecular ??= new IblSpecularPass(this._graphics);
    this._iblDiffuse ??= new IblDiffusePass(this._graphics);
    this._lpvIndirectDiffuse ??= new LpvIndirectDiffusePass(this._graphics);
    this._indirectComposite ??= new IndirectCompositePass(this._graphics);
    this._transparentOit ??= new TransparentOitPass(this._graphics);
    this._brick4Diffuse ??= new Brick4DiffusePass(this._graphics);
    this._brick4Specular ??= new Brick4SpecularPass(this._graphics);
    this._brick4Fused ??= new Brick4FusedIndirectPass(this._graphics);
    this._occlusionConfidence ??= new OcclusionConfidencePass(this._graphics);
    if (topology.ssao) {
      this._ssao ??= new ScreenSpaceAmbientOcclusionPass(this._graphics);
    } else if (this._ssao !== null) {
      this.retireAfterSubmittedWork(this._ssao);
      this._ssao = null;
    }
    if (topology.ssr) {
      this._ssr ??= new ScreenSpaceReflectionsPass(this._graphics);
    } else if (this._ssr !== null) {
      this.retireAfterSubmittedWork(this._ssr);
      this._ssr = null;
    }
    if (topology.taa) {
      this._taa ??= new TemporalAntiAliasingPass(this._graphics);
    } else if (this._taa !== null) {
      this.retireAfterSubmittedWork(this._taa);
      this._taa = null;
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
    },
    packedPath: boolean
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
        "packed.visibility.fixedVertexCount",
        this._packedVisibility.lastFixedVertexCount
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
    profiler.recordCounter(
      packedPath
        ? "packed.material.fullscreenDraws"
        : "legacy.material.fullscreenDraws",
      packedPath
        ? this._packedMaterialResolve.lastDrawCount
        : this._materialExpand!.lastDrawCount
    );
    if (packedPath) {
      const materialEvidence = this._graphics.material_visibility_if_created?.evidence();
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
        materialEvidence?.residentTextureCount ?? 0
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
        materialEvidence?.residentTextureBytes ?? 0
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
    profiler.recordCounter("gpu.residentBytes", this._graphics.gpu_memory_usage);
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
      Math.floor(this._output_resolution.x * this._internal_resolution_scale),
      1,
      limit
    );
    const height = clampInteger(
      Math.floor(this._output_resolution.y * this._internal_resolution_scale),
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
          1 / this._internal_resolution_scale
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
    this.indicate_view_change();
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
