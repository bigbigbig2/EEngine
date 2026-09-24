import {
  load_oegpack_product, OrbitControls, parseOegPackSceneManifestV3, PerspectiveCamera,
  RenderDebugView, Renderer, resolveOegPackScenePackUrlV3, Scene,
  type OegPackProductAsset, type ProductSceneHandles
} from "../../../../OEngine/src/index.ts";
import { LargeBasicPanel } from "./panel.ts";
import { LargeBasicTelemetry } from "./telemetry.ts";

const manifestUrl = "/assets/oengine/offline-large/scene.oescene";
const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const telemetry = new LargeBasicTelemetry();
const scene = new Scene();
const abort = new AbortController();
let renderer: Renderer | undefined;
let asset: OegPackProductAsset | undefined;
let handles: ProductSceneHandles | undefined;
let controls: OrbitControls | undefined;
let camera: PerspectiveCamera | undefined;
let framing: SceneFraming | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;
let refreshId = 0;
let closing = false;
let meshletView = true;

const panel = new LargeBasicPanel(telemetry, {
  center: () => placeCamera(false), overview: () => placeCamera(true),
  reload: () => location.reload(), release: () => { void release(); }
});
document.querySelector("#meshlet-view")!.addEventListener("click", () => setColorMode(true));
document.querySelector("#solid-view")!.addEventListener("click", () => setColorMode(false));
void start().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  telemetry.error = message;
  telemetry.event("加载失败", message);
  console.error(error);
  panel.paint();
  void release();
});

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("此浏览器没有可用的 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  const manifestResponse = await fetch(manifestUrl, { headers: { "Accept-Encoding": "identity" } });
  if (!manifestResponse.ok) throw new Error(`离线 scene manifest 不可用：HTTP ${manifestResponse.status}`);
  const manifestText = await manifestResponse.text();
  const manifest = parseOegPackSceneManifestV3(manifestText);
  const manifestUrlAbsolute = new URL(manifestUrl, window.location.href).href;
  const packUrl = resolveOegPackScenePackUrlV3(manifestUrlAbsolute, manifest.packs[0]!);
  telemetry.manifest = manifest;
  telemetry.event("离线 manifest 就绪", `${manifest.assets.length} assets / ${manifest.instances.length} instances`);
  renderer = new Renderer({
    debug: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    renderSettings: {
      resolution: { mode: "fixed", internalScale: 1 },
      features: {
        shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false,
        temporalAntiAliasing: false, bloom: false, automaticExposure: false,
        motionBlur: false, sharpening: false
      }
    }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(devicePixelRatio, 2) });
  if (closing) return;
  renderer.render_debug_view = meshletView ? RenderDebugView.MeshletId : RenderDebugView.None;
  renderer.packed_visibility_cone_enabled = true;
  renderer.packed_visibility_hzb_enabled = true;
  renderer.packed_visibility_sse_threshold = 4;
  renderer.profiler.configure({ enabled: true, gpuSampleInterval: 8, gpuCounterSampleInterval: 16, historyCapacity: 400, cpuPassTimings: true });
  renderer.profiler.subscribe(frame => telemetry.acceptFrame(frame));
  telemetry.adapter = { identity: renderer.adapter_info, gpuTimestamp: renderer.profiler.gpuTimestampAvailable, features: renderer.capabilities.features };
  telemetry.event("WebGPU 就绪", renderer.adapter_info?.device ?? "adapter");

  asset = await load_oegpack_product({ kind: "http-range", url: packUrl, manifestUrl: manifestUrlAbsolute }, { signal: abort.signal });
  telemetry.offline = asset.evidence();
  telemetry.openedAt = performance.now() - telemetry.startedAt;
  telemetry.event("OEGPACK 已打开", `${telemetry.offline.pageCount} pages / ${telemetry.offline.fileBytes} bytes`);
  refreshId = window.setInterval(refresh, 500);
  handles = await renderer.uploadOegPackScene(scene, asset, { signal: abort.signal, fitHeight: 10, fitBase: [0, -5, 0] });
  if (closing) return;
  framing = sceneFraming(handles.current().source);
  telemetry.sourceCount = handles.current().source.count;
  telemetry.firstPublishedAt = performance.now() - telemetry.startedAt;
  telemetry.event("离线 Product 发布", `${telemetry.sourceCount} instances`);
  camera = new PerspectiveCamera();
  camera.near = Math.max(0.001, framing.radius / 10000);
  camera.far = Math.max(100, framing.radius * 30);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = Math.max(0.02, framing.radius / 1000);
  controls.maxDistance = framing.radius * 15;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  placeCamera(false);
  let previous = performance.now();
  const frame = (now: number) => {
    if (closing || !renderer || !camera) return;
    const interval = Math.max(0, now - previous);
    previous = now;
    const delta = Math.min(0.1, interval / 1000);
    controls?.update(delta);
    camera.update();
    renderer.profiler.recordExternalMetric("frame.rafIntervalMs", interval);
    const submitted = renderer.render(camera, scene, delta);
    if (submitted && telemetry.firstSubmittedAt === undefined) {
      telemetry.firstSubmittedAt = performance.now() - telemetry.startedAt;
      telemetry.event("首次提交画面");
    }
    if (renderer.profiler.diagnostics.deviceLostCount > 0) {
      telemetry.error = "WebGPU 设备丢失";
      panel.paint();
      return;
    }
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  await handles.settled();
  if (closing) return;
  telemetry.settledAt = performance.now() - telemetry.startedAt;
  telemetry.event("离线 Product settled", `${telemetry.sourceCount} instances`);
  refresh();
}

function setColorMode(meshlet: boolean): void {
  meshletView = meshlet;
  if (renderer) renderer.render_debug_view = meshlet ? RenderDebugView.MeshletId : RenderDebugView.None;
  document.querySelector("#meshlet-view")!.setAttribute("aria-pressed", String(meshlet));
  document.querySelector("#solid-view")!.setAttribute("aria-pressed", String(!meshlet));
  document.querySelector("#color-caption")!.textContent = meshlet ? "MESHLET ID" : "UNLIT";
  panel.setColorMode(meshlet ? "meshlet" : "solid");
}

function placeCamera(overview: boolean): void {
  if (!camera || !controls || !framing || !renderer) return;
  const currentFraming = framing;
  const center = currentFraming.center;
  const extent = currentFraming.max.map((value, axis) => value - currentFraming.min[axis]!);
  const mainAxis = extent.indexOf(Math.max(...extent));
  const shortExtent = Math.max(0.1, ...extent.filter((_, axis) => axis !== mainAxis));
  const distance = overview ? currentFraming.radius * 2.6 : Math.max(0.7, shortExtent * 2.8);
  const eye = [center[0], center[1] + distance * 0.38, center[2]];
  eye[mainAxis === 2 ? 0 : 2]! += distance * 1.55;
  camera.transform.position.set(eye[0]!, eye[1]!, eye[2]!);
  camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
  controls.target.set(...center);
  controls.reset();
  renderer.indicate_view_change();
  telemetry.event(overview ? "全览视角" : "中心视角");
}

function resize(): void {
  if (!renderer || !camera) return;
  renderer.resize(Math.max(1, Math.round(canvas.clientWidth)), Math.max(1, Math.round(canvas.clientHeight)));
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}

function refresh(): void {
  if (!renderer || closing) return;
  telemetry.offline = asset?.evidence() ?? null;
  telemetry.runtime = handles?.admission.evidence() ?? null;
  telemetry.streaming = handles?.current().streaming?.evidence() ?? null;
  telemetry.acceptMemory(renderer.memoryEvidence());
  telemetry.peakGpuBytes = Math.max(telemetry.peakGpuBytes, renderer.profiler.latest?.counters["gpu.residentBytes"] ?? 0);
  telemetry.adapter = { ...(telemetry.adapter as object), deviceErrors: renderer.profiler.diagnostics.uncapturedErrorCount + renderer.profiler.diagnostics.validationErrorCount };
  panel.paint();
}

async function release(): Promise<void> {
  if (closing) return;
  closing = true;
  abort.abort(new Error("demo released"));
  cancelAnimationFrame(frameId);
  clearInterval(refreshId);
  resizeObserver?.disconnect();
  controls?.dispose();
  try {
    if (handles && renderer) {
      await renderer.releaseVirtualGeometryScene(scene);
      handles.current().streaming?.destroy();
      handles.admission.retireActive();
      handles.admission.retireReplaced();
    }
    asset?.release();
  } catch (error) {
    telemetry.error ??= error instanceof Error ? error.message : String(error);
    asset?.release();
  } finally {
    renderer?.destroy();
    canvas.getContext("webgpu")?.unconfigure();
    telemetry.disposedAt = performance.now() - telemetry.startedAt;
    telemetry.event("资源已释放");
    panel.paint();
  }
}

window.addEventListener("pagehide", () => { void release(); }, { once: true });

type SceneFraming = Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number]; center: readonly [number, number, number]; radius: number }>;

function sceneFraming(source: { readonly count: number; readonly boundsSpheres: Float32Array }): SceneFraming {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const x = source.boundsSpheres[index * 4]!, y = source.boundsSpheres[index * 4 + 1]!, z = source.boundsSpheres[index * 4 + 2]!, radius = source.boundsSpheres[index * 4 + 3]!;
    minX = Math.min(minX, x - radius); minY = Math.min(minY, y - radius); minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius); maxY = Math.max(maxY, y + radius); maxZ = Math.max(maxZ, z + radius);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) throw new Error("离线场景没有可用边界");
  const min = [minX, minY, minZ] as const, max = [maxX, maxY, maxZ] as const;
  const center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as const;
  return Object.freeze({ min, max, center, radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) });
}
