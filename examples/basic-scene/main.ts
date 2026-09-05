import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type GeometryAssetPackage,
  type PackedSceneSource
} from "../../OEngine/src/index.ts";
import { Inspector } from "../../OEngine/src/addons/inspector/index.ts";

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");

let renderer: Renderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let inspector: Inspector | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest = 0;
let disposed = false;

void initialize().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = message;
  status.style.background = "#4a1720e6";
  console.error(error);
});

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable in this browser.");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Unable to create a WebGPU canvas context.");

  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio, 2) });
  activeRenderer.configure({
    features: {
      shadows: true,
      ambientOcclusion: false,
      screenSpaceReflections: false,
      temporalAntiAliasing: true,
      bloom: false,
      automaticExposure: false,
      motionBlur: false,
      sharpening: false
    }
  });

  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 3.2;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = true;
  activeScene.addChild(light);

  const source = await createBasicSceneSource();
  await activeRenderer.uploadPackedScene(activeScene, source);

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.transform.position.set(7, 5.5, 8);
  activeCamera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = 2;
  activeControls.distanceLimits.max = 30;
  activeControls.movement_speed_scale = 1.2;
  activeControls.from_transform(activeCamera.transform);

  resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  // This example owns its Inspector instance. It does not share UI state with
  // Rendering Lab; the addon only observes this example's renderer profiler.
  inspector = new Inspector(activeRenderer, {
    container: document.body,
    initialMode: "live",
    historyCapacity: 512,
    uiRefreshHz: 5,
    styles: "inline"
  });
  inspector.open();

  status.textContent = "运行中 · WebGPU";
  startFrameLoop();
}

async function createBasicSceneSource(): Promise<PackedSceneSource> {
  const geometrySources = [
    buildBoxSourceGeometry(2, 2, 2),
    buildBoxSourceGeometry(12, 0.12, 12)
  ];
  const recipe = createGeometryCookRecipe();
  const geometries: GeometryAssetPackage[] = [];
  for (const source of geometrySources) {
    geometries.push((await cookGeometryAssetPackage(source, recipe)).asset);
  }

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.1, 0.42, 0.95, 1);
  cubeMaterial.roughness_factor = 0.34;
  const planeMaterial = new StandardShadeMaterial();
  planeMaterial.diffuse_color.set(0.18, 0.2, 0.24, 1);
  planeMaterial.roughness_factor = 0.9;

  const currentTransforms = new Float32Array(32);
  writeTranslation(currentTransforms, 0, 0, 1.06, 0);
  writeTranslation(currentTransforms, 16, 0, -0.06, 0);
  return {
    geometries,
    materials: [cubeMaterial, planeMaterial],
    count: 2,
    geometryIndices: new Uint32Array([0, 1]),
    materialIndices: new Uint32Array([0, 1]),
    currentTransforms,
    previousTransforms: currentTransforms.slice(),
    boundsSpheres: new Float32Array([0, 1.06, 0, 1.7321, 0, -0.06, 0, 8.4853]),
    boundsMin: new Float32Array([-1, 0.06, -1, -6, -0.12, -6]),
    boundsMax: new Float32Array([1, 2.06, 1, 6, 0, 6]),
    flags: new Uint32Array([0, 0]),
    debugIds: new Uint32Array([1, 2])
  };
}

function writeTranslation(target: Float32Array, offset: number, x: number, y: number, z: number): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
}

function startFrameLoop(): void {
  let previousTime = performance.now();
  const frame = (now: number): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    const rafIntervalMs = Math.max(0, now - previousTime);
    const deltaSeconds = Math.min(0.1, rafIntervalMs / 1000);
    previousTime = now;
    controls?.update(deltaSeconds);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    renderer.profiler.recordExternalMetric("frame.rafIntervalMs", rafIntervalMs);
    if (!renderer.render(camera, scene, deltaSeconds)) {
      status.textContent = "WebGPU device lost";
      return;
    }
    frameRequest = requestAnimationFrame(frame);
  };
  frameRequest = requestAnimationFrame(frame);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameRequest);
  resizeObserver?.disconnect();
  controls?.pointer.stop();
  controls?.keyboard.stop();
  inspector?.dispose();
  inspector = null;
  renderer?.destroy();
  canvas.getContext("webgpu")?.unconfigure();
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
