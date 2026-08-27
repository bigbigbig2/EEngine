import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry
} from "../../OEngine/src/index.ts";
import { GpuAssetStore } from "../../OEngine/src/gpu/GpuAssetStore.ts";
import {
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_POSITION_FORMAT
} from "../../OEngine/src/gpu/GpuGeometryAbi.ts";

const WIDTH = 512;
const HEIGHT = 512;
const MAX_MESHLET_VERTICES = 384;

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");
const canvas = requiredElement<HTMLCanvasElement>("preview");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});

async function run(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器没有 WebGPU");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("没有可用的 WebGPU adapter");
  const device = await adapter.requestDevice();
  const uncapturedErrors: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    uncapturedErrors.push(event.error.message);
  });

  const source = buildSource(24, 24);
  const cooked = await cookGeometryAssetPackage(source, createGeometryCookRecipe());
  const asset = cooked.asset;
  if (asset.clusters.length === 0 || asset.bvh8Nodes.length === 0) {
    throw new Error("R2-C browser fixture did not produce hierarchy/BVH8 data");
  }

  device.pushErrorScope("validation");
  const store = new GpuAssetStore(device);
  const command = new BrowserAssetCommand(device, "R2-C/resident-and-draw");
  const handle = store.resident(asset, command);
  const geometryIndex = store.recordIndex(handle);
  const bindings = store.bindings();

  const params = createMappedBuffer(
    device,
    "R2-C/geometry-index",
    new Uint32Array([geometryIndex, 0, 0, 0]),
    GPUBufferUsage.UNIFORM
  );
  const indirect = device.createBuffer({
    label: "R2-C/flat-hardware-indirect",
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC
  });
  const abiResult = device.createBuffer({
    label: "R2-C/abi-result",
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const abiReadback = device.createBuffer({
    label: "R2-C/abi-readback",
    size: 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const color = device.createTexture({
    label: "R2-C/hardware-color",
    size: [WIDTH, HEIGHT],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const colorReadback = device.createBuffer({
    label: "R2-C/color-readback",
    size: bytesPerRow * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const computeModule = device.createShaderModule({
    label: "R2-C/flat-producer",
    code: createProducerWgsl()
  });
  const renderModule = device.createShaderModule({
    label: "R2-C/flat-hardware-consumer",
    code: createHardwareConsumerWgsl()
  });
  const shaderDiagnostics = (await Promise.all([
    shaderDiagnosticsFor("producer", computeModule),
    shaderDiagnosticsFor("consumer", renderModule)
  ])).flat();
  const shaderErrors = shaderDiagnostics.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(`R2-C WGSL compilation failed: ${JSON.stringify(shaderErrors)}`);
  }

  const [producer, consumer] = await Promise.all([
    device.createComputePipelineAsync({
      label: "R2-C/flat-producer",
      layout: "auto",
      compute: { module: computeModule, entryPoint: "main" }
    }),
    device.createRenderPipelineAsync({
      label: "R2-C/flat-hardware-consumer",
      layout: "auto",
      vertex: { module: renderModule, entryPoint: "vs_main" },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [{ format: "rgba8unorm" }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    })
  ]);

  const producerGroup = device.createBindGroup({
    label: "R2-C/producer-bindings",
    layout: producer.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bindings.geometryRecords } },
      { binding: 1, resource: { buffer: bindings.clusterRecords } },
      { binding: 2, resource: { buffer: params } },
      { binding: 3, resource: { buffer: indirect } },
      { binding: 4, resource: { buffer: abiResult } }
    ]
  });
  const consumerGroup = device.createBindGroup({
    label: "R2-C/consumer-bindings",
    layout: consumer.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bindings.geometryRecords } },
      { binding: 1, resource: { buffer: bindings.meshletRecords } },
      { binding: 2, resource: { buffer: bindings.meshletVertexIndices } },
      { binding: 3, resource: { buffer: bindings.meshletTriangleIndices } },
      { binding: 4, resource: { buffer: bindings.vertexStreamData } },
      { binding: 5, resource: { buffer: params } }
    ]
  });

  const compute = command.encoder.beginComputePass({ label: "R2-C/flat-work-producer" });
  compute.setPipeline(producer);
  compute.setBindGroup(0, producerGroup);
  compute.dispatchWorkgroups(1);
  compute.end();

  const render = command.encoder.beginRenderPass({
    label: "R2-C/existing-flat-hardware-consumer",
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
  command.encoder.copyBufferToBuffer(abiResult, 0, abiReadback, 0, 32);
  command.encoder.copyTextureToBuffer(
    { texture: color },
    { buffer: colorReadback, bytesPerRow, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT, 1]
  );
  command.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  await abiReadback.mapAsync(GPUMapMode.READ);
  const abi = new Uint32Array(abiReadback.getMappedRange().slice(0));
  abiReadback.unmap();
  await colorReadback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(colorReadback.getMappedRange());
  const tight = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let nonBackgroundPixels = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const row = pixels.subarray(y * bytesPerRow, y * bytesPerRow + WIDTH * 4);
    tight.set(row, y * WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const offset = x * 4;
      if (row[offset]! > 8 || row[offset + 1]! > 8 || row[offset + 2]! > 10) {
        nonBackgroundPixels++;
      }
    }
  }
  colorReadback.unmap();
  const context2d = canvas.getContext("2d");
  if (!context2d) throw new Error("无法创建 2D preview context");
  context2d.putImageData(new ImageData(tight, WIDTH, HEIGHT), 0, 0);

  const validationError = await device.popErrorScope();
  const residentEvidence = store.evidence();
  const abiExpected = [
    asset.directory.vertexCount,
    asset.meshlets.length,
    asset.clusters.length,
    asset.bvh8Nodes.length,
    GPU_POSITION_FORMAT.Float32x3,
    geometryIndex
  ];
  const abiActual = [...abi.subarray(0, abiExpected.length)];

  const abortCommand = new BrowserAssetCommand(device, "R2-C/abort-proof");
  const abortedHandle = store.resident(asset, abortCommand);
  abortCommand.abort();
  let abortedHandleRejected = false;
  try {
    store.recordIndex(abortedHandle);
  } catch {
    abortedHandleRejected = true;
  }

  const releaseCommand = new BrowserAssetCommand(device, "R2-C/release-proof");
  store.release(handle, releaseCommand);
  releaseCommand.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();
  let releasedHandleRejected = false;
  try {
    store.recordIndex(handle);
  } catch {
    releasedHandleRejected = true;
  }
  const finalEvidence = store.evidence();

  const passed =
    validationError === null &&
    uncapturedErrors.length === 0 &&
    abiActual.every((value, index) => value === abiExpected[index]) &&
    nonBackgroundPixels > 1000 &&
    residentEvidence.residentAssetCount === 1 &&
    residentEvidence.committedGrowCount > 0 &&
    residentEvidence.privateSubmitCount === 0 &&
    residentEvidence.uploadedBytes ===
      residentEvidence.uploadSourceBytes + residentEvidence.uploadPaddingBytes &&
    abortedHandleRejected &&
    releasedHandleRejected &&
    finalEvidence.residentAssetCount === 0 &&
    finalEvidence.abortedResidencyCount === 1 &&
    finalEvidence.releaseCount === 1;

  const artifact = {
    passed,
    adapter: adapter.info,
    source: { vertices: source.vertexCount, triangles: source.triangleCount },
    package: {
      hash: asset.package.manifest.contentHash,
      bytes: asset.package.manifest.totalByteLength,
      meshlets: asset.meshlets.length,
      clusters: asset.clusters.length,
      bvh8Nodes: asset.bvh8Nodes.length
    },
    gpuRoundtrip: { expected: abiExpected, actual: abiActual },
    hardwareConsumer: {
      producer: "Compute writes drawIndirect args",
      consumer: `drawIndirect(${MAX_MESHLET_VERTICES} vertices × GPU meshlet count)`,
      nonBackgroundPixels,
      resolution: [WIDTH, HEIGHT]
    },
    lifecycle: { abortedHandleRejected, releasedHandleRejected },
    residentEvidence,
    finalEvidence,
    shaderDiagnostics,
    validationError: validationError?.message ?? null,
    uncapturedErrors
  };
  status.textContent = passed ? "验证通过" : "验证失败";
  status.className = passed ? "ok" : "error";
  summary.innerHTML = passed
    ? `<strong>PASS</strong>：package 已驻留紧凑表，GPU ABI 一致，Compute producer → drawIndirect Hardware consumer 闭环成立。`
    : "R2-C residency、ABI、画面或生命周期门禁未通过。";
  result.textContent = JSON.stringify(artifact, null, 2);
  if (!passed) throw new Error("R2-C browser residency validation failed");

  params.destroy();
  indirect.destroy();
  abiResult.destroy();
  abiReadback.destroy();
  colorReadback.destroy();
  color.destroy();
  store.destroy();
}

function createProducerWgsl(): string {
  return /* wgsl */ `
${GPU_GEOMETRY_RECORD_WGSL}
struct Params { geometry_index: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
struct DrawIndirectArgs {
  vertex_count: u32,
  instance_count: u32,
  first_vertex: u32,
  first_instance: u32,
};
@group(0) @binding(0) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(1) var<storage, read> clusters: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> args: DrawIndirectArgs;
@group(0) @binding(4) var<storage, read_write> result: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let geometry = geometries[params.geometry_index];
  args.vertex_count = ${MAX_MESHLET_VERTICES}u;
  args.instance_count = geometry.meshlet_count;
  args.first_vertex = 0u;
  args.first_instance = 0u;
  result[0] = geometry.vertex_count;
  result[1] = geometry.meshlet_count;
  result[2] = geometry.cluster_count;
  result[3] = geometry.bvh_count;
  result[4] = geometry.position_format;
  result[5] = params.geometry_index;
  result[6] = select(0u, clusters[geometry.cluster_root * 32u + 1u], geometry.cluster_count > 0u);
  result[7] = geometry.flags;
}
`;
}

function createHardwareConsumerWgsl(): string {
  return /* wgsl */ `
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
struct Params { geometry_index: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) color: vec3f,
};
@group(0) @binding(0) var<storage, read> geometries: array<GpuGeometryRecord>;
@group(0) @binding(1) var<storage, read> meshlets: array<GpuMeshletRecord>;
@group(0) @binding(2) var<storage, read> meshlet_vertices: array<u32>;
@group(0) @binding(3) var<storage, read> meshlet_triangles: array<u32>;
@group(0) @binding(4) var<storage, read> vertex_data: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;

fn read_u8(byte_offset: u32) -> u32 {
  let word = meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32
) -> VertexOutput {
  let geometry = geometries[params.geometry_index];
  let meshlet = meshlets[geometry.meshlet_begin + instance_index];
  let draw_index = min(vertex_index, meshlet.triangle_count * 3u - 1u);
  let local_vertex = read_u8(meshlet.triangle_byte_offset + draw_index);
  let source_vertex = meshlet_vertices[meshlet.vertex_offset + local_vertex];
  let position_word = geometry.position_byte_offset / 4u
    + source_vertex * (geometry.position_stride / 4u);
  let position = vec3f(
    bitcast<f32>(vertex_data[position_word]),
    bitcast<f32>(vertex_data[position_word + 1u]),
    bitcast<f32>(vertex_data[position_word + 2u])
  );
  let center = (geometry.bounds_min.xyz + geometry.bounds_max.xyz) * 0.5;
  let extent = max(geometry.bounds_max.xyz - geometry.bounds_min.xyz, vec3f(1e-5));
  let scale = 1.8 / max(extent.x, extent.y);
  var output: VertexOutput;
  output.position = vec4f((position.xy - center.xy) * scale, 0.5, 1.0);
  let hash = f32((instance_index * 1664525u + 1013904223u) & 255u) / 255.0;
  output.color = vec3f(0.15 + hash * 0.7, 0.75 - hash * 0.35, 0.95 - hash * 0.5);
  return output;
}

@fragment
fn fs_main(@location(0) @interpolate(flat) color: vec3f) -> @location(0) vec4f {
  return vec4f(color, 1.0);
}
`;
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

class BrowserAssetCommand {
  readonly onFinished = new BrowserSignal();
  readonly onAborted = new BrowserSignal();
  readonly encoder: GPUCommandEncoder;
  readonly staging: GPUBuffer[] = [];
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
      label: "R2-C/transactional-upload",
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
    if (this.closed) throw new Error("BrowserAssetCommand is already closed");
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
    this.onAborted.send(this, new Error("R2-C validation command aborted"));
  }
}

function buildSource(widthSegments: number, heightSegments: number) {
  const row = widthSegments + 1;
  const positions = new Float32Array(row * (heightSegments + 1) * 3);
  let vertex = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++, vertex++) {
      positions.set([
        x,
        y,
        Math.sin(x * 0.45) * Math.cos(y * 0.4) * 1.5
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
  const triangles = indices.length / 3;
  return createSourceGeometry({
    sourceId: "r2-c-residency-grid",
    indices,
    attributes: [{ semantic: "position", componentCount: 3, data: positions }],
    materialRanges: [
      {
        firstTriangle: 0,
        triangleCount: triangles / 2,
        materialId: 3,
        alphaMode: "opaque",
        doubleSided: false
      },
      {
        firstTriangle: triangles / 2,
        triangleCount: triangles / 2,
        materialId: 7,
        alphaMode: "mask",
        doubleSided: true
      }
    ]
  });
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
