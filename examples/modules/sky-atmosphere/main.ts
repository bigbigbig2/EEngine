import {
  cookSceneGeometryProductV1,
  createDefaultWebGeometryCookerModule,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  VSM_DEFAULT_SETTINGS,
  type RenderDebugViewName,
  type VsmSettings
} from "../../../OEngine/src/index.ts";
import { createSkyScene, SKY_SCENE_DEFAULTS, type LightingDiagnostic, type SkySceneSettings } from "./scene.ts";
import {
  createIcons,
  Download,
  Maximize,
  PanelRightClose,
  PanelRightOpen,
  Scan
} from "lucide";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

declare global {
  interface Window {
    skyModuleDemo: {
      report: () => Record<string, unknown>;
    };
  }
}

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing sky module element #${id}`);
  return value as T;
};

const canvas = element<HTMLCanvasElement>("viewport");
const phase = element("phase");
const elapsed = element("elapsed");
const errorOutput = element("error");
const diagnostics = element("diagnostics");
const dirty = element("dirty");
const debugView = element<HTMLSelectElement>("debug-view");
const lightingView = element<HTMLSelectElement>("lighting-contribution");
const vsmToggle = element<HTMLInputElement>("vsm");
const vsmParameters = element("vsm-parameters");
const fsr3Toggle = element<HTMLInputElement>("fsr3");
const jitterToggle = element<HTMLInputElement>("jitter");
const panel = element("debug-panel");
const panelBody = element("panel-body");
const panelToggle = element<HTMLButtonElement>("panel-toggle");

const sceneState: Mutable<SkySceneSettings> = { ...SKY_SCENE_DEFAULTS };
const vsmState: Mutable<VsmSettings> = { ...VSM_DEFAULT_SETTINGS };
const quality = {
  antiAliasing: true,
  cameraJitter: true
};
let renderScale = 0.7;
const query = new URLSearchParams(location.search);
const autoExposure = query.get("exposure") === "auto";
const fixedExposure = Number(query.get("fixedExposure") ?? 3.2);
const camera = new PerspectiveCamera();
camera.fov_degrees = 55;
camera.near = 0.25;
camera.far = 1_000;
camera.transform.position.set(72, 38, 92);
camera.transform.lookAt({ x: 0, y: 12, z: 0 });
const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 12, 0);
orbit.minDistance = 8;
orbit.maxDistance = 600;
orbit.maxPolarAngle = Math.PI * 0.49;
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.keyboard.stop();

let renderer: Renderer | undefined;
let skyScene: ReturnType<typeof createSkyScene> | undefined;
let disposed = false;
let running = false;
let lastTime = performance.now();
let frameCount = 0;
let cpuMs = 0;
let gpuSpanMs: number | null = null;
let lastSubmittedFrame = 0;
let lastSubmittedSampleTime = performance.now();
const startTime = performance.now();

function setPhase(text: string): void {
  phase.textContent = text;
  elapsed.textContent = `${((performance.now() - startTime) / 1000).toFixed(1)} s`;
}

function fail(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  running = false;
  errorOutput.textContent = message;
  setPhase(message);
  console.error(reason);
}

function markDirty(): void {
  dirty.textContent = "待应用";
}

function updateRange(id: string, value: number, digits = 2): void {
  element<HTMLOutputElement>(`${id}-value`).textContent = value.toFixed(digits);
}

function bindRange(
  id: string,
  target: Mutable<SkySceneSettings>,
  key: keyof SkySceneSettings,
  digits = 2
): void {
  const input = element<HTMLInputElement>(id);
  input.addEventListener("input", () => {
    target[key] = input.valueAsNumber as never;
    updateRange(id, input.valueAsNumber, digits);
    applySettings();
  });
  updateRange(id, input.valueAsNumber, digits);
}

function bindVsmRange(id: string, key: keyof VsmSettings, digits = 2): void {
  const input = element<HTMLInputElement>(id);
  input.addEventListener("input", () => {
    vsmState[key] = input.valueAsNumber as never;
    updateRange(id, input.valueAsNumber, digits);
    if (renderer) {
      renderer.setVsmSettings({ [key]: input.valueAsNumber });
    }
    dirty.textContent = "已应用";
  });
  updateRange(id, input.valueAsNumber, digits);
}

function populateSelects(): void {
  const finalOption = document.createElement("option");
  finalOption.value = RenderDebugView.None;
  finalOption.textContent = "Final shaded";
  debugView.append(finalOption);
  for (const option of RENDER_DEBUG_VIEW_OPTIONS) {
    if (option.status !== "supported") continue;
    const entry = document.createElement("option");
    entry.value = option.view;
    entry.textContent = option.label;
    debugView.append(entry);
  }
  for (const [value, label] of [
    ["all", "All lighting"],
    ["background-only", "Sky background"],
    ["diffuse-only", "Diffuse sky IBL"],
    ["specular-only", "Specular sky IBL"],
    ["direct-only", "Direct sun"],
    ["aerial-only", "Aerial perspective"]
  ] as const) {
    const entry = document.createElement("option");
    entry.value = value;
    entry.textContent = label;
    lightingView.append(entry);
  }
  lightingView.value = sceneState.lightingView;
}

function syncRendererSettings(): void {
  if (!renderer) return;
  renderer.shadowVisibilityEnabled = vsmToggle.checked;
  renderer.setVsmSettings(vsmState);
  renderer.setResolutionScale(renderScale);
  renderer.fsr3_enabled = quality.antiAliasing;
  renderer.temporal_jitter_enabled = quality.cameraJitter;
  renderer.render_debug_view = debugView.value as RenderDebugViewName;
}

function applySettings(): void {
  skyScene?.apply(sceneState);
  syncRendererSettings();
  dirty.textContent = "已应用";
}

function resize(): void {
  if (!renderer) return;
  const width = Math.max(320, window.innerWidth);
  const height = Math.max(240, window.innerHeight);
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
}

function setQuality(key: keyof typeof quality, checked: boolean): void {
  quality[key] = checked;
  if (key === "antiAliasing" && !checked) {
    // Renderer temporal bypass requires native output resolution.
    renderScale = 1;
    const renderScaleInput = element<HTMLInputElement>("render-scale");
    renderScaleInput.value = "1";
    element<HTMLOutputElement>("render-scale-value").textContent = "100%";
  }
  renderer?.invalidateTemporalHistory();
  syncRendererSettings();
  dirty.textContent = "已应用";
}

function report(): Record<string, unknown> {
  return {
    example: "sky-atmosphere",
    design: "Mesa Commons / new module scene",
    source: import.meta.url,
    scene: sceneState,
    metadata: skyScene?.metadata ?? null,
    camera: {
      position: { x: camera.transform.position.x, y: camera.transform.position.y, z: camera.transform.position.z },
      target: { x: orbit.target.x, y: orbit.target.y, z: orbit.target.z }
    },
    vsm: {
      enabled: vsmToggle.checked,
      settings: renderer?.vsmSettings ?? vsmState,
      diagnostics: renderer?.vsmDiagnostics?.() ?? null
    },
    quality: {
      ...quality,
      renderScale,
      jitterActive: renderer?.temporalJitterActive ?? false
    },
    resolution: renderer?.resolutionEvidence() ?? null,
    submission: renderer?.frameSubmissionEvidence() ?? null,
    frame: renderer?.frame_count ?? frameCount,
    profiler: renderer?.profiler?.diagnostics ?? null
  };
}

function refreshDiagnostics(): void {
  diagnostics.textContent = JSON.stringify(report(), null, 2);
}

function frame(time: number): void {
  if (disposed) return;
  requestAnimationFrame(frame);
  if (!running || !renderer || !skyScene) return;
  const delta = Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  orbit.update(delta);
  const started = performance.now();
  renderer.render(camera, skyScene.scene, delta);
  cpuMs = performance.now() - started;
  frameCount += 1;
  const sampleNow = performance.now();
  const sampleDuration = sampleNow - lastSubmittedSampleTime;
  if (sampleDuration >= 500) {
    const submittedFrames = renderer.frame_count - lastSubmittedFrame;
    const submittedFps = submittedFrames * 1000 / sampleDuration;
    element("quick-fps").textContent = submittedFps.toFixed(0);
    lastSubmittedFrame = renderer.frame_count;
    lastSubmittedSampleTime = sampleNow;
  }
  element("quick-cpu").textContent = `${cpuMs.toFixed(2)} ms`;
  element("quick-gpu").textContent = gpuSpanMs === null ? "--" : `${gpuSpanMs.toFixed(2)} ms`;
  elapsed.textContent = `${((performance.now() - startTime) / 1000).toFixed(1)} s`;
  if (frameCount % 30 === 0) refreshDiagnostics();
}

function wireControls(): void {
  createIcons({ icons: { Download, Maximize, PanelRightClose, PanelRightOpen, Scan } });
  populateSelects();
  bindRange("sun-azimuth", sceneState, "sunAzimuth", 1);
  bindRange("sun-elevation", sceneState, "sunElevation", 1);
  bindRange("sun", sceneState, "sunScale");
  bindRange("sky", sceneState, "skyScale");
  bindVsmRange("vsm-radius", "filterRadiusTexels");
  bindVsmRange("vsm-depth-bias", "depthBiasTexels");
  bindVsmRange("vsm-angular-bias", "angularBiasTexels");
  bindVsmRange("vsm-coverage", "clipExtentScale");
  element<HTMLInputElement>("aerial-perspective").addEventListener("change", (event) => {
    sceneState.aerial = (event.currentTarget as HTMLInputElement).checked;
    applySettings();
  });
  lightingView.addEventListener("change", () => {
    sceneState.lightingView = lightingView.value as LightingDiagnostic;
    applySettings();
  });
  debugView.addEventListener("change", syncRendererSettings);
  vsmToggle.addEventListener("change", () => {
    vsmParameters.hidden = !vsmToggle.checked;
    syncRendererSettings();
  });
  fsr3Toggle.addEventListener("change", () => setQuality("antiAliasing", fsr3Toggle.checked));
  jitterToggle.addEventListener("change", () => setQuality("cameraJitter", jitterToggle.checked));
  element<HTMLSelectElement>("vsm-filter").addEventListener("change", () => {
    vsmState.filterMode = element<HTMLSelectElement>("vsm-filter").value as VsmSettings["filterMode"];
    syncRendererSettings();
  });
  element<HTMLSelectElement>("vsm-debug-view").addEventListener("change", () => {
    vsmState.debugView = element<HTMLSelectElement>("vsm-debug-view").value as VsmSettings["debugView"];
    syncRendererSettings();
  });
  element("vsm-rebuild").addEventListener("click", () => {
    renderer?.invalidateVsmPages();
    dirty.textContent = "已应用";
  });
  element("vsm-reset").addEventListener("click", () => {
    Object.assign(vsmState, VSM_DEFAULT_SETTINGS);
    syncVsmInputs();
    syncRendererSettings();
  });
  const renderScaleInput = element<HTMLInputElement>("render-scale");
  renderScaleInput.addEventListener("input", () => {
    renderScale = renderScaleInput.valueAsNumber;
    element<HTMLOutputElement>("render-scale-value").textContent = `${Math.round(renderScale * 100)}%`;
    syncRendererSettings();
  });
  element("frame-scene").addEventListener("click", () => {
    camera.transform.position.set(72, 38, 92);
    camera.transform.lookAt({ x: 0, y: 12, z: 0 });
    orbit.target.set(0, 12, 0);
    renderer?.invalidateTemporalHistory();
  });
  element("fullscreen").addEventListener("click", () => {
    void document.documentElement.requestFullscreen?.();
  });
  element("export").addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sky-atmosphere-${renderer?.frame_count ?? 0}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  });
  panelToggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    panelBody.hidden = collapsed;
    panelToggle.setAttribute("aria-expanded", String(!collapsed));
    panelToggle.replaceChildren();
    panelToggle.append(document.createElement("i"));
    panelToggle.querySelector("i")!.setAttribute("data-lucide", collapsed ? "panel-right-open" : "panel-right-close");
    createIcons({ icons: { PanelRightClose, PanelRightOpen } });
  });
  element<HTMLSelectElement>("exposure-mode").value = autoExposure ? "auto" : "fixed";
  element<HTMLInputElement>("fixed-exposure").value = String(fixedExposure);
  element("exposure-mode").addEventListener("change", () => {
    const next = new URL(location.href);
    next.searchParams.set("exposure", element<HTMLSelectElement>("exposure-mode").value);
    next.searchParams.set("fixedExposure", element<HTMLInputElement>("fixed-exposure").value);
    location.assign(next.href);
  });
  element("fixed-exposure").addEventListener("change", () => {
    if (autoExposure) return;
    const next = new URL(location.href);
    next.searchParams.set("fixedExposure", element<HTMLInputElement>("fixed-exposure").value);
    location.assign(next.href);
  });
  window.addEventListener("resize", resize);
}

function syncVsmInputs(): void {
  for (const [id, value, digits] of [
    ["vsm-radius", vsmState.filterRadiusTexels, 2],
    ["vsm-depth-bias", vsmState.depthBiasTexels, 2],
    ["vsm-angular-bias", vsmState.angularBiasTexels, 2],
    ["vsm-coverage", vsmState.clipExtentScale, 2]
  ] as const) {
    const input = element<HTMLInputElement>(id);
    input.value = String(value);
    updateRange(id, value, digits);
  }
  element<HTMLSelectElement>("vsm-filter").value = vsmState.filterMode;
  element<HTMLSelectElement>("vsm-debug-view").value = vsmState.debugView;
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU，请使用支持 WebGPU 的浏览器。");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  skyScene = createSkyScene();
  wireControls();
  setPhase("初始化 WebGPU…");
  renderer = new Renderer({
    autoExposure,
    fixedExposure,
    enableVsm: true,
    enablePhysicalEnvironment: true,
    ambientOcclusion: {
      enabled: false
    },
    renderScale,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
  });
  renderer.bloom_enabled = false;
  await renderer.initialize({ context });
  resize();
  applySettings();
  setPhase("准备程序化场景…");
  const cooker = await createDefaultWebGeometryCookerModule();
  const product = await cookSceneGeometryProductV1(skyScene.scene, {
    module: cooker,
    producerId: "sky-atmosphere-mesa-commons",
    producerVersion: "1",
    maxDecodedProductBytes: 64 * 1024 * 1024
  });
  await renderer.uploadCookedSceneProduct(skyScene.scene, product);
  running = true;
  setPhase(`就绪 · ${skyScene.metadata.instances} 个实例 / ${skyScene.metadata.triangles} 三角形`);
  refreshDiagnostics();
  window.skyModuleDemo = { report };
  requestAnimationFrame(frame);
}

window.addEventListener("pagehide", () => {
  disposed = true;
  running = false;
  orbit.dispose();
  renderer?.destroy();
}, { once: true });

void start().catch(fail);
