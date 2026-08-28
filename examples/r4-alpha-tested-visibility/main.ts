import { PerspectiveCamera } from "../../OEngine/src/camera/PerspectiveCamera.ts";
import {
  GPU_GEOMETRY_RECORD_STRIDE,
  GPU_POSITION_FORMAT,
  GPU_UV_FORMAT,
  packGpuGeometryRecord,
  packGpuMeshletRecords
} from "../../OEngine/src/gpu/GpuGeometryAbi.ts";
import {
  GPU_INSTANCE_RECORD_STRIDE,
  packGpuInstanceRecords
} from "../../OEngine/src/gpu/GpuInstanceAbi.ts";
import {
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  materialVisibilitySource,
  packGpuMaterialVisibilityRecord
} from "../../OEngine/src/gpu/GpuMaterialVisibilityAbi.ts";
import {
  GPU_RASTER_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  packRasterWork,
  packVisibleClusterRecord,
  packWorkQueueHeader
} from "../../OEngine/src/gpu/GpuWorkGenerationAbi.ts";
import {
  GPU_VISIBILITY_KEY_EMPTY,
  decodeVisibilityKey
} from "../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";
import { ShadeDrawSide, ShadeTransparencyMode } from "../../OEngine/src/material/enums.ts";
import { StandardShadeMaterial } from "../../OEngine/src/material/StandardShadeMaterial.ts";
import { GPUCameraState } from "../../OEngine/src/render/GPUCameraState.ts";
import { VIS_MESH_CLEAR_SENTINEL } from "../../OEngine/src/render/VisibilityBufferContract.ts";
import { LPV_CAMERA_TYPE } from "../../OEngine/src/shaders/lpv_indirect_diffuse.ts";
import {
  PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT,
  PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
} from "../../OEngine/src/shaders/packed_visibility.ts";
import { ShadeImage, ShadeTexture } from "../../OEngine/src/texture/ShadeTexture.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];

const WIDTH = 640;
const HEIGHT = 320;
const BYTES_PER_ROW = Math.ceil(WIDTH * 4 / 256) * 256;
const CASES = [
  "opaque",
  "mask-texture-transform",
  "mask-factor-discard",
  "blend-excluded",
  "double-sided",
  "mirrored-single-sided",
  "invalid-texture-factor-fallback",
  "sampler-fallback"
] as const;

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
  anchor.download = `oengine-r4-a-03-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = "R4-A-03 validation failed";
  status.className = "error";
  result.textContent = message;
  publishResult({ passed: false, fatalError: message });
  console.error(error);
});

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

  const camera = new PerspectiveCamera();
  camera.aspect = WIDTH / HEIGHT;
  camera.fov_degrees = 60;
  camera.near = 0.1;
  const cameraState = new GPUCameraState(device, camera);
  const cameraCommand = new BrowserGpuCommand(device, "R4-A-03/camera");
  cameraState.update(cameraCommand as never);
  cameraCommand.finishAndSubmit();
  await device.queue.onSubmittedWorkDone();

  const materials = buildMaterials();
  const geometry = buildGeometryBuffers(device);
  const instances = createBufferWithData(
    device,
    "R4-A-03 instances",
    packGpuInstanceRecords(materials.map((material, index) => ({
      geometryRecordIndex: 0,
      materialHandle: material.id,
      flags: 1,
      debugId: index,
      boundsSphere: [0, 0, 0, 1],
      boundsMin: [-0.75, -0.75, 0],
      boundsMax: [0.75, 0.75, 0],
      currentObjectToWorld: transform(-4.2 + index * 1.2, index >= 4 ? -0.9 : 0.9, 5,
        index === 4 || index === 5 ? -1 : 1),
      previousObjectToWorld: transform(-4.2 + index * 1.2, index >= 4 ? -0.9 : 0.9, 5,
        index === 4 || index === 5 ? -1 : 1)
    }))),
    GPUBufferUsage.STORAGE
  );
  const visibleClusters = createQueueBuffer(
    device,
    "R4-A-03 VisibleCluster queue",
    materials.map((material, index) => packVisibleClusterRecord({
      instanceRecordIndex: index,
      geometryRecordIndex: 0,
      clusterRecordIndex: 0,
      materialHandle: material.id
    })),
    GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride
  );
  const rasterWork = createQueueBuffer(
    device,
    "R4-A-03 RasterWork queue",
    materials.map((_, index) => packRasterWork({
      visibleClusterSlot: index,
      meshletRecordIndex: 0
    })),
    GPU_RASTER_WORK_SCHEMA.stride
  );
  const drawIndirect = createBufferWithData(
    device,
    "R4-A-03 drawIndirect",
    u32Bytes([
      PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT,
      materials.length,
      0,
      0
    ]),
    GPUBufferUsage.INDIRECT
  );
  const materialRecords = buildMaterialBuffer(device, materials);
  const alphaAtlas = buildAlphaAtlas(device);

  const shaderModule = device.createShaderModule({
    label: "R4-A-03 production alpha Visibility WGSL",
    code: PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
  });
  const shaderDiagnostics = [...(await shaderModule.getCompilationInfo()).messages].map(
    (message) => ({
      type: message.type,
      message: message.message,
      lineNum: message.lineNum,
      linePos: message.linePos
    })
  );
  const shaderErrors = shaderDiagnostics.filter((message) => message.type === "error");
  if (shaderErrors.length > 0) {
    throw new Error(`Alpha Visibility WGSL compilation failed: ${JSON.stringify(shaderErrors)}`);
  }

  const bindGroupLayout = device.createBindGroupLayout({
    label: "R4-A-03 production alpha group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
      ...Array.from({ length: 8 }, (_, index) => ({
        binding: index + 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" as GPUBufferBindingType }
      })),
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }
    ]
  });
  const pipeline = await device.createRenderPipelineAsync({
    label: "R4-A-03 production alpha Visibility producer",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: "raster_hierarchy_meshlets" },
    fragment: {
      module: shaderModule,
      entryPoint: "write_hierarchy_visibility",
      targets: [{ format: "r32uint" }, { format: "r32uint" }, { format: "r32uint" }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "greater"
    }
  });
  const bindGroup = device.createBindGroup({
    label: "R4-A-03 production alpha bindings",
    layout: bindGroupLayout,
    entries: [
      cameraState.buffer,
      instances,
      geometry.meshlets,
      geometry.meshletVertices,
      geometry.meshletTriangles,
      geometry.vertexData,
      geometry.geometryRecords,
      visibleClusters,
      rasterWork,
      materialRecords
    ].map((buffer, binding) => ({ binding, resource: { buffer } })).concat([
      { binding: 10, resource: alphaAtlas.createView() }
    ])
  });

  const visibilityKey = createTarget(device, "VisibilityKey", "r32uint");
  const triangleId = createTarget(device, "triangle ID", "r32uint");
  const instanceId = createTarget(device, "instance ID", "r32uint");
  const depth = createTarget(device, "reverse-Z depth", "depth32float");
  const keyReadback = createReadback(device, "VisibilityKey readback");
  const depthReadback = createReadback(device, "depth readback");

  const encoder = device.createCommandEncoder({ label: "R4-A-03 alpha evidence" });
  const pass = encoder.beginRenderPass({
    label: "R4-A-03 one drawIndirect alpha producer",
    colorAttachments: [
      colorAttachment(visibilityKey, GPU_VISIBILITY_KEY_EMPTY),
      colorAttachment(triangleId, VIS_MESH_CLEAR_SENTINEL),
      colorAttachment(instanceId, VIS_MESH_CLEAR_SENTINEL)
    ],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: "clear",
      depthStoreOp: "store"
    }
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.drawIndirect(drawIndirect, 0);
  pass.end();
  copyTextureToReadback(encoder, visibilityKey, keyReadback);
  copyTextureToReadback(encoder, depth, depthReadback);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await Promise.all([
    keyReadback.mapAsync(GPUMapMode.READ),
    depthReadback.mapAsync(GPUMapMode.READ)
  ]);
  const keyBytes = new Uint8Array(keyReadback.getMappedRange().slice(0));
  const depthBytes = new Uint8Array(depthReadback.getMappedRange().slice(0));
  const pixels = inspectPixels(keyBytes, depthBytes, materials.length);
  drawPreview(keyBytes);
  keyReadback.unmap();
  depthReadback.unmap();

  const validationError = await device.popErrorScope();
  const counts = pixels.perRasterWorkSlot;
  const opaquePixels = counts[0] ?? 0;
  const passed = validationError === null &&
    uncapturedErrors.length === 0 && deviceLost.length === 0 && shaderErrors.length === 0 &&
    pixels.invalidKeys === 0 && pixels.depthMismatchPixels === 0 &&
    pixels.referencedRasterWorkSlots.length >= 6 &&
    opaquePixels > 0 &&
    (counts[1] ?? 0) > 0 && (counts[1] ?? 0) < opaquePixels &&
    (counts[2] ?? 0) === 0 &&
    (counts[3] ?? 0) === 0 &&
    (counts[4] ?? 0) > 0 &&
    (counts[5] ?? 0) > 0 &&
    (counts[6] ?? 0) > 0 &&
    (counts[7] ?? 0) > 0;

  finalResult = {
    passed,
    task: "R4-A-03 Material Visibility / alpha-tested",
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__
    },
    adapter: {
      maxStorageBuffersInVertexStage: Number(device.limits.maxStorageBuffersInVertexStage),
      maxStorageBuffersInFragmentStage: Number(device.limits.maxStorageBuffersInFragmentStage),
      maxSampledTexturesPerShaderStage: Number(device.limits.maxSampledTexturesPerShaderStage)
    },
    producer: {
      drawCalls: 1,
      drawIndirect: [PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT, materials.length, 0, 0],
      rasterWorkSlots: materials.length,
      cpuMaterialDrawLoops: 0
    },
    cases: Object.fromEntries(CASES.map((name, index) => [name, counts[index] ?? 0])),
    pixels,
    shaderDiagnostics,
    validationError: validationError?.message ?? null,
    uncapturedErrors,
    deviceLost
  };
  publishResult(finalResult);
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed ? "R4-A-03 GPU validation passed" : "R4-A-03 GPU validation failed";
  status.className = passed ? "ok" : "error";
  download.disabled = false;

  cameraState.destroy();
  for (const buffer of [
    instances,
    geometry.meshlets,
    geometry.meshletVertices,
    geometry.meshletTriangles,
    geometry.vertexData,
    geometry.geometryRecords,
    visibleClusters,
    rasterWork,
    drawIndirect,
    materialRecords,
    keyReadback,
    depthReadback
  ]) buffer.destroy();
  for (const texture of [visibilityKey, triangleId, instanceId, depth, alphaAtlas]) {
    texture.destroy();
  }
}

function buildMaterials(): StandardShadeMaterial[] {
  const alphaTexture = fixtureTexture();
  const samplerFallbackTexture = fixtureTexture();
  const opaque = new StandardShadeMaterial();

  const maskTexture = new StandardShadeMaterial();
  maskTexture.transparency_mode = ShadeTransparencyMode.AlphaTested;
  maskTexture.texture_albedo = alphaTexture;
  maskTexture.alpha_cutoff = 0.5;
  maskTexture.base_color_uv_offset = [0.25, 0];

  const maskFactorDiscard = new StandardShadeMaterial();
  maskFactorDiscard.transparency_mode = ShadeTransparencyMode.AlphaTested;
  maskFactorDiscard.diffuse_color.a = 0.2;
  maskFactorDiscard.alpha_cutoff = 0.5;

  const blend = new StandardShadeMaterial();
  blend.transparency_mode = ShadeTransparencyMode.Transparent;

  const doubleSided = new StandardShadeMaterial();
  doubleSided.draw_side = ShadeDrawSide.Double;

  const mirrored = new StandardShadeMaterial();

  const invalidTexture = new StandardShadeMaterial();
  invalidTexture.transparency_mode = ShadeTransparencyMode.AlphaTested;
  invalidTexture.texture_albedo = new ShadeTexture();
  invalidTexture.diffuse_color.a = 0.8;
  invalidTexture.alpha_cutoff = 0.5;

  const samplerFallback = new StandardShadeMaterial();
  samplerFallback.transparency_mode = ShadeTransparencyMode.AlphaTested;
  samplerFallback.texture_albedo = samplerFallbackTexture;
  samplerFallback.alpha_cutoff = 0.5;
  samplerFallbackTexture.wrapS = 99;

  return [
    opaque,
    maskTexture,
    maskFactorDiscard,
    blend,
    doubleSided,
    mirrored,
    invalidTexture,
    samplerFallback
  ];
}

function buildMaterialBuffer(
  device: GPUDevice,
  materials: readonly StandardShadeMaterial[]
): GPUBuffer {
  const maxId = Math.max(...materials.map((material) => material.id));
  const bytes = new ArrayBuffer((maxId + 1) * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index]!;
    const textureRef = index === 1 || index === 7
      ? 0
      : GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
    const source = materialVisibilitySource(material, textureRef);
    packGpuMaterialVisibilityRecord(
      source.packed,
      bytes,
      material.id * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE
    );
  }
  return createBufferWithData(
    device,
    "R4-A-03 MaterialVisibilityRecord table",
    new Uint8Array(bytes),
    GPUBufferUsage.STORAGE
  );
}

function buildGeometryBuffers(device: GPUDevice) {
  const vertexData = new Uint8Array(80);
  new Float32Array(vertexData.buffer, 0, 9).set([
    -0.7, -0.65, 0,
    0, 0.7, 0,
    0.7, -0.65, 0
  ]);
  new Float32Array(vertexData.buffer, 48, 6).set([
    0, 0,
    0.5, 1,
    1, 0
  ]);
  const geometryRecord = packGpuGeometryRecord({
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-0.7, -0.65, 0],
    boundsMax: [0.7, 0.7, 0],
    vertexCount: 3,
    indexBegin: 0,
    indexCount: 3,
    meshletBegin: 0,
    meshletCount: 1,
    clusterBegin: 0,
    clusterRoot: 0,
    clusterCount: 1,
    bvhBegin: 0,
    bvhRoot: 0,
    bvhCount: 0,
    materialRangeBegin: 0,
    materialRangeCount: 1,
    streamDescriptorBegin: 0,
    streamDescriptorCount: 2,
    vertexDataByteBegin: 0,
    vertexDataByteLength: vertexData.byteLength,
    positionByteOffset: 0,
    positionStride: 12,
    positionFormat: GPU_POSITION_FORMAT.Float32x3,
    flags: 0,
    uv0ByteOffset: 48,
    uv0Stride: 8,
    uv0Format: GPU_UV_FORMAT.Float32x2,
    uv1ByteOffset: 0,
    uv1Stride: 0,
    uv1Format: GPU_UV_FORMAT.Unknown
  });
  const meshlet = packGpuMeshletRecords([{
    vertexOffset: 0,
    vertexCount: 3,
    triangleByteOffset: 0,
    triangleCount: 1,
    materialRangeIndex: 0,
    materialId: 0,
    flags: 0,
    boundsMin: [-0.7, -0.65, 0],
    boundsMax: [0.7, 0.7, 0],
    boundsSphere: [0, 0, 0, 1],
    coneApex: [0, 0, 0, 0],
    coneAxisCutoff: [0, 0, 0, 1]
  }]);
  return {
    geometryRecords: createBufferWithData(device, "R4-A-03 geometry record", geometryRecord, GPUBufferUsage.STORAGE),
    meshlets: createBufferWithData(device, "R4-A-03 meshlet record", meshlet, GPUBufferUsage.STORAGE),
    meshletVertices: createBufferWithData(device, "R4-A-03 meshlet vertices", u32Bytes([0, 1, 2]), GPUBufferUsage.STORAGE),
    meshletTriangles: createBufferWithData(device, "R4-A-03 meshlet triangles", new Uint8Array([0, 1, 2, 0]), GPUBufferUsage.STORAGE),
    vertexData: createBufferWithData(device, "R4-A-03 vertex data", vertexData, GPUBufferUsage.STORAGE)
  };
}

function buildAlphaAtlas(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({
    label: "R4-A-03 alpha atlas tile 0",
    size: [64, 64],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = x >= 32 ? 255 : 0;
    }
  }
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: 256, rowsPerImage: 64 },
    [64, 64]
  );
  return texture;
}

function fixtureTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint8Array([255, 255, 255, 255]),
    4,
    "uint8",
    1,
    1,
    1
  );
  image.color_space = 0;
  image.normalized = true;
  return ShadeTexture.from(image);
}

function createQueueBuffer(
  device: GPUDevice,
  label: string,
  records: readonly Uint8Array[],
  stride: number
): GPUBuffer {
  const bytes = new Uint8Array(GPU_WORK_QUEUE_HEADER_SCHEMA.stride + records.length * stride);
  bytes.set(packWorkQueueHeader({
    written: records.length,
    attempted: records.length,
    peak: records.length,
    overflow: 0,
    fallback: 0,
    capacity: records.length
  }));
  for (let index = 0; index < records.length; index++) {
    bytes.set(records[index]!, GPU_WORK_QUEUE_HEADER_SCHEMA.stride + index * stride);
  }
  return createBufferWithData(device, label, bytes, GPUBufferUsage.STORAGE);
}

function createBufferWithData(
  device: GPUDevice,
  label: string,
  bytes: Uint8Array,
  usage: GPUBufferUsageFlags
): GPUBuffer {
  const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4);
  const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(bytes);
  buffer.unmap();
  return buffer;
}

function inspectPixels(keyBytes: Uint8Array, depthBytes: Uint8Array, slotCount: number) {
  const perRasterWorkSlot = Array.from({ length: slotCount }, () => 0);
  const referencedRasterWorkSlots = new Set<number>();
  let emptyPixels = 0;
  let invalidKeys = 0;
  let depthMismatchPixels = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const keyRow = new DataView(keyBytes.buffer, keyBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    const depthRow = new DataView(depthBytes.buffer, depthBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const decoded = decodeVisibilityKey(keyRow.getUint32(x * 4, true));
      const pixelDepth = depthRow.getFloat32(x * 4, true);
      if (decoded.kind === "empty") {
        emptyPixels++;
        if (pixelDepth !== 0) depthMismatchPixels++;
      } else if (decoded.kind === "invalid") {
        invalidKeys++;
      } else {
        referencedRasterWorkSlots.add(decoded.rasterWorkSlot);
        if (decoded.rasterWorkSlot < perRasterWorkSlot.length) {
          perRasterWorkSlot[decoded.rasterWorkSlot]++;
        }
        if (!(pixelDepth > 0 && pixelDepth <= 1)) depthMismatchPixels++;
      }
    }
  }
  return {
    emptyPixels,
    invalidKeys,
    depthMismatchPixels,
    perRasterWorkSlot,
    referencedRasterWorkSlots: [...referencedRasterWorkSlots].sort((a, b) => a - b)
  };
}

function drawPreview(keyBytes: Uint8Array): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D preview context is unavailable");
  const image = context.createImageData(WIDTH, HEIGHT);
  const colors = [
    [78, 205, 245], [247, 194, 72], [245, 105, 112], [150, 110, 210],
    [111, 220, 145], [225, 126, 205], [180, 214, 92], [255, 151, 86]
  ];
  for (let y = 0; y < HEIGHT; y++) {
    const row = new DataView(keyBytes.buffer, keyBytes.byteOffset + y * BYTES_PER_ROW, WIDTH * 4);
    for (let x = 0; x < WIDTH; x++) {
      const target = (y * WIDTH + x) * 4;
      const decoded = decodeVisibilityKey(row.getUint32(x * 4, true));
      const color = decoded.kind === "valid"
        ? colors[decoded.rasterWorkSlot % colors.length]!
        : [8, 12, 16];
      image.data.set([color[0]!, color[1]!, color[2]!, 255], target);
    }
  }
  context.putImageData(image, 0, 0);
}

function transform(x: number, y: number, z: number, scaleX: number): Float32Array {
  return new Float32Array([
    scaleX, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ]);
}

function u32Bytes(values: readonly number[]): Uint8Array {
  return new Uint8Array(new Uint32Array(values).buffer);
}

function createTarget(device: GPUDevice, label: string, format: GPUTextureFormat): GPUTexture {
  return device.createTexture({
    label: `R4-A-03 ${label}`,
    size: [WIDTH, HEIGHT],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
}

function createReadback(device: GPUDevice, label: string): GPUBuffer {
  return device.createBuffer({
    label: `R4-A-03 ${label}`,
    size: BYTES_PER_ROW * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
}

function copyTextureToReadback(
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  buffer: GPUBuffer
): void {
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT]
  );
}

function colorAttachment(
  texture: GPUTexture,
  clear: number
): GPURenderPassColorAttachment {
  return {
    view: texture.createView(),
    clearValue: { r: clear, g: 0, b: 0, a: 0 },
    loadOp: "clear",
    storeOp: "store"
  };
}

function publishResult(value: unknown): void {
  (window as unknown as { __OENGINE_R4_A_03_RESULT__: unknown })
    .__OENGINE_R4_A_03_RESULT__ = value;
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

  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number
  ): void {
    const staging = this.device.createBuffer({
      label: "R4-A-03 transactional camera upload",
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
