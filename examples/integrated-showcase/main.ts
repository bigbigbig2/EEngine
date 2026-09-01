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
  { value: RenderDebugView.None, label: "Final output", help: "Final tonemapped output." },
  { value: RenderDebugView.VisibilityKey, label: "Visibility key", help: "Packed instance, cluster, meshlet, and material identity." },
  { value: RenderDebugView.Depth, label: "Reverse-Z depth", help: "Near geometry is bright; untouched background is black." },
  { value: RenderDebugView.BaseColor, label: "Base color", help: "Linear base-color material channel." },
  { value: RenderDebugView.ShadingNormal, label: "Shading normal", help: "Decoded world-facing surface normals." },
  { value: RenderDebugView.Roughness, label: "Roughness", help: "Perceptual material roughness." },
  { value: RenderDebugView.Metallic, label: "Metallic", help: "Metallic material response." },
  { value: RenderDebugView.Occlusion, label: "Material occlusion", help: "Material-provided ambient occlusion." },
  { value: RenderDebugView.AmbientOcclusionTemporal, label: "Ambient occlusion", help: "Final temporal GTAO visibility.", requires: "ssao" },
  { value: RenderDebugView.Emissive, label: "Emissive", help: "Decoded emissive contribution from the GLB materials." },
  { value: RenderDebugView.Velocity, label: "Velocity", help: "Screen-space motion direction and magnitude." },
  { value: RenderDebugView.HistoryValidity, label: "History validity", help: "Temporal motion-valid and reactive state." },
  { value: RenderDebugView.Reactive, label: "Reactive mask", help: "Pixels that reject temporal history." },
  { value: RenderDebugView.IndirectDiffuse, label: "Diffuse IBL", help: "Cosine-convolved diffuse environment lighting." },
  { value: RenderDebugView.IndirectSpecular, label: "Specular IBL", help: "GGX-prefiltered environment reflections." },
  { value: RenderDebugView.ScreenSpaceReflectionHitMiss, label: "SSR hit / miss", help: "Screen-space reflection hit confidence.", requires: "ssr" },
  { value: RenderDebugView.ScreenSpaceReflectionHistoryConfidence, label: "SSR history", help: "Temporal reflection history confidence.", requires: "ssr" },
  { value: RenderDebugView.LinearHdr, label: "Linear HDR", help: "Scene-linear color before exposure and tonemapping." }
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

  setLoading("Initializing the WebGPU renderer…", "Renderer setup", 0.04);
  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({
    context,
    pixelRatio: Math.min(window.devicePixelRatio, 1.5)
  });
  configurePipeline(activeRenderer);
  if (disposed) return;

  setLoading(
    "Loading the 146.9 MB GLB and the HDR environment map…",
    "Asset import",
    0.1
  );
  const [imported, environment] = await Promise.all([
    loadNormalizedPackedGltf(MODEL_URL),
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
    `Uploading ${packages.length} cooked geometry packages and ${imported.materials.length} materials…`,
    "GPU residency",
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

  readyPill.textContent = "Live";
  fieldset.disabled = false;
  root.dataset.state = "ready";
  root.dataset.debugView = RenderDebugView.None;
  setLoading("Ready", "Rendering", 1);
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
  activeRenderer.internal_resolution_scale = 0.75;
  activeRenderer.packed_visibility_sse_threshold = 4;
  activeRenderer.packed_visibility_cone_enabled = true;
  activeRenderer.packed_visibility_hzb_enabled = true;
  activeRenderer.render_debug_view = RenderDebugView.None;
}

async function loadNormalizedPackedGltf(url: string): Promise<PackedGltfSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Cyberpunk City GLB: ${response.status} ${response.statusText}`);
  }
  const source = await response.arrayBuffer();
  const normalized = normalizeGlbSharedUvMappings(source);
  const normalizedUrl = URL.createObjectURL(new Blob([normalized], { type: "model/gltf-binary" }));
  try {
    return await load_gltf_packed(normalizedUrl);
  } finally {
    URL.revokeObjectURL(normalizedUrl);
  }
}

function normalizeGlbSharedUvMappings(source: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(source);
  const view = new DataView(source);
  if (
    bytes.length < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(16, true) !== 0x4e4f534a
  ) {
    throw new Error("Cyberpunk City must be an embedded glTF 2.0 binary (GLB).");
  }
  const jsonLength = view.getUint32(12, true);
  const remainingChunksOffset = 20 + jsonLength;
  if (remainingChunksOffset > bytes.length) throw new Error("Cyberpunk City GLB has a truncated JSON chunk.");
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, remainingChunksOffset)).replace(/[\u0000 ]+$/u, "")
  ) as NormalizableGltf;
  let normalizedTextureMappings = 0;
  for (const material of json.materials ?? []) {
    const textureInfos = [
      material.pbrMetallicRoughness?.baseColorTexture,
      material.normalTexture,
      material.pbrMetallicRoughness?.metallicRoughnessTexture,
      material.occlusionTexture,
      material.emissiveTexture
    ].filter((value): value is NormalizableTextureInfo => value !== undefined);
    if (textureInfos.length === 0) continue;
    const reference = textureInfos[0]!;
    const referenceTexCoord = reference.extensions?.KHR_texture_transform?.texCoord ??
      reference.texCoord ?? 0;
    const referenceTransform = reference.extensions?.KHR_texture_transform;
    for (const info of textureInfos) {
      const currentTexCoord = info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0;
      const currentTransform = info.extensions?.KHR_texture_transform;
      if (currentTexCoord !== referenceTexCoord || !sameTextureTransform(currentTransform, referenceTransform)) {
        normalizedTextureMappings++;
      }
      if (referenceTexCoord === 0) delete info.texCoord;
      else info.texCoord = referenceTexCoord;
      if (referenceTransform === undefined) {
        if (info.extensions !== undefined) {
          delete info.extensions.KHR_texture_transform;
          if (Object.keys(info.extensions).length === 0) delete info.extensions;
        }
      } else {
        info.extensions ??= {};
        info.extensions.KHR_texture_transform = structuredClone(referenceTransform);
      }
    }
  }
  console.info(`Cyberpunk City: normalized ${normalizedTextureMappings} texture UV mapping(s) to MaterialRecord v2.`);
  const encodedJson = new TextEncoder().encode(JSON.stringify(json));
  const paddedJsonLength = alignTo4(encodedJson.length);
  const remainingLength = bytes.length - remainingChunksOffset;
  const output = new Uint8Array(20 + paddedJsonLength + remainingLength);
  output.set(bytes.subarray(0, 12), 0);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(8, output.length, true);
  outputView.setUint32(12, paddedJsonLength, true);
  outputView.setUint32(16, 0x4e4f534a, true);
  output.set(encodedJson, 20);
  output.fill(0x20, 20 + encodedJson.length, 20 + paddedJsonLength);
  output.set(bytes.subarray(remainingChunksOffset), 20 + paddedJsonLength);
  return output.buffer;
}

function sameTextureTransform(
  left: NormalizableTextureTransform | undefined,
  right: NormalizableTextureTransform | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function alignTo4(value: number): number {
  return (value + 3) & ~3;
}

type NormalizableTextureTransform = {
  texCoord?: number;
  offset?: number[];
  scale?: number[];
  rotation?: number;
};

type NormalizableTextureInfo = {
  index: number;
  texCoord?: number;
  extensions?: { KHR_texture_transform?: NormalizableTextureTransform };
};

type NormalizableMaterial = {
  pbrMetallicRoughness?: {
    baseColorTexture?: NormalizableTextureInfo;
    metallicRoughnessTexture?: NormalizableTextureInfo;
  };
  normalTexture?: NormalizableTextureInfo;
  occlusionTexture?: NormalizableTextureInfo;
  emissiveTexture?: NormalizableTextureInfo;
};

type NormalizableGltf = { materials?: NormalizableMaterial[] };

async function cookGeometries(
  sources: PackedGltfSource["geometries"]
): Promise<readonly GeometryAssetPackage[]> {
  const recipe = createGeometryCookRecipe();
  const packages: GeometryAssetPackage[] = [];
  for (let index = 0; index < sources.length; index++) {
    const ordinal = index + 1;
    setLoading(
      `Building meshlets and renderable LOD hierarchy ${ordinal} of ${sources.length}…`,
      "Geometry cooker",
      0.18 + index / Math.max(1, sources.length) * 0.66
    );
    packages.push((await cookGeometryAssetPackage(sources[index]!, recipe)).asset);
    if (ordinal % 3 === 0) await nextFrame();
  }
  return Object.freeze(packages);
}

function addShowcaseLights(activeScene: Scene, bounds: Bounds): void {
  const sun = new DirectionalLight();
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
    const angle = time * (0.12 + index * 0.015) + index / pointLights.length * Math.PI * 2;
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
    panelToggle.textContent = collapsed ? "Controls" : "Close";
  });
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
  readyPill.textContent = "Error";
  setLoading(message, "Unable to start the showcase", 1);
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
