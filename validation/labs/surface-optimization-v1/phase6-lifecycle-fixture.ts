import {
  BoxGeometry, Mesh, PerspectiveCamera, PointLight, Renderer, Scene,
  StandardShadeMaterial, cookSceneGeometryProductV1, createDefaultWebGeometryCookerModule
} from "../../../OEngine/src/index.ts";

const host = globalThis as typeof globalThis & {
  cellOracleStage?: string; cellOracleResult?: unknown;
};
const report = { evidenceRole: "diagnostic", accepted: false, passed: false,
  cases: [] as unknown[], errors: [] as string[], failure: "" };
function check(condition: unknown, message: string): asserts condition {
  if (!condition) { throw new Error(message); }
}
let renderer: Renderer | undefined;
let swapchain: GPUTexture | undefined;
let readback: { buffer: GPUBuffer; width: number; height: number; pitch: number } | undefined;
let intentionalLoss = false;
const allocations: { label: string; bytes: number; destroyed: boolean }[] = [];
let scratchPeakBytes = 0;
const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const context = canvas.getContext("webgpu")!;
const configure = context.configure.bind(context);
context.configure = config => configure({ ...config,
  usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
const currentTexture = context.getCurrentTexture.bind(context);
context.getCurrentTexture = () => { swapchain = currentTexture(); return swapchain; };

function trace(device: GPUDevice): void {
  device.addEventListener("uncapturederror", event => report.errors.push(event.error.message));
  void device.lost.then(info => {
    if (!intentionalLoss) { report.errors.push(`Unexpected device loss: ${info.message}`); }
  });
  const create = device.createBuffer.bind(device);
  device.createBuffer = descriptor => {
    const buffer = create(descriptor);
    if ((descriptor.label ?? "").startsWith("Surface/")) {
      const entry = { label: descriptor.label!, bytes: descriptor.size, destroyed: false };
      allocations.push(entry);
      const live = allocations.filter(item => !item.destroyed && item.label !== "Surface/local texture variation pool")
        .reduce((sum, item) => sum + item.bytes, 0);
      scratchPeakBytes = Math.max(scratchPeakBytes, live);
      check(live <= 240 * 1024 ** 2, "Actual live/retired Surface scratch exceeded its physical envelope");
      const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => { entry.destroyed = true; destroy(); };
    }
    return buffer;
  };
  const createEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = descriptor => {
    const encoder = createEncoder(descriptor), finish = encoder.finish.bind(encoder);
    encoder.finish = finishDescriptor => {
      if (descriptor?.label === "Renderer/visibility-frame" && swapchain !== undefined) {
        readback?.buffer.destroy();
        const width = canvas.width, height = canvas.height;
        const pitch = Math.ceil(width * 4 / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyTextureToBuffer({ texture: swapchain }, { buffer, bytesPerRow: pitch }, [width, height]);
        readback = { buffer, width, height, pitch };
      }
      return finish(finishDescriptor);
    };
    return encoder;
  };
}

async function pixels(): Promise<Uint8Array> {
  check(renderer && readback, "No actual frame readback producer");
  const { buffer, width, height, pitch } = readback;
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) { result.set(mapped.subarray(y * pitch, y * pitch + width * 4), y * width * 4); }
  buffer.unmap(); buffer.destroy(); readback = undefined;
  let colored = 0;
  for (let i = 0; i < result.length; i += 4) {
    if (Math.max(result[i]!, result[i + 1]!, result[i + 2]!) - Math.min(result[i]!, result[i + 1]!, result[i + 2]!) > 5) { colored++; }
  }
  check(colored > 32, "Renderer output has no nonzero material/light workload");
  return result;
}

async function run(): Promise<void> {
  try {
    host.cellOracleStage = "Initializing actual Renderer and cooked Product";
    renderer = new Renderer({ enableVsm: false, enablePhysicalEnvironment: true,
      autoExposure: false, fixedExposure: 1,
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
    await renderer.initialize({ context }); trace(renderer.device);
    renderer.shadowVisibilityEnabled = false;
    renderer.temporal_jitter_enabled = false;
    renderer.xe_gtao_enabled = false; renderer.fsr3_enabled = false; renderer.bloom_enabled = false;
    const scene = new Scene(), material = new StandardShadeMaterial();
    material.diffuse_color.set(0.8, 0.15, 0.07, 1);
    scene.add(Mesh.from(new BoxGeometry(1.5, 1.5, 1.5), material));
    const light = new PointLight(); light.position.set(2, 3, 4); light.distance = 20;
    light.intensity = 200; light.casts_shadow = false; scene.add(light);
    const module = await createDefaultWebGeometryCookerModule();
    const product = await cookSceneGeometryProductV1(scene, { module,
      producerId: "surface-phase6-lifecycle", producerVersion: "1", maxDecodedProductBytes: 64 * 1024 ** 2 });
    await renderer.uploadCookedSceneProduct(scene, product);
    const camera = new PerspectiveCamera(); camera.near = 0.05; camera.far = 100;
    camera.transform.position.set(3, 2, 4); camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    const frame = async (width: number, height: number) => {
      renderer!.resize(width, height); camera.aspect = width / height; camera.update();
      const before = renderer!.frame_count;
      for (let retry = 0; retry < 8 && renderer!.frame_count === before; retry++) {
        check(renderer!.render(camera, scene), "Renderer rejected healthy frame");
        await renderer!.device.queue.onSubmittedWorkDone();
      }
      check(renderer!.frame_count > before, "Resize remained deferred after actual completion fence");
      return pixels();
    };
    const base = await frame(320, 240);
    const scratch = () => allocations.filter(a => a.label === "Surface/cell plan workspace");
    const first = scratch().length;
    await frame(320, 240);
    check(scratch().length === first, "Steady frame reallocated Workspace");
    report.cases.push({ name: "steady actual Workspace reuse", passed: true });
    host.cellOracleStage = "NPOT, rapid resize and actual queue retirement";
    for (const [width, height] of [[333, 251], [640, 360], [320, 240]]) {
      await frame(width!, height!);
      check(scratch().filter(a => !a.destroyed).length === 1, "Completed resize retained old Workspace");
      report.cases.push({ name: "resize", width, height, passed: true });
    }
    // No wait between these real submissions/requests. The final extent must win.
    renderer.render(camera, scene);
    renderer.resize(701, 397); renderer.resize(509, 283); renderer.resize(337, 253);
    renderer.render(camera, scene);
    await renderer.device.queue.onSubmittedWorkDone();
    await frame(337, 253);
    check(canvas.width === 337 && canvas.height === 253, "Rapid resize lost latest extent");
    report.cases.push({ name: "rapid resize latest extent", passed: true });
    host.cellOracleStage = "camera cut and encoder abort/retry";
    camera.transform.position.set(-3, 2, 4); camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    renderer.invalidateTemporalHistory(); await frame(320, 240);
    report.cases.push({ name: "camera cut real output", passed: true });
    const beforeRestart = await frame(320, 240);
    const fieldStore = renderer.graphics.surface_field_store;
    const signalStore = renderer.graphics.surface_signal_store;
    fieldStore.requestNamespaceRestart(); signalStore.requestNamespaceRestart();
    const createEncoder = renderer.device.createCommandEncoder.bind(renderer.device);
    let injected = false;
    renderer.device.createCommandEncoder = descriptor => {
      const encoder = createEncoder(descriptor), begin = encoder.beginComputePass.bind(encoder);
      encoder.beginComputePass = passDescriptor => {
        if (!injected && passDescriptor?.label?.startsWith("Surface/reconstruct batch")) {
          injected = true; throw new Error("fixture controlled pre-submit abort");
        }
        return begin(passDescriptor);
      };
      return encoder;
    };
    let abortObserved = false;
    try { renderer.render(camera, scene); }
    catch (error) { check(String(error).includes("fixture controlled"), "Unexpected abort root cause"); abortObserved = true; }
    renderer.device.createCommandEncoder = createEncoder;
    check(injected && abortObserved, "Required actual encoder abort branch did not execute");
    check(fieldStore.needsNamespaceRestart() && signalStore.needsNamespaceRestart(),
      "Abort advanced a namespace which was never submitted");
    const afterRestart = await frame(320, 240);
    check(!fieldStore.needsNamespaceRestart() && !signalStore.needsNamespaceRestart(), "Real GPU namespace restart did not commit");
    let namespaceDifference = 0;
    for (let i = 0; i < afterRestart.length; i++) {
      namespaceDifference = Math.max(namespaceDifference, Math.abs(afterRestart[i]! - beforeRestart[i]!));
    }
    check(namespaceDifference <= 1, `Namespace rebuild lost complete output: ${namespaceDifference}`);
    report.cases.push({ name: "coordinated namespace restart survives abort and GPU rebuild", namespaceDifference, passed: true });
    report.cases.push({ name: "actual encoder abort followed by complete retry", passed: true });
    host.cellOracleStage = "device loss, fresh owners and Product replay";
    const beforeRecovery = await frame(320, 240), old = renderer;
    swapchain = undefined;
    intentionalLoss = true; old.device.destroy(); await old.device.lost;
    renderer = await old.recoverAfterDeviceLoss(); trace(renderer.device);
    check(renderer.device !== old.device, "Recovery reused dead device");
    renderer.shadowVisibilityEnabled = false;
    renderer.temporal_jitter_enabled = false;
    renderer.xe_gtao_enabled = false; renderer.fsr3_enabled = false; renderer.bloom_enabled = false;
    const afterRecovery = await frame(320, 240);
    check(afterRecovery.length === beforeRecovery.length, "Recovery changed output shape");
    let maxDifference = 0;
    for (let i = 0; i < afterRecovery.length; i++) { maxDifference = Math.max(maxDifference, Math.abs(afterRecovery[i]! - beforeRecovery[i]!)); }
    check(maxDifference <= 1, `Recovery changed material/light output: ${maxDifference}`);
    report.cases.push({ name: "fresh device Product and Surface recovery", maxDifference, passed: true });
    report.cases.push({ name: "initial output", bytes: base.length, passed: true });
    check(report.errors.length === 0, "Actual GPU errors occurred");
    report.passed = true;
  } catch (error) { report.failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    intentionalLoss = true; renderer?.destroy();
    readback?.buffer.destroy();
    await Promise.resolve();
    host.cellOracleResult = { ...report, allocations, scratchPeakBytes };
  }
}
void run();
