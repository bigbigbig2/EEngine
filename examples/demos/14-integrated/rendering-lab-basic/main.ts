import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_gltf_packed,
  type GeometryAssetPackage,
  type PackedGltfSource,
  type PackedSceneSource
} from "../../../../OEngine/src/index.ts";

type Bounds = {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly center: [number, number, number];
  readonly radius: number;
};

const MODEL_URL = new URL(
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
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let resizeObserver: ResizeObserver | undefined;
let animationFrame = 0;
let disposed = false;
let sun: DirectionalLight | undefined;

const exampleSettings = {
  sunIntensity: 2.8,
  sunAzimuth: -36,
  sunElevation: 65
};

async function start(): Promise<void> {
  if (navigator.gpu === undefined) {
    throw new Error("WebGPU is unavailable. Open this page on localhost in a WebGPU-capable browser.");
  }

  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Failed to create a WebGPU canvas context");

  setLoading("Renderer", "Initializing WebGPU...", 0.04);
  const activeRenderer = new Renderer({
    debug: false,
    renderSettings: {
      features: {
        shadows: false,
        screenSpaceDiffuseMode: "off",
        screenSpaceReflections: false,
        temporalAntiAliasing: false,
        bloom: false,
        automaticExposure: false,
        motionBlur: false,
        sharpening: false
      }
    }
  });
  renderer = activeRenderer;
  await activeRenderer.initialize({
    context,
    pixelRatio: Math.min(window.devicePixelRatio, 1.5)
  });
  rendererReady = true;
  activeRenderer.internal_resolution_scale = 1;
  activeRenderer.packed_visibility_cone_enabled = true;
  activeRenderer.packed_visibility_hzb_enabled = true;
  activeRenderer.packed_visibility_sse_threshold = 4;
  if (disposed) return;

  setLoading("Assets", "Loading Dungeon by Warkarma without an environment map...", 0.1);
  const imported = await load_gltf_packed(MODEL_URL);
  if (disposed) return;

  const lab = await createRenderingLab(imported);
  if (disposed) return;

  const activeScene = new Scene();
  scene = activeScene;
  sun = addDirectionalLight(activeScene);

  setLoading(
    "GPU residency",
    `Uploading ${lab.source.geometries.length} geometry packages, ${lab.source.materials.length} materials, and ${lab.source.count} instances...`,
    0.9
  );
  await activeRenderer.uploadPackedScene(activeScene, lab.source);
  if (disposed) return;

  const activeCamera = createCamera(activeRenderer, lab.bounds);
  camera = activeCamera;
  controls = new OrbitControls(activeCamera, canvas);
  controls.minDistance = 0.25;
  controls.maxDistance = 80;
  controls.keyPanSpeed = 12.6;
  controls.enableDamping = true;
  setCameraPose([17.5, 9.6, 21], [0, -0.1, -0.8]);

  addExampleControls(activeRenderer);
  startResizeObserver(activeRenderer, activeCamera);

  status.dataset.state = "ready";
  setLoading("Ready", `${lab.source.count} instances - ${lab.source.geometries.length} geometries - advanced effects off`, 1);
  startFrameLoop(activeRenderer, activeScene, activeCamera);
}

function addExampleControls(activeRenderer: Renderer): void {
  const sceneFolder = activeRenderer.debug?.addExampleFolder("Scene");
  sceneFolder?.addBinding(exampleSettings, "sunIntensity", {
    label: "Sun intensity",
    min: 0,
    max: 10,
    step: 0.1
  }).on("change", ({ value }) => {
    if (sun === undefined || scene === undefined) return;
    sun.intensity = value;
    scene.lights.markChanged(sun);
  });
  sceneFolder?.addBinding(exampleSettings, "sunAzimuth", {
    label: "Sun azimuth",
    min: -180,
    max: 180,
    step: 1
  }).on("change", updateSunDirection);
  sceneFolder?.addBinding(exampleSettings, "sunElevation", {
    label: "Sun elevation",
    min: 5,
    max: 89,
    step: 1
  }).on("change", updateSunDirection);

  const cameraFolder = activeRenderer.debug?.addExampleFolder("Camera presets");
  cameraFolder?.addButton({ title: "Overview" }).on("click", () => {
    setCameraPose([17.5, 9.6, 21], [0, -0.1, -0.8]);
  });
  cameraFolder?.addButton({ title: "Street" }).on("click", () => {
    setCameraPose([3.1, 4.8, 10.8], [-5.8, -0.2, -0.5]);
  });
  cameraFolder?.addButton({ title: "Road" }).on("click", () => {
    setCameraPose([14.2, 3.5, 9.4], [8, -0.45, -0.3]);
  });
  cameraFolder?.addButton({ title: "Contact" }).on("click", () => {
    setCameraPose([3.2, 1.8, 5.6], [7.2, -0.8, 0.1]);
  });
  activeRenderer.debug?.focus("renderer");
}

async function createRenderingLab(imported: PackedGltfSource): Promise<{
  readonly source: PackedSceneSource;
  readonly bounds: Bounds;
}> {
  const geometries = await cookGeometries(imported.geometries);
  const currentTransforms = fitPackedTransforms(imported, 5.4, [-5.8, -1, -0.4]);

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

async function cookGeometries(
  sources: PackedGltfSource["geometries"]
): Promise<readonly GeometryAssetPackage[]> {
  const recipe = createGeometryCookRecipe();
  const packages: GeometryAssetPackage[] = [];
  for (let index = 0; index < sources.length; index++) {
    const ordinal = index + 1;
    setLoading(
      "Geometry cooking",
      `Building meshlets and renderable LOD hierarchy ${ordinal}/${sources.length}...`,
      0.18 + index / Math.max(1, sources.length) * 0.68
    );
    packages.push((await cookGeometryAssetPackage(sources[index]!, recipe)).asset);
    if (ordinal % 3 === 0) await nextFrame();
    if (disposed) break;
  }
  return Object.freeze(packages);
}

function addDirectionalLight(activeScene: Scene): DirectionalLight {
  const light = new DirectionalLight();
  light.name = "Rendering Lab Sun";
  light.intensity = exampleSettings.sunIntensity;
  light.casts_shadow = false;
  activeScene.addChild(light);
  sun = light;
  updateSunDirection();
  return light;
}

function updateSunDirection(): void {
  if (sun === undefined) return;
  const azimuth = exampleSettings.sunAzimuth * Math.PI / 180;
  const elevation = exampleSettings.sunElevation * Math.PI / 180;
  const horizontal = Math.cos(elevation);
  sun.forward = [
    horizontal * Math.cos(azimuth),
    -Math.sin(elevation),
    horizontal * Math.sin(azimuth)
  ];
  scene?.lights.markChanged(sun);
}

function createCamera(activeRenderer: Renderer, bounds: Bounds): PerspectiveCamera {
  const activeCamera = new PerspectiveCamera();
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.near = Math.max(0.01, bounds.radius / 5000);
  activeCamera.far = Math.max(100, bounds.radius * 24);
  activeCamera.update();
  return activeCamera;
}

function setCameraPose(
  position: readonly [number, number, number],
  target: readonly [number, number, number]
): void {
  if (camera === undefined) return;
  camera.transform.position.set(position[0], position[1], position[2]);
  camera.transform.lookAt({ x: target[0], y: target[1], z: target[2] });
  camera.update();
  if (controls !== undefined) {
    controls.target.set(target[0], target[1], target[2]);
    controls.update(0);
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

    controls?.update(deltaSeconds);
    activeCamera.aspect = activeRenderer.aspect_ratio;
    activeCamera.update();
    activeRenderer.profiler.recordExternalMetric("frame.rafIntervalMs", rafIntervalMs);
    if (!activeRenderer.render(activeCamera, activeScene, deltaSeconds)) {
      showFatalError(new Error("The WebGPU device was lost and rendering stopped."));
      return;
    }
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
  controls?.dispose();
  if (rendererReady) renderer?.destroy();
  canvas.getContext("webgpu")?.unconfigure();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Rendering Lab requires ${selector}`);
  return element;
}

window.addEventListener("pagehide", dispose, { once: true });

start().catch(showFatalError);
