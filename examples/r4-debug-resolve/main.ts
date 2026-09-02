import {
  PerspectiveCamera,
  Renderer,
  RenderDebugView,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_gltf_packed
} from "../../OEngine/src/index.ts";
import { GPU_INSTANCE_FLAGS, packGpuInstanceRecords } from "../../OEngine/src/gpu/GpuInstanceAbi.ts";
import { packGpuMeshletRecords } from "../../OEngine/src/gpu/GpuGeometryAbi.ts";
import {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  packGpuMaterialVisibilityRecord
} from "../../OEngine/src/gpu/GpuMaterialVisibilityAbi.ts";
import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  packClassifiedRasterWorkHeaders,
  packRasterWork,
} from "../../OEngine/src/gpu/GpuWorkGenerationAbi.ts";
import {
  GPU_VISIBILITY_DEBUG_COLORS,
  GPU_VISIBILITY_DEBUG_SETTINGS_SIZE
} from "../../OEngine/src/gpu/GpuVisibilityDebugResolve.ts";
import {
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  encodeVisibilityKey
} from "../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";
import {
  PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL,
  RENDER_DEBUG_VIEW_FORMAT
} from "../../OEngine/src/shaders/render_debug_view.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];

const WIDTH = 768;
const HEIGHT = 432;
const CASE_COUNT = 15;
const ROW_BYTES = 256;
const status = requiredElement<HTMLElement>("status");
const result = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");
const canvas = requiredElement<HTMLCanvasElement>("gpu-canvas");
const failureStrip = requiredElement<HTMLCanvasElement>("failure-strip");
let finalResult: unknown = null;

download.addEventListener("click", () => {
  if (finalResult === null) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(
    [JSON.stringify(finalResult, null, 2)],
    { type: "application/json" }
  ));
  anchor.download = `oengine-r4-a-04-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = "R4-A-04 validation failed";
  status.className = "error";
  result.textContent = message;
  publishResult({ passed: false, fatalError: message });
  console.error(error);
});

async function run(): Promise<void> {
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("WebGPU canvas context is unavailable");

  const renderer = new Renderer();
  await renderer.initialize({ context, pixelRatio: 1 });
  configureRenderer(renderer);
  renderer.render_debug_view = RenderDebugView.VisibilityKey;

  const imported = await load_gltf_packed(
    new URL("./alpha-mask.gltf", import.meta.url).href
  );
  const recipe = createGeometryCookRecipe();
  const packages = [];
  for (const geometry of imported.geometries) {
    packages.push((await cookGeometryAssetPackage(geometry, recipe)).asset);
  }
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  const count = imported.geometryIndices.length;
  await renderer.uploadPackedScene(scene, {
    geometries: packages,
    materials: imported.materials,
    count,
    geometryIndices: imported.geometryIndices,
    materialIndices: imported.materialIndices,
    currentTransforms: imported.transforms,
    boundsSpheres: imported.boundsSpheres,
    boundsMin: imported.boundsMin,
    boundsMax: imported.boundsMax,
    flags: imported.flags,
    debugIds: Uint32Array.from({ length: count }, (_, index) => index + 101)
  });

  const camera = new PerspectiveCamera();
  camera.aspect = WIDTH / HEIGHT;
  camera.near = 0.1;
  camera.transform.position.set(0, 0, 4);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  for (let frame = 0; frame < 6; frame++) {
    if (!renderer.render(camera, scene, 1 / 60)) {
      throw new Error("Production Renderer stopped because the GPU device was lost");
    }
  }
  await renderer.device.queue.onSubmittedWorkDone();

  const injection = await runFailureInjection(renderer.device);
  drawFailureStrip(injection.rgba);
  const diagnostics = renderer.profiler.diagnostics;
  const material = imported.materials[0];
  const productionPassed = count > 0 &&
    packages.length > 0 &&
    imported.materials.length === 1 &&
    renderer.render_debug_view_status.status === "supported" &&
    diagnostics.validationErrorCount === 0 &&
    diagnostics.uncapturedErrorCount === 0 &&
    diagnostics.deviceLostCount === 0;
  const passed = productionPassed && injection.passed;

  finalResult = {
    passed,
    task: "R4-A-04 Hardware debug Resolve",
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__
    },
    production: {
      path: "load_gltf_packed -> Cooker -> uploadPackedScene -> Renderer",
      asset: "examples/r4-debug-resolve/alpha-mask.gltf",
      instances: count,
      geometries: packages.length,
      materials: imported.materials.length,
      materialId: material?.id ?? null,
      transparencyMode: material?.transparency_mode ?? null,
      alphaCutoff: material?.alpha_cutoff ?? null,
      hasBaseColorTexture: material?.texture_albedo !== null,
      debugView: renderer.render_debug_view,
      debugStatus: renderer.render_debug_view_status,
      frames: 6,
      output: { width: renderer.output_resolution.x, height: renderer.output_resolution.y },
      diagnostics
    },
    injection: {
      shaderDiagnostics: injection.shaderDiagnostics,
      validationError: injection.validationError,
      cases: injection.cases,
      passed: injection.passed,
      targetFormat: "rgba8unorm",
      productionTargetFormat: RENDER_DEBUG_VIEW_FORMAT
    }
  };
  publishResult(finalResult);
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed
    ? "R4-A-04 production and fail-visible validation passed"
    : "R4-A-04 validation failed";
  status.className = passed ? "ok" : "error";
  download.disabled = false;
}

async function runFailureInjection(device: GPUDevice) {
  const caseDefinitions = buildFailureCases();
  const keyTexture = device.createTexture({
    label: "R4-A-04 injected VisibilityKey cases",
    size: [CASE_COUNT, 1],
    format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const keyUpload = new Uint32Array(ROW_BYTES / 4);
  keyUpload.set(caseDefinitions.map((entry) => entry.key));
  device.queue.writeTexture(
    { texture: keyTexture },
    keyUpload,
    { bytesPerRow: ROW_BYTES, rowsPerImage: 1 },
    [CASE_COUNT, 1]
  );

  const rasterWork = createClassifiedRasterBuffer(device, "R4-A-04 injected RasterWork", [
    rasterWorkRecord(0, 0, 5, 0, 0),
    rasterWorkRecord(0, 0, 0, 1, 0),
    rasterWorkRecord(5, 0, 0, 0, 0),
    rasterWorkRecord(1, 0, 0, 0, 0),
    rasterWorkRecord(0, 5, 0, 0, 0),
    rasterWorkRecord(0, 1, 0, 0, 0),
    rasterWorkRecord(0, 0, 0, 0, 1),
    rasterWorkRecord(2, 0, 0, 0, 5),
    rasterWorkRecord(3, 0, 0, 0, 1),
    rasterWorkRecord(4, 0, 0, 0, 2),
    rasterWorkRecord(0, 0, 0, 0, 0)
  ]);
  const instances = createBufferWithData(
    device,
    "R4-A-04 injected instances",
    packGpuInstanceRecords([
      instance(0, 0, GPU_INSTANCE_FLAGS.Active, 77),
      instance(0, 0, 0, 78),
      instance(0, 5, GPU_INSTANCE_FLAGS.Active, 79),
      instance(0, 1, GPU_INSTANCE_FLAGS.Active, 80),
      instance(0, 2, GPU_INSTANCE_FLAGS.Active, 81)
    ])
  );
  const meshlets = createBufferWithData(
    device,
    "R4-A-04 injected meshlets",
    packGpuMeshletRecords([{
      vertexOffset: 0,
      vertexCount: 3,
      triangleByteOffset: 0,
      triangleCount: 1,
      materialRangeIndex: 0,
      materialId: 0,
      flags: 0,
      boundsMin: [-1, -1, 0],
      boundsMax: [1, 1, 0],
      boundsSphere: [0, 0, 0, 1],
      coneApex: [0, 0, 0, 0],
      coneAxisCutoff: [0, 0, 0, 1]
    }])
  );
  const materials = createBufferWithData(
    device,
    "R4-A-04 injected materials",
    packMaterials()
  );
  const settings = createBufferWithData(
    device,
    "R4-A-04 debug settings",
    new Uint8Array(new Uint32Array([
      CASE_COUNT, 1, 1, 5, 2, 3, 0, 0
    ]).buffer),
    GPUBufferUsage.UNIFORM
  );
  if (settings.size < GPU_VISIBILITY_DEBUG_SETTINGS_SIZE) {
    throw new Error("R4-A-04 settings buffer is smaller than the frozen ABI");
  }

  const module = device.createShaderModule({
    label: "R4-A-04 production debug Resolve WGSL injection",
    code: PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL
  });
  const shaderDiagnostics = [...(await module.getCompilationInfo()).messages].map((message) => ({
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
  const layout = device.createBindGroupLayout({
    label: "R4-A-04 injected debug group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
      ...Array.from({ length: 4 }, (_, index) => ({
        binding: index + 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" as GPUBufferBindingType }
      })),
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: GPU_VISIBILITY_DEBUG_SETTINGS_SIZE } }
    ]
  });
  device.pushErrorScope("validation");
  const pipeline = await device.createRenderPipelineAsync({
    label: "R4-A-04 injected debug Resolve",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list", cullMode: "none" }
  });
  const output = device.createTexture({
    label: "R4-A-04 injected debug colors",
    size: [CASE_COUNT, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: "R4-A-04 injected debug readback",
    size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const bindGroup = device.createBindGroup({
    label: "R4-A-04 injected debug bindings",
    layout,
    entries: [
      { binding: 0, resource: keyTexture.createView() },
      { binding: 1, resource: { buffer: instances } },
      { binding: 2, resource: { buffer: meshlets } },
      { binding: 3, resource: { buffer: rasterWork } },
      { binding: 4, resource: { buffer: materials } },
      { binding: 5, resource: { buffer: settings } }
    ]
  });
  const encoder = device.createCommandEncoder({ label: "R4-A-04 fail-visible injection" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: output.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: output },
    { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: 1 },
    [CASE_COUNT, 1]
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const rgba = new Uint8Array(readback.getMappedRange().slice(0, CASE_COUNT * 4));
  readback.unmap();
  const validationError = await device.popErrorScope();
  const cases = caseDefinitions.map((entry, index) => {
    const actual = [...rgba.subarray(index * 4, index * 4 + 4)];
    const expected = entry.color === null
      ? null
      : [...entry.color.map((component) => Math.round(component * 255)), 255];
    const matches = expected === null
      ? actual[3] === 255
      : expected.every((component, lane) => Math.abs(component - actual[lane]!) <= 1);
    return { name: entry.name, key: entry.key, expected, actual, matches };
  });
  const passed = validationError === null &&
    shaderDiagnostics.every((entry) => entry.type !== "error") &&
    cases.every((entry) => entry.matches);

  for (const resource of [keyTexture, output]) resource.destroy();
  for (const resource of [rasterWork, instances, meshlets, materials, settings, readback]) {
    resource.destroy();
  }
  return {
    passed,
    rgba,
    cases,
    shaderDiagnostics,
    validationError: validationError?.message ?? null
  };
}

function buildFailureCases() {
  const color = GPU_VISIBILITY_DEBUG_COLORS;
  return [
    { name: "empty", key: GPU_VISIBILITY_KEY_EMPTY, color: color.Empty },
    { name: "invalid-reserved", key: GPU_VISIBILITY_KEY_INVALID, color: color.InvalidKey },
    { name: "maximum-valid-key", key: encodeVisibilityKey(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT), color: color.RasterWorkOutOfRange },
    { name: "raster-work-oob", key: encodeVisibilityKey(30), color: color.RasterWorkOutOfRange },
    { name: "meshlet-oob", key: encodeVisibilityKey(0), color: color.MeshletOutOfRange },
    { name: "triangle-oob", key: encodeVisibilityKey(1), color: color.TriangleOutOfRange },
    { name: "instance-oob", key: encodeVisibilityKey(2), color: color.InstanceOutOfRange },
    { name: "inactive-instance", key: encodeVisibilityKey(3), color: color.InactiveInstance },
    { name: "geometry-oob", key: encodeVisibilityKey(4), color: color.GeometryOutOfRange },
    { name: "geometry-identity-mismatch", key: encodeVisibilityKey(5), color: color.IdentityMismatch },
    { name: "material-identity-mismatch", key: encodeVisibilityKey(6), color: color.IdentityMismatch },
    { name: "material-oob", key: encodeVisibilityKey(7), color: color.MaterialOutOfRange },
    { name: "material-invalid", key: encodeVisibilityKey(8), color: color.MaterialRecordInvalid },
    { name: "blend-in-opaque", key: encodeVisibilityKey(9), color: color.BlendMaterial },
    { name: "valid-mask", key: encodeVisibilityKey(10), color: null }
  ] as const;
}

function instance(geometry: number, material: number, flags: number, debugId: number) {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    geometryRecordIndex: geometry,
    materialHandle: material,
    flags,
    debugId,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    currentObjectToWorld: identity,
    previousObjectToWorld: identity
  };
}

function packMaterials(): Uint8Array {
  const bytes = new Uint8Array(3 * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  const records = [
    materialRecord(0, GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask,
      GPU_MATERIAL_VISIBILITY_FLAGS.Valid | GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided),
    materialRecord(1, GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Opaque, 0),
    materialRecord(2, GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend,
      GPU_MATERIAL_VISIBILITY_FLAGS.Valid)
  ];
  for (let index = 0; index < records.length; index++) {
    bytes.set(new Uint8Array(packGpuMaterialVisibilityRecord(records[index]!)),
      index * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  }
  return bytes;
}

function materialRecord(materialId: number, alphaMode: number, flags: number) {
  return {
    materialId,
    alphaMode,
    flags,
    textureRef: GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    baseColorFactorAlpha: 1,
    alphaCutoff: 0.5,
    uvSet: 0,
    samplerClass: 0,
    uvOffset: [0, 0],
    uvScale: [1, 1],
    rotationCos: 1,
    rotationSin: 0
  };
}

function rasterWorkRecord(
  instanceRecordIndex: number,
  geometryRecordIndex: number,
  meshletRecordIndex: number,
  localTriangleIndex: number,
  materialHandle: number
): Uint8Array {
  return packRasterWork({
    instanceRecordIndex,
    geometryRecordIndex,
    meshletRecordIndex,
    localTriangleIndex,
    materialHandle,
    rasterFlags: 0
  });
}

function createClassifiedRasterBuffer(
  device: GPUDevice,
  label: string,
  records: readonly Uint8Array[]
): GPUBuffer {
  const bytes = new Uint8Array(
    GPU_CLASSIFIED_RASTER_HEADER_BYTES + records.length * 2 * GPU_RASTER_WORK_SCHEMA.stride
  );
  bytes.set(packClassifiedRasterWorkHeaders(records.length));
  const header = new DataView(bytes.buffer);
  header.setUint32(GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.written, records.length, true);
  header.setUint32(GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.attempted, records.length, true);
  header.setUint32(GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.peak, records.length, true);
  for (let index = 0; index < records.length; index++) {
    bytes.set(records[index]!, GPU_CLASSIFIED_RASTER_HEADER_BYTES + index * GPU_RASTER_WORK_SCHEMA.stride);
  }
  return createBufferWithData(device, label, bytes);
}

function createBufferWithData(
  device: GPUDevice,
  label: string,
  bytes: Uint8Array,
  extraUsage: GPUBufferUsageFlags = 0
): GPUBuffer {
  const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4);
  const buffer = device.createBuffer({
    label,
    size,
    usage: GPUBufferUsage.STORAGE | extraUsage,
    mappedAtCreation: true
  });
  new Uint8Array(buffer.getMappedRange()).set(bytes);
  buffer.unmap();
  return buffer;
}

function drawFailureStrip(rgba: Uint8Array): void {
  const context = failureStrip.getContext("2d");
  if (context === null) throw new Error("Failure strip 2D context is unavailable");
  const image = context.createImageData(CASE_COUNT, 1);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
}

function createEnvironmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x2a66, 0x2e66, 0x3266, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function configureRenderer(renderer: Renderer): void {
  renderer.configure({ features: {
    shadows: false, screenSpaceReflections: false, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
  renderer.profiler.configure({ enabled: true });
}

function publishResult(value: unknown): void {
  (window as unknown as { __OENGINE_R4_A_04_RESULT__: unknown })
    .__OENGINE_R4_A_04_RESULT__ = value;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
