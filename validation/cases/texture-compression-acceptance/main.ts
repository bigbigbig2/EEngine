import {
  Renderer,
  Scene,
  PerspectiveCamera,
  load_oegpack_product,
  parseOegPackSceneManifestV4,
  buildVirtualGeometrySceneSourceV1,
  type ProductSceneHandles
} from "../../../OEngine/src/index.ts";
import { ShadeTexture } from "../../../OEngine/src/texture/ShadeTexture.ts";
import { ImageTextureSource } from "../../../OEngine/src/assets/ImageTextureSource.ts";
import { imageTextureHash } from "../../../OEngine/src/assets/ImageTextureProduct.ts";
import { cookedAssetPreparation } from "../../../OEngine/src/assets/codec/CookedAssetPreparation.ts";
import { MATERIAL_TEXTURE_PROPERTIES } from "../../../OEngine/src/assets/PcMaterialTextures.ts";
import { ShadeImage } from "../../../OEngine/src/texture/ShadeImage.ts";
import { parseGltfMaterial } from "../../../OEngine/src/loaders/gltf/gltfMaterials.ts";
import { textureFromGltf } from "../../../OEngine/src/loaders/gltf/gltfTextures.ts";
import { validationImageKernels } from "../../harness/image-kernels.ts";
import { materialTextureLeaves } from "../../../OEngine/src/assets/PcMaterialTextures.ts";
import { summarizeGpuTimingCost } from "../../../OEngine/src/debug/GpuTimingCost.ts";
import { decodeFloat16 } from "../../../OEngine/src/core/Float16.ts";
import { geometryProductGpuBudgetEvidence } from "../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import type { TextureResidencyEvidence } from "../../../OEngine/src/gpu/TextureResidency.ts";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.ts";
import type { SurfaceV4, NativeSurfaceFrame } from "../../../OEngine/src/render/surface/SurfaceV4.ts";
import { createValidationController, attachGpuErrorCollection } from "../../harness/browser.ts";

const frozen = {
  url: "/assets/texture-dungeon/dungeon.glb",
  bytes: 7990584,
  sha256: "cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1",
  primitives: 798,
  triangles: 72137,
  images: 25
};
const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLPreElement>("#status")!;
let renderer: Renderer | undefined;
let scene: Scene | undefined;
let asset: Awaited<ReturnType<typeof load_oegpack_product>> | undefined;
const sources = new Set<ImageTextureSource>();
let handles: ProductSceneHandles | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
const intentionallyDestroyedDevices = new WeakSet<GPUDevice>();
let disposed = false;
const controller = createValidationController(
  {
    caseId: "texture-compression-acceptance",
    workloadId: "texture-compression-acceptance-v1"
  },
  dispose
);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function distribution(values: number[]) {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
}
async function drained() {
  await renderer!.device.queue.onSubmittedWorkDone();
  await Promise.resolve();
  await Promise.resolve();
}
function zeroTextureOwner(ledger: TextureResidencyEvidence) {
  check(
    ledger.allocatedBytes === 0 &&
      ledger.residentTextureCount === 0 &&
      ledger.retiringTextureCount === 0 &&
      ledger.pendingTextureCount === 0 &&
      ledger.quarantinedTextureCount === 0,
    "Texture owner did not clear after fence"
  );
}
async function dispose() {
  if (!disposed) {
    capture?.destroy();
    winners?.destroy();
    capture = undefined;
    winners = undefined;
    if (renderer && scene) {
      await renderer.releaseScene(scene);
      await drained();
      const texture = renderer.graphics.texture_residency.evidence();
      zeroTextureOwner(texture);
      const geometry = geometryProductGpuBudgetEvidence(renderer.device);
      check(
        geometry.totalBytes === 0 && geometry.allocations === 0 && geometry.metadataAllocations === 0,
        "Geometry owner did not clear"
      );
      controller.addEvidence("teardown", { texture, geometry });
      await renderer.releaseScene(scene);
    }
    asset?.release();
    for (const source of sources) source.close();
    sources.clear();
    errors?.remove();
    if (renderer) intentionallyDestroyedDevices.add(renderer.device);
    renderer?.destroy();
    disposed = true;
  }
  return { disposed, producer: asset?.evidence() ?? null };
}
function observeDeviceErrors() {
  const device = renderer!.device;
  errors = attachGpuErrorCollection(device, controller, () => intentionallyDestroyedDevices.has(device));
}
const camera = new PerspectiveCamera();
function resetCamera() {
  camera.aspect = 1920 / 1080;
  camera.fov_degrees = 60;
  camera.near = 0.05;
  camera.transform.position.set(10, 7, 12);
  camera.transform.lookAt({ x: 0, y: 3, z: 0 });
  camera.update();
}
async function tick() {
  const first = renderer!.frame_count;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const start = performance.now();
    renderer!.render(camera, scene!, 1 / 60);
    const cpuMs = performance.now() - start;
    const wait = performance.now();
    await renderer!.device.queue.onSubmittedWorkDone();
    const completionWaitMs = performance.now() - wait;
    if (renderer!.frame_count !== first) return { cpuMs, completionWaitMs };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Published authored scene never became renderable");
}
let prepared: NativeSurfaceFrame | undefined;
let inspection = false;
let capture: GPUBuffer | undefined;
let winners: GPUBuffer | undefined;
function observeSurface() {
  const surface = Reflect.get(renderer!, "_surface") as SurfaceV4;
  const prepare = surface.prepareFrameNow.bind(surface);
  surface.prepareFrameNow = (frame, bins) => {
    prepared = frame;
    prepare(frame, bins);
  };
  const encode = surface.encode.bind(surface);
  surface.encode = (encoder) => {
    encode(encoder);
    if (!inspection) return;
    check(prepared?.output, "Missing production HDR");
    capture = renderer!.device.createBuffer({
      size: Math.ceil((prepared.width * 8) / 256) * 256 * prepared.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    winners = renderer!.device.createBuffer({
      size: Math.ceil((prepared.width * 4) / 256) * 256 * prepared.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    encoder.copyTextureToBuffer(
      { texture: prepared.output },
      { buffer: capture, bytesPerRow: Math.ceil((prepared.width * 8) / 256) * 256 },
      [prepared.width, prepared.height]
    );
    encoder.copyTextureToBuffer(
      { texture: prepared.visibility },
      { buffer: winners, bytesPerRow: Math.ceil((prepared.width * 4) / 256) * 256 },
      [prepared.width, prepared.height]
    );
  };
}
async function inspect() {
  inspection = true;
  await tick();
  inspection = false;
  check(capture && winners && prepared, "No production capture");
  await Promise.all([capture.mapAsync(GPUMapMode.READ), winners.mapAsync(GPUMapMode.READ)]);
  const colors = new Uint16Array(capture.getMappedRange());
  const keys = new Uint32Array(winners.getMappedRange());
  const colorStride = Math.ceil((prepared.width * 8) / 256) * 128;
  const keyStride = Math.ceil((prepared.width * 4) / 256) * 64;
  let visible = 0,
    nonzero = 0;
  let sum = 0;
  for (let y = 0; y < prepared.height; y++) {
    for (let x = 0; x < prepared.width; x++) {
      if (keys[y * keyStride + x] !== 0xffffffff) visible++;
      for (let c = 0; c < 3; c++) {
        const value = decodeFloat16(colors[y * colorStride + x * 4 + c]!);
        check(Number.isFinite(value), "Nonfinite authored HDR");
        if (value > 0) nonzero++;
        sum += value;
      }
    }
  }
  capture.unmap();
  capture.destroy();
  capture = undefined;
  winners.unmap();
  winners.destroy();
  winners = undefined;
  check(visible > 0 && nonzero > 0, "Empty authored surface");
  return { width: prepared.width, height: prepared.height, visible, nonzero, hdrSum: sum };
}
async function costs() {
  const profiler = renderer!.profiler;
  profiler.configure({ enabled: false, gpuTimingMode: "production" });
  renderer!.perf_gpu_counters_enabled = false;
  for (let i = 0; i < 30; i++) await tick();
  const normal = [];
  for (let i = 0; i < 120; i++) normal.push(await tick());
  profiler.setMode("record");
  profiler.configure({
    enabled: true,
    warmupFrames: 0,
    gpuTimingMode: "full",
    gpuSampleInterval: 1,
    gpuCounterSampleInterval: 1,
    historyCapacity: 512
  });
  renderer!.perf_gpu_counters_enabled = true;
  for (let i = 0; i < 30; i++) await tick();
  profiler.configure({ gpuTimingMode: "full" });
  const first = renderer!.frame_count;
  const full = [];
  for (let i = 0; i < 120; i++) full.push(await tick());
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + 120 && p.gpu.sampled && !p.gpu.pending
      ).length === 120
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const profiles = profiler.history.filter((p) => p.frameIndex >= first && p.frameIndex < first + 120);
  check(
    profiles.length === 120 &&
      profiles.every(
        (p) =>
          p.gpu.sampled &&
          !p.gpu.pending &&
          p.gpu.mode === "full" &&
          !p.counters["gpu.timing.truncated"] &&
          p.submits.count === 1
      ),
    "Incomplete full GPU timing or extra frame submit"
  );
  const measured = profiles.map((p) => summarizeGpuTimingCost(p.gpu.segments));
  const stages = Object.keys(measured[0]!.stageMs);
  check(
    measured.every((p) => p.commandSpanMs !== null && p.surfacePassSumMs !== null),
    "No GPU frame/Surface cost"
  );
  return {
    normalCpuMs: distribution(normal.map((p) => p.cpuMs)),
    profilingCpuMs: distribution(full.map((p) => p.cpuMs)),
    completionWaitMs: distribution(normal.map((p) => p.completionWaitMs)),
    gpuFrameMs: distribution(measured.map((p) => p.commandSpanMs!)),
    surfaceMs: distribution(measured.map((p) => p.surfacePassSumMs!)),
    stagesMs: Object.fromEntries(
      stages.map((label) => [label, distribution(measured.map((p) => p.stageMs[label]!))])
    ),
    normalSamples: normal,
    profilingSamples: full,
    gpuSamples: measured,
    gpuCounters: profiles.map((p) => p.gpuCounters),
    frameSubmits: profiles.map((p) => p.submits.count),
    output: await inspect()
  };
}
async function initialize() {
  renderer = new Renderer({ imageTextureKernels: await validationImageKernels(), autoExposure: false, fixedExposure: 1, requiredFeatures: ["timestamp-query"] });
  await renderer.initialize({ context: canvas.getContext("webgpu")! });
  renderer.resize(1920, 1080);
  observeDeviceErrors();
  controller.addEvidence("capability", renderer.capabilities);
  scene = new Scene();
  resetCamera();
  observeSurface();
}
async function load() {
  const start = performance.now();
  const base = new URL("/assets/texture-dungeon/cooked/", location.href);
  const response = await fetch(new URL("scene.materials.json", base));
  check(response.ok, "Final Dungeon image scene is not mounted");
  const manifest = await response.json();
  check(manifest.schema === "oengine-image-scene-materials-v2" &&
    manifest.source.sha256 === frozen.sha256 && manifest.source.cookedImages === frozen.images &&
    manifest.source.primitives === frozen.primitives && manifest.source.triangles === frozen.triangles,
    "Complete frozen authored scene missing");
  const geometryResponse = await fetch(new URL(manifest.geometryManifest, base));
  check(geometryResponse.ok, "Missing immutable geometry manifest");
  const bytes = await geometryResponse.arrayBuffer();
  check(await imageTextureHash(new Uint8Array(bytes)) === manifest.geometryManifestHash, "Geometry manifest changed");
  const geometry = parseOegPackSceneManifestV4(bytes);
  check(geometry.packs.length === 1, "Dungeon fixture requires its complete single pack, not a subset");
  const images = Array.from({ length: manifest.source.images }, () => ShadeImage.fromEncodedImage(new ArrayBuffer(0), "image/png"));
  const textures = manifest.gltf.textures.map((texture: any) => textureFromGltf(texture, images, manifest.gltf.samplers));
  const materials = manifest.gltf.materials.map((material: any) => parseGltfMaterial(material, textures));
  const byUri = new Map<string, ImageTextureSource>();
  for (const entry of manifest.products) {
    const source = await ImageTextureSource.open(new URL(entry.uri, base).href, entry.identity, entry.byteLength);
    sources.add(source);
    byUri.set(entry.uri, source);
  }
  for (const [index, material] of materials.entries()) {
    for (const property of MATERIAL_TEXTURE_PROPERTIES) {
      const binding = manifest.bindings[index][property];
      if (!binding) { check(!material[property], "Authored texture binding omitted"); continue; }
      const source = byUri.get(binding.uri);
      check(source && textures[binding.textureIndex], "Authored product/sampler missing");
      const texture = ShadeTexture.fromImageSource(source);
      for (const name of ["minFilter", "magFilter", "mipmapFilter", "wrapS", "wrapT", "wrapR", "dimensions"] as const)
        texture[name] = textures[binding.textureIndex][name];
      material[property] = texture;
    }
  }
  asset = await load_oegpack_product({ kind: "http-range", url: new URL(geometry.packs[0]!.uri, base).href }, { manifest: bytes });
  const sourceTriangles = geometry.instances.reduce((sum, instance) => {
    const reference = geometry.assets[instance.asset]!;
    return sum + asset!.pack.assets[reference.assetRecordIndex]!.sourceTriangleCount;
  }, 0);
  check(sourceTriangles === frozen.triangles && geometry.instances.length === manifest.instanceMaterials.length,
    "Incomplete source triangle/instance union");
  handles = await renderer!.uploadProductScene(scene!, asset, ({ descriptor }) => {
    const profiles = new Array(descriptor.assetRecords.byteLength / 128);
    const instances = geometry.instances.map((instance, index) => {
      const assetIndex = geometry.assets[instance.asset]!.assetRecordIndex;
      profiles[assetIndex] = manifest.instanceProfiles[index];
      return { assetIndex, materialIndex: manifest.instanceMaterials[index], transform: instance.transform, flags: instance.flags };
    });
    check(profiles.filter(Boolean).length === profiles.length, "Uninstantiated Product profile");
    return buildVirtualGeometrySceneSourceV1(descriptor, profiles, instances, materials, { fitHeight: 8, fitBase: [0, 0, 0] });
  }, { residency: { requestedProfile: "HighEnd", configuredCapacityBytes: 512 * 1024 ** 2, configuredBankBytes: 128 * 1024 ** 2 } });
  await handles.settled();
  const settledMs = performance.now() - start;
  const runtime = renderer!.graphics.render_world.runtime(scene!)!;
  check(runtime.instanceCount === geometry.instances.length && runtime.materials.length === frozen.images,
    "Incomplete authored material/instance publication");
  const leaves = [...new Set(runtime.materials.flatMap((material) => [...materialTextureLeaves(material)]))];
  const uniqueTextureProducts = new Set(leaves.map((texture) => texture.image_source?.identity)).size;
  check(leaves.length === frozen.images && leaves.every((texture) => texture.image_source &&
    texture.image_source.directory.width === 2048 && texture.image_source.directory.height === 2048),
    "Authored texture domain/resolution changed");
  await tick();
  const firstUsefulFrameMs = performance.now() - start;
  const virtual = renderer!.graphics.texture_residency.virtualTextures;
  const qualityDeadline = performance.now() + 180_000;
  let completeFrames = 0;
  while (completeFrames < 3) {
    await tick();
    const state = virtual?.state();
    const refinement = renderer!.sceneRefinementEvidence(scene!);
    check(!state?.error, `VT preparation failed: ${state?.error}`);
    check(!refinement?.error, `Geometry refinement failed: ${refinement?.error}`);
    completeFrames = (!state || (state.complete && !state.limited)) && refinement?.phase === "view-settled"
      ? completeFrames + 1 : 0;
    check(performance.now() < qualityDeadline, "Visible VG and VT fine/tail demand did not converge");
  }
  const fullQualityMs = performance.now() - start;
  const full = renderer!.graphics.texture_residency.evidence();
  check(full.residentTextureCount === uniqueTextureProducts && full.pendingTextureCount === 0 && full.mipUploadCount > 0,
    "Complete image publication absent");
  const samplers = runtime.nativeMaterials!.bindings.flatMap((binding) =>
    [...binding.program.source.matchAll(/reference, u32\(native_material_constant\(material_base, (\d+)u\)\)/gu)]
      .map((match) => binding.program.constants[Number(match[1])]!));
  const virtualRanges = runtime.nativeMaterials!.bindings.flatMap((binding) =>
    [...binding.program.source.matchAll(/native_vt_sample\([^;]+?u32\(native_material_constant\(material_base, (\d+)u\)\), u32\(native_material_constant\(material_base, (\d+)u\)\)/gu)]
      .map((match) => [binding.program.constants[Number(match[1])]!, binding.program.constants[Number(match[2])]!]));
  check(samplers.length + virtualRanges.length >= frozen.images && samplers.every((value) =>
    ((value & S.MipMask) >>> S.MipShift) === S.FullMipCode), "Native full logical mip publication missing");
  check(virtualRanges.every(([levels, tail]) => levels === 12 && tail >= 0 && tail < levels),
    "Native VT route omitted authored mip levels or its resident tail");
  return { settledMs, firstUsefulFrameMs, fullQualityMs, qualityCompletion: virtual?.evidence() ?? null,
    refinement: renderer!.sceneRefinementEvidence(scene!), uniqueTextureProducts,
    products: 1, instances: runtime.instanceCount, triangles: sourceTriangles, authoredTextureCount: leaves.length,
    quality: manifest.evidence, full, memory: renderer!.memoryEvidence(),
    resourceLedger: renderer!.graphics.resource_accounting.snapshot(),
    geometry: geometryProductGpuBudgetEvidence(renderer!.device),
    preparation: cookedAssetPreparation().evidence(),
    streaming: renderer!.geometryStreamingEvidence(scene!), producer: asset.evidence(), frames: await costs() };
}
async function releaseRun() {
  await renderer!.releaseScene(scene!);
  await drained();
  zeroTextureOwner(renderer!.graphics.texture_residency.evidence());
  const geometry = geometryProductGpuBudgetEvidence(renderer!.device);
  check(
    geometry.totalBytes === 0 && geometry.allocations === 0 && geometry.metadataAllocations === 0,
    "Run retained Geometry allocations"
  );
  asset!.release();
  for (const source of sources) source.close();
  sources.clear();
  check(cookedAssetPreparation().evidence().credit.used.total === 0, "Released scene retained preparation credit");
  errors!.remove();
  intentionallyDestroyedDevices.add(renderer!.device);
  renderer!.destroy();
  renderer = undefined;
  scene = undefined;
  asset = undefined;
  handles = undefined;
}
async function run() {
  try {
    controller.transition("negotiating");
    const response = await fetch(frozen.url);
    const source = await response.arrayBuffer();
    check(
      response.ok &&
        source.byteLength === frozen.bytes &&
        (await imageTextureHash(new Uint8Array(source))) === frozen.sha256,
      "Frozen dungeon source unavailable"
    );
    controller.addEvidence("source", frozen);
    controller.transition("ready");
    controller.transition("warming");
    controller.transition("sampling");
    await initialize();
    const cold = await load();
    controller.addEvidence("cold", cold);
    await releaseRun();
    await initialize();
    const cooked = await load();
    controller.addEvidence("warm", cooked);
    check(cooked.frames.output.visible === cold.frames.output.visible &&
      cooked.frames.output.hdrSum === cold.frames.output.hdrSum,
      "Cold/warm image publication changed Geometry coverage or HDR");
    for (let i = 0; i < 20; i++) {
      camera.transform.position.set(10 + Math.sin(i * 0.3) * 3, 7, 12);
      camera.transform.lookAt({ x: 0, y: 3, z: 0 });
      camera.update();
      await tick();
    }
    renderer!.resize(1280, 720);
    camera.aspect = 1280 / 720;
    camera.update();
    const resized = await inspect();
    renderer!.resize(1920, 1080);
    resetCamera();
    const restored = await inspect();
    controller.addEvidence("resizeMotion", { motionFrames: 20, resized, restored });
    const oldOwner = renderer!.graphics.texture_residency;
    const oldDevice = renderer!.device;
    await drained();
    intentionallyDestroyedDevices.add(oldDevice);
    oldDevice.destroy();
    check((await errors!.lost).reason === "destroyed", "Unexpected device loss reason");
    errors!.remove();
    renderer = await renderer!.recoverAfterDeviceLoss();
    zeroTextureOwner(oldOwner.evidence());
    const oldGeometry = geometryProductGpuBudgetEvidence(oldDevice);
    check(
      oldGeometry.totalBytes === 0 && oldGeometry.allocations === 0 && oldGeometry.metadataAllocations === 0,
      "Lost epoch retained Geometry"
    );
    observeDeviceErrors();
    observeSurface();
    for (let i = 0; i < 8; i++) await tick();
    check(
        renderer.graphics.texture_residency.evidence().residentTextureCount ===
          cooked.uniqueTextureProducts &&
        renderer.geometryStreamingError() === null &&
        renderer.geometryStreamingEvidence(scene!)?.products.length === cooked.products,
      "Recovery lost authored Products or recooked textures"
    );
    controller.addEvidence("recovery", {
      output: await inspect(),
      texture: renderer.graphics.texture_residency.evidence(),
      oldTexture: oldOwner.evidence(),
      oldGeometry,
      epoch: Reflect.get(renderer, "deviceEpoch"),
      limitation: "Controlled device destruction, not native driver fault"
    });
    controller.addEvidence("readback", {
      matches: true,
      cold: cold.frames.output,
      cooked: cooked.frames.output,
      recovery: "finite/nonempty HDR and Geometry winners"
    });
    controller.transition("draining");
    // Runner screenshots the live recovered output, then calls the real fenced teardown.
    controller.pass();
    status.textContent = "Complete Dungeon image GPU encoding acceptance passed";
  } catch (error) {
    controller.fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
void run();
