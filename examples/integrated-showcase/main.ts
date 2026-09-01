import {
  DirectionalLight,
  OrbitalCameraController,
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

const debugDescriptors: readonly DebugDescriptor[] = [
  { value: RenderDebugView.None, label: "最终画面", help: "曝光、色调映射与后处理后的最终输出。" },
  { value: RenderDebugView.VisibilityKey, label: "可见性键", help: "Packed Instance、Cluster、Meshlet 与材质标识。" },
  { value: RenderDebugView.Depth, label: "反向 Z 深度", help: "近处更亮，未覆盖背景为黑色。" },
  { value: RenderDebugView.BaseColor, label: "基础色", help: "线性空间的材质基础色通道。" },
  { value: RenderDebugView.ShadingNormal, label: "着色法线", help: "解码后的世界空间表面法线。" },
  { value: RenderDebugView.Roughness, label: "粗糙度", help: "材质感知粗糙度。" },
  { value: RenderDebugView.Metallic, label: "金属度", help: "材质金属响应。" },
  { value: RenderDebugView.Occlusion, label: "材质遮蔽", help: "材质纹理提供的环境遮蔽。" },
  { value: RenderDebugView.AmbientOcclusionTemporal, label: "环境光遮蔽", help: "时域 GTAO 最终可见度。", requires: "ssao" },
  { value: RenderDebugView.Emissive, label: "自发光", help: "从 GLB 材质解码的自发光贡献。" },
  { value: RenderDebugView.Velocity, label: "运动矢量", help: "屏幕空间运动方向和幅度。" },
  { value: RenderDebugView.HistoryValidity, label: "历史有效性", help: "时域运动有效与反应状态。" },
  { value: RenderDebugView.Reactive, label: "反应遮罩", help: "拒绝使用时域历史的像素。" },
  { value: RenderDebugView.IndirectDiffuse, label: "漫反射 IBL", help: "余弦卷积后的环境漫反射照明。" },
  { value: RenderDebugView.IndirectSpecular, label: "镜面 IBL", help: "GGX 预过滤环境反射。" },
  { value: RenderDebugView.ScreenSpaceReflectionHitMiss, label: "SSR 命中 / 未命中", help: "屏幕空间反射命中置信度。", requires: "ssr" },
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

let renderer: Renderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controller: OrbitalCameraController | null = null;
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

  sceneBounds = computeWorldBounds(imported);
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
    currentTransforms: imported.transforms,
    previousTransforms: imported.transforms.slice(),
    boundsSpheres: imported.boundsSpheres,
    boundsMin: imported.boundsMin,
    boundsMax: imported.boundsMax,
    flags: imported.flags,
    debugIds: imported.debugIds
  });
  if (disposed) return;

  const activeCamera = createCamera(activeRenderer, sceneBounds);
  camera = activeCamera;
  controller = new OrbitalCameraController(activeCamera, canvas);
  resetCamera();
  bindRendererControls(activeRenderer);
  startResizeObserver(activeRenderer, activeCamera);

  readyPill.textContent = "运行中";
  fieldset.disabled = false;
  root.dataset.state = "ready";
  root.dataset.debugView = RenderDebugView.None;
  setLoading("准备完成", "正在渲染", 1);
  startFrameLoop();
}

function configurePipeline(activeRenderer: Renderer): void {
  activeRenderer.feature_shadows_enabled = true;
  activeRenderer.feature_ssao_enabled = true;
  activeRenderer.ssao_resolution_scale = 0.5;
  activeRenderer.ssao_temporal_enabled = true;
  activeRenderer.feature_ssr_enabled = false;
  activeRenderer.feature_taa_enabled = true;
  activeRenderer.feature_bloom_enabled = true;
  activeRenderer.feature_automatic_exposure_enabled = true;
  activeRenderer.feature_motion_blur_enabled = false;
  activeRenderer.feature_sharpening_enabled = true;
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
        case "shadows": activeRenderer.feature_shadows_enabled = checkbox.checked; break;
        case "ssao": activeRenderer.feature_ssao_enabled = checkbox.checked; break;
        case "ssr": activeRenderer.feature_ssr_enabled = checkbox.checked; break;
        case "taa": activeRenderer.feature_taa_enabled = checkbox.checked; break;
        case "bloom": activeRenderer.feature_bloom_enabled = checkbox.checked; break;
        case "exposure": activeRenderer.feature_automatic_exposure_enabled = checkbox.checked; break;
        case "sharpen": activeRenderer.feature_sharpening_enabled = checkbox.checked; break;
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
    activeRenderer.ssao_resolution_scale = Number(aoResolution.value) as 0.5 | 1;
    activeRenderer.indicate_view_change();
  });
  required<HTMLInputElement>("ao-temporal").addEventListener("change", (event) => {
    activeRenderer.ssao_temporal_enabled = (event.currentTarget as HTMLInputElement).checked;
    activeRenderer.indicate_view_change();
  });

  bindRange("sun-intensity", (value) => {
    if (sunLight !== null) {
      sunLight.intensity = value;
      scene?.lights.markChanged(sunLight);
    }
  }, (value) => value.toFixed(1));
  bindRange("ao-intensity", (value) => activeRenderer.ssao_intensity = value,
    (value) => value.toFixed(2));
  bindRange("ao-falloff", (value) => activeRenderer.ssao_falloff = value,
    (value) => value.toFixed(2));
  bindRange("ssr-distance", (value) => activeRenderer.ssr_max_distance = value,
    (value) => `${value.toFixed(0)} m`);
  bindRange("ssr-edge", (value) => activeRenderer.ssr_edge_fade = value,
    (value) => value.toFixed(2));
  bindRange("taa-history", (value) => activeRenderer.taa_history_strength = value,
    (value) => value.toFixed(2));
  bindRange("bloom-intensity", (value) => activeRenderer.bloom_intensity = value,
    (value) => value.toFixed(2));
  bindRange("exposure-compensation", (value) => activeRenderer.exposure_compensation = value,
    (value) => value.toFixed(1));
  bindRange("exposure-up", (value) => activeRenderer.exposure_speed_up = value,
    (value) => value.toFixed(1));
  bindRange("exposure-down", (value) => activeRenderer.exposure_speed_down = value,
    (value) => value.toFixed(1));
  bindRange("sharpen-strength", (value) => activeRenderer.sharpening_strength = value,
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
  if (descriptor?.requires === "ssao" && !activeRenderer.feature_ssao_enabled) {
    selectFinalOutput(activeRenderer);
  }
  if (descriptor?.requires === "ssr" && !activeRenderer.feature_ssr_enabled) {
    selectFinalOutput(activeRenderer);
  }
}

function enableFeature(feature: "ssao" | "ssr", activeRenderer: Renderer): void {
  const checkbox = document.querySelector<HTMLInputElement>(`input[data-feature="${feature}"]`);
  if (checkbox !== null) checkbox.checked = true;
  if (feature === "ssao") activeRenderer.feature_ssao_enabled = true;
  if (feature === "ssr") activeRenderer.feature_ssr_enabled = true;
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

function computeWorldBounds(source: PackedGltfSource): Bounds {
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
      const worldX = source.transforms[matrixOffset]! * localX +
        source.transforms[matrixOffset + 4]! * localY +
        source.transforms[matrixOffset + 8]! * localZ +
        source.transforms[matrixOffset + 12]!;
      const worldY = source.transforms[matrixOffset + 1]! * localX +
        source.transforms[matrixOffset + 5]! * localY +
        source.transforms[matrixOffset + 9]! * localZ +
        source.transforms[matrixOffset + 13]!;
      const worldZ = source.transforms[matrixOffset + 2]! * localX +
        source.transforms[matrixOffset + 6]! * localY +
        source.transforms[matrixOffset + 10]! * localZ +
        source.transforms[matrixOffset + 14]!;
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
  framesSinceSample = 0;
  lastFpsSample = now;
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
