import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry
} from "../../OEngine/src/index.ts";
import type { GeometryAssetPackage } from "../../OEngine/src/assets/GeometryAssetPackage.ts";
import {
  computePackedHierarchyWorkCapacity,
  selectGeometryHierarchyInstances,
  type GeometryHierarchyInstanceReference,
  type GeometryHierarchyView
} from "../../OEngine/src/geometry/GeometryHierarchy.ts";
import {
  GpuAssetStore,
  type AssetHandle
} from "../../OEngine/src/gpu/GpuAssetStore.ts";
import { GpuScene } from "../../OEngine/src/gpu/GpuScene.ts";
import {
  unpackDrawIndirectArgs,
  unpackRasterWorkRecords,
  unpackVisibleClusterRecords,
  unpackWorkQueueHeader
} from "../../OEngine/src/gpu/GpuWorkGenerationAbi.ts";
import {
  HierarchicalWorkGenerator,
  type HierarchicalWorkFeatures,
  type PreparedHierarchyWork
} from "../../OEngine/src/render/HierarchicalWorkGenerator.ts";
import {
  HIERARCHICAL_HZB_WORK_GENERATION_WGSL,
  HIERARCHICAL_WORK_GENERATION_WGSL
} from "../../OEngine/src/shaders/hierarchical_work_generation.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");
let finalResult: unknown = null;

download.addEventListener("click", () => {
  if (finalResult === null) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(
    [JSON.stringify(finalResult, null, 2)],
    { type: "application/json" }
  ));
  anchor.download = `oengine-r3-c-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  status.textContent = "R3-C 验证失败";
  status.className = "error";
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});

interface ResidentFixture {
  readonly asset: GeometryAssetPackage;
  readonly handle: AssetHandle;
  readonly geometryRecordIndex: number;
  readonly clusterRecordBegin: number;
  readonly meshletRecordBegin: number;
}

interface GpuCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly selectedCount: number;
  readonly selectedKeys: readonly string[];
  readonly cpuKeys: readonly string[];
  readonly root: ReturnType<typeof unpackWorkQueueHeader>;
  readonly rounds: readonly ReturnType<typeof unpackWorkQueueHeader>[];
  readonly selected: ReturnType<typeof unpackWorkQueueHeader>;
  readonly raster: ReturnType<typeof unpackWorkQueueHeader>;
  readonly rasterKeys: readonly string[];
  readonly cpuRasterKeys: readonly string[];
  readonly drawIndirect: ReturnType<typeof unpackDrawIndirectArgs>;
}

async function shaderCompilationDiagnostics(
  device: GPUDevice,
  label: string,
  code: string
): Promise<readonly {
  readonly source: string;
  readonly type: GPUCompilationMessageType;
  readonly message: string;
  readonly lineNum: number;
  readonly linePos: number;
}[]> {
  const module = device.createShaderModule({ label, code });
  return [...(await module.getCompilationInfo()).messages].map((message) => ({
    source: label,
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
}

async function run(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("没有可用的 WebGPU adapter");
  const device = await adapter.requestDevice();
  const uncapturedErrors: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    uncapturedErrors.push(event.error.message);
  });
  device.pushErrorScope("validation");

  const recipe = createGeometryCookRecipe({
    meshletMaxVertices: 32,
    meshletMaxTriangles: 64,
    hierarchyTargetFanout: 2,
    hierarchyMaxDepth: 16,
    simplificationTargetRatio: 0.5
  });
  const cooked = await Promise.all([
    cookGeometryAssetPackage(buildGridSource("r3-b-grid-a", 32, 30, 0.35), recipe),
    cookGeometryAssetPackage(buildGridSource("r3-b-grid-b", 26, 34, 0.55), recipe),
    cookGeometryAssetPackage(buildTriangleSource("r3-d-depth-zero"), recipe)
  ]);
  const assetA = cooked[0]!.asset;
  const assetB = cooked[1]!.asset;
  const assetC = cooked[2]!.asset;
  if (assetA.clusters.length < 3 || assetB.clusters.length < 3) {
    throw new Error("R3-B fixtures did not produce multi-level Cluster hierarchies");
  }
  if (assetC.clusters.length !== 0 || assetC.meshlets.length !== 1) {
    throw new Error("R3-D fused-leaf fixture did not produce a virtual depth-zero leaf");
  }

  const shaderDiagnostics = (await Promise.all([
    shaderCompilationDiagnostics(
      device,
      "R3-D/browser work generation diagnostics",
      HIERARCHICAL_WORK_GENERATION_WGSL
    ),
    shaderCompilationDiagnostics(
      device,
      "R3-D/browser previous-HZB diagnostics",
      HIERARCHICAL_HZB_WORK_GENERATION_WGSL
    )
  ])).flat();
  const shaderErrors = shaderDiagnostics.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(`R3-B WGSL compilation failed: ${JSON.stringify(shaderErrors)}`);
  }

  const assets = new GpuAssetStore(device);
  const fixtures = [
    await residentFixture(device, assets, assetA, "A"),
    await residentFixture(device, assets, assetB, "B"),
    await residentFixture(device, assets, assetC, "C")
  ] as const;
  const geometryIndices = new Uint32Array([0, 1, 0, 1, 2]);
  const materialHandles = new Uint32Array([101, 202, 303, 404, 505]);
  const transforms = new Float32Array(5 * 16);
  transforms.set(transform(-3, 0, -12, 1, 1, 1), 0);
  transforms.set(transform(3, 0, -24, -1.5, 2, 0.75), 16);
  transforms.set(transform(0, 0, -0.5, 1, 1, 1), 32);
  transforms.set(transform(100, 0, -15, 1, 1, 1), 48);
  transforms.set(transform(0, 0, -8, 1, 1, 1), 64);
  const boundsSpheres = new Float32Array(20);
  for (let index = 0; index < geometryIndices.length; index++) {
    boundsSpheres.set(
      fixtures[geometryIndices[index]!]!.asset.directory.boundsSphere,
      index * 4
    );
  }

  const gpuScene = new GpuScene(device, assets);
  const sceneCommand = new BrowserGpuCommand(device, "R3-B/instantiate");
  const instanceHandle = gpuScene.instantiate({
    count: geometryIndices.length,
    geometryHandles: fixtures.map((fixture) => fixture.handle),
    geometryIndices,
    materialHandles,
    currentTransforms: transforms,
    boundsSpheres
  }, sceneCommand);
  const instanceRange = gpuScene.range(instanceHandle);
  sceneCommand.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  const cpuInstances: GeometryHierarchyInstanceReference[] = [];
  for (let index = 0; index < geometryIndices.length; index++) {
    const fixture = fixtures[geometryIndices[index]!]!;
    cpuInstances.push({
      asset: fixture.asset,
      instanceRecordIndex: instanceRange.start + index,
      geometryRecordIndex: fixture.geometryRecordIndex,
      clusterRecordBegin: fixture.clusterRecordBegin,
      meshletRecordBegin: fixture.meshletRecordBegin,
      materialHandle: materialHandles[index]!,
      objectToWorld: transforms.subarray(index * 16, index * 16 + 16)
    });
  }
  const capacity = computePackedHierarchyWorkCapacity(cpuInstances);
  if (capacity.maxHierarchyDepth < 1 || capacity.traversalWorkCapacity < 2) {
    throw new Error("R3-B fixtures do not exercise ping/pong or pressure fallback");
  }

  const generator = new HierarchicalWorkGenerator(device);
  const counterBuffer = device.createBuffer({
    label: "R3-C/browser counter sink",
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST
  });
  const descriptor = {
    assets: assets.bindings(),
    scene: gpuScene.bindings(),
    instanceBegin: instanceRange.start,
    instanceCount: instanceRange.count,
    maxHierarchyDepth: capacity.maxHierarchyDepth,
    traversalWorkCapacity: capacity.traversalWorkCapacity,
    visibleClusterCapacity: capacity.visibleClusterCapacity,
    rasterWorkCapacity: capacity.rasterWorkCapacity,
    counterBuffer
  };
  const normal = generator.prepare(descriptor, {
    sseThreshold: 18,
    countersEnabled: false,
    diagnosticsEnabled: true
  });
  const pressure = generator.prepare(descriptor, {
    sseThreshold: 0,
    countersEnabled: false,
    diagnosticsEnabled: true,
    traversalWorkCapacity: 1
  });
  const leafInstances = cpuInstances.slice(-1);
  const leafCapacity = computePackedHierarchyWorkCapacity(leafInstances);
  const leaf = generator.prepare({
    ...descriptor,
    instanceBegin: instanceRange.start + instanceRange.count - 1,
    instanceCount: 1,
    maxHierarchyDepth: leafCapacity.maxHierarchyDepth,
    traversalWorkCapacity: leafCapacity.traversalWorkCapacity,
    visibleClusterCapacity: leafCapacity.visibleClusterCapacity,
    rasterWorkCapacity: leafCapacity.rasterWorkCapacity
  }, {
    sseThreshold: 18,
    countersEnabled: false,
    diagnosticsEnabled: true
  });
  const emptyHzb = device.createTexture({
    label: "R3-D/browser empty previous HZB",
    size: [1, 1, 1],
    format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture(
    { texture: emptyHzb },
    new Uint8Array(256),
    { bytesPerRow: 256 },
    [1, 1, 1]
  );
  const hzbFeatures: HierarchicalWorkFeatures = {
    previousHzb: {
      view: emptyHzb.createView(),
      width: 1,
      height: 1,
      mipLevelCount: 1,
      worldToClipMatrix: identityMatrix()
    }
  };
  const cases = [
    await runCase(device, counterBuffer, generator, normal, perspectiveView(), cpuInstances, 18, capacity.traversalWorkCapacity, "perspective"),
    await runCase(device, counterBuffer, generator, normal, perspectiveView(), cpuInstances, 18, capacity.traversalWorkCapacity, "perspective-empty-hzb", hzbFeatures),
    await runCase(device, counterBuffer, generator, normal, orthographicView(), cpuInstances, 18, capacity.traversalWorkCapacity, "orthographic"),
    await runCase(device, counterBuffer, generator, normal, emptyView(), cpuInstances, 18, capacity.traversalWorkCapacity, "empty-queue"),
    await runCase(device, counterBuffer, generator, pressure, perspectiveView(), cpuInstances, 0, 1, "capacity-parent-fallback"),
    await runCase(device, counterBuffer, generator, leaf, perspectiveView(), leafInstances, 18, leafCapacity.traversalWorkCapacity, "depth-zero-fused-leaf")
  ];
  const pressureFallback = cases[4]!.rounds.some((round) => round.fallback > 0);
  const emptyQueue = cases[3]!.selectedCount === 0 &&
    cases[3]!.rounds.every((round) => round.written === 0);
  const validationError = await device.popErrorScope();
  await device.queue.onSubmittedWorkDone();

  const ownerEvidence = generator.evidence(normal);
  const passed = cases.every((entry) => entry.passed) &&
    pressureFallback && emptyQueue && validationError === null &&
    uncapturedErrors.length === 0;
  finalResult = {
    passed,
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__
    },
    adapter: {
      maxBufferSize: Number(device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
      maxComputeWorkgroupsPerDimension: Number(device.limits.maxComputeWorkgroupsPerDimension)
    },
    source: {
      geometryCount: fixtures.length,
      instanceCount: instanceRange.count,
      clusterCounts: fixtures.map((fixture) => fixture.asset.clusters.length),
      meshletCounts: fixtures.map((fixture) => fixture.asset.meshlets.length),
      nearPlaneInstance: true,
      mirroredNonUniformInstance: true
    },
    capacity,
    leafCapacity,
    ownerEvidence,
    leafOwnerEvidence: generator.evidence(leaf),
    cases,
    pressureFallback,
    emptyQueue,
    shaderDiagnostics,
    validationError: validationError?.message ?? null,
    uncapturedErrors
  };
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed ? "R3-C GPU/CPU RasterWork 验证通过" : "R3-C 验证未通过";
  status.className = passed ? "ok" : "error";
  summary.textContent = `6 cases，${capacity.maxHierarchyDepth + 1} encoded rounds，pressure fallback=${pressureFallback}，leaf=${generator.evidence(leaf).implementation}。`;
  download.disabled = false;

  generator.release(normal);
  generator.release(pressure);
  generator.release(leaf);
  generator.destroy();
  emptyHzb.destroy();
  counterBuffer.destroy();
  gpuScene.destroy();
  assets.destroy();
}

async function residentFixture(
  device: GPUDevice,
  store: GpuAssetStore,
  asset: GeometryAssetPackage,
  suffix: string
): Promise<ResidentFixture> {
  const before = store.bindings().highWaterCounts;
  const command = new BrowserGpuCommand(device, `R3-B/resident-${suffix}`);
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

async function runCase(
  device: GPUDevice,
  counterBuffer: GPUBuffer,
  generator: HierarchicalWorkGenerator,
  prepared: PreparedHierarchyWork,
  view: GeometryHierarchyView,
  cpuInstances: readonly GeometryHierarchyInstanceReference[],
  sseThreshold: number,
  traversalQueueCapacity: number,
  name: string,
  features: HierarchicalWorkFeatures = {}
): Promise<GpuCaseResult> {
  const generated = prepared.generated;
  if (generated.evidence === null) {
    throw new Error(`R3-D/${name} diagnostics evidence was not enabled`);
  }
  const evidence = generated.evidence;
  const selectedReadback = device.createBuffer({
    label: `R3-B/${name}/selected-readback`,
    size: generated.visibleClusters.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const evidenceReadback = device.createBuffer({
    label: `R3-B/${name}/evidence-readback`,
    size: evidence.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const rasterReadback = device.createBuffer({
    label: `R3-C/${name}/RasterWork-readback`,
    size: generated.rasterWork.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const indirectReadback = device.createBuffer({
    label: `R3-C/${name}/drawIndirect-readback`,
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder({ label: `R3-B/${name}` });
  encoder.clearBuffer(counterBuffer, 0, 256);
  generator.encode(encoder, prepared, view, features);
  encoder.copyBufferToBuffer(generated.visibleClusters, 0, selectedReadback, 0, generated.visibleClusters.size);
  encoder.copyBufferToBuffer(evidence, 0, evidenceReadback, 0, evidence.size);
  encoder.copyBufferToBuffer(generated.rasterWork, 0, rasterReadback, 0, generated.rasterWork.size);
  encoder.copyBufferToBuffer(generated.drawIndirect, 0, indirectReadback, 0, 16);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await Promise.all([
    selectedReadback.mapAsync(GPUMapMode.READ),
    evidenceReadback.mapAsync(GPUMapMode.READ),
    rasterReadback.mapAsync(GPUMapMode.READ),
    indirectReadback.mapAsync(GPUMapMode.READ)
  ]);
  const selectedBytes = new Uint8Array(selectedReadback.getMappedRange().slice(0));
  const evidenceBytes = new Uint8Array(evidenceReadback.getMappedRange().slice(0));
  const rasterBytes = new Uint8Array(rasterReadback.getMappedRange().slice(0));
  const indirectBytes = new Uint8Array(indirectReadback.getMappedRange().slice(0));
  selectedReadback.unmap();
  evidenceReadback.unmap();
  rasterReadback.unmap();
  indirectReadback.unmap();
  selectedReadback.destroy();
  evidenceReadback.destroy();
  rasterReadback.destroy();
  indirectReadback.destroy();

  const selected = unpackWorkQueueHeader(selectedBytes);
  const gpuVisibleRecords = unpackVisibleClusterRecords(
    selectedBytes,
    selected.written
  );
  const gpuKeys = gpuVisibleRecords.map(recordKey).sort();
  const cpu = selectGeometryHierarchyInstances(cpuInstances, {
    view,
    sseThreshold,
    rootQueueCapacity: cpuInstances.length,
    traversalQueueCapacity
  });
  const cpuKeys = cpu.selectedClusters.map(recordKey).sort();
  const raster = unpackWorkQueueHeader(rasterBytes);
  const rasterKeys = unpackRasterWorkRecords(rasterBytes, raster.written)
    .map((work) => `${recordKey(gpuVisibleRecords[work.visibleClusterSlot]!)}:${work.meshletRecordIndex}`)
    .sort();
  const cpuRasterKeys = cpu.selectedMeshlets.map((work) =>
    `${recordKey(cpu.selectedClusters[work.visibleClusterSlot]!)}:${work.meshletRecordIndex}`
  ).sort();
  const drawIndirect = unpackDrawIndirectArgs(indirectBytes);
  const layout = generated.evidenceLayout;
  const root = unpackWorkQueueHeader(
    evidenceBytes,
    layout.rootHeaderIndex * layout.headerStride
  );
  const rounds = Array.from({ length: layout.traversalHeaderCount }, (_, index) =>
    unpackWorkQueueHeader(
      evidenceBytes,
      (layout.traversalHeaderBegin + index) * layout.headerStride
    )
  );
  const selectedEvidence = unpackWorkQueueHeader(
    evidenceBytes,
    layout.selectedHeaderIndex * layout.headerStride
  );
  const rasterEvidence = unpackWorkQueueHeader(
    evidenceBytes,
    layout.rasterHeaderIndex * layout.headerStride
  );
  const passed = JSON.stringify(gpuKeys) === JSON.stringify(cpuKeys) &&
    JSON.stringify(rasterKeys) === JSON.stringify(cpuRasterKeys) &&
    selected.overflow === 0 && selected.written === selectedEvidence.written &&
    raster.overflow === 0 && raster.written === rasterEvidence.written &&
    drawIndirect.vertexCount === 384 &&
    drawIndirect.instanceCount === raster.written &&
    drawIndirect.firstVertex === 0 && drawIndirect.firstInstance === 0 &&
    root.overflow === 0 && rounds.at(-1)?.written === 0;
  return {
    name,
    passed,
    selectedCount: selected.written,
    selectedKeys: gpuKeys,
    cpuKeys,
    root,
    rounds,
    selected: selectedEvidence,
    raster: rasterEvidence,
    rasterKeys,
    cpuRasterKeys,
    drawIndirect
  };
}

function recordKey(record: {
  readonly instanceRecordIndex: number;
  readonly geometryRecordIndex: number;
  readonly clusterRecordIndex: number;
  readonly materialHandle: number;
}): string {
  return `${record.instanceRecordIndex}:${record.geometryRecordIndex}:` +
    `${record.clusterRecordIndex}:${record.materialHandle}`;
}

function perspectiveView(): GeometryHierarchyView {
  return {
    kind: "perspective",
    cameraPosition: [0, 0, 0],
    viewportHeight: 720,
    verticalFovRadians: Math.PI / 3,
    nearPlane: 0.1,
    frustumPlanes: boxFrustum(45, 45, 0.1, 120)
  };
}

function orthographicView(): GeometryHierarchyView {
  return {
    kind: "orthographic",
    cameraPosition: [0, 0, 0],
    viewportHeight: 720,
    verticalWorldSize: 36,
    frustumPlanes: boxFrustum(45, 45, 0.1, 120)
  };
}

function emptyView(): GeometryHierarchyView {
  const base = perspectiveView();
  return {
    ...base,
    frustumPlanes: [[1, 0, 0, -1000], ...base.frustumPlanes.slice(1)]
  };
}

function boxFrustum(
  horizontal: number,
  vertical: number,
  near: number,
  far: number
): GeometryHierarchyView["frustumPlanes"] {
  return [
    [1, 0, 0, horizontal],
    [-1, 0, 0, horizontal],
    [0, 1, 0, vertical],
    [0, -1, 0, vertical],
    [0, 0, -1, -near],
    [0, 0, 1, far]
  ];
}

function transform(
  x: number,
  y: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number
): Float32Array {
  return new Float32Array([
    scaleX, 0, 0, 0,
    0, scaleY, 0, 0,
    0, 0, scaleZ, 0,
    x, y, z, 1
  ]);
}

function identityMatrix(): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
}

function buildGridSource(
  sourceId: string,
  widthSegments: number,
  heightSegments: number,
  wave: number
) {
  const row = widthSegments + 1;
  const positions = new Float32Array(row * (heightSegments + 1) * 3);
  let vertex = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++, vertex++) {
      positions.set([
        (x / widthSegments - 0.5) * 8,
        (y / heightSegments - 0.5) * 8,
        Math.sin(x * wave) * Math.cos(y * wave) * 0.7
      ], vertex * 3);
    }
  }
  const indices = new Uint32Array(widthSegments * heightSegments * 6);
  let offset = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.set([a, b, c, c, b, d], offset);
      offset += 6;
    }
  }
  return createSourceGeometry({
    sourceId,
    indices,
    attributes: [{ semantic: "position", componentCount: 3, data: positions }],
    materialRanges: [{
      firstTriangle: 0,
      triangleCount: indices.length / 3,
      materialId: 0,
      alphaMode: "opaque",
      doubleSided: false
    }]
  });
}

function buildTriangleSource(sourceId: string) {
  return createSourceGeometry({
    sourceId,
    indices: new Uint32Array([0, 1, 2]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([
        -1, -1, 0,
        1, -1, 0,
        0, 1, 0
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
      label: "R3-B/transactional-upload",
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
