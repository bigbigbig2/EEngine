import {
  BoxGeometry, Mesh, PerspectiveCamera, Renderer, Scene, StandardShadeMaterial,
  buildBoxSourceGeometry, cookGeometryAssetPackage, createGeometryCookRecipe
} from "../../../../OEngine/src/index.ts";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits, withGpuErrorScopes } from "../../host/webgpu.ts";
import { ProductionGpuObserver, type ProductionFault } from "../../host/production-gpu-observer.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
type LinearHdrCaptureResult = Awaited<ReturnType<Renderer["requestLinearHdrCapture"]>>;
let renderer: Renderer | undefined;
let intentionalLoss = false;
const devices: GPUDevice[] = [];
const collectors: ReturnType<typeof attachGpuErrorCollection>[] = [];
const observations: unknown[] = [];
const gpuObservers: ProductionGpuObserver[] = [];
const controller = createValidationController({ caseId: "sparse-shading-production", workloadId: "sparse-shading-production-correctness-v1" }, async () => {
  intentionalLoss = true;
  renderer?.destroy();
  for (const device of devices) device.destroy();
  await Promise.all(collectors.map((collector) => collector.lost));
  for (const collector of collectors) collector.remove();
  Object.defineProperty(navigator.gpu, "requestAdapter", { value: requestAdapter, configurable: true });
  return { devices: 0, rafPending: 0, listeners: 0, rendererDestroyed: true, intentionalDeviceDestroy: true };
});

// Validation-owned observation hook, installed before the public Renderer asks
// for a device. No internal engine import or product test-hook API is needed.
const requestAdapter = navigator.gpu?.requestAdapter.bind(navigator.gpu);
if (navigator.gpu) Object.defineProperty(navigator.gpu, "requestAdapter", {
  configurable: true,
  value: async (options?: GPURequestAdapterOptions) => {
    const adapter = await requestAdapter!(options);
    if (adapter === null) return null;
    observations.push({ info: snapshotAdapterInfo(adapter.info), features: snapshotGpuFeatures(adapter.features), limits: snapshotGpuLimits(adapter.limits) });
    const requestDevice = adapter.requestDevice.bind(adapter);
    Object.defineProperty(adapter, "requestDevice", { configurable: true, value: async (descriptor?: GPUDeviceDescriptor) => {
      const device = await requestDevice(descriptor);
      devices.push(device);
      collectors.push(attachGpuErrorCollection(device, controller, () => intentionalLoss));
      gpuObservers.push(new ProductionGpuObserver(device));
      observations.push({ requested: descriptor, features: snapshotGpuFeatures(device.features), limits: snapshotGpuLimits(device.limits) });
      return device;
    } });
    return adapter;
  }
});

const OFF = { shadows: false, screenSpaceDiffuseMode: "off" as const, screenSpaceReflections: false,
  temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false };
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function require(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const results: Record<string, unknown> = {};

async function frame(camera: PerspectiveCamera, scene: Scene): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    await nextFrame();
    if (renderer!.render(camera, scene, 1 / 60)) return;
  }
  throw new Error("Production Renderer did not submit a frame within 240 RAF callbacks");
}
async function capture(camera: PerspectiveCamera, scene: Scene): Promise<LinearHdrCaptureResult> {
  const promise = renderer!.requestLinearHdrCapture({ x: 636, y: 356, width: 8, height: 8, stage: "lighting" });
  await frame(camera, scene);
  return promise;
}
async function validateFactor(result: LinearHdrCaptureResult, expected: readonly number[], label: string): Promise<void> {
  let maximumError = 0;
  for (let pixel = 0; pixel < result.width * result.height; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      const actual = result.rgba[pixel * 4 + channel]!;
      require(Number.isFinite(actual), `${label}: non-finite HDR`);
      maximumError = Math.max(maximumError, Math.abs(actual - expected[channel]!));
    }
  }
  const frameIndex = renderer!.profiler.latest?.frameIndex;
  for (let attempt = 0; frameIndex !== undefined && attempt < 120; attempt++) {
    const sample = renderer!.profiler.getFrame(frameIndex);
    if (sample !== undefined && !sample.gpu.pending && !sample.gpuCounters.pending) break;
    await nextFrame();
  }
  const profile = frameIndex === undefined ? undefined : renderer!.profiler.getFrame(frameIndex);
  const profileHistory = frameIndex === undefined ? undefined : renderer!.profiler.historyStore?.get(frameIndex);
  results[label] = { expected, rgba: [...result.rgba], maximumError, profile, profileHistory,
    graph: renderer!.mainFrameGraphEvidence(), publication: renderer!.sparseShadingPublicationEvidence(),
    owners: renderer!.gpuOwnerCreationEvidence(), memory: renderer!.memoryEvidence(), profiler: renderer!.profiler.diagnostics };
  controller.addEvidence("readback", { scenarios: results });
  require(maximumError <= 0.002, `${label}: HDR factor error ${maximumError}`);
}

try {
  controller.transition("negotiating");
  if (!navigator.gpu || !window.isSecureContext) controller.unsupported("WebGPU secure context unavailable");
  else {
    renderer = new Renderer({ debug: false, renderSettings: { features: OFF } });
    const context = canvas.getContext("webgpu");
    require(context, "WebGPU canvas context unavailable");
    const configureCanvas = context.configure.bind(context);
    Object.defineProperty(context, "configure", { configurable: true, value: (descriptor: GPUCanvasConfiguration) =>
      configureCanvas({ ...descriptor, usage: (descriptor.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) });
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 512 });
    renderer.profiler.setMode("deep-capture");
    renderer.resize(1280, 720);
    const scene = new Scene();
    const geometry = new BoxGeometry(1.5, 1.5, 1.5);
    const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(1.5, 1.5, 1.5), createGeometryCookRecipe());
    const material = new StandardShadeMaterial();
    material.is_unlit = true;
    material.diffuse_color.set(0.12, 0.52, 0.92, 1);
    const cube = Mesh.from(geometry, material);
    scene.add(cube);
    const replacementMaterial = new StandardShadeMaterial();
    replacementMaterial.is_unlit = true;
    replacementMaterial.diffuse_color.set(0.3, 0.2, 0.1, 1);
    const dictionaryMesh = Mesh.from(geometry, replacementMaterial);
    dictionaryMesh.transform_local.position.set(100, 0, 0);
    scene.add(dictionaryMesh);

    // Keep another off-screen active association with a different program so
    // the production case exercises the SparseMicrotile classifier faults as
    // well as the DirectSingleBin path used by the visible cube. The patched
    // material remains registered in the initial scene, preserving the
    // ordinary-scene material publication contract.
    const classifierMaterial = new StandardShadeMaterial();
    classifierMaterial.is_unlit = false;
    classifierMaterial.diffuse_color.set(0.05, 0.05, 0.05, 1);
    const classifierMesh = Mesh.from(geometry, classifierMaterial);
    classifierMesh.transform_local.position.set(200, 0, 0);
    scene.add(classifierMesh);
    await renderer.uploadScene(scene, [{ geometry, asset: cooked.asset }]);
    const camera = new PerspectiveCamera();
    camera.near = 0.05; camera.aspect = 1280 / 720;
    camera.transform.position.set(0, 0, 4); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update();
    controller.transition("ready"); controller.transition("warming");
    await frame(camera, scene);
    controller.transition("sampling");
    const scoped = await withGpuErrorScopes(renderer.device, "production correctness and lifecycle", async () => {
      await validateFactor(await capture(camera, scene), [0.12, 0.52, 0.92, 1], "BasicCubeNear");
      camera.transform.position.set(0, 0, 10); camera.update();
      await validateFactor(await capture(camera, scene), [0.12, 0.52, 0.92, 1], "BasicCubeFar");
      cube.material = replacementMaterial;
      await validateFactor(await capture(camera, scene), [0.3, 0.2, 0.1, 1], "MaterialAssociationPatch");
    });
    require(scoped.errors.length === 0, JSON.stringify(scoped.errors));
    const old = renderer;
    const oldDevice = old.device;
    await oldDevice.queue.onSubmittedWorkDone();
    for (let attempt = 0; attempt < 120 && old.profiler.history.some((value) => value.gpu.pending || value.gpuCounters.pending); attempt++) await nextFrame();
    require(!old.profiler.history.some((value) => value.gpu.pending || value.gpuCounters.pending), "Readback did not drain before intentional device loss");
    intentionalLoss = true; oldDevice.destroy(); await collectors[0]!.lost;
    const recovery = old.recoverAfterDeviceLoss();
    require(recovery === old.recoverAfterDeviceLoss(), "Concurrent recovery was not single-flight");
    renderer = await recovery;
    renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 512 });
    renderer.profiler.setMode("deep-capture");
    intentionalLoss = false;
    require(renderer.device !== oldDevice, "Recovery retained the lost GPUDevice");
    require(!old.render(camera, scene), "Lost Renderer submitted after recovery");
    await validateFactor(await capture(camera, scene), [0.3, 0.2, 0.1, 1], "DeviceRecovery");
    require(devices.length === 2, "Recovery did not re-request exactly one device");
    require(renderer.sparseShadingPublicationEvidence().gpu.activeDeviceEpoch === 2, "Recovery reused the old sparse device epoch");
    const observer = gpuObservers[1]!;
    for (const fault of ["reservation-overflow", "layout-revision", "consumer-identity"] as const) {
      observer.fault = fault;
      const displayCapture = observer.requestDisplayCapture(context);
      await frame(camera, scene);
      const faultFrame = renderer.profiler.latest!.frameIndex;
      await renderer.device.queue.onSubmittedWorkDone();
      let counters;
      for (let attempt = 0; attempt < 120; attempt++) {
        const sample = renderer.profiler.getFrame(faultFrame)!;
        if (!sample.gpuCounters.pending && sample.gpuCounters.sampled && !sample.gpuCounters.dropped) { counters = sample.gpuCounters.values; break; }
        await nextFrame();
      }
      require(counters, `${fault}: safety counter readback unavailable`);
      require(counters.shadingBinFrameFlags! > 0 && counters.shadingBinErrors! > 0, `${fault}: did not invalidate the frame`);
      const pixels = await displayCapture;
      for (let pixel = 0; pixel < 9; pixel++) {
        require(pixels[pixel * 4] === 255 && pixels[pixel * 4 + 1] === 0 && pixels[pixel * 4 + 2] === 255 && pixels[pixel * 4 + 3] === 255,
          `${fault}: Final Output presented partial/non-diagnostic pixels`);
      }
      if (fault !== "consumer-identity") {
        require(counters.shadingBinIndirectWorkgroups === 0, `${fault}: executable indirect work survived`);
        require(counters.shadingBinIndirectNonzeroWords === 0, `${fault}: executable indirect tuple survived`);
        observer.restoreHeapLayout();
      } else require((counters.shadingBinFrameFlags! & 32) !== 0, "Consumer identity failure did not report identity mismatch");
      results[fault] = { counters, faultFrame, finalOutputRgba: [...pixels], finalOutput: renderer.finalOutputEvidence() };
      await validateFactor(await capture(camera, scene), [0.3, 0.2, 0.1, 1], `${fault}/next-valid-frame`);
    }
    const beforeAbort = renderer.sparseShadingPublicationEvidence();
    observer.fault = "aborted-submit" satisfies ProductionFault;
    let aborted = false;
    try { renderer.render(camera, scene, 1 / 60); } catch (error) {
      require(error instanceof Error && error.message === "ADR-0013 intentional aborted-submit fault", "Unexpected submit failure"); aborted = true;
    }
    require(aborted, "Aborted-submit fault did not reach the main submit");
    require(renderer.sparseShadingPublicationEvidence().gpu.activeRevision === beforeAbort.gpu.activeRevision, "Aborted frame advanced publication");
    results.abortedSubmit = { before: beforeAbort, after: renderer.sparseShadingPublicationEvidence(), temporal: renderer.temporalEvidence() };
    await validateFactor(await capture(camera, scene), [0.3, 0.2, 0.1, 1], "after-aborted-submit");
    await Promise.all(gpuObservers.flatMap((value) => value.compilationPending));
    require(gpuObservers.every((value) => value.compilation.every((entry) => entry.messages.every((message) => message.type !== "error"))), "Production shader compilation errors");
    controller.transition("draining");
    await renderer.device.queue.onSubmittedWorkDone();
    controller.addEvidence("adapter", observations[0]);
    controller.addEvidence("devices", observations);
    controller.addEvidence("gpuDiagnostics", gpuObservers.map((value) => ({ creations: value.creations, faultApplications: value.faultApplications, submissions: value.submissions, passes: value.passes, compilation: value.compilation })));
    controller.addEvidence("readback", { schemaVersion: 1, entry: "public Renderer", scenarios: results });
    document.querySelector("#status")!.textContent = "Production Renderer correctness";
    controller.pass();
  }
} catch (error) { controller.fail(error instanceof Error ? error.stack ?? error.message : String(error)); }
