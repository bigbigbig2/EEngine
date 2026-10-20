import { exampleImageKernels } from "../../shared/image-kernels";
import {
  buildVirtualGeometrySceneSourceV1,
  load_oegpack_product,
  load_environment_map,
  parseOegPackSceneManifestV4,
  OrbitControls,
  PerspectiveCamera,
  ProjectionMappingType,
  Renderer,
  Scene
} from "../../../OEngine/src/index.ts";
import { ImageTextureSource } from "../../../OEngine/src/assets/ImageTextureSource.ts";
import { imageTextureHash } from "../../../OEngine/src/assets/ImageTextureProduct.ts";
import { MATERIAL_TEXTURE_PROPERTIES } from "../../../OEngine/src/assets/PcMaterialTextures.ts";
import { parseGltfMaterial } from "../../../OEngine/src/loaders/gltf/gltfMaterials.ts";
import { textureFromGltf } from "../../../OEngine/src/loaders/gltf/gltfTextures.ts";
import { ShadeImage } from "../../../OEngine/src/texture/ShadeImage.ts";
import { ShadeTexture } from "../../../OEngine/src/texture/ShadeTexture.ts";

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
let activeAsset: Awaited<ReturnType<typeof load_oegpack_product>> | undefined;
const imageSources = new Set<ImageTextureSource>();
const loadAbort = new AbortController();
const startupMarks: Record<string, number> = {};

function markStartup(name: string): void {
  startupMarks[name] = performance.now();
  performance.mark(`hello-hdr-gltf/${name}`);
}

function releaseScene(): void {
  loadAbort.abort();
  activeAsset?.release();
  activeAsset = undefined;
  renderer?.destroy();
  for (const source of imageSources) source.close();
  imageSources.clear();
}

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
  releaseScene();
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
  markStartup("start");
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU，请使用支持 WebGPU 的浏览器。");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context。");

  setPhase("初始化原生 HDR 管线");
  const kernels = await exampleImageKernels();
  markStartup("kernels-ready");
  loadAbort.signal.throwIfAborted();
  renderer = new Renderer({
    imageTextureKernels: kernels,
    autoExposure: false,
    fixedExposure: Number(exposure.value),
    enableVsm: false,
    enablePhysicalEnvironment: false,
    ambientOcclusion: { enabled: false },
    renderScale: 1
  });
  await renderer.initialize({ context });
  markStartup("renderer-ready");
  if (loadAbort.signal.aborted) {
    renderer.destroy();
    loadAbort.signal.throwIfAborted();
  }
  renderer.packed_visibility_hzb_enabled = false;
  renderer.packed_visibility_current_hzb_late_recheck_enabled = false;
  renderer.fsr3_enabled = false;
  renderer.temporal_jitter_enabled = false;
  renderer.bloom_enabled = false;
  renderer.setToneMapping(toneMapping.value as "engine" | "neutral" | "aces" | "reinhard");

  resize();

  setPhase("解码 Venice Sunset HDR");
  scene.lights.environment = await load_environment_map(
    "/modules/hello-hdr-gltf/assets/venice_sunset_1k.hdr",
    ProjectionMappingType.Equirectangular
  );
  markStartup("hdr-ready");
  loadAbort.signal.throwIfAborted();

  setPhase("打开离线 GeometryProduct / AVIF 纹理");
  const base = "/modules/hello-hdr-gltf/assets/cooked/";
  const manifestResponse = await fetch(`${base}scene.materials.json`, { signal: loadAbort.signal });
  if (!manifestResponse.ok) throw new Error(`无法读取预烘焙材质清单 (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  if (manifest.schema !== "oengine-image-scene-materials-v2") {
    throw new Error("Expected schema4 image scene; recook required");
  }
  const sceneResponse = await fetch(`${base}${manifest.geometryManifest}`, { signal: loadAbort.signal });
  if (!sceneResponse.ok) throw new Error(`无法读取预烘焙场景清单 (${sceneResponse.status})`);
  const sceneBytes = await sceneResponse.arrayBuffer();
  if ((await imageTextureHash(new Uint8Array(sceneBytes))) !== manifest.geometryManifestHash) {
    throw new Error("Geometry manifest hash mismatch");
  }
  const sceneManifest = parseOegPackSceneManifestV4(sceneBytes);
  markStartup("scene-catalog-ready");
  const images = Array.from({ length: manifest.source.images }, () =>
    ShadeImage.fromEncodedImage(new ArrayBuffer(0), "image/png")
  );
  const textures = manifest.gltf.textures.map((texture: any) =>
    textureFromGltf(texture, images, manifest.gltf.samplers)
  );
  const materials = manifest.gltf.materials.map((material: any) => parseGltfMaterial(material, textures));
  const products = new Map<string, ImageTextureSource>();
  await Promise.all(
    manifest.products.map(async (product: { uri: string; identity: string; byteLength: number }) => {
      const source = await ImageTextureSource.open(
        new URL(base + product.uri, location.href).href, product.identity, product.byteLength, loadAbort.signal);
      if (disposed || loadAbort.signal.aborted) {
        source.close();
        loadAbort.signal.throwIfAborted();
        throw new Error("Scene was disposed");
      }
      imageSources.add(source);
      products.set(product.identity, source);
    })
  );
  markStartup("image-directories-ready");
  for (const [materialIndex, material] of materials.entries()) {
    const bindings = manifest.bindings[materialIndex];
    for (const property of MATERIAL_TEXTURE_PROPERTIES) {
      const binding = bindings[property];
      if (!binding) continue;
      const identity = manifest.products.find((candidate: { uri: string; identity: string }) => candidate.uri === binding.uri)?.identity;
      const product = identity ? products.get(identity) : undefined;
      const sampler = textures[binding.textureIndex];
      if (!product || !sampler) throw new Error(`预烘焙材质 ${materialIndex} 缺少 ${property} 纹理`);
      const texture = ShadeTexture.fromImageSource(product);
      for (const name of ["minFilter", "magFilter", "mipmapFilter", "wrapS", "wrapT", "wrapR", "dimensions"] as const)
        texture[name] = sampler[name];
      material[property] = texture;
    }
  }
  const asset = await load_oegpack_product({
    kind: "http-range",
    url: `${base}${sceneManifest.packs[0]!.uri}`
  }, { manifest: sceneBytes, verifyPageSha256: false });
  if (loadAbort.signal.aborted) {
    asset.release();
    loadAbort.signal.throwIfAborted();
  }
  activeAsset = asset;
  markStartup("geometry-directory-ready");
  setPhase("发布 Virtual Geometry");
  const mask = asset.pack.vertexFormats.reduce((value, format) => value | format.attributeMask, 0);
  const profile = {
    hasAuthoredVertexColor: (mask & (1 << 5)) !== 0,
    hasUv0: (mask & (1 << 3)) !== 0,
    hasUv1: (mask & (1 << 4)) !== 0,
    hasUv2: false,
    hasNormal: (mask & (1 << 1)) !== 0,
    hasTangent: (mask & (1 << 2)) !== 0
  };
  const residency = await renderer.uploadProductScene(scene, asset, ({ descriptor }) => {
    const profiles = Array.from({ length: descriptor.assetRecords.byteLength / 128 }, () => profile);
    const instances = sceneManifest.instances.map((instance, index) => ({
      assetIndex: sceneManifest.assets[instance.asset]!.assetRecordIndex,
      materialIndex: manifest.instanceMaterials[index] ?? 0,
      transform: instance.transform,
      flags: instance.flags
    }));
    return buildVirtualGeometrySceneSourceV1(descriptor, profiles, instances, materials, {
      fitHeight: 0.065,
      fitBase: [0, 0, 0]
    });
  }, {
    residency: {
      requestedProfile: "HighEnd",
      configuredCapacityBytes: 128 * 1024 * 1024,
      configuredBankBytes: 32 * 1024 * 1024
    }
  });
  markStartup("scene-published");
  loadAbort.signal.throwIfAborted();
  void residency.settled().then(
    () => undefined,
    fail
  );
  running = true;
  lastTime = performance.now();
  lastFpsTime = lastTime;
  submittedFrameAtSample = renderer.frame_count;
  const owner = renderer;
  owner.onFrameFinished.addOne(() => {
    void owner.device.queue.onSubmittedWorkDone().then(() => {
      if (disposed || renderer !== owner) return;
      markStartup("first-completed-frame");
      canvas.dataset.initialization = JSON.stringify({
        marks: startupMarks,
        renderer: owner.initializationEvidence(scene),
        texture: owner.graphics.texture_residency.evidence(),
        preparation: owner.texturePreparationEvidence(),
        geometry: activeAsset?.evidence(),
        memory: owner.memoryEvidence()
      });
    }, fail);
  });
  requestAnimationFrame(frame);
  setPhase("就绪 · 拖动旋转，滚轮缩放");
  sceneState.textContent = "Venice Mask · Venice Sunset HDR";
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
  releaseScene();
}, { once: true });

void start().catch(fail);
