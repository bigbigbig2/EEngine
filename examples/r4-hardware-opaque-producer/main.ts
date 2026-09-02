import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry
} from "../../OEngine/src/index.ts";
import type { GeometryAssetPackage } from "../../OEngine/src/assets/GeometryAssetPackage.ts";
import { PerspectiveCamera } from "../../OEngine/src/camera/PerspectiveCamera.ts";
import { counterByteOffset } from "../../OEngine/src/debug/GpuFrameCounters.ts";
import {
  computePackedHierarchyWorkCapacity,
  type GeometryHierarchyInstanceReference,
  type GeometryHierarchyView
} from "../../OEngine/src/geometry/GeometryHierarchy.ts";
import { GpuAssetStore, type AssetHandle } from "../../OEngine/src/gpu/GpuAssetStore.ts";
import { GpuScene } from "../../OEngine/src/gpu/GpuScene.ts";
import {
  GPU_VISIBILITY_KEY_EMPTY,
  decodeVisibilityKey,
  resolveVisibilityKeyReference
} from "../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";
import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  unpackDrawIndirectArgs,
  unpackRasterWorkRecords,
  unpackWorkQueueHeader
} from "../../OEngine/src/gpu/GpuWorkGenerationAbi.ts";
import { GPUCameraState } from "../../OEngine/src/render/GPUCameraState.ts";
import { ExactTriangleFilter } from "../../OEngine/src/render/ExactTriangleFilter.ts";
import { HierarchicalWorkGenerator } from "../../OEngine/src/render/HierarchicalWorkGenerator.ts";
import {
  VISIBILITY_COUNTER_WGSL,
  VISIBILITY_COUNTER_WORKGROUP_SIZE
} from "../../OEngine/src/render/passes/VisibilityCounterPass.ts";
import { LPV_CAMERA_TYPE } from "../../OEngine/src/shaders/lpv_indirect_diffuse.ts";
import {
  PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE,
  PACKED_OPAQUE_VISIBILITY_RASTER_WGSL
} from "../../OEngine/src/shaders/packed_visibility.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];

const WIDTH = 320;
const HEIGHT = 240;
const BYTES_PER_ROW = Math.ceil(WIDTH * 4 / 256) * 256;

const status = requiredElement<HTMLElement>("status");
const result = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");
const canvas = requiredElement<HTMLCanvasElement>("preview");
let finalResult: unknown = null;

download.addEventListener("click", () => {
  if (finalResult === null) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(
    [JSON.stringify(finalResult, null, 2)],
    { type: "application/json" }
  ));
  anchor.download = `oengine-r4-a-02-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = "R4-A-02 validation failed";
  status.className = "error";
  result.textContent = message;
  publishResult({ passed: false, fatalError: message });
  console.error(error);
});

interface ResidentFixture {
  readonly asset: GeometryAssetPackage;
  readonly handle: AssetHandle;
  readonly geometryRecordIndex: number;
  readonly clusterRecordBegin: number;
  readonly meshletRecordBegin: number;
}

async function run(): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU is unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available");
  const device = await adapter.requestDevice();
  const deviceLost: string[] = [];
  void device.lost.then((info) => deviceLost.push(`${info.reason}: ${info.message}`));
  const uncapturedErrors: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    uncapturedErrors.push(event.error.message);
  });
  device.pushErrorScope("validation");

  const cooked = await cookGeometryAssetPackage(
    buildTriangleSource(),
    createGeometryCookRecipe({
      meshletMaxVertices: 32,
      meshletMaxTriangles: 64,
      hierarchyTargetFanout: 2,
      hierarchyMaxDepth: 16,
      simplificationTargetRatio: 0.5
    })
  );
  const assets = new GpuAssetStore(device);
  const fixture = await residentFixture(device, assets, cooked.asset);
  const gpuScene = new GpuScene(device, assets);
  const sceneCommand = new BrowserGpuCommand(device, "R4-A-02/instantiate");
  const transforms = transform(0, 0, 4);
  const instanceHandle = gpuScene.instantiate({
    count: 1,
    geometryHandles: [fixture.handle],
    geometryIndices: new Uint32Array([0]),
    materialHandles: new Uint32Array([17]),
    currentTransforms: transforms,
    boundsSpheres: fixture.asset.directory.boundsSphere
  }, sceneCommand);
  const instanceRange = gpuScene.range(instanceHandle);
  sceneCommand.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  const camera = new PerspectiveCamera();
  camera.aspect = WIDTH / HEIGHT;
  camera.fov_degrees = 60;
  camera.near = 0.1;
  const cameraState = new GPUCameraState(device, camera);
  const cameraCommand = new BrowserGpuCommand(device, "R4-A-02/camera");
  cameraState.update(cameraCommand as never);
  cameraCommand.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  const cpuInstances: GeometryHierarchyInstanceReference[] = [{
    asset: fixture.asset,
    instanceRecordIndex: instanceRange.start,
    geometryRecordIndex: fixture.geometryRecordIndex,
    clusterRecordBegin: fixture.clusterRecordBegin,
    meshletRecordBegin: fixture.meshletRecordBegin,
    materialHandle: 17,
    objectToWorld: transforms
  }];
  const capacity = computePackedHierarchyWorkCapacity(cpuInstances);
  const counterBuffer = device.createBuffer({
    label: "R4-A-02/counter sink",
    size: 512,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const generator = new HierarchicalWorkGenerator(device);
  const prepared = generator.prepare({
    assets: assets.bindings(),
    scene: gpuScene.bindings(),
    instanceBegin: instanceRange.start,
    instanceCount: instanceRange.count,
    maxHierarchyDepth: capacity.maxHierarchyDepth,
    traversalWorkCapacity: capacity.traversalWorkCapacity,
    visibleClusterCapacity: capacity.visibleClusterCapacity,
    rasterWorkCapacity: capacity.rasterWorkCapacity,
    counterBuffer
  }, {
    sseThreshold: 4,
    countersEnabled: false,
    diagnosticsEnabled: true
  });
  const exactFilter = new ExactTriangleFilter(device);
  const assetBindings = assets.bindings();
  const sceneBindings = gpuScene.bindings();
  const exactPrepared = exactFilter.prepare({
    camera: cameraState.buffer,
    candidates: prepared.generated.rasterWork,
    candidateCapacity: prepared.generated.rasterWorkCapacity,
    assets: assetBindings,
    scene: sceneBindings,
    counterBuffer,
    countersEnabled: false
  });

  const hardwareModule = device.createShaderModule({
    label: "R4-A-02 production Hardware opaque WGSL",
    code: PACKED_OPAQUE_VISIBILITY_RASTER_WGSL
  });
  const counterModule = device.createShaderModule({
    label: "R4-A-02 production VisibilityKey counter WGSL",
    code: VISIBILITY_COUNTER_WGSL
  });
  const shaderDiagnostics = (await Promise.all([
    shaderDiagnosticsFor(hardwareModule, "Hardware opaque"),
    shaderDiagnosticsFor(counterModule, "VisibilityKey counter")
  ])).flat();
  const shaderErrors = shaderDiagnostics.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(`Hardware opaque WGSL compilation failed: ${JSON.stringify(shaderErrors)}`);
  }

  const bindGroupLayout = device.createBindGroupLayout({
    label: "R4-A-02 Hardware opaque group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
      ...Array.from({ length: 7 }, (_, index) => ({
        binding: index + 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" as GPUBufferBindingType }
      }))
    ]
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: "R4-A-02 Hardware opaque producer",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: hardwareModule, entryPoint: "raster_opaque_exact" },
    fragment: {
      module: hardwareModule,
      entryPoint: "write_opaque_visibility",
      targets: [{ format: "r32uint" }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "greater"
    }
  });

  const visibilityKey = createTarget(device, "Direct VisibilityKey", "r32uint");
  const depth = createTarget(device, "reverse-Z depth", "depth32float");
  const counterBindGroupLayout = device.createBindGroupLayout({
    label: "R4-A-02 VisibilityKey counter group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "uint", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ]
  });
  const counterPipeline = await device.createComputePipelineAsync({
    label: "R4-A-02 VisibilityKey counter",
    layout: device.createPipelineLayout({ bindGroupLayouts: [counterBindGroupLayout] }),
    compute: { module: counterModule, entryPoint: "count_visibility_keys" }
  });
  const counterBindGroup = device.createBindGroup({
    label: "R4-A-02 VisibilityKey counter bindings",
    layout: counterBindGroupLayout,
    entries: [
      { binding: 0, resource: visibilityKey.createView() },
      { binding: 1, resource: { buffer: counterBuffer } }
    ]
  });
  const keyReadback = createReadback(device, "VisibilityKey readback");
  const depthReadback = createReadback(device, "depth readback");
  const rasterReadback = createBufferReadback(device, exactPrepared.output.rasterWork, "Classified RasterWork readback");
  const indirectReadback = device.createBuffer({
    label: "R4-A-02 drawIndirect readback",
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const counterReadback = device.createBuffer({
    label: "R4-A-02 VisibilityKey counter readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const bindGroup = device.createBindGroup({
    label: "R4-A-02 Hardware opaque bindings",
    layout: bindGroupLayout,
    entries: [
      cameraState.buffer,
      sceneBindings.instances,
      assetBindings.meshletRecords,
      assetBindings.meshletVertexIndices,
      assetBindings.meshletTriangleIndices,
      assetBindings.vertexStreamData,
      assetBindings.geometryRecords,
      exactPrepared.output.rasterWork
    ].map((buffer, binding) => ({ binding, resource: { buffer } }))
  });

  const encoder = device.createCommandEncoder({ label: "R4-A-02 producer and evidence" });
  encoder.clearBuffer(counterBuffer, 0, 512);
  generator.encode(encoder, prepared, hierarchyView());
  const exact = exactFilter.encode(encoder, exactPrepared, WIDTH, HEIGHT);
  const pass = encoder.beginRenderPass({
    label: "R4-A-02 Packed VisibilityKey/depth Hardware drawIndirect",
    colorAttachments: [colorAttachment(visibilityKey, GPU_VISIBILITY_KEY_EMPTY)],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: "clear",
      depthStoreOp: "store"
    }
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.drawIndirect(exact.drawIndirect, exact.opaqueDrawOffset);
  pass.end();
  const countPass = encoder.beginComputePass({ label: "R4-A-02 VisibilityKey counter" });
  countPass.setPipeline(counterPipeline);
  countPass.setBindGroup(0, counterBindGroup);
  countPass.dispatchWorkgroups(
    Math.ceil(WIDTH / VISIBILITY_COUNTER_WORKGROUP_SIZE),
    Math.ceil(HEIGHT / VISIBILITY_COUNTER_WORKGROUP_SIZE)
  );
  countPass.end();
  copyTextureToReadback(encoder, visibilityKey, keyReadback);
  copyTextureToReadback(encoder, depth, depthReadback);
  encoder.copyBufferToBuffer(exact.rasterWork, 0, rasterReadback, 0, exact.rasterWork.size);
  encoder.copyBufferToBuffer(exact.drawIndirect, exact.opaqueDrawOffset, indirectReadback, 0, 16);
  encoder.copyBufferToBuffer(counterBuffer, 0, counterReadback, 0, 256);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await Promise.all([
    keyReadback.mapAsync(GPUMapMode.READ),
    depthReadback.mapAsync(GPUMapMode.READ),
    rasterReadback.mapAsync(GPUMapMode.READ),
    indirectReadback.mapAsync(GPUMapMode.READ),
    counterReadback.mapAsync(GPUMapMode.READ)
  ]);
  const keyBytes = new Uint8Array(keyReadback.getMappedRange().slice(0));
  const depthBytes = new Uint8Array(depthReadback.getMappedRange().slice(0));
  const rasterBytes = new Uint8Array(rasterReadback.getMappedRange().slice(0));
  const indirectBytes = new Uint8Array(indirectReadback.getMappedRange().slice(0));
  const counterBytes = new Uint8Array(counterReadback.getMappedRange().slice(0));
  const rasterHeader = unpackWorkQueueHeader(rasterBytes, 0);
  const maskHeader = unpackWorkQueueHeader(rasterBytes, GPU_WORK_QUEUE_HEADER_SCHEMA.stride);
  const rasterRecords = unpackRasterWorkRecords(
    rasterBytes,
    rasterHeader.written,
    GPU_CLASSIFIED_RASTER_HEADER_BYTES
  );
  const drawIndirect = unpackDrawIndirectArgs(indirectBytes);
  const pixelEvidence = inspectPixels(keyBytes, depthBytes, rasterRecords);
  const gpuPixelCounters = unpackPixelCounters(counterBytes);
  drawPreview(keyBytes, depthBytes);

  for (const buffer of [keyReadback, depthReadback, rasterReadback, indirectReadback, counterReadback]) {
    buffer.unmap();
  }
  const validationError = await device.popErrorScope();
  const passed = shaderErrors.length === 0 &&
    validationError === null && uncapturedErrors.length === 0 &&
    rasterHeader.written > 0 && rasterHeader.overflow === 0 && maskHeader.written === 0 &&
    drawIndirect.vertexCount === rasterHeader.written *
      PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE &&
    drawIndirect.instanceCount === 1 &&
    drawIndirect.firstVertex === 0 && drawIndirect.firstInstance === 0 &&
    pixelEvidence.validPixels > 0 && pixelEvidence.emptyPixels > 0 &&
    pixelEvidence.invalidKeys === 0 && pixelEvidence.unresolvedKeys === 0 &&
    pixelEvidence.depthMismatchPixels === 0 &&
    gpuPixelCounters.shadedPixels === pixelEvidence.validPixels &&
    gpuPixelCounters.emptyVisibilityPixels === pixelEvidence.emptyPixels &&
    gpuPixelCounters.invalidVisibilityKeys === pixelEvidence.invalidKeys;

  finalResult = {
    passed,
    task: "R4-A-02 Hardware opaque producer",
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__
    },
    adapter: {
      maxBufferSize: Number(device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize)
    },
    attachment: {
      width: WIDTH,
      height: HEIGHT,
      visibilityKeyFormat: "r32uint",
      depthFormat: "depth32float",
      depthClearValue: 0,
      depthCompare: "greater"
    },
    work: { capacity, rasterHeader, maskHeader, drawIndirect },
    pixels: { ...pixelEvidence, gpuCounters: gpuPixelCounters },
    shaderDiagnostics,
    validationError: validationError?.message ?? null,
    uncapturedErrors,
    deviceLost
  };
  publishResult(finalResult);
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed ? "R4-A-02 GPU validation passed" : "R4-A-02 GPU validation failed";
  status.className = passed ? "ok" : "error";
  download.disabled = false;

  exactFilter.release(exactPrepared);
  exactFilter.destroy();
  generator.release(prepared);
  generator.destroy();
  cameraState.destroy();
  gpuScene.destroy();
  assets.destroy();
  counterBuffer.destroy();
  for (const texture of [visibilityKey, depth]) texture.destroy();
  for (const buffer of [keyReadback, depthReadback, rasterReadback, indirectReadback, counterReadback]) buffer.destroy();
}

async function shaderDiagnosticsFor(module: GPUShaderModule, source: string) {
  return [...(await module.getCompilationInfo()).messages].map((message) => ({
    source,
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
}

function unpackPixelCounters(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    shadedPixels: view.getUint32(counterByteOffset("shadedPixels"), true),
    emptyVisibilityPixels: view.getUint32(counterByteOffset("emptyVisibilityPixels"), true),
    invalidVisibilityKeys: view.getUint32(counterByteOffset("invalidVisibilityKeys"), true)
  };
}

function inspectPixels(
  keyBytes: Uint8Array,
  depthBytes: Uint8Array,
  rasterRecords: ReturnType<typeof unpackRasterWorkRecords>
) {
  let validPixels = 0;
  let emptyPixels = 0;
  let invalidKeys = 0;
  let unresolvedKeys = 0;
  let depthMismatchPixels = 0;
  let minimumVisibleDepth = 1;
  let maximumVisibleDepth = 0;
  const referencedRasterWorkSlots = new Set<number>();
  for (let y = 0; y < HEIGHT; y++) {
    const keyRow = new DataView(keyBytes.buffer, keyBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    const depthRow = new DataView(depthBytes.buffer, depthBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const key = keyRow.getUint32(x * 4, true);
      const pixelDepth = depthRow.getFloat32(x * 4, true);
      const decoded = decodeVisibilityKey(key);
      if (decoded.kind === "empty") {
        emptyPixels++;
        if (pixelDepth !== 0) depthMismatchPixels++;
        continue;
      }
      if (decoded.kind === "invalid") {
        invalidKeys++;
        continue;
      }
      validPixels++;
      referencedRasterWorkSlots.add(decoded.rasterWorkSlot);
      const resolved = resolveVisibilityKeyReference(key, rasterRecords);
      if (resolved.kind !== "valid") unresolvedKeys++;
      if (!(pixelDepth > 0 && pixelDepth <= 1)) depthMismatchPixels++;
      minimumVisibleDepth = Math.min(minimumVisibleDepth, pixelDepth);
      maximumVisibleDepth = Math.max(maximumVisibleDepth, pixelDepth);
    }
  }
  return {
    validPixels,
    emptyPixels,
    invalidKeys,
    unresolvedKeys,
    depthMismatchPixels,
    minimumVisibleDepth,
    maximumVisibleDepth,
    referencedRasterWorkSlots: [...referencedRasterWorkSlots].sort((a, b) => a - b)
  };
}

function drawPreview(keyBytes: Uint8Array, depthBytes: Uint8Array): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D preview context is unavailable");
  const image = context.createImageData(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const keyRow = new DataView(keyBytes.buffer, keyBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    const depthRow = new DataView(depthBytes.buffer, depthBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const key = keyRow.getUint32(x * 4, true);
      const target = (y * WIDTH + x) * 4;
      if (key === GPU_VISIBILITY_KEY_EMPTY) {
        image.data.set([8, 12, 16, 255], target);
        continue;
      }
      const depthValue = depthRow.getFloat32(x * 4, true);
      const light = Math.max(0.25, Math.min(1, depthValue * 40));
      image.data[target] = Math.round((70 + (key & 63)) * light);
      image.data[target + 1] = Math.round(205 * light);
      image.data[target + 2] = Math.round(245 * light);
      image.data[target + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

async function residentFixture(
  device: GPUDevice,
  store: GpuAssetStore,
  asset: GeometryAssetPackage
): Promise<ResidentFixture> {
  const before = store.bindings().highWaterCounts;
  const command = new BrowserGpuCommand(device, "R4-A-02/resident");
  const handle = store.resident(asset, command);
  const geometryRecordIndex = store.recordIndex(handle);
  command.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();
  return {
    asset,
    handle,
    geometryRecordIndex,
    clusterRecordBegin: before.clusterRecords,
    meshletRecordBegin: before.meshletRecords
  };
}

function createTarget(device: GPUDevice, label: string, format: GPUTextureFormat): GPUTexture {
  return device.createTexture({
    label: `R4-A-02 ${label}`,
    size: [WIDTH, HEIGHT],
    format,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC
  });
}

function createReadback(device: GPUDevice, label: string): GPUBuffer {
  return device.createBuffer({
    label: `R4-A-02 ${label}`,
    size: BYTES_PER_ROW * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
}

function createBufferReadback(device: GPUDevice, source: GPUBuffer, label: string): GPUBuffer {
  return device.createBuffer({
    label: `R4-A-02 ${label}`,
    size: source.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
}

function copyTextureToReadback(encoder: GPUCommandEncoder, texture: GPUTexture, buffer: GPUBuffer): void {
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT]
  );
}

function colorAttachment(texture: GPUTexture, clear: number): GPURenderPassColorAttachment {
  return {
    view: texture.createView(),
    clearValue: { r: clear, g: 0, b: 0, a: 0 },
    loadOp: "clear",
    storeOp: "store"
  };
}

function hierarchyView(): GeometryHierarchyView {
  return {
    kind: "perspective",
    cameraPosition: [0, 0, 0],
    viewportHeight: HEIGHT,
    verticalFovRadians: Math.PI / 3,
    nearPlane: 0.1,
    frustumPlanes: [
      [1, 0, 0, 8],
      [-1, 0, 0, 8],
      [0, 1, 0, 8],
      [0, -1, 0, 8],
      [0, 0, 1, -0.1],
      [0, 0, -1, 20]
    ]
  };
}

function buildTriangleSource() {
  return createSourceGeometry({
    sourceId: "r4-a-02-opaque-triangle",
    indices: new Uint32Array([0, 1, 2]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([
        -1.2, -1.0, 0,
        1.2, -1.0, 0,
        0, 1.1, 0
      ])
    }],
    materialRanges: [{
      firstTriangle: 0,
      triangleCount: 1,
      materialId: 0,
      alphaMode: "opaque",
      doubleSided: false
    }]
  });
}

function transform(x: number, y: number, z: number): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ]);
}

function publishResult(value: unknown): void {
  (window as unknown as { __OENGINE_R4_A_02_RESULT__: unknown })
    .__OENGINE_R4_A_02_RESULT__ = value;
}

class BrowserSignal {
  private readonly listeners: ((...args: any[]) => void)[] = [];
  addOne(listener: (...args: any[]) => void): void {
    this.listeners.push(listener);
  }
  send(...args: any[]): void {
    for (const listener of this.listeners.splice(0)) listener(...args);
  }
}

class BrowserGpuCommand {
  readonly onFinished = new BrowserSignal();
  readonly onAborted = new BrowserSignal();
  readonly encoder: GPUCommandEncoder;
  private readonly staging: GPUBuffer[] = [];
  closed = false;

  constructor(readonly device: GPUDevice, label: string) {
    this.encoder = device.createCommandEncoder({ label });
  }

  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size?: number
  ): void {
    this.encoder.copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size);
  }

  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number
  ): void {
    const staging = this.device.createBuffer({
      label: "R4-A-02 transactional upload",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    new Uint8Array(staging.getMappedRange()).set(new Uint8Array(data, dataOffset, size));
    staging.unmap();
    this.staging.push(staging);
    this.encoder.copyBufferToBuffer(staging, 0, buffer, bufferOffset, size);
  }

  finishAndSubmit(): void {
    if (this.closed) throw new Error("BrowserGpuCommand is already closed");
    this.closed = true;
    this.device.queue.submit([this.encoder.finish()]);
    this.onFinished.send(this);
    void this.device.queue.onSubmittedWorkDone().then(() => {
      for (const buffer of this.staging) buffer.destroy();
      this.staging.length = 0;
    });
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}`);
  return element as T;
}
