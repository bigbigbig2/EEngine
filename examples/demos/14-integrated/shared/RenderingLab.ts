import {
  DirectionalLight,
  createDefaultWebCookWorker,
  load_environment_map,
  load_gltf_packed,
  load_gltf_web_product,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  type PackedGltfSource,
  type PackedSceneSource,
  type StandardShadeMaterial,
  type VirtualGeometrySceneSource
} from "../../../../OEngine/src/index.ts";

import { GeometryPackagePipeline } from "./GeometryPackagePipeline.ts";
import { PerformancePanel } from "./PerformancePanel.ts";
import "./performance-panel.css";

export type LabVariant = "basic" | "full";

export interface RenderingLabOptions {
  readonly modelUrl?: string;
  readonly modelName?: string;
  readonly modelLabel?: string;
  readonly comparisonExampleId?: string;
  readonly geometryCacheKey?: string;
  readonly geometryManifestUrl?: string;
  /** `web-product` routes geometry through the Runtime-first Web Cooker; `packed` keeps the V2 path. */
  readonly geometryRoute?: "packed" | "web-product";
}

type Bounds = {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly center: [number, number, number];
  readonly radius: number;
};

interface LabScene {
  readonly count: number;
  readonly geometryCount: number;
  readonly materials: readonly StandardShadeMaterial[];
  readonly bounds: Bounds;
}

const DEFAULT_MODEL_URL = new URL(
  "../../../assets/three/rendering-lab/dungeon_warkarma.glb",
  import.meta.url
).href;
const canvas = requireElement<HTMLCanvasElement>("#viewport");
const status = requireElement<HTMLDivElement>("#status");
const statusStage = requireElement<HTMLElement>("#status-stage");
const statusDetail = requireElement<HTMLElement>("#status-detail");
const statusProgress = requireElement<HTMLElement>("#status-progress");

let renderer: Renderer | undefined;
let rendererReady = false;
let controls: OrbitControls | undefined;
let resizeObserver: ResizeObserver | undefined;
let animationFrame = 0;
let disposed = false;
let performancePanel: PerformancePanel | undefined;
let variant: LabVariant = "basic";
let modelUrl = DEFAULT_MODEL_URL;
let modelName = "dungeon_warkarma.glb";
let modelLabel = "Dungeon by Warkarma";
let comparisonExampleId = "rendering-lab";
let geometryCacheKey: string | undefined;
let geometryManifestUrl: string | undefined;
let geometryRoute: "packed" | "web-product" = "packed";
let geometryPackages: GeometryPackagePipeline | undefined;
const multiBinFixture = new URLSearchParams(window.location.search).get("multiBin") === "1";

async function start(): Promise<void> {
  if (navigator.gpu === undefined) {
    throw new Error("WebGPU is unavailable. Open this page on localhost in a WebGPU-capable browser.");
  }

  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Failed to create a WebGPU canvas context");

  setLoading("Renderer", "Initializing WebGPU...", 0.04);
  const activeRenderer = new Renderer({
    debug: false,
    ...(geometryRoute === "web-product" ? { requiredLimits: { maxStorageBuffersPerShaderStage: 14 } } : {}),
    ...(geometryManifestUrl === undefined ? {} : {
      textureMaxResolution: 256 as const,
      textureBankMaxCapacities: [64, 40, 72, 160, 288] as const,
      geometryResidency: {
        maxUploadBytes: 640 * 1024 * 1024,
        maxResidentBytes: 1024 * 1024 * 1024
      }
    }),
    renderSettings: {
      features: {
        shadows: variant === "full",
        screenSpaceDiffuseMode: variant === "full" ? "gtao" : "off",
        screenSpaceReflections: variant === "full",
        temporalAntiAliasing: variant === "full",
        bloom: variant === "full",
        automaticExposure: variant === "full",
        motionBlur: variant === "full",
        sharpening: variant === "full"
      },
      ao: { resolutionScale: 0.5, temporalEnabled: true },
      ssr: { resolutionScale: 0.5, temporalEnabled: true },
      resolution: { mode: "fixed", internalScale: 1 }
    }
  });
  renderer = activeRenderer;
  await activeRenderer.initialize({
    context,
    pixelRatio: window.devicePixelRatio
  });
  rendererReady = true;
  activeRenderer.packed_visibility_cone_enabled = geometryManifestUrl === undefined;
  activeRenderer.packed_visibility_hzb_enabled = geometryManifestUrl === undefined;
  activeRenderer.packed_visibility_sse_threshold = 4;
  if (disposed) return;

  const activeScene = new Scene();
  if (variant === "full") {
    const environmentUrl = new URL("../../../assets/three/rendering-lab/venice_sunset_1k.hdr", import.meta.url).href;
    activeScene.lights.environment = await load_environment_map(environmentUrl);
    if (disposed) return;
    const sun = new DirectionalLight();
    sun.name = "Rendering Lab Sun";
    sun.intensity = 2.8;
    sun.casts_shadow = true;
    const azimuth = -36 * Math.PI / 180;
    const elevation = 65 * Math.PI / 180;
    sun.forward = [Math.cos(elevation) * Math.cos(azimuth), -Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
    activeScene.addChild(sun);
  }
  if (variant === "basic" && multiBinFixture) {
    const sun = new DirectionalLight();
    sun.name = "Multi-bin fixture light";
    sun.intensity = 1.5;
    sun.casts_shadow = false;
    sun.forward = [0.25, -0.8, 0.45];
    activeScene.addChild(sun);
  }

  const lab = geometryRoute === "web-product"
    ? await loadWebProductLab(activeRenderer, activeScene)
    : await loadPackedLab(activeRenderer, activeScene);
  if (disposed) return;

  const activeCamera = createCamera(activeRenderer, lab.bounds);
  controls = new OrbitControls(activeCamera, canvas);
  controls.target.set(...lab.bounds.center);
  controls.minDistance = Math.max(0.25, lab.bounds.radius * 0.1);
  controls.maxDistance = lab.bounds.radius * 12;
  controls.enableDamping = true;
  controls.update(0);

  performancePanel = new PerformancePanel({
    renderer: activeRenderer, camera: activeCamera, controls, canvas, variant,
    comparisonExampleId,
    scene: { model: `${modelName}${multiBinFixture ? " (multi-bin fixture)" : ""}`, instances: lab.count, geometries: lab.geometryCount, materials: lab.materials.length },
    resetCamera: () => {
      activeCamera.transform.position.set(lab.bounds.center[0] + lab.bounds.radius * 1.5, lab.bounds.center[1] + lab.bounds.radius * 0.8, lab.bounds.center[2] + lab.bounds.radius * 1.8);
      controls!.target.set(...lab.bounds.center);
      controls!.reset();
      activeRenderer.indicate_view_change();
    }
  });
  startResizeObserver(activeRenderer, activeCamera);

  status.dataset.state = "ready";
  setLoading("Ready", `${lab.count} model instances · ${variant === "basic" ? "Unlit" : "PBR"}${multiBinFixture ? " · multi-bin fixture" : ""} · performance panel ready`, 1);
  startFrameLoop(activeRenderer, activeScene, activeCamera);
}

function emptyLab(): LabScene {
  return { count: 0, geometryCount: 0, materials: [], bounds: { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1 } };
}

/** V2 path: full glTF object graph, Worker geometry cooking, GeometryAssetPackage upload. */
async function loadPackedLab(activeRenderer: Renderer, activeScene: Scene): Promise<LabScene> {
  setLoading("Assets", `Loading ${modelLabel}...`, 0.1);
  const imported = await load_gltf_packed(modelUrl);
  if (disposed) return emptyLab();
  if (variant === "basic") {
    for (const material of imported.materials) material.is_unlit = true;
  }
  if (multiBinFixture && imported.materials.length > 0) {
    const materialIndex = imported.materialIndices.find((index) => index >= 0) ?? 0;
    const fixtureMaterial = imported.materials[materialIndex];
    if (fixtureMaterial === undefined) throw new Error(`Multi-bin fixture material ${materialIndex} is unavailable`);
    if (variant === "full") {
      // Keep the full scene's PBR materials and introduce one real UnlitTexture
      // association through the normal material ABI.
      fixtureMaterial.is_unlit = true;
    } else {
      // Basic normally only has UnlitFactor associations; make one referenced
      // material PBR so the fixture exercises a second program identity.
      fixtureMaterial.is_unlit = false;
    }
  }
  const packed = await createRenderingLab(imported);
  if (disposed) return emptyLab();
  setLoading(
    "GPU residency",
    `Uploading ${packed.source.geometries.length} geometry packages, ${packed.source.materials.length} materials, and ${packed.source.count} instances...`,
    0.9
  );
  await activeRenderer.uploadPackedScene(activeScene, packed.source);
  return { count: packed.source.count, geometryCount: packed.source.geometries.length, materials: packed.source.materials, bounds: packed.bounds };
}

/** Runtime-first path: GLB -> Web Worker/WASM CookSession -> shared Product admission. */
async function loadWebProductLab(activeRenderer: Renderer, activeScene: Scene): Promise<LabScene> {
  setLoading("Assets", `Loading ${modelLabel} via Web Runtime Cooker...`, 0.1);
  const runtimeProfile = new URLSearchParams(window.location.search).get("profile") === "isolated-pthreads" ? "isolated-pthreads" : "portable-single";
  const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 128 * 1024 * 1024, maxDecodedProductBytes: 512 * 1024 * 1024, runtimeProfile });
  const asset = load_gltf_web_product(modelUrl, {
    worker,
    runtimeProfile,
    sessionId: `rendering-lab-${crypto.randomUUID()}`,
    sessionGeneration: 1,
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 128 * 1024 * 1024, maxWasmBytes: 128 * 1024 * 1024, maxOutputBytes: 256 * 1024 * 1024, maxQueuedEvents: 1024 },
    initialOutputPageCredits: 64,
    maxBufferedPages: 64,
    maxBufferedBytes: 64 * 262144
  });
  setLoading("GPU residency", "Cooking and uploading the Web Product...", 0.4);
  const handles = await activeRenderer.uploadWebCookedScene(activeScene, asset, {
    fitHeight: 5.4,
    fitBase: [0, -1, 0],
    onMaterials: (materials) => { if (variant === "basic") for (const material of materials) material.is_unlit = true; }
  });
  return { count: handles.source.count, geometryCount: handles.source.assetCount, materials: handles.materials, bounds: computeSphereBounds(handles.source) };
}

function computeSphereBounds(source: VirtualGeometrySceneSource): Bounds {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  if (source.boundsMin !== undefined && source.boundsMax !== undefined) {
    for (let index = 0; index < source.count; index++) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis]!, source.boundsMin[index * 3 + axis]!);
        maximum[axis] = Math.max(maximum[axis]!, source.boundsMax[index * 3 + axis]!);
      }
    }
  } else {
    for (let index = 0; index < source.count; index++) {
      const x = source.boundsSpheres[index * 4]!, y = source.boundsSpheres[index * 4 + 1]!, z = source.boundsSpheres[index * 4 + 2]!, radius = source.boundsSpheres[index * 4 + 3]!;
      minimum[0] = Math.min(minimum[0]!, x - radius); minimum[1] = Math.min(minimum[1]!, y - radius); minimum[2] = Math.min(minimum[2]!, z - radius);
      maximum[0] = Math.max(maximum[0]!, x + radius); maximum[1] = Math.max(maximum[1]!, y + radius); maximum[2] = Math.max(maximum[2]!, z + radius);
    }
  }
  const center: [number, number, number] = [(minimum[0]! + maximum[0]!) * 0.5, (minimum[1]! + maximum[1]!) * 0.5, (minimum[2]! + maximum[2]!) * 0.5];
  return Object.freeze({
    min: minimum as [number, number, number],
    max: maximum as [number, number, number],
    center,
    radius: Math.max(1, 0.5 * Math.hypot(maximum[0]! - minimum[0]!, maximum[1]! - minimum[1]!, maximum[2]! - minimum[2]!))
  });
}

async function createRenderingLab(imported: PackedGltfSource): Promise<{
  readonly source: PackedSceneSource;
  readonly bounds: Bounds;
}> {
  geometryPackages = new GeometryPackagePipeline();
  const geometries = await geometryPackages.prepare(imported.geometries, {
    cacheKey: geometryCacheKey,
    manifestUrl: geometryManifestUrl,
    onProgress: ({ stage, completed, total }) => {
      const label = stage === "pre-cooked"
        ? "Loading pre-cooked geometry packages"
        : stage === "cache"
          ? "Restoring cached geometry packages"
          : "Building meshlets and renderable LOD hierarchy in a Worker";
      setLoading(
        stage === "cook" ? "Geometry cooking" : "Geometry packages",
        `${label} ${completed}/${total}...`,
        0.18 + completed / Math.max(1, total) * 0.68
      );
    }
  });
  const currentTransforms = fitPackedTransforms(imported, 5.4, [0, -1, 0]);

  return Object.freeze({
    source: Object.freeze({
      geometries,
      materials: imported.materials,
      count: imported.geometryIndices.length,
      geometryIndices: imported.geometryIndices,
      materialIndices: imported.materialIndices,
      currentTransforms,
      previousTransforms: currentTransforms.slice(),
      boundsSpheres: imported.boundsSpheres,
      boundsMin: imported.boundsMin,
      boundsMax: imported.boundsMax,
      flags: imported.flags,
      debugIds: imported.debugIds
    }),
    bounds: Object.freeze(computeWorldBounds(imported, currentTransforms))
  });
}

function fitPackedTransforms(
  source: PackedGltfSource,
  targetHeight: number,
  targetBase: readonly [number, number, number]
): Float32Array {
  const bounds = computeWorldBounds(source);
  const height = Math.max(1e-5, bounds.max[1] - bounds.min[1]);
  const scale = targetHeight / height;
  const targetCenter: readonly [number, number, number] = [
    targetBase[0],
    targetBase[1] + (bounds.center[1] - bounds.min[1]) * scale,
    targetBase[2]
  ];
  const output = source.transforms.slice();
  for (let offset = 0; offset < output.length; offset += 16) {
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        const element = offset + column * 4 + row;
        output[element] = output[element]! * scale;
      }
    }
    output[offset + 12] = targetCenter[0] + (output[offset + 12]! - bounds.center[0]) * scale;
    output[offset + 13] = targetCenter[1] + (output[offset + 13]! - bounds.center[1]) * scale;
    output[offset + 14] = targetCenter[2] + (output[offset + 14]! - bounds.center[2]) * scale;
  }
  return output;
}

function computeWorldBounds(source: PackedGltfSource, transformedTransforms = source.transforms): Bounds {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let instance = 0; instance < source.geometryIndices.length; instance++) {
    const boundsOffset = instance * 3;
    const matrixOffset = instance * 16;
    for (let corner = 0; corner < 8; corner++) {
      const localX = corner & 1 ? source.boundsMax[boundsOffset]! : source.boundsMin[boundsOffset]!;
      const localY = corner & 2 ? source.boundsMax[boundsOffset + 1]! : source.boundsMin[boundsOffset + 1]!;
      const localZ = corner & 4 ? source.boundsMax[boundsOffset + 2]! : source.boundsMin[boundsOffset + 2]!;
      const worldX = transformedTransforms[matrixOffset]! * localX +
        transformedTransforms[matrixOffset + 4]! * localY +
        transformedTransforms[matrixOffset + 8]! * localZ +
        transformedTransforms[matrixOffset + 12]!;
      const worldY = transformedTransforms[matrixOffset + 1]! * localX +
        transformedTransforms[matrixOffset + 5]! * localY +
        transformedTransforms[matrixOffset + 9]! * localZ +
        transformedTransforms[matrixOffset + 13]!;
      const worldZ = transformedTransforms[matrixOffset + 2]! * localX +
        transformedTransforms[matrixOffset + 6]! * localY +
        transformedTransforms[matrixOffset + 10]! * localZ +
        transformedTransforms[matrixOffset + 14]!;
      minimum[0] = Math.min(minimum[0]!, worldX);
      minimum[1] = Math.min(minimum[1]!, worldY);
      minimum[2] = Math.min(minimum[2]!, worldZ);
      maximum[0] = Math.max(maximum[0]!, worldX);
      maximum[1] = Math.max(maximum[1]!, worldY);
      maximum[2] = Math.max(maximum[2]!, worldZ);
    }
  }
  const center: [number, number, number] = [
    (minimum[0]! + maximum[0]!) * 0.5,
    (minimum[1]! + maximum[1]!) * 0.5,
    (minimum[2]! + maximum[2]!) * 0.5
  ];
  return {
    min: minimum as [number, number, number],
    max: maximum as [number, number, number],
    center,
    radius: Math.max(
      1,
      0.5 * Math.hypot(
        maximum[0]! - minimum[0]!,
        maximum[1]! - minimum[1]!,
        maximum[2]! - minimum[2]!
      )
    )
  };
}

function createCamera(activeRenderer: Renderer, bounds: Bounds): PerspectiveCamera {
  const activeCamera = new PerspectiveCamera();
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.near = Math.max(0.01, bounds.radius / 5000);
  activeCamera.far = Math.max(100, bounds.radius * 24);
  activeCamera.transform.position.set(
    bounds.center[0] + bounds.radius * 1.5,
    bounds.center[1] + bounds.radius * 0.8,
    bounds.center[2] + bounds.radius * 1.8
  );
  activeCamera.update();
  return activeCamera;
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

function startFrameLoop(
  activeRenderer: Renderer,
  activeScene: Scene,
  activeCamera: PerspectiveCamera
): void {
  let previousTime = performance.now();
  const frame = (time: number): void => {
    if (disposed) return;
    const rafIntervalMs = Math.max(0, time - previousTime);
    const deltaSeconds = Math.min(0.1, rafIntervalMs / 1000);
    previousTime = time;

    performancePanel?.beforeFrame(time);
    controls?.update(deltaSeconds);
    activeCamera.aspect = activeRenderer.aspect_ratio;
    activeCamera.update();
    activeRenderer.profiler.recordExternalMetric("frame.rafIntervalMs", rafIntervalMs);
    const rendered = activeRenderer.render(activeCamera, activeScene, deltaSeconds);
    if (!rendered && activeRenderer.profiler.diagnostics.deviceLostCount > 0) {
      showFatalError(new Error("The WebGPU device was lost and rendering stopped."));
      return;
    }
    // A feature change can temporarily defer rendering while a new shading
    // publication compiles. Keep the RAF loop alive during that preparation.
    performancePanel?.afterFrame(time);
    animationFrame = requestAnimationFrame(frame);
  };
  animationFrame = requestAnimationFrame(frame);
}

function setLoading(stage: string, detail: string, progress: number): void {
  statusStage.textContent = stage;
  statusDetail.textContent = detail;
  statusProgress.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
}

function showFatalError(error: unknown): void {
  if (disposed) return;
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  status.dataset.state = "error";
  setLoading("Example failed", message, 1);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  performancePanel?.dispose();
  controls?.dispose();
  geometryPackages?.dispose();
  if (rendererReady) renderer?.destroy();
  canvas.getContext("webgpu")?.unconfigure();
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Rendering Lab requires ${selector}`);
  return element;
}

window.addEventListener("pagehide", dispose, { once: true });

export function startRenderingLab(
  selectedVariant: LabVariant,
  options: Readonly<RenderingLabOptions> = {}
): void {
  variant = selectedVariant;
  modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
  modelName = options.modelName ?? "dungeon_warkarma.glb";
  modelLabel = options.modelLabel ?? "Dungeon by Warkarma";
  comparisonExampleId = options.comparisonExampleId ??
    (selectedVariant === "basic" ? "rendering-lab" : "rendering-lab-basic");
  geometryCacheKey = options.geometryCacheKey;
  geometryManifestUrl = options.geometryManifestUrl;
  const routeOverride = new URLSearchParams(window.location.search).get("route");
  geometryRoute = routeOverride === "packed" || routeOverride === "web-product"
    ? routeOverride
    : (options.geometryRoute ?? (selectedVariant === "basic" ? "web-product" : "packed"));
  start().catch(showFatalError);
}
