import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  PointLight,
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  Renderer,
  Scene,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_environment_map,
  load_gltf_packed,
  type GeometryAssetPackage,
  type PackedGltfSource,
  type RenderDebugViewName
} from "../../OEngine/src/index.ts";
import {
  SHOWCASE_GPU_DOMAINS,
  ShowcaseEvidenceWindow
} from "./evidence.js";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];
declare const __BUILD_CONTENT_HASH__: string;

declare global {
  interface Window {
    __OENGINE_Q00_SET_STATE__?: (state: Q00CaptureState) => void;
    __OENGINE_Q00_SNAPSHOT__?: () => unknown;
    __OENGINE_Q00_FRAME__?: () => number;
  }
}

type Q00CaptureState = {
  readonly features?: Partial<Record<
    "shadows" | "ssao" | "ssr" | "taa" | "bloom" | "exposure" | "sharpen" | "lights",
    boolean
  >>;
  readonly debugView?: RenderDebugViewName;
  readonly resetCamera?: boolean;
  readonly cameraPreset?: "overview" | "street" | "road" | "contact";
  readonly cameraPose?: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
  };
  readonly captureClean?: boolean;
};

type Bounds = {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly center: [number, number, number];
  readonly radius: number;
};

type DebugDescriptor = {
  readonly value: RenderDebugViewName;
  readonly label: string;
  readonly help: string;
  readonly requires?: "ssao" | "ssr";
};

const MODEL_URL = new URL("../public/cyberpunk_city.glb", import.meta.url).href;
const ENVIRONMENT_URL = new URL("./assets/venice_sunset_1k.hdr", import.meta.url).href;
const MODEL_WORLD_SCALE = 10;

const debugDescriptors: readonly DebugDescriptor[] = [
  { value: RenderDebugView.None, label: "最终画面", help: "曝光、色调映射与后处理后的最终输出。" },
  { value: RenderDebugView.VisibilityKey, label: "可见性键", help: "Packed Instance、Cluster、Meshlet 与材质标识。" },
  { value: RenderDebugView.Depth, label: "反向 Z 深度", help: "近处更亮，未覆盖背景为黑色。" },
  { value: RenderDebugView.BaseColor, label: "基础色", help: "线性空间的材质基础色通道。" },
  { value: RenderDebugView.ShadingNormal, label: "着色法线", help: "解码后的世界空间表面法线。" },
  { value: RenderDebugView.Roughness, label: "粗糙度", help: "材质感知粗糙度。" },
  { value: RenderDebugView.Metallic, label: "金属度", help: "材质金属响应。" },
  { value: RenderDebugView.Occlusion, label: "材质遮蔽", help: "材质纹理提供的环境遮蔽。" },
  { value: RenderDebugView.AmbientOcclusionRaw, label: "GTAO 原始", help: "未进行空间与时域滤波的 GTAO visibility。", requires: "ssao" },
  { value: RenderDebugView.AmbientOcclusionDenoised, label: "GTAO 空间滤波", help: "空间滤波后的 GTAO visibility。", requires: "ssao" },
  { value: RenderDebugView.AmbientOcclusionTemporal, label: "环境光遮蔽", help: "时域 GTAO 最终可见度。", requires: "ssao" },
  { value: RenderDebugView.Emissive, label: "自发光", help: "从 GLB 材质解码的自发光贡献。" },
  { value: RenderDebugView.Velocity, label: "运动矢量", help: "屏幕空间运动方向和幅度。" },
  { value: RenderDebugView.HistoryValidity, label: "历史有效性", help: "时域运动有效与反应状态。" },
  { value: RenderDebugView.Reactive, label: "反应遮罩", help: "拒绝使用时域历史的像素。" },
  { value: RenderDebugView.IndirectDiffuse, label: "漫反射 IBL", help: "余弦卷积后的环境漫反射照明。" },
  { value: RenderDebugView.IndirectSpecular, label: "镜面 IBL", help: "GGX 预过滤环境反射。" },
  { value: RenderDebugView.ScreenSpaceReflectionHitMiss, label: "SSR 命中 / 未命中", help: "屏幕空间反射命中置信度。", requires: "ssr" },
  { value: RenderDebugView.ScreenSpaceReflectionResolve, label: "SSR Resolve", help: "空间 resolve、进入时域累计前的反射辐射。", requires: "ssr" },
  { value: RenderDebugView.ScreenSpaceReflectionTemporal, label: "SSR Temporal", help: "时域累计后、最终空间滤波前的反射辐射。", requires: "ssr" },
  { value: RenderDebugView.ScreenSpaceReflectionHistoryConfidence, label: "SSR 历史", help: "反射时域历史置信度。", requires: "ssr" },
  { value: RenderDebugView.LinearHdr, label: "线性 HDR", help: "曝光和色调映射之前的场景线性颜色。" }
];

const root = required<HTMLElement>("showcase");
const canvas = required<HTMLCanvasElement>("gpu-canvas");
const loadingDetail = required<HTMLElement>("loading-detail");
const loadingProgress = required<HTMLElement>("loading-progress");
const loadingStage = required<HTMLElement>("loading-stage");
const fieldset = required<HTMLFieldSetElement>("control-fieldset");
const readyPill = required<HTMLElement>("ready-pill");
const debugView = required<HTMLSelectElement>("debug-view");
const debugHelp = required<HTMLElement>("debug-help");
const lodThreshold = required<HTMLInputElement>("lod-threshold");
const lodValue = required<HTMLOutputElement>("lod-value");
const panelToggle = required<HTMLButtonElement>("panel-toggle");
const metricFps = required<HTMLElement>("metric-fps");
const metricInstances = required<HTMLElement>("metric-instances");
const metricGeometries = required<HTMLElement>("metric-geometries");
const evidenceSamples = required<HTMLElement>("evidence-samples");
const evidenceGpuP50 = required<HTMLElement>("evidence-gpu-p50");
const evidenceGpuTail = required<HTMLElement>("evidence-gpu-tail");
const evidencePasses = required<HTMLElement>("evidence-passes");
const evidenceCommands = required<HTMLElement>("evidence-commands");
const evidenceDomains = required<HTMLElement>("evidence-domains");
const evidenceResolution = required<HTMLElement>("evidence-resolution");
const evidenceAo = required<HTMLElement>("evidence-ao");
const evidenceSsr = required<HTMLElement>("evidence-ssr");
const evidenceSystem = required<HTMLElement>("evidence-system");

let renderer: Renderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controller: OrbitControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest = 0;
let disposed = false;
let sceneBounds: Bounds | null = null;
let animatedLights = true;
let pointLights: PointLight[] = [];
let sunLight: DirectionalLight | null = null;
let lightAnimationSpeed = 1;
let framesSinceSample = 0;
let lastFpsSample = performance.now();
const evidenceWindow = new ShowcaseEvidenceWindow(1024);
let unsubscribeProfiler: (() => void) | null = null;

populateDebugViews();
bindPanelShell();
void initialize().catch(showFatalError);

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU is unavailable. Open this example in a current WebGPU-capable desktop browser.");
  }
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Unable to create a WebGPU canvas context.");

  setLoading("正在初始化 WebGPU 渲染器…", "渲染器初始化", 0.04);
  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({
    context,
    pixelRatio: Math.min(window.devicePixelRatio, 1.5)
  });
  activeRenderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: 8,
    gpuCounterSampleInterval: 11,
    historyCapacity: 2048,
    readbackRingSlots: 3
  });
  unsubscribeProfiler = activeRenderer.profiler.subscribe((snapshot) => {
    evidenceWindow.update(snapshot);
  });
  configurePipeline(activeRenderer);
  if (disposed) return;

  setLoading(
    "正在加载 146.9 MB GLB 与 HDR 环境贴图…",
    "资产导入",
    0.1
  );
  const [imported, environment] = await Promise.all([
    load_gltf_packed(MODEL_URL),
    load_environment_map(ENVIRONMENT_URL)
  ]);
  if (disposed) return;

  const sourceBounds = computeWorldBounds(imported);
  const showcaseTransforms = scalePackedTransforms(
    imported.transforms,
    MODEL_WORLD_SCALE,
    sourceBounds.center
  );
  sceneBounds = computeWorldBounds(imported, showcaseTransforms);
  metricInstances.textContent = formatInteger(imported.geometryIndices.length);
  metricGeometries.textContent = formatInteger(imported.geometries.length);

  const packages = await cookGeometries(imported.geometries);
  if (disposed) return;

  const activeScene = new Scene();
  scene = activeScene;
  activeScene.lights.environment = environment;
  addShowcaseLights(activeScene, sceneBounds);

  setLoading(
    `正在上传 ${packages.length} 个几何包和 ${imported.materials.length} 个材质…`,
    "GPU 驻留",
    0.88
  );
  await activeRenderer.uploadPackedScene(activeScene, {
    geometries: packages,
    materials: imported.materials,
    count: imported.geometryIndices.length,
    geometryIndices: imported.geometryIndices,
    materialIndices: imported.materialIndices,
    currentTransforms: showcaseTransforms,
    previousTransforms: showcaseTransforms.slice(),
    boundsSpheres: imported.boundsSpheres,
    boundsMin: imported.boundsMin,
    boundsMax: imported.boundsMax,
    flags: imported.flags,
    debugIds: imported.debugIds
  });
  if (disposed) return;

  const activeCamera = createCamera(activeRenderer, sceneBounds);
  camera = activeCamera;
  controller = new OrbitControls(activeCamera, canvas);
  resetCamera();
  bindRendererControls(activeRenderer);
  installQ00Api(activeRenderer);
  startResizeObserver(activeRenderer, activeCamera);

  readyPill.textContent = "运行中";
  fieldset.disabled = false;
  root.dataset.state = "ready";
  root.dataset.debugView = RenderDebugView.None;
  setLoading("准备完成", "正在渲染", 1);
  startFrameLoop();
}

function installQ00Api(activeRenderer: Renderer): void {
  window.__OENGINE_Q00_SET_STATE__ = (state) => {
    for (const [feature, enabled] of Object.entries(state.features ?? {})) {
      const checkbox = document.querySelector<HTMLInputElement>(`input[data-feature="${feature}"]`);
      if (checkbox === null || enabled === undefined) continue;
      checkbox.checked = enabled;
      checkbox.dispatchEvent(new Event("change"));
    }
    if (state.debugView !== undefined) {
      debugView.value = state.debugView;
      debugView.dispatchEvent(new Event("change"));
    }
    if (state.cameraPreset !== undefined) applyCameraPreset(state.cameraPreset);
    if (state.cameraPose !== undefined) {
      setCameraPose(state.cameraPose.position, state.cameraPose.target);
    }
    if (state.resetCamera === true) resetCamera();
    if (state.captureClean !== undefined) {
      root.classList.toggle("q00-capture-clean", state.captureClean);
    }
    activeRenderer.indicate_view_change();
  };
  window.__OENGINE_Q00_SNAPSHOT__ = () => {
    const profile = evidenceWindow.summarize();
    const activeCamera = camera;
    return {
      schemaVersion: 1,
      taskId: "R5-Q00",
      capturedAt: new Date().toISOString(),
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: [...__BUILD_DIRTY_REASONS__],
        contentHash: __BUILD_CONTENT_HASH__
      },
      environment: {
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        rendererPixelRatio: activeRenderer.pixel_ratio,
        adapter: activeRenderer.adapter_info
      },
      camera: activeCamera === null ? null : {
        position: [
          activeCamera.transform.position.x,
          activeCamera.transform.position.y,
          activeCamera.transform.position.z
        ],
        near: activeCamera.near,
        far: activeCamera.far,
        aspect: activeCamera.aspect
      },
      sceneBounds,
      settings: {
        shadows: activeRenderer.render_settings.features.shadows,
        ssao: activeRenderer.render_settings.features.ambientOcclusion,
        ssaoResolutionScale: activeRenderer.render_settings.ao.resolutionScale,
        ssaoTemporal: activeRenderer.render_settings.ao.temporalEnabled,
        ssr: activeRenderer.render_settings.features.screenSpaceReflections,
        taa: activeRenderer.render_settings.features.temporalAntiAliasing,
        bloom: activeRenderer.render_settings.features.bloom,
        automaticExposure: activeRenderer.render_settings.features.automaticExposure,
        sharpening: activeRenderer.render_settings.features.sharpening,
        internalResolutionScale: activeRenderer.internal_resolution_scale,
        debugView: activeRenderer.render_debug_view
      },
      temporal: activeRenderer.temporalEvidence(),
      ao: activeRenderer.ambientOcclusionEvidence(),
      ssr: activeRenderer.screenSpaceReflectionsEvidence(),
      memory: activeRenderer.memoryEvidence(),
      graph: activeRenderer.mainFrameGraphEvidence(),
      diagnostics: activeRenderer.profiler.diagnostics,
      summary: {
        timestampSampleCount: profile.timestampSampleCount,
        gpuTotal: profile.gpuTotal,
        gpuDomains: Object.fromEntries(profile.gpuDomains),
        latestCommands: profile.latestCommands,
        latestSubmitCount: profile.latestSubmitCount,
        latestGpuCounters: profile.latestGpuCounters,
        latestTimestampFrame: profile.latestTimestampFrame,
        latestCounterFrame: profile.latestCounterFrame
      },
      frames: activeRenderer.profiler.history.slice(-2048)
    };
  };
  window.__OENGINE_Q00_FRAME__ = () => activeRenderer.frame_count;
}

function configurePipeline(activeRenderer: Renderer): void {
  activeRenderer.configure({
    features: {
      shadows: true, ambientOcclusion: true, screenSpaceReflections: false,
      temporalAntiAliasing: true, bloom: true, automaticExposure: true,
      motionBlur: false, sharpening: true
    },
    ao: { resolutionScale: 0.5, temporalEnabled: true }
  });
  activeRenderer.internal_resolution_scale = 1;
  activeRenderer.packed_visibility_sse_threshold = 4;
  activeRenderer.packed_visibility_cone_enabled = true;
  activeRenderer.packed_visibility_hzb_enabled = true;
  activeRenderer.render_debug_view = RenderDebugView.None;
}

async function cookGeometries(
  sources: PackedGltfSource["geometries"]
): Promise<readonly GeometryAssetPackage[]> {
  const recipe = createGeometryCookRecipe();
  const packages: GeometryAssetPackage[] = [];
  for (let index = 0; index < sources.length; index++) {
    const ordinal = index + 1;
    setLoading(
      `正在构建 Meshlet 与可渲染 LOD 层级 ${ordinal}/${sources.length}…`,
      "几何处理",
      0.18 + index / Math.max(1, sources.length) * 0.66
    );
    packages.push((await cookGeometryAssetPackage(sources[index]!, recipe)).asset);
    if (ordinal % 3 === 0) await nextFrame();
  }
  return Object.freeze(packages);
}

function addShowcaseLights(activeScene: Scene, bounds: Bounds): void {
  const sun = new DirectionalLight();
  sunLight = sun;
  sun.intensity = 2.8;
  sun.forward = [0.38, -1, -0.28];
  sun.casts_shadow = true;
  activeScene.addChild(sun);

  const colors = [
    [1, 0.12, 0.06],
    [0.08, 0.42, 1],
    [0.72, 0.08, 1],
    [0.08, 1, 0.7]
  ] as const;
  pointLights = colors.map((color, index) => {
    const light = new PointLight();
    const angle = index / colors.length * Math.PI * 2;
    light.color.set(color[0], color[1], color[2]);
    light.intensity = 40;
    light.distance = Math.max(4, bounds.radius * 0.75);
    light.radius = Math.max(0.05, bounds.radius * 0.005);
    light.casts_shadow = false;
    light.position = [
      bounds.center[0] + Math.cos(angle) * bounds.radius * 0.38,
      bounds.center[1] + bounds.radius * 0.08,
      bounds.center[2] + Math.sin(angle) * bounds.radius * 0.38
    ];
    light.updateMatrices();
    activeScene.addChild(light);
    return light;
  });
}

function createCamera(activeRenderer: Renderer, bounds: Bounds): PerspectiveCamera {
  const activeCamera = new PerspectiveCamera();
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.near = Math.max(0.01, bounds.radius / 5000);
  activeCamera.far = Math.max(100, bounds.radius * 24);
  activeCamera.update();
  return activeCamera;
}

function resetCamera(): void {
  if (camera === null || sceneBounds === null) return;
  const { center, radius } = sceneBounds;
  camera.transform.position.set(
    center[0] + radius * 1.15,
    center[1] + radius * 0.72,
    center[2] + radius * 1.35
  );
  camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
  camera.update();
  if (controller !== null) {
    controller.look(camera.transform.position, {
      x: center[0],
      y: center[1],
      z: center[2]
    });
    controller.distanceLimits.min = Math.max(0.1, radius * 0.025);
    controller.distanceLimits.max = radius * 8;
    controller.movement_speed_scale = Math.max(0.5, radius * 0.12);
  }
  renderer?.indicate_view_change();
}

function applyCameraPreset(preset: "overview" | "street" | "road" | "contact"): void {
  if (sceneBounds === null) return;
  if (preset === "overview") {
    resetCamera();
    return;
  }
  const { center, radius } = sceneBounds;
  const offset = preset === "street"
    ? { position: [0.34, 0.09, 0.46], target: [0.0, -0.20, -0.02] }
    : preset === "road"
      ? { position: [0.25, 0.02, 0.34], target: [0.0, -0.27, -0.04] }
      : { position: [0.20, 0.0, 0.30], target: [-0.02, -0.27, -0.06] };
  setCameraPose(
    [
      center[0] + offset.position[0] * radius,
      center[1] + offset.position[1] * radius,
      center[2] + offset.position[2] * radius
    ],
    [
      center[0] + offset.target[0] * radius,
      center[1] + offset.target[1] * radius,
      center[2] + offset.target[2] * radius
    ]
  );
}

function setCameraPose(
  position: readonly [number, number, number],
  target: readonly [number, number, number]
): void {
  if (camera === null) return;
  camera.transform.position.set(position[0], position[1], position[2]);
  camera.transform.lookAt({ x: target[0], y: target[1], z: target[2] });
  camera.update();
  controller?.look(camera.transform.position, {
    x: target[0],
    y: target[1],
    z: target[2]
  });
  renderer?.indicate_view_change();
}

function startResizeObserver(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  const resize = (): void => {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    activeRenderer.resize(width, height);
    activeCamera.aspect = activeRenderer.aspect_ratio;
    activeCamera.update();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
}

function startFrameLoop(): void {
  let previousTime = performance.now();
  const frame = (now: number): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    if (!document.hidden) {
      controller?.update();
      animateLights(scene, now * 0.001);
      camera.aspect = renderer.aspect_ratio;
      camera.update();
      if (!renderer.render(camera, scene, deltaSeconds)) {
        showFatalError(new Error("The WebGPU device was lost and rendering stopped."));
        return;
      }
      updateFps(now);
    }
    frameRequest = requestAnimationFrame(frame);
  };
  frameRequest = requestAnimationFrame(frame);
}

function animateLights(activeScene: Scene, time: number): void {
  if (!animatedLights || sceneBounds === null) return;
  const { center, radius } = sceneBounds;
  for (let index = 0; index < pointLights.length; index++) {
    const light = pointLights[index]!;
    const angle = time * lightAnimationSpeed * (0.12 + index * 0.015) +
      index / pointLights.length * Math.PI * 2;
    light.position = [
      center[0] + Math.cos(angle) * radius * 0.38,
      center[1] + radius * (0.08 + 0.04 * Math.sin(time * 0.7 + index)),
      center[2] + Math.sin(angle) * radius * 0.38
    ];
    light.updateMatrices();
    activeScene.lights.markChanged(light);
  }
}

function bindRendererControls(activeRenderer: Renderer): void {
  const checkboxes = document.querySelectorAll<HTMLInputElement>("input[data-feature]");
  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", () => {
      switch (checkbox.dataset.feature) {
        case "shadows": activeRenderer.configure({ features: { shadows: checkbox.checked } }); break;
        case "ssao": activeRenderer.configure({ features: { ambientOcclusion: checkbox.checked } }); break;
        case "ssr": activeRenderer.configure({ features: { screenSpaceReflections: checkbox.checked } }); break;
        case "taa": activeRenderer.configure({ features: { temporalAntiAliasing: checkbox.checked } }); break;
        case "bloom": activeRenderer.configure({ features: { bloom: checkbox.checked } }); break;
        case "exposure": activeRenderer.configure({ features: { automaticExposure: checkbox.checked } }); break;
        case "sharpen": activeRenderer.configure({ features: { sharpening: checkbox.checked } }); break;
        case "cone": activeRenderer.packed_visibility_cone_enabled = checkbox.checked; break;
        case "hzb": activeRenderer.packed_visibility_hzb_enabled = checkbox.checked; break;
        case "lights": animatedLights = checkbox.checked; break;
      }
      ensureDebugProducer(activeRenderer);
    });
  }

  debugView.addEventListener("change", () => {
    const descriptor = debugDescriptors.find((entry) => entry.value === debugView.value);
    if (descriptor === undefined) return;
    if (descriptor.requires !== undefined) enableFeature(descriptor.requires, activeRenderer);
    activeRenderer.render_debug_view = descriptor.value;
    root.dataset.debugView = descriptor.value;
    debugHelp.textContent = descriptor.help;
  });

  lodThreshold.addEventListener("input", () => {
    activeRenderer.packed_visibility_sse_threshold = Number(lodThreshold.value);
    lodValue.value = `${Number(lodThreshold.value).toFixed(1)} px`;
  });

  const aoResolution = required<HTMLSelectElement>("ao-resolution");
  aoResolution.addEventListener("change", () => {
    activeRenderer.configure({ ao: { resolutionScale: Number(aoResolution.value) as 0.5 | 1 } });
    activeRenderer.indicate_view_change();
  });
  required<HTMLInputElement>("ao-temporal").addEventListener("change", (event) => {
    activeRenderer.configure({ ao: { temporalEnabled: (event.currentTarget as HTMLInputElement).checked } });
    activeRenderer.indicate_view_change();
  });

  bindRange("sun-intensity", (value) => {
    if (sunLight !== null) {
      sunLight.intensity = value;
      scene?.lights.markChanged(sunLight);
    }
  }, (value) => value.toFixed(1));
  bindRange("ao-intensity", (value) => activeRenderer.configure({ ao: { intensity: value } }),
    (value) => value.toFixed(2));
  bindRange("ao-radius", (value) => activeRenderer.configure({ ao: { radiusMeters: value } }),
    (value) => `${value.toFixed(2)} m`);
  bindRange("ao-falloff", (value) => activeRenderer.configure({ ao: { falloffMeters: value } }),
    (value) => value.toFixed(2));
  bindRange("ssr-distance", (value) => activeRenderer.configure({ ssr: { maxDistanceMeters: value } }),
    (value) => `${value.toFixed(0)} m`);
  bindRange("ssr-edge", (value) => activeRenderer.configure({ ssr: { edgeFade: value } }),
    (value) => value.toFixed(2));
  bindRange("taa-history", (value) => activeRenderer.configure({ temporal: { historyStrength: value } }),
    (value) => value.toFixed(2));
  bindRange("bloom-intensity", (value) => activeRenderer.configure({ post: { bloomIntensity: value } }),
    (value) => value.toFixed(2));
  bindRange("exposure-compensation", (value) => activeRenderer.configure({ post: { exposureCompensation: value } }),
    (value) => value.toFixed(1));
  bindRange("exposure-up", (value) => activeRenderer.configure({ post: { exposureSpeedUp: value } }),
    (value) => value.toFixed(1));
  bindRange("exposure-down", (value) => activeRenderer.configure({ post: { exposureSpeedDown: value } }),
    (value) => value.toFixed(1));
  bindRange("sharpen-strength", (value) => activeRenderer.configure({ post: { sharpeningStrength: value } }),
    (value) => value.toFixed(2));
  bindRange("light-intensity", (value) => {
    for (const light of pointLights) {
      light.intensity = value;
      scene?.lights.markChanged(light);
    }
  }, (value) => value.toFixed(0));
  bindRange("light-range", (value) => {
    if (sceneBounds === null) return;
    for (const light of pointLights) {
      light.distance = sceneBounds.radius * value;
      scene?.lights.markChanged(light);
    }
  }, (value) => `${value.toFixed(2)}×`);
  bindRange("light-speed", (value) => lightAnimationSpeed = value,
    (value) => `${value.toFixed(1)}×`);

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-scale]")) {
    button.addEventListener("click", () => {
      const scale = Number(button.dataset.scale);
      activeRenderer.internal_resolution_scale = scale;
      activeRenderer.indicate_view_change();
      for (const candidate of document.querySelectorAll<HTMLButtonElement>("button[data-scale]")) {
        candidate.classList.toggle("active", candidate === button);
      }
    });
  }

  required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
}

function ensureDebugProducer(activeRenderer: Renderer): void {
  const descriptor = debugDescriptors.find((entry) => entry.value === activeRenderer.render_debug_view);
  if (descriptor?.requires === "ssao" && !activeRenderer.render_settings.features.ambientOcclusion) {
    selectFinalOutput(activeRenderer);
  }
  if (descriptor?.requires === "ssr" && !activeRenderer.render_settings.features.screenSpaceReflections) {
    selectFinalOutput(activeRenderer);
  }
}

function enableFeature(feature: "ssao" | "ssr", activeRenderer: Renderer): void {
  const checkbox = document.querySelector<HTMLInputElement>(`input[data-feature="${feature}"]`);
  if (checkbox !== null) checkbox.checked = true;
  if (feature === "ssao") activeRenderer.configure({ features: { ambientOcclusion: true } });
  if (feature === "ssr") activeRenderer.configure({ features: { screenSpaceReflections: true } });
}

function selectFinalOutput(activeRenderer: Renderer): void {
  activeRenderer.render_debug_view = RenderDebugView.None;
  debugView.value = RenderDebugView.None;
  root.dataset.debugView = RenderDebugView.None;
  debugHelp.textContent = debugDescriptors[0]!.help;
}

function populateDebugViews(): void {
  const supported = new Set(
    RENDER_DEBUG_VIEW_OPTIONS
      .filter((entry) => entry.status !== "unsupported")
      .map((entry) => entry.view)
  );
  for (const descriptor of debugDescriptors) {
    if (!supported.has(descriptor.value)) continue;
    const option = document.createElement("option");
    option.value = descriptor.value;
    option.textContent = descriptor.label;
    debugView.append(option);
  }
}

function bindPanelShell(): void {
  panelToggle.addEventListener("click", () => {
    const collapsed = root.classList.toggle("panel-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!collapsed));
    panelToggle.textContent = collapsed ? "调试面板" : "关闭";
  });
}

function bindRange(
  id: string,
  apply: (value: number) => void,
  format: (value: number) => string
): void {
  const input = required<HTMLInputElement>(id);
  const output = required<HTMLOutputElement>(`${id}-value`);
  const update = (): void => {
    const value = Number(input.value);
    apply(value);
    output.value = format(value);
  };
  input.addEventListener("input", update);
  update();
}

function scalePackedTransforms(
  source: Float32Array,
  scale: number,
  pivot: readonly [number, number, number]
): Float32Array {
  const output = source.slice();
  for (let matrixOffset = 0; matrixOffset < output.length; matrixOffset += 16) {
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        const offset = matrixOffset + column * 4 + row;
        output[offset] = output[offset]! * scale;
      }
    }
    output[matrixOffset + 12] = pivot[0] +
      (output[matrixOffset + 12]! - pivot[0]) * scale;
    output[matrixOffset + 13] = pivot[1] +
      (output[matrixOffset + 13]! - pivot[1]) * scale;
    output[matrixOffset + 14] = pivot[2] +
      (output[matrixOffset + 14]! - pivot[2]) * scale;
  }
  return output;
}

function computeWorldBounds(
  source: PackedGltfSource,
  transforms: Float32Array = source.transforms
): Bounds {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let instance = 0; instance < source.geometryIndices.length; instance++) {
    const boundsOffset = instance * 3;
    const matrixOffset = instance * 16;
    for (let corner = 0; corner < 8; corner++) {
      const x = source.boundsMin[boundsOffset]!;
      const y = source.boundsMin[boundsOffset + 1]!;
      const z = source.boundsMin[boundsOffset + 2]!;
      const localX = corner & 1 ? source.boundsMax[boundsOffset]! : x;
      const localY = corner & 2 ? source.boundsMax[boundsOffset + 1]! : y;
      const localZ = corner & 4 ? source.boundsMax[boundsOffset + 2]! : z;
      const worldX = transforms[matrixOffset]! * localX +
        transforms[matrixOffset + 4]! * localY +
        transforms[matrixOffset + 8]! * localZ +
        transforms[matrixOffset + 12]!;
      const worldY = transforms[matrixOffset + 1]! * localX +
        transforms[matrixOffset + 5]! * localY +
        transforms[matrixOffset + 9]! * localZ +
        transforms[matrixOffset + 13]!;
      const worldZ = transforms[matrixOffset + 2]! * localX +
        transforms[matrixOffset + 6]! * localY +
        transforms[matrixOffset + 10]! * localZ +
        transforms[matrixOffset + 14]!;
      minimum[0] = Math.min(minimum[0]!, worldX);
      minimum[1] = Math.min(minimum[1]!, worldY);
      minimum[2] = Math.min(minimum[2]!, worldZ);
      maximum[0] = Math.max(maximum[0]!, worldX);
      maximum[1] = Math.max(maximum[1]!, worldY);
      maximum[2] = Math.max(maximum[2]!, worldZ);
    }
  }
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    return { min: [-5, -5, -5], max: [5, 5, 5], center: [0, 0, 0], radius: 10 };
  }
  const center: [number, number, number] = [
    (minimum[0]! + maximum[0]!) * 0.5,
    (minimum[1]! + maximum[1]!) * 0.5,
    (minimum[2]! + maximum[2]!) * 0.5
  ];
  const radius = Math.max(
    1,
    0.5 * Math.hypot(
      maximum[0]! - minimum[0]!,
      maximum[1]! - minimum[1]!,
      maximum[2]! - minimum[2]!
    )
  );
  return {
    min: minimum as [number, number, number],
    max: maximum as [number, number, number],
    center,
    radius
  };
}

function updateFps(now: number): void {
  framesSinceSample++;
  const elapsed = now - lastFpsSample;
  if (elapsed < 500) return;
  metricFps.textContent = String(Math.round(framesSinceSample * 1000 / elapsed));
  updateProfilerEvidence();
  framesSinceSample = 0;
  lastFpsSample = now;
}

function updateProfilerEvidence(): void {
  if (renderer === null) return;
  const summary = evidenceWindow.summarize();
  evidenceSamples.textContent = summary.timestampSampleCount > 0
    ? `${summary.timestampSampleCount} 个 timestamp 样本`
    : "等待 GPU timestamp";
  evidenceGpuP50.textContent = formatMilliseconds(summary.gpuTotal?.p50);
  evidenceGpuTail.textContent = summary.gpuTotal === null
    ? "—"
    : `${formatMilliseconds(summary.gpuTotal.p95)} / ${formatMilliseconds(summary.gpuTotal.p99)}`;

  const commands = summary.latestCommands;
  evidencePasses.textContent = `${commandValue(commands, "renderPass")} / ${commandValue(commands, "computePass")}`;
  evidenceCommands.textContent = `${commandValue(commands, "draw")} / ${commandValue(commands, "dispatch")}`;

  evidenceDomains.replaceChildren();
  for (const domain of SHOWCASE_GPU_DOMAINS) {
    const timing = summary.gpuDomains.get(domain);
    if (timing === undefined) continue;
    const row = document.createElement("div");
    const label = document.createElement("dt");
    const value = document.createElement("dd");
    label.textContent = domain;
    value.textContent = `${formatMilliseconds(timing.p50)} · ${formatMilliseconds(timing.p95)} · ${formatMilliseconds(timing.p99)}`;
    row.append(label, value);
    evidenceDomains.append(row);
  }

  const temporal = renderer.temporalEvidence();
  const ao = renderer.ambientOcclusionEvidence();
  const ssr = renderer.screenSpaceReflectionsEvidence();
  evidenceResolution.textContent = [
    `internal-full ${temporal.internalWidth}×${temporal.internalHeight}`,
    `output-full ${temporal.outputWidth}×${temporal.outputHeight}`,
    ao.enabled ? `AO ${ao.aoWidth}×${ao.aoHeight} (${ao.resolutionScale}×)` : "AO off",
    ssr.enabled ? `SSR ${ssr.internalWidth}×${ssr.internalHeight} (1× current)` : "SSR off"
  ].join(" · ");

  const gpu = summary.latestGpuCounters;
  const aoEvaluated = gpu.aoEvaluatedPixels ?? 0;
  const aoAccepted = gpu.aoHistoryAcceptedPixels ?? 0;
  const aoRejected = gpu.aoHistoryRejectedPixels ?? 0;
  evidenceAo.textContent = ao.enabled
    ? `${formatInteger(aoEvaluated)} px · history 接受 ${formatRatio(aoAccepted, aoEvaluated)} · 拒绝 ${formatRatio(aoRejected, aoEvaluated)} · ${ao.rawPasses}/${ao.spatialPasses}/${ao.temporalPasses}/${ao.compositePasses} Pass`
    : "功能关闭；无 Pass、历史和采样计数。";

  const tracePixels = gpu.ssrTracePixels ?? 0;
  const hitPixels = gpu.ssrHitPixels ?? 0;
  const traceSteps = gpu.ssrTraceSteps ?? 0;
  evidenceSsr.textContent = ssr.enabled
    ? [
        `${formatInteger(tracePixels)} rays`,
        `hit ${formatRatio(hitPixels, tracePixels)}`,
        `steps avg ${tracePixels > 0 ? (traceSteps / tracePixels).toFixed(1) : "—"} / max ${gpu.ssrMaxTraceSteps ?? 0}`,
        `roughness reject ${gpu.ssrRoughnessRejectedPixels ?? 0}`,
        `distance reject ${gpu.ssrDistanceRejectedPixels ?? 0}`,
        `高粗糙仍追踪 ${formatInteger(gpu.ssrHighRoughnessTracePixels ?? 0)}`,
        `超 maxDistance 仍保留 ${formatInteger(gpu.ssrDistanceLimitExceededPixels ?? 0)}`,
        `validation reject ${formatInteger(gpu.ssrValidationRejectedPixels ?? 0)}`
      ].join(" · ")
    : "功能关闭；无 trace/resolve/temporal Pass 和历史资源。";

  const temporalPixels = temporal.internalPixels;
  const temporalRejected = gpu.temporalHistoryRejectedPixels ?? 0;
  const memory = renderer.memoryEvidence();
  const diagnostics = renderer.profiler.diagnostics;
  evidenceSystem.textContent = [
    `Temporal internal-pixel reject ${formatRatio(temporalRejected, temporalPixels)}`,
    `allocated ${formatBytes(memory.allocatedBytes)}`,
    `resident logical ${formatBytes(memory.residentLogicalBytes)}`,
    `transient pool ${formatBytes(memory.transientPoolBytes)}`,
    `history ${formatBytes(memory.historyBytes)}`,
    `retiring ${formatBytes(memory.retiringBytes)}`,
    `fragmentation ${formatBytes(memory.fragmentationBytes)}`,
    `submit ${summary.latestSubmitCount ?? "—"}`,
    `validation ${diagnostics.validationErrorCount}`,
    `counter drop ${diagnostics.droppedGpuCounterSamples}`
  ].join(" · ");
}

function commandValue(counters: Readonly<Record<string, number>>, name: string): number | string {
  return counters[`gpu.commands.${name}`] ?? "—";
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(2)} ms`;
}

function formatRatio(value: number, total: number): string {
  return total > 0 ? `${(value / total * 100).toFixed(1)}%` : "—";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setLoading(detail: string, stage: string, progress: number): void {
  loadingDetail.textContent = detail;
  loadingStage.textContent = stage;
  loadingProgress.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
}

function showFatalError(error: unknown): void {
  if (disposed) return;
  const message = error instanceof Error ? error.message : String(error);
  root.dataset.state = "error";
  root.dataset.error = message;
  readyPill.textContent = "错误";
  setLoading(message, "示例无法启动", 1);
  console.error(error);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  unsubscribeProfiler?.();
  unsubscribeProfiler = null;
  delete window.__OENGINE_Q00_SET_STATE__;
  delete window.__OENGINE_Q00_SNAPSHOT__;
  delete window.__OENGINE_Q00_FRAME__;
  cancelAnimationFrame(frameRequest);
  resizeObserver?.disconnect();
  controller?.pointer.stop();
  controller?.keyboard.stop();
  renderer?.destroy();
  const context = canvas.getContext("webgpu");
  context?.unconfigure();
}

window.addEventListener("pagehide", dispose, { once: true });

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
