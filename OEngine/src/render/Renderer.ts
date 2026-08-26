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
import { FrameGraph } from "../framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { MAIN_COMMAND_LABEL, MAIN_FRAME_GRAPH_NAME } from "../framegraph/FrameGraphNotes.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";
import { RenderTargets } from "./RenderTargets.js";
import { GPUViewKey, ViewManager } from "./ViewManager.js";
import { GPUCameraStateManager } from "./GPUCameraState.js";
import { VisibilityPass } from "./passes/VisibilityPass.js";
import { VisibilityCounterPass } from "./passes/VisibilityCounterPass.js";
import { MaterialExpandPass } from "./passes/MaterialExpandPass.js";
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
import { VelocityDebugPass } from "./passes/VelocityDebugPass.js";
import { OcclusionConfidencePass } from "./passes/OcclusionConfidencePass.js";
import { ScreenSpaceAmbientOcclusionPass } from "./passes/ScreenSpaceAmbientOcclusionPass.js";
import { ScreenSpaceReflectionsPass } from "./passes/ScreenSpaceReflectionsPass.js";
import { TemporalAntiAliasingPass } from "./passes/TemporalAntiAliasingPass.js";
import { NeuralSuperSamplingPass } from "./passes/NeuralSuperSamplingPass.js";
import { MotionBlurPass } from "./passes/MotionBlurPass.js";
import { SharpenPass } from "./passes/SharpenPass.js";
import { BloomPass } from "./passes/BloomPass.js";
import { AutomaticExposurePass } from "./passes/AutomaticExposurePass.js";
import {
  TemporalJitterController,
  recommendedTaaJitterSequenceSize
} from "./TemporalJitterController.js";
import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { createNativeTextureView, id } from "../gpu/GPUTextureDescriptors.js";
import { TonemapPass } from "./passes/TonemapPass.js";
import type { FrameGraphContext } from "../framegraph/FrameGraph.js";
import { FrameProfiler } from "../debug/FrameProfiler.js";
import { addGpuListCounterPass } from "../debug/GpuListCounterAccumulator.js";
import { GPU_QUEUE_OVERFLOW_BITS } from "../debug/GpuFrameCounters.js";
import {
  captureGpuAdapterIdentity,
  type BenchmarkAdapterIdentity
} from "../debug/EnvironmentManifest.js";
import type { HierarchicalZBuffer } from "./HierarchicalZBuffer.js";
import { resolveGpuEncoder } from "../framegraph/FrameGraph.js";
import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import type { Scene } from "../scene/Scene.js";
import {
  ShadeIndirectLightingMode,
  type ShadeIndirectLightingMode as ShadeIndirectLightingModeT
} from "./ShadeIndirectLightingMode.js";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "./STATIC_GRAPHICS_ENGINE_ASSETS.js";

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
  private _scenes!: GPUSceneManager;
  private _cameraStates!: GPUCameraStateManager;
  private _meshletDrawList!: MeshletDrawList;
  private _views!: ViewManager;
  private readonly _output_resolution = new Vec2(1, 1);
  private _visibility!: VisibilityPass;
  private _visibilityCounters: VisibilityCounterPass | null = null;
  private _materialExpand!: MaterialExpandPass;
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
  private _velocity!: VelocityPass;
  private _velocityDebug!: VelocityDebugPass;
  private _occlusionConfidence!: OcclusionConfidencePass;
  private _ssao!: ScreenSpaceAmbientOcclusionPass;
  private _ssr!: ScreenSpaceReflectionsPass;
  private _taa!: TemporalAntiAliasingPass;
  private _nss: NeuralSuperSamplingPass | null = null;
  private _motionBlur!: MotionBlurPass;
  private _sharpen!: SharpenPass;
  private _bloom!: BloomPass;
  private _automaticExposure!: AutomaticExposurePass;
  private readonly _taaJitter = new TemporalJitterController();
  private _taaHistory!: [GPUTextureContext, GPUTextureContext];
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
  feature_velocity_debug_view = false;
  fused_indirect = true;
  indirect_lighting_mode: ShadeIndirectLightingModeT = ShadeIndirectLightingMode.IBL;
  upscale_type = 0;
  motion_blur_strength = 1;

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
   * Frame evidence is disabled by default. Benchmarks enable it explicitly and
   * choose a GPU timestamp sampling cadence through `configure()`.
   */
  get profiler(): FrameProfiler {
    return this._profiler;
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
        "float32-blendable"
      ];
      const optionalFeatures: GPUFeatureName[] = [
        "timestamp-query",
        "subgroups",
        "texture-formats-tier1"
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
    const historyDescriptor = id.from({
      label: "",
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
      this._graphics.textures.contextFromDescriptor(new id().copy(historyDescriptor)),
      this._graphics.textures.contextFromDescriptor(new id().copy(historyDescriptor))
    ];
    this._automaticExposure = new AutomaticExposurePass(device);
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
    this._meshletDrawList?.destroy();
    this._nss?.destroy();
    this._nss = null;
    this._scenes?.destroy();
    this._probeRenderers.clear();
    this._profiler.detachGpuDevice(this.device);
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

  update_lpv(scene: Scene): void {
    const gpuScene = this._scenes.obtain(scene);
    const command = ShadeGPUCommandContext.create(this._graphics, "LPV");
    command.recordGraphBuild();
    const graph = new FrameGraph("LPV");
    gpuScene.light_probe_volume.atlas.graph_update({
      graph,
      scene: gpuScene,
      graphics: this._graphics,
      update_ray_count: 100000
    });
    command.encodeGraph(graph);
    command.finish();
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
    const profileFrameIndex = this._frame_count;
    this._profiler.beginFrame(profileFrameIndex);
    try {
    this._renderTargets.setFrameIndex(this._frame_count);
    this.applyPendingRenderResolutionChange();
    if (this._canvasNeedsConfigure) {
      this.configureCanvas();
      this._canvasNeedsConfigure = false;
    }
    this._profiler.measure("graphics-update", () => this._graphics.update());
    if (this.upscale_type === 1) {
      this.nss.frame_count = this._frame_count;
      this.nss.frame_index = this._frame_count;
    } else {
      this._taaJitter.frame_index = this._frame_count;
    }

    const outputWidth = this._output_resolution.x;
    const outputHeight = this._output_resolution.y;
    const w = this._render_resolution.x;
    const h = this._render_resolution.y;
    this.initializeRenderPasses(this.device);
    const debugFrameIndex =
      this._debug_frame_budget > 0 ? this._frame_count : null;
    if (debugFrameIndex !== null) this._debug_frame_budget--;

    if (this.indirect_lighting_mode === ShadeIndirectLightingMode.LPV) {
      this.update_lpv(scene);
    }

    const temporalJitter = this.upscale_type === 1 ? this.nss : this._taaJitter;
    const viewKey = GPUViewKey.from(camera, scene);
    viewKey.label = "check_assertions";
    const view = this.views.obtain(viewKey);
    const gpuScene = view.scene;
    gpuScene.lights.shadow_context.enabled = this.feature_shadows_enabled;
    view.setJitter(temporalJitter.Jitter[0], temporalJitter.Jitter[1]);
    view.setViewportSize(w, h);
    view.setUpscaleRatio(
      outputWidth / w,
      outputHeight / h
    );
    view.gpu_camera_state.setViewportOffset(
      (2 * temporalJitter.Jitter[0]) / w,
      (2 * temporalJitter.Jitter[1]) / h
    );
    this._profiler.measure("world-and-view-update", () => {
      view.update(this._graphics);
    });
    const viewHzb = view.hierarchical_z_buffer;
    viewHzb.resetFrameStatistics();
    const colorView = createNativeTextureView(this.context.getCurrentTexture());

    {
      const cmd = ShadeGPUCommandContext.create(this._graphics, MAIN_COMMAND_LABEL);
      this._profiler.encodeGpuCounterClear(cmd);
      if (
        (debugFrameIndex !== null || this._profiler.shouldSampleGpu()) &&
        this.device.features.has("timestamp-query")
      ) {
        cmd.enable_debug_timers((results) => {
          if (debugFrameIndex !== null) {
            this.onFrameDebug.send2(debugFrameIndex, results);
          }
          this._profiler.recordGpuTimings(profileFrameIndex, results);
        });
      }
      gpuScene.tick(cmd, time_delta_seconds);

      if (this.feature_shadows_enabled) {
        const shadows = gpuScene.lights.shadow_context;
        shadows.select_for_draw(camera, this._frame_count, [w, h]);
        shadows.draw(
          cmd,
          gpuScene,
          gpuScene.lights.database,
          this._meshletDrawList
        );
      }

      // 帧图只描述本帧的资源依赖；实际 GPU 资源会在编译和执行阶段按生命周期分配。
      this._profiler.recordGraphBuild();
      const finishGraphBuild = this._profiler.beginCpuSection("graph-build");
      const graph = new FrameGraph(MAIN_FRAME_GRAPH_NAME);

      const swapId = graph.import_resource(
        "swapchain",
        { kind: "imported", label: "swapchain" },
        colorView
      );

      const sceneDatabaseRes = graph.import_resource(
        "scene_database_buffer",
        { kind: "imported", label: "scene_database" },
        gpuScene.scene_database_buffer
      );

      {
        const rt = this._renderTargets.asImportBundle();
        const meshIdRes = graph.import_resource(
          "texture_viz_mesh",
          { kind: "imported", label: "r32uint mesh id" },
          rt.meshId
        );
        const triIdRes = graph.import_resource(
          "texture_viz_triangle",
          { kind: "imported", label: "r32uint triangle id" },
          rt.triangleId
        );
        const depthRes = graph.import_resource(
          "main_depth",
          { kind: "imported", label: "depth32float" },
          rt.depth
        );
        const previousDepthRes = graph.import_resource(
          "previous_depth",
          { kind: "imported", label: "previous depth32float" },
          this._renderTargets.depthPrevious
        );
        const currentCameraRes = graph.import_resource(
          "camera_current",
          { kind: "imported", label: "packed current camera Td" },
          view.gpu_camera_state.buffer
        );
        const previousCameraRes = graph.import_resource(
          "camera_previous",
          { kind: "imported", label: "packed previous camera Td" },
          view.gpu_previous_camera_state.buffer
        );
        const viewUniformRes = graph.import_resource(
          "view/Yu",
          { kind: "imported", label: "packed view Yu" },
          view.uniform_buffer
        );
        let hzbRes: ResourceId | null = null;
        let gpuCounterRes: ResourceId | null = null;
        if (this._profiler.shouldSampleGpuCounters()) {
          const counterBuffer = this._profiler.gpuCounterBuffer;
          if (counterBuffer === null) {
            throw new Error("GPU counter sampling has no counter buffer");
          }
          gpuCounterRes = graph.import_resource(
            "r0_gpu_frame_counters",
            { kind: "imported", label: "R0 GPU frame counters" },
            counterBuffer
          );
        }

        {
          const prevHzbView = viewHzb.obtainFullView();
          gpuCounterRes = this._visibility.addToGraph(
            graph,
            {
              camera,
              gpuCameraBuffer: view.gpu_camera_state.buffer,
              gpuPreviousCameraBuffer:
                view.gpu_previous_camera_state.buffer,
              gpuViewBuffer: view.uniform_buffer,
              scene,
              targets: this._renderTargets,
              meshCount: gpuScene.mesh_count,
              meshlets: gpuScene.meshlets,
              drawList: this._meshletDrawList,
              meshTable: gpuScene.meshSlice,
              transformTable: gpuScene.transformSlice,
              sceneDatabase: gpuScene.scene_database,
              materialMetadata: gpuScene.material_metadata,
              enableFrustumCull: true,
              hzbView: prevHzbView,
              viewportWidth: w,
              viewportHeight: h,
              enableHzbCull: true,
              enableInstanceCull: true,
              clearTargets: true,
              secondChance: false
            },
            {
              meshId: meshIdRes,
              triangleId: triIdRes,
              depth: depthRes,
              counters: gpuCounterRes ?? undefined
            },
            "Visibility"
          ) ?? gpuCounterRes;
        }

        {
          const hzb = viewHzb;
          const depthTex = this._renderTargets.depth;
          const hzbBuilder = graph.add(
            "graph_rasterize_triangle_closest",
            { depthTex, hzb },
            (data, _res, ctx: FrameGraphContext) => {
              const enc = resolveGpuEncoder(ctx);
              if (!enc || !data.depthTex) return;
              data.hzb.build(enc, data.depthTex);
            }
          );
          hzbBuilder.read(depthRes);
          hzbBuilder.make_side_effect();
          hzbRes = graph.import_resource(
            "hzb",
            { kind: "imported", label: "hierarchical_z rg16float" },
            viewHzb.getTexture()
          );
        }

        {
          const sameFrameHzbView = viewHzb.obtainFullView();
          if (sameFrameHzbView) {
            gpuCounterRes = this._visibility.addToGraph(
              graph,
              {
                camera,
                gpuCameraBuffer: view.gpu_camera_state.buffer,
                gpuPreviousCameraBuffer:
                  view.gpu_previous_camera_state.buffer,
                gpuViewBuffer: view.uniform_buffer,
                scene,
                targets: this._renderTargets,
                meshCount: gpuScene.mesh_count,
                meshlets: gpuScene.meshlets,
                drawList: this._meshletDrawList,
                meshTable: gpuScene.meshSlice,
                transformTable: gpuScene.transformSlice,
                sceneDatabase: gpuScene.scene_database,
                materialMetadata: gpuScene.material_metadata,
                enableFrustumCull: false,
                hzbView: sameFrameHzbView,
                viewportWidth: w,
                viewportHeight: h,
                enableHzbCull: true,
                enableInstanceCull: true,
                clearTargets: false,
                secondChance: true
              },
              {
                meshId: meshIdRes,
                triangleId: triIdRes,
                depth: depthRes,
                counters: gpuCounterRes ?? undefined
              },
              "Visibility/second-chance"
            ) ?? gpuCounterRes;

            const hzb2 = viewHzb;
            const depthTex2 = this._renderTargets.depth;
            const hzb2Builder = graph.add(
              "graph_rasterize_triangle_closest/second",
              { depthTex: depthTex2, hzb: hzb2 },
              (data, _res, ctx: FrameGraphContext) => {
                const enc = resolveGpuEncoder(ctx);
                if (!enc || !data.depthTex) return;
                data.hzb.build(enc, data.depthTex);
              }
            );
            hzb2Builder.read(depthRes);
            hzb2Builder.make_side_effect();
          }
        }

        const hasAlphaTested =
          this._visibility.hasAlphaTestedMaterials(scene);
        if (hasAlphaTested) {
          const alphaHzbView = viewHzb.obtainFullView();
          gpuCounterRes = this._visibility.addToGraph(
            graph,
            {
              camera,
              gpuCameraBuffer: view.gpu_camera_state.buffer,
              gpuPreviousCameraBuffer:
                view.gpu_previous_camera_state.buffer,
              gpuViewBuffer: view.uniform_buffer,
              scene,
              targets: this._renderTargets,
              meshCount: gpuScene.mesh_count,
              meshlets: gpuScene.meshlets,
              drawList: this._meshletDrawList,
              meshTable: gpuScene.meshSlice,
              transformTable: gpuScene.transformSlice,
              sceneDatabase: gpuScene.scene_database,
              materialMetadata: gpuScene.material_metadata,
              materialRegistry: gpuScene.materials ?? this._graphics.materials,
              enableFrustumCull: true,
              hzbView: alphaHzbView,
              viewportWidth: w,
              viewportHeight: h,
              enableHzbCull: true,
              enableInstanceCull: true,
              clearTargets: false,
              secondChance: false,
              alphaTestedPass: true
            },
            {
              meshId: meshIdRes,
              triangleId: triIdRes,
              depth: depthRes,
              counters: gpuCounterRes ?? undefined
            },
            "Visibility/alpha-tested"
          ) ?? gpuCounterRes;

          {
            const hzbA = viewHzb;
            const depthTexA = this._renderTargets.depth;
            const hzbABuilder = graph.add(
              "graph_rasterize_triangle_closest/alpha",
              { depthTex: depthTexA, hzb: hzbA },
              (data, _res, ctx: FrameGraphContext) => {
                const enc = resolveGpuEncoder(ctx);
                if (!enc || !data.depthTex) return;
                data.hzb.build(enc, data.depthTex);
              }
            );
            hzbABuilder.read(depthRes);
            hzbABuilder.make_side_effect();
          }
        }

        if (gpuCounterRes !== null) {
          this._visibilityCounters ??= new VisibilityCounterPass();
          gpuCounterRes = this._visibilityCounters.addToGraph(
            graph,
            { width: w, height: h },
            { meshId: meshIdRes, counters: gpuCounterRes }
          );
          this._profiler.registerGpuCounterFields([
            "visibleInstances",
            "candidateClusters",
            "selectedClusters",
            "hwClusters",
            "alphaClusters",
            "hwTriangles",
            "shadedPixels",
            "emptyVisibilityPixels",
            "queueOverflowMask"
          ]);
        }

        const geometryMetaRes = graph.import_resource(
          "geometries/Jg",
          { kind: "imported", label: "geometry metadata Jg" },
          gpuScene.meshlets.meshMetaBuffer
        );
        const meshletHeadersRes = graph.import_resource(
          "meshlets/ki",
          { kind: "imported", label: "meshlet headers ki" },
          gpuScene.meshlets.headerBuffer
        );
        const meshletDataRes = graph.import_resource(
          "meshlets/data",
          { kind: "imported", label: "meshlet data" },
          gpuScene.meshlets.dataBuffer
        );

        const matOut = this._materialExpand.addToGraph(
          graph,
          {
            scene,
            materials: gpuScene.materials,
            width: w,
            height: h
          },
          {
            meshId: meshIdRes,
            triangleId: triIdRes,
            sceneDatabase: sceneDatabaseRes,
            geometries: geometryMetaRes,
            meshletHeaders: meshletHeadersRes,
            meshletData: meshletDataRes,
            view: viewUniformRes,
            camera: currentCameraRes
          }
        );
        let gPbrRes = matOut.gPbr;
        let gNormalRes = matOut.gNormal;
        let gAlbedoRes = matOut.gAlbedo;
        const gEmissiveRes = matOut.gEmissive;

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
                previousOffsetsBuffer
              )
            : null;
          const previousPositionsRes = previousPositionsBuffer
            ? graph.import_resource(
                "velocity/previous positions",
                { kind: "imported", label: "previous positions" },
                previousPositionsBuffer
              )
            : null;
          velocityRes = this._velocity!.addToGraph(
            graph,
            {
              width: w,
              height: h,
              currentCamera: view.gpu_camera_state.camera,
              previousCamera: view.gpu_previous_camera_state.camera
            },
            {
              depth: depthRes,
              meshId: meshIdRes,
              triangleId: triIdRes,
              sceneDatabase: sceneDatabaseRes,
              meshletHeaders: meshletHeadersRes,
              meshletData: meshletDataRes,
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
            gpuScene.lights.buffer_data
          );
          environmentRes = graph.import_resource(
            "Ch/sec_radix_passes",
            { kind: "imported", label: "rgba16float environment" },
            gpuScene.lights.environment.gpu_texture
          );
          shadowAtlasRes = graph.import_resource(
            "Ch/pass_descriptor",
            { kind: "imported", label: "depth32float shadow atlas" },
            gpuScene.lights.shadow_context.texture.gpu_texture
          );
          clusters = this._lightCluster.addToGraph(
            graph,
            {
              camera,
              lights: gpuScene.lights,
              width: w,
              height: h
            },
            {
              camera: currentCameraRes,
              lightDatabase: lightDatabaseRes,
              hzb: hzbRes
            }
          );
          if (gpuCounterRes !== null) {
            gpuCounterRes = addGpuListCounterPass(
              graph,
              clusters.candidateLightList,
              gpuCounterRes,
              {
                overflowBit: GPU_QUEUE_OVERFLOW_BITS.lightList,
                headerBytes: Uint32Array.BYTES_PER_ELEMENT,
                elementBytes: Uint32Array.BYTES_PER_ELEMENT
              }
            );
            gpuCounterRes = addGpuListCounterPass(
              graph,
              clusters.activeLightList,
              gpuCounterRes,
              {
                primary: "activeLights",
                overflowBit: GPU_QUEUE_OVERFLOW_BITS.lightList,
                headerBytes: Uint32Array.BYTES_PER_ELEMENT,
                elementBytes: Uint32Array.BYTES_PER_ELEMENT
              }
            );
            this._profiler.registerGpuCounterFields(["activeLights"]);
          }
          const lightOut = this._lighting.addToGraph(
            graph,
            {
              width: w,
              height: h
            },
            {
              gPbr: gPbrRes,
              gNormal: gNormalRes,
              gAlbedo: gAlbedoRes,
              gEmissive: gEmissiveRes,
              depth: depthRes,
              lightDatabase: lightDatabaseRes,
              environment: environmentRes,
              clusterParameters: clusters.parameters,
              clusterLookup: clusters.lookup,
              clusterData: clusters.data,
              shadowAtlas: shadowAtlasRes,
              camera: currentCameraRes,
              view: viewUniformRes
            }
          );
          hdrRes = lightOut.hdr;
        }

        let bentNormalRes = gNormalRes;
        let ssaoReady = !this.feature_ssao_enabled;
        if (
          this.feature_ssao_enabled &&
          velocityRes !== null &&
          occlusionConfidenceRes !== null &&
          gNormalRes !== null &&
          gAlbedoRes !== null
        ) {
          const ssao = this._ssao!.addToGraph(
            graph,
            {
              samplers: this._graphics.samplers,
              frameIndex: this._frame_count,
              width: w,
              height: h
            },
            {
              depth: depthRes,
              normal: gNormalRes,
              velocity: velocityRes,
              occlusionConfidence: occlusionConfidenceRes,
              albedoAo: gAlbedoRes,
              camera: currentCameraRes
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
          if (this.feature_ssr_enabled) {
            const blueNoise = this._graphics.textures.obtain(
              STATIC_GRAPHICS_ENGINE_ASSETS.stbn_vec2
            );
            const blueNoiseRes = graph.import_resource(
              "SSR/stbn_vec2",
              { kind: "imported", label: "STBN vec2 3D" },
              blueNoise.gpu_texture
            );
            indirectSpecularRes = this._ssr.addToGraph(
              graph,
              {
                width: w,
                height: h,
                frameIndex: this._frame_count,
                samplers: this._graphics.samplers
              },
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
            gpuScene.volumetric_light_map.buffer
          );
          const base = {
            depth: depthRes,
            stbn: stbnRes,
            view: viewUniformRes,
            camera: currentCameraRes,
            lightMap: lightMapRes
          };
          if (this.fused_indirect && !this.feature_ssr_enabled) {
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
            gpuScene.light_probe_volume.atlas.texture_radiance.texture
          );
          const atlasDepthRes = graph.import_resource(
            "LPV/depth atlas",
            { kind: "imported", label: "rg16float LPV depth atlas" },
            gpuScene.light_probe_volume.atlas.texture_depth.texture
          );
          const lpvMeshBvhRes = graph.import_resource(
            "LPV/tetra BVH",
            { kind: "imported", label: "LPV tetra BVH" },
            gpuScene.light_probe_volume.buffer_mesh_bvh
          );
          const lpvMetadataRes = graph.import_resource(
            "LPV/metadata",
            { kind: "imported", label: "LPV metadata" },
            gpuScene.light_probe_volume.buffer_metadata
          );
          const lpvTetraRes = graph.import_resource(
            "LPV/tetrahedra",
            { kind: "imported", label: "LPV tetrahedra" },
            gpuScene.light_probe_volume.buffer_mesh
          );
          const lpvProbesRes = graph.import_resource(
            "LPV/probes",
            { kind: "imported", label: "LPV probes" },
            gpuScene.light_probe_volume.buffer_probes
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
            this.feature_ssr_enabled &&
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
              {
                width: w,
                height: h,
                frameIndex: this._frame_count,
                samplers: this._graphics.samplers
              },
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
            {
              camera,
              samplers: this._graphics.samplers,
              width: w,
              height: h
            },
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
                  gpuScene.volumetric_light_map.buffer
                )
              : undefined;
          hdrRes = this._transparentOit.addToGraph(
            graph,
            {
              width: w,
              height: h,
              scene,
              materials: gpuScene.materials,
              drawList: this._meshletDrawList,
              indirectLightingMode: this.indirect_lighting_mode
            },
            {
              hdr: hdrRes,
              depth: depthRes,
              hzb: hzbRes,
              camera: currentCameraRes,
              view: viewUniformRes,
              sceneDatabase: sceneDatabaseRes,
              geometryMetadata: geometryMetaRes,
              meshletHeaders: meshletHeadersRes,
              meshletData: meshletDataRes,
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
          this.feature_velocity_debug_view &&
          velocityRes !== null &&
          gAlbedoRes !== null
        ) {
          hdrRes = this._velocityDebug.addToGraph(
            graph,
            velocityRes,
            gAlbedoRes,
            w,
            h
          );
        }

        if (
          this.feature_taa_enabled &&
          hdrRes !== null &&
          velocityRes !== null &&
          occlusionConfidenceRes !== null
        ) {
          const historyInput = this._taaHistory[this._frame_count % 2]!;
          const historyOutput = this._taaHistory[(this._frame_count + 1) % 2]!;
          historyInput.resize(this._output_resolution.x, this._output_resolution.y);
          historyOutput.resize(this._output_resolution.x, this._output_resolution.y);
          const historyInputRes = graph.import_resource(
            "taa_history",
            { kind: "imported", label: "TAA history input rgba16float" },
            historyInput.gpu_texture
          );
          const historyOutputRes = graph.import_resource(
            "taa_output",
            { kind: "imported", label: "TAA history output rgba16float" },
            historyOutput.gpu_texture
          );
          if (this.upscale_type === 1) {
            hdrRes = this.nss.addToGraph(
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
              }
            );
          } else {
            const historyValidity = this._taaJitter.reset_history ? 0 : 1;
            this._taaJitter.reset_history = false;
            hdrRes = this._taa.addToGraph(
              graph,
              {
                jitter: this._taaJitter.Jitter,
                historyValidity,
                samplers: this._graphics.samplers
              },
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
          this.feature_motion_blur_enabled &&
          hdrRes !== null &&
          velocityRes !== null
        ) {
          hdrRes = this._motionBlur.addToGraph(
            graph,
            {
              width: this._output_resolution.x,
              height: this._output_resolution.y,
              strength: this.motion_blur_strength
            },
            {
              color: hdrRes,
              velocity: velocityRes,
              depth: depthRes
            }
          );
        }

        if (this.feature_sharpening_enabled && hdrRes !== null) {
          hdrRes = this._sharpen.addToGraph(
            graph,
            hdrRes,
            this._output_resolution.x,
            this._output_resolution.y,
            0.8
          );
        }

        let exposureRes: ResourceId | null = null;
        if (
          hdrRes !== null &&
          (this.feature_bloom_enabled || this.feature_automatic_exposure_enabled)
        ) {
          const bloom = this._bloom.addToGraph(graph, hdrRes, {
            width: this._output_resolution.x,
            height: this._output_resolution.y,
            intensity: 1,
            mipCount: 5,
            samplers: this._graphics.samplers
          });
          if (this.feature_bloom_enabled) hdrRes = bloom.composited;
          if (this.feature_automatic_exposure_enabled) {
            exposureRes = this._automaticExposure.update(
              graph,
              bloom.downsampled,
              time_delta_seconds
            );
          }
        }
        if (!this.feature_automatic_exposure_enabled) {
          exposureRes = this._automaticExposure.unadapted(graph);
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
      cmd.encodeGraph(graph);
      view.finish_frame(cmd);
      this.recordLegacyFrameCounters(viewHzb);
      this._profiler.encodeGpuCounterReadback(cmd);
      cmd.finish();
    }

    this._frame_count++;
    this.onFrameFinished.send1(this._frame_count);
    return true;
    } finally {
      this._profiler.endFrame();
    }
  }

  private initializeRenderPasses(device: GPUDevice): void {
    if (!this._visibility) {
      this._visibility = new VisibilityPass(this._graphics);
      this._visibility.init();
    }
    if (!this._materialExpand) {
      this._materialExpand = new MaterialExpandPass(
        this._graphics,
        this._graphics.materials
      );
      this._materialExpand.init();
    }
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
    this._velocity ??= new VelocityPass(this._graphics);
    this._velocityDebug ??= new VelocityDebugPass(this._graphics);
    this._occlusionConfidence ??= new OcclusionConfidencePass(this._graphics);
    this._ssao ??= new ScreenSpaceAmbientOcclusionPass(this._graphics);
    this._ssr ??= new ScreenSpaceReflectionsPass(this._graphics);
    this._taa ??= new TemporalAntiAliasingPass(this._graphics);
    this._motionBlur ??= new MotionBlurPass(this._graphics);
    this._sharpen ??= new SharpenPass(this._graphics);
    this._bloom ??= new BloomPass(this._graphics);
    this._automaticExposure ??= new AutomaticExposurePass(device);
    if (!this._tonemap) {
      this._tonemap = new TonemapPass(device, this._format);
      this._tonemap.hdrEnabled = this._highDynamicRange;
      this._tonemap.peakNits = this._peakNits;
      this._tonemap.init();
    }
  }

  private recordLegacyFrameCounters(hzb: HierarchicalZBuffer): void {
    const profiler = this._profiler;
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
    profiler.recordCounter("legacy.visibility.drawCount", visibility.lastDrawCount);
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
    profiler.recordCounter("legacy.hzb.builds", hzb.lastBuildCount);
    profiler.recordCounter("legacy.hzb.mips", hzb.lastMipCount);
    profiler.recordCounter("legacy.hzb.mipPasses", hzb.lastMipPassCount);
    profiler.recordCounter(
      "legacy.material.fullscreenDraws",
      this._materialExpand.lastDrawCount
    );
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
    this._taaHistory.forEach((history) => {
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

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
