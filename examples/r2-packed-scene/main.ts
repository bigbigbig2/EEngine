import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry
} from "../../OEngine/src/index.ts";
import { GpuAssetStore } from "../../OEngine/src/gpu/GpuAssetStore.ts";
import {
  GPU_GEOMETRY_RECORD_WGSL
} from "../../OEngine/src/gpu/GpuGeometryAbi.ts";
import {
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_OFFSETS,
  GPU_INSTANCE_RECORD_STRIDE,
  GPU_INSTANCE_RECORD_WGSL
} from "../../OEngine/src/gpu/GpuInstanceAbi.ts";
import {
  GpuScene,
  type InstancePatchResult,
  type InstanceSetHandle,
  type InstanceSource
} from "../../OEngine/src/gpu/GpuScene.ts";

const WIDTH = 512;
const HEIGHT = 512;
const RENDER_COUNT = 1_000;

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");
const canvas = requiredElement<HTMLCanvasElement>("preview");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  if (result.textContent.trim().length === 0) {
    result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  console.error(error);
});

async function run(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("没有可用的 WebGPU adapter");
  const device = await adapter.requestDevice();
  const uncapturedErrors: string[] = [];
  device.addEventListener("uncapturederror", (event) => uncapturedErrors.push(event.error.message));
  device.pushErrorScope("validation");

  const cooked = await cookGeometryAssetPackage(buildTriangleSource(), createGeometryCookRecipe());
  const assets = new GpuAssetStore(device);
  const gpuScene = new GpuScene(device, assets);
  const assetCommand = new BrowserCommand(device, "R2-D/asset-residency");
  const assetHandle = assets.resident(cooked.asset, assetCommand);
  assetCommand.finishAndSubmit();

  const bulk: {
    count: number;
    sourceBytes: number;
    cpuMs: number;
    handle: InstanceSetHandle;
  }[] = [];
  for (const count of [1_000, 10_000, 100_000]) {
    const source = buildGridSource(count, assetHandle);
    const command = new BrowserCommand(device, `R2-D/bulk-${count}`);
    const begin = performance.now();
    const handle = gpuScene.instantiate(source, command);
    const cpuMs = performance.now() - begin;
    command.finishAndSubmit();
    bulk.push({ count, sourceBytes: instanceSourceBytes(source), cpuMs, handle });
  }

  const renderHandle = bulk[0]!.handle;
  const patchResults: { label: string; result: InstancePatchResult }[] = [];
  const uploadBeforeStable = gpuScene.evidence().uploadedBytes;
  const stableCommand = new BrowserCommand(device, "R2-D/stable-noop");
  const stableResult = gpuScene.patch(renderHandle, { frameId: 1 }, stableCommand);
  const stableEncodedCopies = stableCommand.copyCount;
  stableCommand.abort();
  const uploadAfterStable = gpuScene.evidence().uploadedBytes;
  patchResults.push({ label: "0%", result: stableResult });

  for (const [label, count, frameId] of [
    ["1%", 10, 2],
    ["10%", 100, 3],
    ["100%", 1_000, 4]
  ] as const) {
    const patch = buildTransformPatch(count, frameId * 0.001);
    const command = new BrowserCommand(device, `R2-D/patch-${label}`);
    const patchResult = gpuScene.patch(renderHandle, {
      frameId,
      transforms: patch,
      materials: {
        indices: patch.indices,
        materialHandles: new Uint32Array(count).fill(frameId)
      }
    }, command);
    command.finishAndSubmit();
    patchResults.push({ label, result: patchResult });
  }

  const baselineX = gridTransform(0, RENDER_COUNT, 0.004)[12]!;
  const expectedCurrentX = gridTransform(0, RENDER_COUNT, 0.02)[12]!;
  for (const xOffset of [0.01, 0.02]) {
    const command = new BrowserCommand(device, `R2-D/same-frame-${xOffset}`);
    gpuScene.patch(renderHandle, {
      frameId: 99,
      transforms: {
        indices: new Uint32Array([0]),
        transforms: gridTransform(0, RENDER_COUNT, xOffset)
      }
    }, command);
    command.finishAndSubmit();
  }

  const sceneBindings = gpuScene.bindings();
  const assetBindings = assets.bindings();
  const renderRange = gpuScene.range(renderHandle);
  const params = createMappedBuffer(
    device,
    "R2-D/params",
    new Uint32Array([renderRange.start, renderRange.count, assets.recordIndex(assetHandle), 0]),
    GPUBufferUsage.UNIFORM
  );
  const indirect = device.createBuffer({
    label: "R2-D/indirect",
    size: 16,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.INDIRECT |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST
  });
  const visible = device.createBuffer({
    label: "R2-D/visible-instances",
    size: 16 + renderRange.count * 4,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST
  });
  const patchReadback = device.createBuffer({
    label: "R2-D/patch-readback",
    size: GPU_INSTANCE_RECORD_STRIDE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const color = device.createTexture({
    label: "R2-D/color",
    size: [WIDTH, HEIGHT],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
  const bytesPerRow = Math.ceil(WIDTH * 4 / 256) * 256;
  const colorReadback = device.createBuffer({
    label: "R2-D/color-readback",
    size: bytesPerRow * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const producerModule = device.createShaderModule({ label: "R2-D/producer", code: producerWgsl() });
  const consumerModule = device.createShaderModule({ label: "R2-D/consumer", code: consumerWgsl() });
  const shaderDiagnostics = (await Promise.all([
    shaderDiagnosticsFor("producer", producerModule),
    shaderDiagnosticsFor("consumer", consumerModule)
  ])).flat();
  if (shaderDiagnostics.some((entry) => entry.type === "error")) {
    throw new Error(`R2-D WGSL compilation failed: ${JSON.stringify(shaderDiagnostics)}`);
  }
  const [producer, consumer] = await Promise.all([
    device.createComputePipelineAsync({
      label: "R2-D/producer",
      layout: "auto",
      compute: { module: producerModule, entryPoint: "main" }
    }),
    device.createRenderPipelineAsync({
      label: "R2-D/consumer",
      layout: "auto",
      vertex: { module: consumerModule, entryPoint: "vs_main" },
      fragment: {
        module: consumerModule,
        entryPoint: "fs_main",
        targets: [{ format: "rgba8unorm" }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    })
  ]);
  const producerGroup = device.createBindGroup({
    label: "R2-D/producer-bindings",
    layout: producer.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sceneBindings.instances } },
      { binding: 1, resource: { buffer: params } },
      { binding: 2, resource: { buffer: visible } },
      { binding: 3, resource: { buffer: indirect } }
    ]
  });
  const consumerGroup = device.createBindGroup({
    label: "R2-D/consumer-bindings",
    layout: consumer.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sceneBindings.instances } },
      { binding: 1, resource: { buffer: assetBindings.geometryRecords } },
      { binding: 2, resource: { buffer: assetBindings.vertexStreamData } },
      { binding: 3, resource: { buffer: visible } }
    ]
  });

  const command = new BrowserCommand(device, "R2-D/compact-and-hardware-draw");
  command.encoder.clearBuffer(indirect);
  command.encoder.clearBuffer(visible);
  const compute = command.encoder.beginComputePass({ label: "R2-D/compact-instances" });
  compute.setPipeline(producer);
  compute.setBindGroup(0, producerGroup);
  compute.dispatchWorkgroups(Math.ceil(renderRange.count / 64));
  compute.end();
  const render = command.encoder.beginRenderPass({
    label: "R2-D/hardware-consumer",
    colorAttachments: [{
      view: color.createView(),
      clearValue: { r: 0.01, g: 0.015, b: 0.025, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  render.setPipeline(consumer);
  render.setBindGroup(0, consumerGroup);
  render.drawIndirect(indirect, 0);
  render.end();
  command.encoder.copyBufferToBuffer(
    sceneBindings.instances,
    renderRange.start * GPU_INSTANCE_RECORD_STRIDE,
    patchReadback,
    0,
    GPU_INSTANCE_RECORD_STRIDE
  );
  command.encoder.copyTextureToBuffer(
    { texture: color },
    { buffer: colorReadback, bytesPerRow, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT, 1]
  );
  command.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  await patchReadback.mapAsync(GPUMapMode.READ);
  const patchBytes = patchReadback.getMappedRange().slice(0);
  patchReadback.unmap();
  const patchView = new DataView(patchBytes);
  const currentX = patchView.getFloat32(
    GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world + 12 * 4,
    true
  );
  const previousFromCurrentX = patchView.getFloat32(
    GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4,
    true
  );

  await colorReadback.mapAsync(GPUMapMode.READ);
  const mappedPixels = new Uint8Array(colorReadback.getMappedRange());
  const tight = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let nonBackgroundPixels = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const row = mappedPixels.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4);
    tight.set(row, y * WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const offset = x * 4;
      if (row[offset]! > 8 || row[offset + 1]! > 8 || row[offset + 2]! > 10) nonBackgroundPixels++;
    }
  }
  colorReadback.unmap();
  const context2d = canvas.getContext("2d");
  if (!context2d) throw new Error("无法创建 2D preview context");
  context2d.putImageData(new ImageData(tight, WIDTH, HEIGHT), 0, 0);

  const validationError = await device.popErrorScope();
  const sceneEvidence = gpuScene.evidence();
  const assetEvidence = assets.evidence();
  const expectedDensities = [0, 0.01, 0.1, 1];
  const passed =
    validationError === null &&
    uncapturedErrors.length === 0 &&
    shaderDiagnostics.every((entry) => entry.type !== "error") &&
    bulk.map((entry) => entry.count).join(",") === "1000,10000,100000" &&
    patchResults.every((entry, index) => Math.abs(entry.result.density - expectedDensities[index]!) < 1e-6) &&
    stableEncodedCopies === 0 &&
    uploadBeforeStable === uploadAfterStable &&
    Math.abs(currentX - expectedCurrentX) < 1e-5 &&
    Math.abs(previousFromCurrentX - (baselineX - expectedCurrentX)) < 1e-5 &&
    nonBackgroundPixels > 1_000 &&
    sceneEvidence.activeInstanceCount === 111_000 &&
    sceneEvidence.privateSubmitCount === 0 &&
    assetEvidence.privateSubmitCount === 0;

  const artifact = {
    passed,
    adapter: adapter.info,
    package: {
      hash: cooked.asset.package.manifest.contentHash,
      bytes: cooked.asset.package.manifest.totalByteLength,
      geometryRecord: assets.recordIndex(assetHandle)
    },
    bulk: bulk.map(({ count, sourceBytes, cpuMs }) => ({ count, sourceBytes, cpuMs })),
    patchDensity: patchResults,
    stableFrame: {
      encodedCopies: stableEncodedCopies,
      uploadBytesBefore: uploadBeforeStable,
      uploadBytesAfter: uploadAfterStable
    },
    previousCurrent: {
      baselineX,
      expectedCurrentX,
      currentX,
      previousFromCurrentX,
      frameId: 99
    },
    hardwareConsumer: {
      producer: "Compute compacts active InstanceRecord indices and writes all 16 indirect bytes",
      consumer: "drawIndirect reads compact list + InstanceRecord + GeometryRecord/vertex payload",
      instances: renderRange.count,
      nonBackgroundPixels,
      resolution: [WIDTH, HEIGHT]
    },
    sceneEvidence,
    assetEvidence,
    shaderDiagnostics,
    validationError: validationError?.message ?? null,
    uncapturedErrors
  };
  status.textContent = passed ? "验证通过" : "验证失败";
  status.className = passed ? "ok" : "error";
  summary.innerHTML = passed
    ? "<strong>PASS</strong>：Packed bulk/patch、previous-from-current 和 GPU compact → Hardware indirect consumer 闭环成立。"
    : "R2-D Packed Scene 的 ABI、bulk、patch、画面或 WebGPU 门禁失败。";
  result.textContent = JSON.stringify(artifact, null, 2);
  if (!passed) throw new Error("R2-D browser validation failed");

  for (const entry of bulk) {
    const release = new BrowserCommand(device, `R2-D/release-${entry.count}`);
    gpuScene.release(entry.handle, release);
    release.finishAndSubmit();
  }
  const releaseAsset = new BrowserCommand(device, "R2-D/release-asset");
  assets.release(assetHandle, releaseAsset);
  releaseAsset.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();
  params.destroy();
  indirect.destroy();
  visible.destroy();
  patchReadback.destroy();
  colorReadback.destroy();
  color.destroy();
  gpuScene.destroy();
  assets.destroy();
}

function producerWgsl(): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
struct Params { instance_begin: u32, instance_count: u32, geometry_index: u32, _pad0: u32, };
struct VisibleList { count: atomic<u32>, _pad0: u32, _pad1: u32, _pad2: u32, elements: array<u32>, };
struct DrawIndirectArgs { vertex_count: u32, instance_count: atomic<u32>, first_vertex: u32, first_instance: u32, };
@group(0) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> visible: VisibleList;
@group(0) @binding(3) var<storage, read_write> args: DrawIndirectArgs;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x == 0u {
    args.vertex_count = 3u;
    args.first_vertex = 0u;
    args.first_instance = 0u;
  }
  if id.x >= params.instance_count { return; }
  let record_index = params.instance_begin + id.x;
  let instance = instances[record_index];
  if !oengine_instance_active(instance) { return; }
  let output_index = atomicAdd(&visible.count, 1u);
  visible.elements[output_index] = record_index;
  atomicAdd(&args.instance_count, 1u);
}
`;
}

function consumerWgsl(): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
struct VisibleList { count: u32, _pad0: u32, _pad1: u32, _pad2: u32, elements: array<u32>, };
struct VertexOutput { @builtin(position) position: vec4f, @location(0) color: vec3f, };
@group(0) @binding(0) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(2) var<storage, read> vertex_data: array<u32>;
@group(0) @binding(3) var<storage, read> visible: VisibleList;

@vertex fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32
) -> VertexOutput {
  let instance = instances[visible.elements[instance_index]];
  let geometry = geometries[instance.geometry_record_index];
  let word = geometry.position_byte_offset / 4u + vertex_index * (geometry.position_stride / 4u);
  let local = vec3f(
    bitcast<f32>(vertex_data[word]),
    bitcast<f32>(vertex_data[word + 1u]),
    bitcast<f32>(vertex_data[word + 2u])
  );
  var output: VertexOutput;
  output.position = instance.current_object_to_world * vec4f(local, 1.0);
  let hue = f32((instance.debug_id + instance.material_handle * 13u) % 97u) / 97.0;
  output.color = vec3f(0.2 + hue * 0.7, 0.8 - hue * 0.45, 0.55 + hue * 0.4);
  return output;
}

@fragment fn fs_main(@location(0) color: vec3f) -> @location(0) vec4f {
  return vec4f(color, 1.0);
}
`;
}

function buildTriangleSource() {
  return createSourceGeometry({
    sourceId: "r2-d-packed-triangle",
    indices: new Uint32Array([0, 1, 2]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([-0.8, -0.6, 0, 0.8, -0.6, 0, 0, 0.85, 0])
    }],
    materialRanges: [{
      firstTriangle: 0,
      triangleCount: 1,
      materialId: 1,
      alphaMode: "opaque",
      doubleSided: false
    }]
  });
}

function buildGridSource(count: number, geometryHandle: InstanceSource["geometryHandles"][number]): InstanceSource {
  const geometryIndices = new Uint32Array(count);
  const materialHandles = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const debugIds = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    materialHandles[index] = index % 8;
    currentTransforms.set(gridTransform(index, count, 0), index * 16);
    boundsSpheres.set([0, 0, 0, 1], index * 4);
    debugIds[index] = index;
  }
  return {
    count,
    geometryHandles: [geometryHandle],
    geometryIndices,
    materialHandles,
    currentTransforms,
    boundsSpheres,
    flags: new Uint32Array(count).fill(GPU_INSTANCE_FLAGS.CastsShadow),
    debugIds
  };
}

function gridTransform(index: number, count: number, xOffset: number): Float32Array {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const x = (index % columns + 0.5) / columns * 1.9 - 0.95 + xOffset;
  const y = (Math.floor(index / columns) + 0.5) / rows * 1.9 - 0.95;
  const scale = Math.min(0.75 / columns, 0.75 / rows);
  return new Float32Array([
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, 1, 0,
    x, y, 0, 1
  ]);
}

function buildTransformPatch(count: number, xOffset: number) {
  const indices = new Uint32Array(count);
  const transforms = new Float32Array(count * 16);
  for (let index = 0; index < count; index++) {
    indices[index] = index;
    transforms.set(gridTransform(index, RENDER_COUNT, xOffset), index * 16);
  }
  return { indices, transforms };
}

function instanceSourceBytes(source: InstanceSource): number {
  return source.geometryIndices.byteLength +
    source.materialHandles.byteLength +
    source.currentTransforms.byteLength +
    source.boundsSpheres.byteLength +
    (source.flags?.byteLength ?? 0) +
    (source.debugIds?.byteLength ?? 0);
}

class BrowserSignal {
  private readonly listeners: ((...args: any[]) => void)[] = [];
  addOne(listener: (...args: any[]) => void): void { this.listeners.push(listener); }
  send(...args: any[]): void {
    for (const listener of this.listeners.splice(0)) listener(...args);
  }
}

class BrowserCommand {
  readonly onFinished = new BrowserSignal();
  readonly onAborted = new BrowserSignal();
  readonly encoder: GPUCommandEncoder;
  readonly staging: GPUBuffer[] = [];
  closed = false;
  copyCount = 0;

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
    this.copyCount++;
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
      label: "R2-D/transactional-upload",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    new Uint8Array(staging.getMappedRange()).set(new Uint8Array(data, dataOffset, size));
    staging.unmap();
    this.staging.push(staging);
    this.copyCount++;
    this.encoder.copyBufferToBuffer(staging, 0, buffer, bufferOffset, size);
  }

  finishAndSubmit(): void {
    if (this.closed) throw new Error("BrowserCommand is already closed");
    this.closed = true;
    this.device.queue.submit([this.encoder.finish()]);
    this.onFinished.send(this);
    void this.device.queue.onSubmittedWorkDone().then(() => {
      for (const buffer of this.staging) buffer.destroy();
      this.staging.length = 0;
    });
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    for (const buffer of this.staging) buffer.destroy();
    this.staging.length = 0;
    this.onAborted.send(this, new Error("R2-D command aborted"));
  }
}

function createMappedBuffer(
  device: GPUDevice,
  label: string,
  data: ArrayBufferView,
  usage: GPUBufferUsageFlags
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.ceil(data.byteLength / 4) * 4,
    usage,
    mappedAtCreation: true
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  );
  buffer.unmap();
  return buffer;
}

async function shaderDiagnosticsFor(label: string, module: GPUShaderModule) {
  const info = await module.getCompilationInfo();
  return info.messages.map((message) => ({
    label,
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
