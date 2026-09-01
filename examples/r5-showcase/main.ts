import {
  DirectionalLight,
  INSTANCE_SOURCE_FLAGS,
  OrbitalCameraController,
  PerspectiveCamera,
  PointLight,
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  Renderer,
  Scene,
  ShadeDataType,
  ShadeDrawSide,
  ShadeImage,
  ShadeTexture,
  ShadeTransparencyMode,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_gltf_packed,
  type PackedGltfSource,
  type RenderDebugViewName,
  type SourceGeometry
} from "../../OEngine/src/index.ts";

declare global {
  interface Window {
    __OENGINE_R5_SHOWCASE__?: ShowcaseState;
  }
}

interface ShowcaseState {
  ready: boolean;
  error: string | null;
  asset: string;
  instances: number;
  materials: number;
  features: Record<string, boolean | number>;
}

interface InstanceRecord {
  geometry: number;
  material: number;
  transform: Float32Array;
  flags: number;
}

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("status");
const detail = required<HTMLElement>("detail");
const fpsOutput = required<HTMLElement>("fps");
const outputSize = required<HTMLElement>("output-size");
const internalSize = required<HTMLElement>("internal-size");
const historyBytes = required<HTMLElement>("history-bytes");
const shadowsInput = required<HTMLInputElement>("feature-shadows");
const aoInput = required<HTMLInputElement>("feature-ao");
const ssrInput = required<HTMLInputElement>("feature-ssr");
const taaInput = required<HTMLInputElement>("feature-taa");
const halfAoInput = required<HTMLInputElement>("ao-half");
const animateLightsInput = required<HTMLInputElement>("animate-lights");
const scaleSelect = required<HTMLSelectElement>("render-scale");
const debugSelect = required<HTMLSelectElement>("debug-view");
const resetCameraButton = required<HTMLButtonElement>("reset-camera");

window.__OENGINE_R5_SHOWCASE__ = {
  ready: false,
  error: null,
  asset: "three.js/examples/models/gltf/Flower/Flower.glb",
  instances: 0,
  materials: 0,
  features: {}
};

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = "示例启动失败";
  status.classList.add("error");
  detail.textContent = message;
  window.__OENGINE_R5_SHOWCASE__ = {
    ...window.__OENGINE_R5_SHOWCASE__!,
    ready: false,
    error: message
  };
  console.error(error);
});

async function start(): Promise<void> {
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("当前浏览器没有可用的 WebGPU canvas context");

  const renderer = new Renderer();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  await renderer.initialize({ context, pixelRatio });
  configureRenderer(renderer);

  status.textContent = "加载并 Cook Flower.glb…";
  const imported = await load_gltf_packed(
    new URL("./assets/Flower.glb", import.meta.url).href
  );
  const fixture = await createShowcaseScene(renderer, imported);

  const camera = new PerspectiveCamera();
  camera.near = 0.08;
  camera.far = 120;
  camera.fov = Math.PI / 3.3;
  camera.transform.position.set(9.4, 5.6, 13.8);
  camera.transform.lookAt({ x: 0, y: 1.25, z: -0.4 });
  camera.update();

  const controller = new OrbitalCameraController(camera, canvas);
  controller.distanceLimits.min = 1.8;
  controller.distanceLimits.max = 42;
  controller.movement_speed_scale = 4;
  controller.target.set(0, 1.25, -0.4);
  controller.look(camera.transform.position, controller.target);
  canvas.addEventListener("pointerdown", () => canvas.focus());

  installDebugViews(renderer);
  installControls(renderer, camera, controller);
  resize(renderer, camera);
  window.addEventListener("resize", () => resize(renderer, camera));

  const adapter = renderer.adapter_info;
  status.textContent = "运行中 · production Packed Renderer";
  status.classList.add("ready");
  detail.textContent = [
    "Flower.glb / CC0 1.0",
    `${fixture.instances} instances`,
    `${fixture.materials} materials`,
    [adapter?.vendor, adapter?.architecture].filter(Boolean).join(" ") || "WebGPU"
  ].join(" · ");
  updatePublicState(renderer, fixture.instances, fixture.materials);

  let previousTime = performance.now();
  let smoothedFps = 60;
  let frameIndex = 0;
  const frame = (time: number): void => {
    const deltaSeconds = Math.min(0.1, Math.max(1 / 240, (time - previousTime) / 1000));
    previousTime = time;
    smoothedFps += (1 / deltaSeconds - smoothedFps) * 0.08;

    controller.update();
    camera.update();
    if (animateLightsInput.checked) animateLights(fixture.pointLights, time * 0.001);
    if (!renderer.render(camera, fixture.scene, deltaSeconds)) {
      throw new Error("WebGPU device lost; Renderer stopped");
    }

    if ((frameIndex++ & 15) === 0) {
      updateStats(renderer, smoothedFps);
      updatePublicState(renderer, fixture.instances, fixture.materials);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.addEventListener("beforeunload", () => {
    controller.pointer.stop();
    controller.keyboard.stop();
    renderer.destroy();
  }, { once: true });
}

function configureRenderer(renderer: Renderer): void {
  renderer.feature_shadows_enabled = true;
  renderer.feature_ssao_enabled = true;
  renderer.ssao_resolution_scale = 0.5;
  renderer.ssao_temporal_enabled = true;
  renderer.feature_ssr_enabled = true;
  renderer.feature_taa_enabled = true;
  renderer.internal_resolution_scale = 0.85;
  renderer.dynamic_resolution_scaling.enabled = false;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
}

async function createShowcaseScene(
  renderer: Renderer,
  imported: PackedGltfSource
): Promise<{
  scene: Scene;
  pointLights: PointLight[];
  instances: number;
  materials: number;
}> {
  const ground = buildBoxSourceGeometry(18, 0.24, 12);
  const wall = buildBoxSourceGeometry(18, 6, 0.24);
  const plinth = buildBoxSourceGeometry(2.25, 0.72, 2.25);
  const cube = buildBoxSourceGeometry(1.25, 1.25, 1.25, 4, 4, 4);
  const glass = buildBoxSourceGeometry(2.7, 2.35, 0.07);
  const sources: SourceGeometry[] = [
    ...imported.geometries,
    ground,
    wall,
    plinth,
    cube,
    glass
  ];
  const recipe = createGeometryCookRecipe();
  const geometries = await Promise.all(sources.map(async (source) =>
    (await cookGeometryAssetPackage(source, recipe)).asset
  ));

  const groundMaterial = material([0.19, 0.24, 0.29, 1], 0.82, 0.05);
  const wallMaterial = material([0.24, 0.3, 0.36, 1], 0.68, 0.08);
  const metalMaterial = material([0.55, 0.64, 0.72, 1], 0.16, 0.92);
  const darkMetalMaterial = material([0.06, 0.09, 0.13, 1], 0.28, 0.8);
  const cyanGlass = transparentMaterial([0.08, 0.62, 0.9, 0.28], [0.01, 0.08, 0.14]);
  const amberGlass = transparentMaterial([1, 0.35, 0.05, 0.24], [0.16, 0.025, 0.002]);
  const materials = [
    ...imported.materials,
    groundMaterial,
    wallMaterial,
    metalMaterial,
    darkMetalMaterial,
    cyanGlass,
    amberGlass
  ];

  const groundGeometry = imported.geometries.length;
  const wallGeometry = groundGeometry + 1;
  const plinthGeometry = groundGeometry + 2;
  const cubeGeometry = groundGeometry + 3;
  const glassGeometry = groundGeometry + 4;
  const groundMaterialIndex = imported.materials.length;
  const wallMaterialIndex = groundMaterialIndex + 1;
  const metalMaterialIndex = groundMaterialIndex + 2;
  const darkMetalMaterialIndex = groundMaterialIndex + 3;
  const cyanGlassMaterialIndex = groundMaterialIndex + 4;
  const amberGlassMaterialIndex = groundMaterialIndex + 5;
  const instances: InstanceRecord[] = [];

  const flowerPlacements = [
    [-3.5, 0.72, -0.65, 6.5],
    [0, 0.72, -1.1, 7.5],
    [3.5, 0.72, -0.65, 6.5],
    [-1.75, 0.02, 2.15, 4.5],
    [1.75, 0.02, 2.15, 4.5]
  ] as const;
  for (const [x, y, z, scale] of flowerPlacements) {
    for (let index = 0; index < imported.geometryIndices.length; index++) {
      instances.push({
        geometry: imported.geometryIndices[index]!,
        material: imported.materialIndices[index]!,
        transform: transformImported(imported.transforms, index, scale, x, y, z),
        flags: imported.flags[index]!
      });
    }
  }

  instances.push(
    packedInstance(groundGeometry, groundMaterialIndex, 0, -0.12, 0, 0),
    packedInstance(wallGeometry, wallMaterialIndex, 0, 2.88, -5.82, 0),
    packedInstance(plinthGeometry, metalMaterialIndex, -3.5, 0.36, -0.65, 0),
    packedInstance(plinthGeometry, darkMetalMaterialIndex, 0, 0.36, -1.1, 0),
    packedInstance(plinthGeometry, metalMaterialIndex, 3.5, 0.36, -0.65, 0),
    packedInstance(cubeGeometry, metalMaterialIndex, -5.7, 0.63, -3.75, 0.2),
    packedInstance(cubeGeometry, darkMetalMaterialIndex, 5.7, 0.63, -3.75, -0.2),
    packedInstance(glassGeometry, cyanGlassMaterialIndex, -5.35, 1.42, 0.4, -0.34, false),
    packedInstance(glassGeometry, amberGlassMaterialIndex, 5.35, 1.42, 0.4, 0.34, false)
  );

  const currentTransforms = new Float32Array(instances.length * 16);
  const geometryIndices = new Uint32Array(instances.length);
  const materialIndices = new Uint32Array(instances.length);
  const boundsSpheres = new Float32Array(instances.length * 4);
  const boundsMin = new Float32Array(instances.length * 3);
  const boundsMax = new Float32Array(instances.length * 3);
  const flags = new Uint32Array(instances.length);
  const debugIds = new Uint32Array(instances.length);
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    const source = sources[instance.geometry]!;
    geometryIndices[index] = instance.geometry;
    materialIndices[index] = instance.material;
    currentTransforms.set(instance.transform, index * 16);
    boundsSpheres.set(source.bounds.sphere, index * 4);
    boundsMin.set(source.bounds.box.subarray(0, 3), index * 3);
    boundsMax.set(source.bounds.box.subarray(3, 6), index * 3);
    flags[index] = instance.flags;
    debugIds[index] = index + 1;
  }

  const scene = new Scene();
  scene.lights.environment = environmentTexture();
  const pointLights = addLights(scene);
  await renderer.uploadPackedScene(scene, {
    geometries,
    materials,
    count: instances.length,
    geometryIndices,
    materialIndices,
    currentTransforms,
    previousTransforms: currentTransforms.slice(),
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags,
    debugIds
  });
  return { scene, pointLights, instances: instances.length, materials: materials.length };
}

function addLights(scene: Scene): PointLight[] {
  const sun = new DirectionalLight();
  sun.intensity = 2.2;
  sun.forward = [0.42, -1, -0.28];
  sun.color.setRGB(1, 0.92, 0.78);
  sun.casts_shadow = true;
  scene.addChild(sun);

  const colors = [
    [0.2, 0.72, 1],
    [1, 0.28, 0.08],
    [0.45, 0.25, 1],
    [0.1, 1, 0.58]
  ] as const;
  return colors.map((color, index) => {
    const light = new PointLight();
    const angle = index / colors.length * Math.PI * 2;
    light.position = [Math.cos(angle) * 4.8, 2.1 + (index & 1) * 0.7, Math.sin(angle) * 3.4 - 0.4];
    light.color.setRGB(color[0], color[1], color[2]);
    light.intensity = 16;
    light.distance = 9;
    light.radius = 0.12;
    light.casts_shadow = false;
    light.updateMatrices();
    scene.addChild(light);
    return light;
  });
}

function animateLights(lights: readonly PointLight[], time: number): void {
  for (let index = 0; index < lights.length; index++) {
    const light = lights[index]!;
    const angle = time * (0.28 + index * 0.025) + index * Math.PI * 0.5;
    const radius = 4.4 + (index & 1) * 0.8;
    light.position = [
      Math.cos(angle) * radius,
      2.2 + Math.sin(time * 0.7 + index) * 0.65,
      Math.sin(angle) * 3.7 - 0.4
    ];
    light.updateMatrices();
  }
}

function installDebugViews(renderer: Renderer): void {
  for (const entry of RENDER_DEBUG_VIEW_OPTIONS) {
    if (entry.status === "unsupported") continue;
    const option = document.createElement("option");
    option.value = entry.view;
    option.textContent = entry.label;
    debugSelect.append(option);
  }
  debugSelect.value = RenderDebugView.None;
  debugSelect.addEventListener("change", () => {
    renderer.render_debug_view = debugSelect.value as RenderDebugViewName;
  });
}

function installControls(
  renderer: Renderer,
  camera: PerspectiveCamera,
  controller: OrbitalCameraController
): void {
  const topologyChanged = (): void => renderer.indicate_view_change();
  shadowsInput.addEventListener("change", () => {
    renderer.feature_shadows_enabled = shadowsInput.checked;
    topologyChanged();
  });
  aoInput.addEventListener("change", () => {
    renderer.feature_ssao_enabled = aoInput.checked;
    topologyChanged();
  });
  ssrInput.addEventListener("change", () => {
    renderer.feature_ssr_enabled = ssrInput.checked;
    topologyChanged();
  });
  taaInput.addEventListener("change", () => {
    renderer.feature_taa_enabled = taaInput.checked;
    topologyChanged();
  });
  halfAoInput.addEventListener("change", () => {
    renderer.ssao_resolution_scale = halfAoInput.checked ? 0.5 : 1;
    topologyChanged();
  });
  scaleSelect.addEventListener("change", () => {
    renderer.internal_resolution_scale = Number(scaleSelect.value);
    topologyChanged();
  });
  resetCameraButton.addEventListener("click", () => {
    camera.transform.position.set(9.4, 5.6, 13.8);
    controller.target.set(0, 1.25, -0.4);
    controller.look(camera.transform.position, controller.target);
    camera.update();
    renderer.indicate_view_change();
    canvas.focus();
  });
}

function updateStats(renderer: Renderer, fps: number): void {
  const temporal = renderer.temporalEvidence();
  const ao = renderer.ambientOcclusionEvidence();
  const ssr = renderer.screenSpaceReflectionsEvidence();
  const output = renderer.output_resolution;
  const internalPixels = temporal.internalPixels;
  const aspect = output.x / Math.max(1, output.y);
  const internalHeightValue = Math.max(1, Math.round(Math.sqrt(internalPixels / aspect)));
  const internalWidthValue = Math.max(1, Math.round(internalHeightValue * aspect));
  fpsOutput.textContent = fps.toFixed(0);
  outputSize.textContent = `${output.x}×${output.y}`;
  internalSize.textContent = `${internalWidthValue}×${internalHeightValue}`;
  historyBytes.textContent = formatBytes(
    temporal.historyBytes + ao.historyBytes + ssr.historyBytes
  );
}

function updatePublicState(renderer: Renderer, instances: number, materials: number): void {
  window.__OENGINE_R5_SHOWCASE__ = {
    ready: true,
    error: null,
    asset: "three.js/examples/models/gltf/Flower/Flower.glb",
    instances,
    materials,
    features: {
      shadows: renderer.feature_shadows_enabled,
      ao: renderer.feature_ssao_enabled,
      ssr: renderer.feature_ssr_enabled,
      taa: renderer.feature_taa_enabled,
      aoScale: renderer.ssao_resolution_scale,
      internalScale: renderer.internal_resolution_scale
    }
  };
}

function resize(renderer: Renderer, camera: PerspectiveCamera): void {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
}

function packedInstance(
  geometry: number,
  materialIndex: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  castsShadow = true
): InstanceRecord {
  return {
    geometry,
    material: materialIndex,
    transform: transform(x, y, z, yaw),
    flags: castsShadow ? INSTANCE_SOURCE_FLAGS.CastsShadow : 0
  };
}

function transform(x: number, y: number, z: number, yaw = 0): Float32Array {
  const value = new Float32Array(16);
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  value[0] = cosine;
  value[2] = -sine;
  value[5] = 1;
  value[8] = sine;
  value[10] = cosine;
  value[12] = x;
  value[13] = y;
  value[14] = z;
  value[15] = 1;
  return value;
}

function transformImported(
  source: Float32Array,
  instanceIndex: number,
  scale: number,
  x: number,
  y: number,
  z: number
): Float32Array {
  const offset = instanceIndex * 16;
  const value = source.slice(offset, offset + 16);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) {
      value[column * 4 + row] = value[column * 4 + row]! * scale;
    }
  }
  value[12] = value[12]! * scale + x;
  value[13] = value[13]! * scale + y;
  value[14] = value[14]! * scale + z;
  return value;
}

function material(
  color: readonly [number, number, number, number],
  roughness: number,
  metallic: number
): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.diffuse_color.set(color[0], color[1], color[2], color[3]);
  value.roughness_factor = roughness;
  value.metallic_factor = metallic;
  return value;
}

function transparentMaterial(
  color: readonly [number, number, number, number],
  emissive: readonly [number, number, number]
): StandardShadeMaterial {
  const value = material(color, 0.18, 0.08);
  value.emissive_factor.setRGB(emissive[0], emissive[1], emissive[2]);
  value.transparency_mode = ShadeTransparencyMode.Transparent;
  value.draw_side = ShadeDrawSide.Double;
  return value;
}

function environmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x3266, 0x3666, 0x3a00, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
