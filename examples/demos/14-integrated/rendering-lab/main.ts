import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  ShadeTexture,
  ShadeTransparencyMode,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_environment_map,
  load_gltf_packed,
  openTextureAssetPackageV2,
  type GeometryAssetPackage,
  type PackedGltfSource,
  type PackedSceneSource
} from "../../../../OEngine/src/index.ts";
import { cookReferenceTextureAssetPackageV2 } from "../../../../OEngine/src/assets/codec/ReferenceTextureCodec.ts";

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
const ENVIRONMENT_URL = new URL(
  "../../../assets/three/rendering-lab/venice_sunset_1k.hdr",
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
let animatedInstanceIndices: Uint32Array | undefined;
let sun: DirectionalLight | undefined;

const exampleSettings = {
  animateObjects: true,
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

  setLoading("Renderer", "Initializing WebGPU…", 0.04);
  const activeRenderer = new Renderer({
    debug: true,
    renderSettings: {
      features: {
        shadows: true,
        screenSpaceDiffuseMode: "gtao",
        screenSpaceReflections: true,
        temporalAntiAliasing: true,
        bloom: true,
        automaticExposure: true,
        motionBlur: true,
        sharpening: true
      },
      ao: {
        resolutionScale: 0.5,
        temporalEnabled: true
      },
      ssr: {
        resolutionScale: 0.5,
        temporalEnabled: true
      },
      resolution: {
        mode: "fixed",
        internalScale: 1
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

  setLoading("Assets", "Loading Dungeon by Warkarma and the HDR environment…", 0.1);
  const [imported, environment] = await Promise.all([
    load_gltf_packed(MODEL_URL),
    load_environment_map(ENVIRONMENT_URL)
  ]);
  if (disposed) return;

  const lab = await createRenderingLab(imported);
  animatedInstanceIndices = new Uint32Array([lab.source.count - 2, lab.source.count - 1]);
  if (disposed) return;

  const activeScene = new Scene();
  scene = activeScene;
  activeScene.lights.environment = environment;
  sun = addDirectionalLight(activeScene);

  setLoading(
    "GPU residency",
    `Uploading ${lab.source.geometries.length} geometry packages, ${lab.source.materials.length} materials, and ${lab.source.count} instances…`,
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
  setLoading("Ready", `${lab.source.count} instances · ${lab.source.geometries.length} geometries`, 1);
  startFrameLoop(activeRenderer, activeScene, activeCamera);
}

function addExampleControls(activeRenderer: Renderer): void {
  const sceneFolder = activeRenderer.debug?.addExampleFolder("Scene");
  sceneFolder?.addBinding(exampleSettings, "animateObjects", { label: "Animate objects" });
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
  const generatedSources = [
    buildBoxSourceGeometry(30, 0.2, 18),
    buildBoxSourceGeometry(8, 6, 0.2),
    buildBoxSourceGeometry(0.2, 6, 12),
    buildBoxSourceGeometry(2.2, 0.06, 10),
    buildBoxSourceGeometry(3.2, 0.4, 3.2),
    buildBoxSourceGeometry(1.1, 1.1, 1.1),
    buildBoxSourceGeometry(0.16, 3.2, 0.16),
    buildBoxSourceGeometry(1.4, 0.32, 0.32)
  ];
  const geometrySources = [...imported.geometries, ...generatedSources];
  const geometries = await cookGeometries(geometrySources);
  const customMaterials = [
    labMaterial([0.32, 0.35, 0.39], 0.88, 0),
    labMaterial([0.56, 0.59, 0.64], 0.72, 0),
    labMaterial([0.72, 0.74, 0.78], 0.03, 1),
    labMaterial([0.54, 0.58, 0.63], 0.38, 1),
    labMaterial([0.42, 0.46, 0.51], 0.82, 1),
    labMaterial([0.86, 0.12, 0.08], 0.24, 0),
    labMaterial([0.08, 0.42, 0.92], 0.52, 0),
    labMaterial([0.06, 0.08, 0.11], 0.3, 0, [3.5, 0.35, 0.08]),
    labMaterial(
      [0.20, 0.55, 0.95],
      0.08,
      1,
      [0.1, 0.2, 0.5],
      ShadeTransparencyMode.Transparent
    )
  ];
  const cookedTextures = await createCookedTextures();
  customMaterials[0]!.texture_albedo = cookedTextures.baseColor;
  customMaterials[0]!.texture_normal = cookedTextures.normal;
  customMaterials[0]!.texture_orm = cookedTextures.orm;
  customMaterials[0]!.texture_emissive = cookedTextures.emissive;
  customMaterials[1]!.texture_albedo = cookedTextures.secondBaseColor;

  const materials = [...imported.materials, ...customMaterials];
  const importedGeometryCount = imported.geometries.length;
  const customMaterialBase = imported.materials.length;
  const importedTransforms = fitPackedTransforms(imported, 5.4, [-5.8, -1, -0.4]);
  const generatedInstances = [
    { geometry: 0, material: 0, position: [0, -1.1, 0] },
    { geometry: 1, material: 1, position: [8, 1.9, -6.5] },
    { geometry: 2, material: 1, position: [12.2, 1.9, -0.4] },
    { geometry: 3, material: 2, position: [5.2, -0.97, 0.4] },
    { geometry: 3, material: 3, position: [8, -0.97, 0.4] },
    { geometry: 3, material: 4, position: [10.8, -0.97, 0.4] },
    { geometry: 4, material: 1, position: [8, -0.82, -2.1] },
    { geometry: 5, material: 5, position: [5.2, -0.4, -0.8] },
    { geometry: 5, material: 6, position: [10.8, -0.4, -0.8] },
    { geometry: 5, material: 5, position: [6.1, -0.4, 3.1] },
    { geometry: 5, material: 6, position: [9.9, -0.4, 3.1] },
    { geometry: 6, material: 1, position: [6.2, 0.5, -4.8] },
    { geometry: 6, material: 1, position: [9.8, 0.5, -4.8] },
    { geometry: 7, material: 7, position: [5.2, 1.8, -6.2] },
    { geometry: 7, material: 7, position: [8, 2.7, -6.2] },
    { geometry: 7, material: 7, position: [10.8, 1.8, -6.2] },
    { geometry: 4, material: 8, position: [3.4, 0.5, 1.8] },
    { geometry: 4, material: 8, position: [12.6, 0.5, 1.8] }
  ] as const;

  const count = imported.geometryIndices.length + generatedInstances.length;
  const geometryIndices = new Uint32Array(count);
  const materialIndices = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const flags = new Uint32Array(count);
  const debugIds = new Uint32Array(count);

  geometryIndices.set(imported.geometryIndices);
  materialIndices.set(imported.materialIndices);
  currentTransforms.set(importedTransforms);
  boundsSpheres.set(imported.boundsSpheres);
  boundsMin.set(imported.boundsMin);
  boundsMax.set(imported.boundsMax);
  flags.set(imported.flags);
  debugIds.set(imported.debugIds);

  for (let index = 0; index < generatedInstances.length; index++) {
    const destination = imported.geometryIndices.length + index;
    const instance = generatedInstances[index]!;
    const source = generatedSources[instance.geometry]!;
    geometryIndices[destination] = importedGeometryCount + instance.geometry;
    materialIndices[destination] = customMaterialBase + instance.material;
    writeTranslationTransform(
      currentTransforms,
      destination * 16,
      instance.position[0],
      instance.position[1],
      instance.position[2]
    );
    boundsSpheres.set(source.bounds.sphere, destination * 4);
    boundsMin.set(source.bounds.box.subarray(0, 3), destination * 3);
    boundsMax.set(source.bounds.box.subarray(3, 6), destination * 3);
    debugIds[destination] = destination + 1;
  }

  return Object.freeze({
    source: Object.freeze({
      geometries,
      materials,
      count,
      geometryIndices,
      materialIndices,
      currentTransforms,
      previousTransforms: currentTransforms.slice(),
      boundsSpheres,
      boundsMin,
      boundsMax,
      flags,
      debugIds
    }),
    bounds: Object.freeze({
      min: [-15, -1.2, -9] as [number, number, number],
      max: [15, 5, 9] as [number, number, number],
      center: [0, 1.9, 0] as [number, number, number],
      radius: 18.1
    })
  });
}

async function createCookedTextures(): Promise<Readonly<{
  baseColor: ShadeTexture;
  normal: ShadeTexture;
  orm: ShadeTexture;
  emissive: ShadeTexture;
  secondBaseColor: ShadeTexture;
}>> {
  const create = async (
    semantic: "base-color-srgb" | "normal-linear" | "orm-linear" | "emissive-srgb",
    size: number,
    suffix: string
  ): Promise<ShadeTexture> => {
    const rgba8 = new Uint8Array(size * size * 4);
    for (let index = 0; index < size * size; index++) {
      rgba8.set(
        semantic === "normal-linear"
          ? [128, 128, 255, 255]
          : semantic === "orm-linear"
            ? [255, 166, 28, 255]
            : suffix === "second"
              ? [150, 164, 184, 255]
              : [82, 96, 112, 255],
        index * 4
      );
    }
    return ShadeTexture.fromAssetPackageV2(await openTextureAssetPackageV2(
      await cookReferenceTextureAssetPackageV2({
        width: size,
        height: size,
        rgba8,
        semantic,
        sourceUri: `example://rendering-lab/${semantic}-${suffix}`
      })
    ));
  };

  const [baseColor, normal, orm, emissive, secondBaseColor] = await Promise.all([
    create("base-color-srgb", 8, "primary"),
    create("normal-linear", 8, "primary"),
    create("orm-linear", 8, "primary"),
    create("emissive-srgb", 16, "primary"),
    create("base-color-srgb", 32, "second")
  ]);
  return Object.freeze({ baseColor, normal, orm, emissive, secondBaseColor });
}

function labMaterial(
  color: readonly [number, number, number],
  roughness: number,
  metallic: number,
  emissive: readonly [number, number, number] = [0, 0, 0],
  transparencyMode: ShadeTransparencyMode = ShadeTransparencyMode.Opaque
): StandardShadeMaterial {
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(
    color[0],
    color[1],
    color[2],
    transparencyMode === ShadeTransparencyMode.Transparent ? 0.52 : 1
  );
  material.transparency_mode = transparencyMode;
  material.roughness_factor = roughness;
  material.metallic_factor = metallic;
  material.emissive_factor.set(emissive[0], emissive[1], emissive[2]);
  return material;
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

function computeWorldBounds(source: PackedGltfSource): Bounds {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let instance = 0; instance < source.geometryIndices.length; instance++) {
    const boundsOffset = instance * 3;
    const matrixOffset = instance * 16;
    for (let corner = 0; corner < 8; corner++) {
      const localX = corner & 1 ? source.boundsMax[boundsOffset]! : source.boundsMin[boundsOffset]!;
      const localY = corner & 2 ? source.boundsMax[boundsOffset + 1]! : source.boundsMin[boundsOffset + 1]!;
      const localZ = corner & 4 ? source.boundsMax[boundsOffset + 2]! : source.boundsMin[boundsOffset + 2]!;
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
      `Building meshlets and renderable LOD hierarchy ${ordinal}/${sources.length}…`,
      0.18 + index / Math.max(1, sources.length) * 0.68
    );
    packages.push((await cookGeometryAssetPackage(sources[index]!, recipe)).asset);
    if (ordinal % 3 === 0) await nextFrame();
    if (disposed) break;
  }
  return Object.freeze(packages);
}

function writeTranslationTransform(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number
): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function addDirectionalLight(activeScene: Scene): DirectionalLight {
  const light = new DirectionalLight();
  light.name = "Rendering Lab Sun";
  light.intensity = exampleSettings.sunIntensity;
  light.casts_shadow = true;
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
    if (exampleSettings.animateObjects) {
      queueAnimatedScenePatch(activeRenderer, activeScene, activeRenderer.frame_count + 1, time / 1000);
    }
    if (!activeRenderer.render(activeCamera, activeScene, deltaSeconds)) {
      showFatalError(new Error("The WebGPU device was lost and rendering stopped."));
      return;
    }
    animationFrame = requestAnimationFrame(frame);
  };
  animationFrame = requestAnimationFrame(frame);
}

function queueAnimatedScenePatch(
  activeRenderer: Renderer,
  activeScene: Scene,
  frameId: number,
  timeSeconds: number
): void {
  const indices = animatedInstanceIndices;
  if (indices === undefined || indices.length === 0) return;
  const transforms = new Float32Array(indices.length * 16);
  for (let index = 0; index < indices.length; index++) {
    const phase = timeSeconds * 1.4 + index * Math.PI;
    writeTranslationTransform(
      transforms,
      index * 16,
      index === 0 ? 3.4 : 12.6,
      0.5 + Math.sin(phase) * 0.35,
      1.8 + Math.cos(phase) * 0.45
    );
  }
  activeRenderer.queuePackedScenePatch(activeScene, {
    frameId,
    transforms: { indices, transforms }
  });
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
