import {
  cookSceneGeometryProductV1,
  createDefaultWebGeometryCookerModule,
  OrbitControls,
  PerspectiveCamera,
  Renderer
} from "../../../OEngine/src/index.ts";
import { createBasicCubeScene } from "./scene.ts";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing hello-cube element #${id}`);
  }
  return value as T;
};

const canvas = element<HTMLCanvasElement>("viewport");
const phase = element("phase");
const sceneState = element("scene-state");
const fpsOutput = element("quick-fps");
const errorOutput = element("error");
const resetCamera = element<HTMLButtonElement>("reset-camera");

const camera = new PerspectiveCamera();
camera.near = 0.05;
camera.far = 100;
camera.fov_degrees = 42;

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 4.5;
orbit.maxDistance = 24;
orbit.target.set(0, 0.8, 0);
camera.transform.position.set(8.5, 6.2, 9.5);
camera.transform.lookAt({ x: 0, y: 0.8, z: 0 });
camera.update();
orbit.reset();

let renderer: Renderer | undefined;
let running = false;
let disposed = false;
let lastTime = performance.now();
let lastFpsTime = lastTime;
let submittedFrameAtSample = 0;

function setPhase(text: string): void {
  phase.textContent = text;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  running = false;
  setPhase("初始化失败");
  errorOutput.textContent = message;
  console.error(error);
}

function resize(): void {
  if (!renderer) {
    return;
  }
  const width = Math.max(320, window.innerWidth);
  const height = Math.max(240, window.innerHeight);
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
  orbit.updateViewportSize();
}

function resetCameraView(): void {
  camera.transform.position.set(8.5, 6.2, 9.5);
  camera.transform.lookAt({ x: 0, y: 0.8, z: 0 });
  camera.update();
  orbit.target.set(0, 0.8, 0);
  orbit.reset();
  renderer?.invalidateTemporalHistory();
}

function frame(time: number): void {
  if (disposed) {
    return;
  }
  requestAnimationFrame(frame);
  if (!running || !renderer) {
    return;
  }

  const delta = Math.min(Math.max((time - lastTime) / 1000, 0), 0.1);
  lastTime = time;
  orbit.update(delta);
  renderer.render(camera, scene, delta);

  const sampleDuration = time - lastFpsTime;
  if (sampleDuration >= 500) {
    const submittedFrames = renderer.frame_count - submittedFrameAtSample;
    fpsOutput.textContent = `${Math.round((submittedFrames * 1000) / sampleDuration)} FPS`;
    submittedFrameAtSample = renderer.frame_count;
    lastFpsTime = time;
  }
}

const { scene, metadata } = createBasicCubeScene();

async function start(): Promise<void> {
  if (!navigator.gpu) {
    throw new Error("当前浏览器没有 WebGPU，请使用支持 WebGPU 的浏览器。");
  }
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("无法创建 WebGPU canvas context。");
  }

  setPhase("创建最小 Renderer");
  renderer = new Renderer({
    autoExposure: false,
    fixedExposure: 1,
    enableVsm: false,
    enablePhysicalEnvironment: false,
    ambientOcclusion: {
      enabled: false
    },
    renderScale: 1
  });
  await renderer.initialize({ context });

  // Keep this example as a stable native baseline: no HZB, temporal
  // reconstruction, jitter, bloom, or post-process history.
  renderer.packed_visibility_hzb_enabled = false;
  renderer.packed_visibility_current_hzb_late_recheck_enabled = false;
  renderer.fsr3_enabled = false;
  renderer.temporal_jitter_enabled = false;
  renderer.bloom_enabled = false;

  resize();
  setPhase("烘焙 GeometryProduct");
  const cooker = await createDefaultWebGeometryCookerModule();
  const product = await cookSceneGeometryProductV1(scene, {
    module: cooker,
    producerId: "hello-cube",
    producerVersion: "1",
    maxDecodedProductBytes: 16 * 1024 * 1024
  });

  setPhase("发布 Virtual Geometry");
  await renderer.uploadCookedSceneProduct(scene, product);
  sceneState.textContent = `${metadata.instances} meshes · ${metadata.triangles} triangles`;
  setPhase("就绪 · 拖动旋转，滚轮缩放");
  running = true;
  submittedFrameAtSample = renderer.frame_count;
  lastTime = performance.now();
  lastFpsTime = lastTime;
  requestAnimationFrame(frame);
}

resetCamera.addEventListener("click", resetCameraView);
window.addEventListener("resize", resize);
window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    running = false;
    orbit.dispose();
    renderer?.destroy();
  },
  { once: true }
);

void start().catch(fail);
