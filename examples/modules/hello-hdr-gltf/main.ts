import {
  load_environment_map,
  load_gltf,
  OrbitControls,
  PerspectiveCamera,
  ProjectionMappingType,
  Renderer,
  Scene,
  resolveWebCookRuntimeProfile,
  createDefaultWebCookWorker
} from "../../../OEngine/src/index.ts";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing hello-hdr-gltf element #${id}`);
  return value as T;
};

const canvas = element<HTMLCanvasElement>("viewport");
const phase = element("phase");
const sceneState = element("scene-state");
const fpsOutput = element("quick-fps");
const errorOutput = element("error");
const panel = element("debug-panel");
const panelToggle = element<HTMLButtonElement>("panel-toggle");
const toneMapping = element<HTMLSelectElement>("tone-mapping");
const exposure = element<HTMLInputElement>("exposure");
const exposureValue = element("exposure-value");
const backgroundIntensity = element<HTMLInputElement>("background-intensity");
const backgroundIntensityValue = element("background-intensity-value");
const backgroundBlur = element<HTMLInputElement>("background-blur");
const backgroundBlurValue = element("background-blur-value");
const resetCamera = element<HTMLButtonElement>("reset-camera");

const scene = new Scene();
const camera = new PerspectiveCamera();
camera.fov_degrees = 45;
camera.near = 0.001;
camera.far = 10;
camera.transform.position.set(-0.045, 0.052, 0.058);
camera.transform.lookAt({ x: 0, y: 0.033, z: 0 });
const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 0.033, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.enablePan = false;
orbit.minDistance = 0.025;
orbit.maxDistance = 0.2;

let renderer: Renderer | undefined;
let running = false;
let disposed = false;
let lastTime = performance.now();
let lastFpsTime = lastTime;
let submittedFrameAtSample = 0;
let activeAsset: ReturnType<typeof load_gltf> | undefined;

function setPhase(message: string): void {
  phase.textContent = message;
}

function resize(): void {
  if (!renderer) return;
  renderer.resize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.update();
  orbit.updateViewportSize();
}

function fail(reason: unknown): void {
  running = false;
  setPhase("初始化失败");
  errorOutput.textContent = reason instanceof Error ? reason.message : String(reason);
  console.error(reason);
}

function updateBackground(): void {
  if (!renderer) return;
  const intensity = Number(backgroundIntensity.value);
  const blur = Number(backgroundBlur.value);
  backgroundIntensityValue.textContent = intensity.toFixed(2);
  backgroundBlurValue.textContent = blur.toFixed(2);
  renderer.setAuthoredBackgroundSettings({ exposure: intensity, blur });
}

function updateExposure(): void {
  if (!renderer) return;
  const value = Number(exposure.value);
  exposureValue.textContent = value.toFixed(2);
  renderer.setFixedExposure(value);
}

function resetView(): void {
  camera.transform.position.set(-0.045, 0.052, 0.058);
  camera.transform.lookAt({ x: 0, y: 0.033, z: 0 });
  camera.update();
  orbit.target.set(0, 0.033, 0);
  orbit.reset();
}

function frame(time: number): void {
  if (disposed) return;
  requestAnimationFrame(frame);
  if (!running || !renderer) return;
  const delta = Math.min(Math.max((time - lastTime) / 1000, 0), 0.1);
  lastTime = time;
  orbit.update(delta);
  renderer.render(camera, scene, delta);
  if (time - lastFpsTime >= 500) {
    const elapsed = time - lastFpsTime;
    const submitted = renderer.frame_count - submittedFrameAtSample;
    fpsOutput.textContent = `${Math.round((submitted * 1000) / elapsed)} FPS`;
    submittedFrameAtSample = renderer.frame_count;
    lastFpsTime = time;
  }
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU，请使用支持 WebGPU 的浏览器。");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context。");

  setPhase("初始化原生 HDR 管线");
  renderer = new Renderer({
    autoExposure: false,
    fixedExposure: Number(exposure.value),
    enableVsm: false,
    enablePhysicalEnvironment: false,
    ambientOcclusion: { enabled: false },
    renderScale: 1
  });
  await renderer.initialize({ context });
  renderer.packed_visibility_hzb_enabled = false;
  renderer.packed_visibility_current_hzb_late_recheck_enabled = false;
  renderer.fsr3_enabled = false;
  renderer.temporal_jitter_enabled = false;
  renderer.bloom_enabled = false;
  renderer.setToneMapping(toneMapping.value as "engine" | "neutral" | "aces" | "reinhard");

  resize();
  // Product admission advances from the regular frame submission loop.
  running = true;
  lastTime = performance.now();
  lastFpsTime = lastTime;
  submittedFrameAtSample = renderer.frame_count;
  requestAnimationFrame(frame);

  setPhase("解码 Venice Sunset HDR");
  scene.lights.environment = await load_environment_map(
    "/modules/hello-hdr-gltf/assets/venice_sunset_1k.hdr",
    ProjectionMappingType.Equirectangular
  );

  setPhase("读取 Venice Mask glTF");
  const profile = resolveWebCookRuntimeProfile("auto");
  const worker = createDefaultWebCookWorker({
    runtimeProfile: profile.selected,
    maxWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)),
    maxCanonicalInputBytes: 64 * 1024 * 1024,
    maxSourceWindowBytes: 64 * 1024 * 1024,
    maxDecodedProductBytes: 128 * 1024 * 1024,
    maxSessionSpillBytes: 512 * 1024 * 1024,
    maxTrianglesPerProduct: 128 * 1024,
    maxVerticesPerProduct: 512 * 1024,
    maxDomainsPerProduct: 64
  });
  const asset = load_gltf("/modules/hello-hdr-gltf/assets/venice_mask.glb", {
    worker,
    runtimeProfile: profile.selected,
    initialOutputPageCredits: 512,
    maxBufferedPages: 512,
    maxBufferedBytes: 128 * 1024 * 1024,
    onSceneCatalogReady: () => setPhase("烘焙 GeometryProduct"),
    onProgress: (progress) => {
      setPhase(`Cook · ${progress.stage}`);
    }
  });
  activeAsset = asset;
  setPhase("发布 Virtual Geometry");
  const publication = renderer.uploadWebCookedMultiProductScene(scene, asset, {
    fitHeight: 0.065,
    fitBase: [0, 0, 0],
    multiProductMetadataBytes: 64 * 1024 * 1024,
    residency: {
      requestedProfile: "HighEnd",
      configuredCapacityBytes: 128 * 1024 * 1024,
      configuredBankBytes: 32 * 1024 * 1024
    }
  });
  void publication.then(
    () => {
      setPhase("就绪 · 拖动旋转，滚轮缩放");
      sceneState.textContent = "Venice Mask · Venice Sunset HDR";
    },
    fail
  );
}

panelToggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
  panelToggle.textContent = collapsed ? "+" : "−";
});
toneMapping.addEventListener("change", () => renderer?.setToneMapping(toneMapping.value as "engine" | "neutral" | "aces" | "reinhard"));
exposure.addEventListener("input", updateExposure);
backgroundIntensity.addEventListener("input", updateBackground);
backgroundBlur.addEventListener("input", updateBackground);
resetCamera.addEventListener("click", resetView);
window.addEventListener("resize", resize);
window.addEventListener("pagehide", () => {
  disposed = true;
  running = false;
  orbit.dispose();
  activeAsset?.dispose();
  renderer?.destroy();
}, { once: true });

void start().catch(fail);
