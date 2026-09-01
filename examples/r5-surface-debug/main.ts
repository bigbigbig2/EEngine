import {
  DirectionalLight,
  PerspectiveCamera,
  Renderer,
  RenderDebugView,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  captureWebGpuLimits,
  cookGeometryAssetPackage,
  createGeometryCookRecipe
} from "../../OEngine/src/index.ts";
import {
  GPU_SURFACE_FLAGS,
  packGpuSurfaceMetadata
} from "../../OEngine/src/gpu/GpuSurfaceAbi.ts";
import { floatToHalf, halfToFloat } from "../../OEngine/src/loaders/float16.ts";
import {
  DEPTH_DEBUG_WGSL,
  SURFACE_AO_DEBUG_WGSL,
  SURFACE_COLOR_DEBUG_WGSL,
  SURFACE_EMISSIVE_DEBUG_WGSL,
  SURFACE_FLAGS_DEBUG_WGSL,
  SURFACE_NORMAL_DEBUG_WGSL,
  SURFACE_PBR_DEBUG_WGSL,
  VELOCITY_DEBUG_WGSL
} from "../../OEngine/src/shaders/render_debug_view.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];
declare const __BUILD_CONTENT_HASH__: string;

const WIDTH = 960;
const HEIGHT = 720;
const ROW_BYTES = 256;
const status = requiredElement<HTMLElement>("status");
const result = requiredElement<HTMLElement>("result");
const canvas = requiredElement<HTMLCanvasElement>("gpu-canvas");
const microCanvas = requiredElement<HTMLCanvasElement>("micro-canvas");
const download = requiredElement<HTMLButtonElement>("download");

const DEBUG_VIEWS = Object.freeze({
  Depth: RenderDebugView.Depth,
  Normal: RenderDebugView.ShadingNormal,
  Metallic: RenderDebugView.Metallic,
  Roughness: RenderDebugView.Roughness,
  Albedo: RenderDebugView.BaseColor,
  AO: RenderDebugView.Occlusion,
  Emissive: RenderDebugView.Emissive,
  Velocity: RenderDebugView.Velocity,
  Reactive: RenderDebugView.Reactive,
  MaterialId: RenderDebugView.MaterialId,
  HistoryValidity: RenderDebugView.HistoryValidity,
  None: RenderDebugView.None
});

let finalResult: Fx01Result | null = null;
let renderer: Renderer;
let scene: Scene;
let camera: PerspectiveCamera;
let sun: DirectionalLight;

download.addEventListener("click", () => {
  if (finalResult === null) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(
    [JSON.stringify(finalResult, null, 2)],
    { type: "application/json" }
  ));
  anchor.download = `oengine-r5-fx01-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = "FX-01 validation failed";
  status.className = "error";
  result.textContent = message;
  publishResult({ completed: true, passed: false, fatalError: message });
  console.error(error);
});

async function run(): Promise<void> {
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("WebGPU canvas context is unavailable");

  renderer = new Renderer();
  await renderer.initialize({ context, pixelRatio: 1 });
  renderer.resize(WIDTH, HEIGHT);
  configureRenderer(renderer);
  ({ scene, camera, sun } = await createMaterialBoard(renderer));

  renderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: 1_000_000,
    gpuCounterSampleInterval: 1_000_000
  });
  const graphEvidence = await collectGraphEvidence();
  const numeric = await runNumericFixture(renderer.device);
  drawMicroFixture(numeric);
  const diagnostics = renderer.profiler.diagnostics;
  const passed = graphEvidence.passed && numeric.passed &&
    diagnostics.validationErrorCount === 0 &&
    diagnostics.uncapturedErrorCount === 0 &&
    diagnostics.deviceLostCount === 0;
  finalResult = {
    completed: true,
    passed,
    task: "R5 FX-01 Surface Debug + Background",
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__,
      contentHash: __BUILD_CONTENT_HASH__
    },
    production: {
      path: "buildBoxSourceGeometry -> Cooker -> uploadPackedScene -> Renderer.render",
      board: [
        "dielectric rough",
        "dielectric smooth",
        "metallic rough",
        "metallic smooth",
        "emissive",
        "unlit"
      ],
      layout: "2x3",
      backgroundAreaTarget: 0.25,
      canvas: { width: WIDTH, height: HEIGHT, dpr: 1 },
      debugGroups: {
        Depth: ["Depth"],
        Normal: ["Normal"],
        PBR: ["Metallic", "Roughness"],
        AlbedoAO: ["Albedo", "AO"],
        Emissive: ["Emissive"],
        Velocity: ["Velocity"],
        Reactive: ["Reactive"],
        MaterialAndMotion: ["MaterialId", "HistoryValidity"]
      },
      graphEvidence,
      screenshotContract: {
        owner: "examples/scripts/run-r5-fx01-gate.mjs",
        captureViews: Object.keys(DEBUG_VIEWS).filter((name) => name !== "None"),
        tileCenters: [
          { material: "dielectric rough", x: 341, y: 182 },
          { material: "dielectric smooth", x: 618, y: 182 },
          { material: "metallic rough", x: 341, y: 359 },
          { material: "metallic smooth", x: 618, y: 359 },
          { material: "emissive", x: 341, y: 536 },
          { material: "unlit motion-invalid", x: 618, y: 536 }
        ],
        screenshotMetrics: "runner-owned PNG decode; page result is necessary but not sufficient"
      },
      gpu: {
        adapter: renderer.adapter_info,
        features: [...renderer.device.features].sort(),
        limits: captureWebGpuLimits(renderer.device.limits)
      },
      diagnostics
    },
    numeric
  };
  publishResult(finalResult);
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed
    ? "FX-01 production and GPU numeric validation passed"
    : "FX-01 validation failed";
  status.className = passed ? "ok" : "error";
  download.disabled = false;
}

async function createMaterialBoard(activeRenderer: Renderer) {
  const source = buildBoxSourceGeometry(1.35, 0.82, 0.12);
  const geometry = (await cookGeometryAssetPackage(
    source,
    createGeometryCookRecipe()
  )).asset;
  const materials = createMaterials();
  const count = materials.length;
  const transforms = new Float32Array(count * 16);
  const previousTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const xPositions = [-0.82, 0.82];
  const yPositions = [1.05, 0, -1.05];
  for (let index = 0; index < count; index++) {
    setTranslationMatrix(
      transforms,
      index * 16,
      xPositions[index % 2]!,
      yPositions[Math.floor(index / 2)]!,
      0
    );
    boundsSpheres.set(source.bounds.sphere, index * 4);
    boundsMin.set(source.bounds.box.subarray(0, 3), index * 3);
    boundsMax.set(source.bounds.box.subarray(3, 6), index * 3);
  }
  previousTransforms.set(transforms);
  previousTransforms.fill(0, (count - 1) * 16, count * 16);

  const activeScene = new Scene();
  activeScene.lights.environment = createEnvironmentTexture();
  const activeSun = new DirectionalLight();
  activeSun.intensity = 4;
  activeSun.forward = [0.4, -0.7, -1];
  activeSun.casts_shadow = false;
  activeScene.addChild(activeSun);
  await activeRenderer.uploadPackedScene(activeScene, {
    geometries: [geometry],
    materials,
    count,
    geometryIndices: new Uint32Array(count),
    materialIndices: Uint32Array.from({ length: count }, (_, index) => index),
    currentTransforms: transforms,
    previousTransforms,
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(count),
    debugIds: Uint32Array.from({ length: count }, (_, index) => index + 1)
  });

  const activeCamera = new PerspectiveCamera();
  activeCamera.aspect = WIDTH / HEIGHT;
  activeCamera.near = 0.1;
  activeCamera.transform.position.set(0, 0, 5.2);
  activeCamera.transform.lookAt({ x: 0, y: 0, z: 0 });
  activeCamera.update();
  return { scene: activeScene, camera: activeCamera, sun: activeSun };
}

function createMaterials(): StandardShadeMaterial[] {
  const definitions = [
    { color: [0.82, 0.18, 0.12, 1], metallic: 0, roughness: 0.88 },
    { color: [0.18, 0.62, 0.24, 1], metallic: 0, roughness: 0.12 },
    { color: [0.16, 0.36, 0.82, 1], metallic: 1, roughness: 0.88 },
    { color: [0.88, 0.62, 0.12, 1], metallic: 1, roughness: 0.12 },
    { color: [0.04, 0.04, 0.04, 1], metallic: 0, roughness: 0.5, emissive: [4, 1, 0.25] },
    { color: [0.12, 0.78, 0.92, 1], metallic: 0, roughness: 1, unlit: true }
  ] as const;
  return definitions.map((definition) => {
    const material = new StandardShadeMaterial();
    material.diffuse_color.set(
      definition.color[0],
      definition.color[1],
      definition.color[2],
      definition.color[3]
    );
    material.metallic_factor = definition.metallic;
    material.roughness_factor = definition.roughness;
    if ("emissive" in definition) material.emissive_factor.setRGB(...definition.emissive);
    if ("unlit" in definition) material.is_unlit = definition.unlit;
    return material;
  });
}

async function collectGraphEvidence() {
  await renderView("None", 3);
  const off = latestGraphDump(renderer);
  const offFrame = renderer.profiler.latest;
  await renderView("Normal", 2);
  const on = latestGraphDump(renderer);
  await renderView("None", 1);
  const offAgain = latestGraphDump(renderer);
  const passNames = (dump: GraphDump | null) => dump?.passes
    .filter((entry) => !entry.culled)
    .map((entry) => entry.name) ?? [];
  const offDebug = passNames(off).filter((name) => name.startsWith("Render debug/"));
  const onDebug = passNames(on).filter((name) => name.startsWith("Render debug/"));
  const offAgainDebug = passNames(offAgain)
    .filter((name) => name.startsWith("Render debug/"));
  const offResources = off?.resources.filter((entry) =>
    entry.name.startsWith("Render debug/")).map((entry) => entry.name) ?? [];
  const offAgainResources = offAgain?.resources.filter((entry) =>
    entry.name.startsWith("Render debug/")).map((entry) => entry.name) ?? [];
  return {
    passed: offDebug.length === 0 && onDebug.length === 1 &&
      offAgainDebug.length === 0 && offResources.length === 0 &&
      offAgainResources.length === 0 && offFrame?.readbacks.count === 0,
    featureOff: {
      debugPasses: offDebug,
      debugResources: offResources,
      exactChecks: {
        debugPasses: offDebug.length === 0,
        debugResources: offResources.length === 0,
        readbacks: offFrame?.readbacks.count === 0
      },
      submits: offFrame?.submits ?? null,
      readbacks: offFrame?.readbacks ?? null,
      graph: off
    },
    featureOn: { debugPasses: onDebug, graph: on },
    featureOffAgain: {
      debugPasses: offAgainDebug,
      debugResources: offAgainResources,
      exactChecks: {
        debugPasses: offAgainDebug.length === 0,
        debugResources: offAgainResources.length === 0
      },
      graph: offAgain
    }
  };
}

async function renderView(name: keyof typeof DEBUG_VIEWS, frames = 3) {
  renderer.render_debug_view = DEBUG_VIEWS[name];
  for (let frame = 0; frame < frames; frame++) {
    if (!renderer.render(camera, scene, 1 / 60)) {
      throw new Error("Production Renderer stopped because the GPU device was lost");
    }
  }
  await renderer.device.queue.onSubmittedWorkDone();
  status.textContent = `FX-01 view: ${name}`;
  return {
    name,
    view: renderer.render_debug_view,
    frame: renderer.frame_count,
    diagnostics: renderer.profiler.diagnostics
  };
}

async function setDirectLight(enabled: boolean) {
  if (enabled && sun.parent === null) scene.add(sun);
  if (!enabled && sun.parent !== null) scene.remove(sun);
  return renderView("None", 3);
}

async function runNumericFixture(device: GPUDevice) {
  const metadata = createUintTexture(
    device,
    "FX-01 metadata",
    "r32uint",
    Uint32Array.of(
      packGpuSurfaceMetadata(5, GPU_SURFACE_FLAGS.Valid),
      0
    )
  );
  const motionMetadata = createUintTexture(
    device,
    "FX-01 motion metadata",
    "r32uint",
    Uint32Array.of(
      packGpuSurfaceMetadata(
        5,
        GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.MotionValid
      ),
      0
    )
  );
  const motionInvalidMetadata = createUintTexture(
    device,
    "FX-01 motion-invalid metadata",
    "r32uint",
    Uint32Array.of(
      packGpuSurfaceMetadata(
        5,
        GPU_SURFACE_FLAGS.Valid | GPU_SURFACE_FLAGS.Reactive
      ),
      0
    )
  );
  const pbr = createByteTexture(device, "FX-01 PBR", "rg8unorm", 2,
    Uint8Array.of(64, 192, 255, 7));
  const albedo = createByteTexture(device, "FX-01 albedo AO", "rgba8unorm", 4,
    Uint8Array.of(51, 102, 153, 204, 255, 0, 255, 255));
  const normalBytes = new Uint16Array([
    49151, 32767, 49151, 32767,
    1, 65534, 2, 65533
  ]);
  const normal = createByteTexture(
    device,
    "FX-01 normal",
    "rgba16uint",
    8,
    new Uint8Array(normalBytes.buffer)
  );
  const emissive = createUintTexture(
    device,
    "FX-01 emissive",
    "r32uint",
    Uint32Array.of(((18 << 27) | (16 << 18) | (64 << 9) | 256) >>> 0, 0xffffffff)
  );
  const velocityBytes = new Uint16Array([
    floatToHalf(0), floatToHalf(0),
    floatToHalf(120), floatToHalf(-80)
  ]);
  const velocity = createByteTexture(
    device,
    "FX-01 velocity",
    "rg16float",
    4,
    new Uint8Array(velocityBytes.buffer)
  );

  const cases = [
    await runDebugShader(device, "base-color", SURFACE_COLOR_DEBUG_WGSL,
      floatPayloadLayout(false), [albedo.createView(), metadata.createView()]),
    await runDebugShader(device, "ao", SURFACE_AO_DEBUG_WGSL,
      floatPayloadLayout(false), [albedo.createView(), metadata.createView()]),
    await runDebugShader(device, "metallic", SURFACE_PBR_DEBUG_WGSL,
      floatPayloadLayout(true), [pbr.createView(), metadata.createView()], 0),
    await runDebugShader(device, "roughness", SURFACE_PBR_DEBUG_WGSL,
      floatPayloadLayout(true), [pbr.createView(), metadata.createView()], 1),
    await runDebugShader(device, "normal", SURFACE_NORMAL_DEBUG_WGSL,
      uintPayloadLayout(false), [normal.createView(), metadata.createView()]),
    await runDebugShader(device, "emissive", SURFACE_EMISSIVE_DEBUG_WGSL,
      uintPayloadLayout(false), [emissive.createView(), metadata.createView()], null, "rgba16float"),
    await runDebugShader(device, "static-velocity", VELOCITY_DEBUG_WGSL,
      floatPayloadLayout(false), [velocity.createView(), motionMetadata.createView()]),
    await runDebugShader(device, "motion-valid", SURFACE_FLAGS_DEBUG_WGSL,
      flagsLayout(), [motionMetadata.createView()], 1),
    await runDebugShader(device, "invalid-velocity", VELOCITY_DEBUG_WGSL,
      floatPayloadLayout(false), [velocity.createView(), motionInvalidMetadata.createView()]),
    await runDebugShader(device, "invalid-motion-valid", SURFACE_FLAGS_DEBUG_WGSL,
      flagsLayout(), [motionInvalidMetadata.createView()], 1),
    await runDebugShader(device, "invalid-reactive", SURFACE_FLAGS_DEBUG_WGSL,
      flagsLayout(), [motionInvalidMetadata.createView()], 2),
    await runDepthDebug(device)
  ];
  const byName = Object.fromEntries(cases.map((entry) => [entry.name, entry]));
  const normalRgb = byName.normal!.valid.slice(0, 3).map((value) => value / 255 * 2 - 1);
  const checks = {
    invalidPayloadBackground: cases
      .filter((entry) => entry.invalid !== null)
      .every((entry) => entry.invalidFloats !== null
        ? isNearFloat(entry.invalidFloats, [0, 0, 0, 1], 0.01)
        : isNear(entry.invalid!, [0, 0, 0, 255], 1)),
    metallic: isNear(byName.metallic!.valid, [64, 64, 64, 255], 1),
    roughness: isNear(byName.roughness!.valid, [192, 192, 192, 255], 1),
    normalUnitLength: Math.abs(Math.hypot(...normalRgb) - 1) < 0.025,
    normalDirection: normalRgb[0]! > 0.65 && Math.abs(normalRgb[1]!) < 0.1 &&
      normalRgb[2]! > 0.65,
    emissiveHdr: byName.emissive!.validFloats !== null &&
      isNearFloat(byName.emissive!.validFloats, [4, 1, 0.25, 1], 0.01),
    staticVelocity: isNear(byName["static-velocity"]!.valid, [20, 20, 20, 255], 2),
    motionValid: byName["motion-valid"]!.valid[1]! > 240,
    sameMotionInvalidPixel:
      isNear(byName["invalid-velocity"]!.valid, [20, 20, 20, 255], 2) &&
      byName["invalid-motion-valid"]!.valid[0]! > 240 &&
      byName["invalid-motion-valid"]!.valid[1]! < 80 &&
      byName["invalid-reactive"]!.valid[0]! > 240 &&
      byName["invalid-reactive"]!.valid[1]! < 80,
    reverseZEmpty: isNear(byName.depth!.valid, [0, 0, 0, 255], 1),
    shaderDiagnostics: cases.every((entry) =>
      entry.shaderDiagnostics.every((message) => message.type !== "error")),
    validation: cases.every((entry) => entry.validationError === null)
  };
  for (const texture of [
    metadata, motionMetadata, motionInvalidMetadata, pbr, albedo, normal, emissive, velocity
  ]) texture.destroy();
  return {
    passed: Object.values(checks).every(Boolean),
    targetFormat: "rgba8unorm + rgba16float emissive",
    source: "production render_debug_view WGSL",
    checks,
    cases
  };
}

async function runDebugShader(
  device: GPUDevice,
  name: string,
  code: string,
  layoutEntries: GPUBindGroupLayoutEntry[],
  textureViews: GPUTextureView[],
  mode: number | null = null,
  targetFormat: GPUTextureFormat = "rgba8unorm"
) {
  const module = device.createShaderModule({ label: `FX-01 ${name}`, code });
  const shaderDiagnostics = [...(await module.getCompilationInfo()).messages].map((message) => ({
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
  const layout = device.createBindGroupLayout({
    label: `FX-01 ${name} layout`,
    entries: layoutEntries
  });
  device.pushErrorScope("validation");
  const pipeline = await device.createRenderPipelineAsync({
    label: `FX-01 ${name}`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
    primitive: { topology: "triangle-list", cullMode: "none" }
  });
  const settings = createUniformBuffer(device, Uint32Array.of(2, 1, 0, 0));
  const modeBuffer = mode === null
    ? null
    : createUniformBuffer(device, Uint32Array.of(mode, 0, 0, 0));
  const bindings: GPUBindGroupEntry[] = textureViews.map((resource, binding) => ({
    binding,
    resource
  }));
  bindings.push({ binding: textureViews.length, resource: { buffer: settings } });
  if (modeBuffer !== null) {
    bindings.push({ binding: textureViews.length + 1, resource: { buffer: modeBuffer } });
  }
  const bindGroup = device.createBindGroup({ layout, entries: bindings });
  const output = device.createTexture({
    label: `FX-01 ${name} output`,
    size: [2, 1],
    format: targetFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: `FX-01 ${name} readback`,
    size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder({ label: `FX-01 ${name} encoder` });
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
    [2, 1]
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(readback.getMappedRange().slice(0, targetFormat === "rgba16float" ? 32 : 8));
  const validFloats = targetFormat === "rgba16float"
    ? Array.from(new Uint16Array(raw.buffer, raw.byteOffset, 8).slice(0, 4), halfToFloat)
    : null;
  const invalidFloats = targetFormat === "rgba16float"
    ? Array.from(new Uint16Array(raw.buffer, raw.byteOffset + 8, 8).slice(0, 4), halfToFloat)
    : null;
  const bytes = raw;
  readback.unmap();
  const validationError = await device.popErrorScope();
  output.destroy();
  readback.destroy();
  settings.destroy();
  modeBuffer?.destroy();
  return {
    name,
    valid: [...bytes.slice(0, 4)],
    invalid: [...bytes.slice(targetFormat === "rgba16float" ? 8 : 4, targetFormat === "rgba16float" ? 12 : 8)],
    validFloats,
    invalidFloats,
    shaderDiagnostics,
    validationError: validationError?.message ?? null
  };
}

async function runDepthDebug(device: GPUDevice) {
  const depth = device.createTexture({
    label: "FX-01 reverse-Z empty depth",
    size: [2, 1],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
  const clearEncoder = device.createCommandEncoder({ label: "FX-01 empty depth clear" });
  const clear = clearEncoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: "clear",
      depthStoreOp: "store"
    }
  });
  clear.end();
  device.queue.submit([clearEncoder.finish()]);
  const result = await runDebugShader(
    device,
    "depth",
    DEPTH_DEBUG_WGSL,
    [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ],
    [depth.createView()]
  );
  depth.destroy();
  return { ...result, invalid: null };
}

function floatPayloadLayout(withMode: boolean): GPUBindGroupLayoutEntry[] {
  return payloadLayout("unfilterable-float", withMode);
}

function uintPayloadLayout(withMode: boolean): GPUBindGroupLayoutEntry[] {
  return payloadLayout("uint", withMode);
}

function payloadLayout(
  sampleType: GPUTextureSampleType,
  withMode: boolean
): GPUBindGroupLayoutEntry[] {
  const entries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ];
  if (withMode) {
    entries.push({
      binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: 16 }
    });
  }
  return entries;
}

function flagsLayout(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: 16 }
    }
  ];
}

function createByteTexture(
  device: GPUDevice,
  label: string,
  format: GPUTextureFormat,
  bytesPerPixel: number,
  source: Uint8Array
): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [2, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const row = new Uint8Array(ROW_BYTES);
  row.set(source.subarray(0, 2 * bytesPerPixel));
  device.queue.writeTexture(
    { texture },
    row,
    { bytesPerRow: ROW_BYTES, rowsPerImage: 1 },
    [2, 1]
  );
  return texture;
}

function createUintTexture(
  device: GPUDevice,
  label: string,
  format: GPUTextureFormat,
  source: Uint32Array
): GPUTexture {
  return createByteTexture(
    device,
    label,
    format,
    4,
    new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  );
}

function createUniformBuffer(device: GPUDevice, source: Uint32Array): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(16, source.byteLength),
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true
  });
  new Uint32Array(buffer.getMappedRange()).set(source);
  buffer.unmap();
  return buffer;
}

function isNear(actual: readonly number[], expected: readonly number[], tolerance: number) {
  return expected.every((value, index) => Math.abs(value - actual[index]!) <= tolerance);
}

function isNearFloat(actual: readonly number[], expected: readonly number[], tolerance: number) {
  return expected.every((value, index) => Math.abs(value - actual[index]!) <= tolerance);
}

function latestGraphDump(activeRenderer: Renderer): GraphDump | null {
  const cache = (activeRenderer as unknown as {
    _mainGraphCache: { entries: Map<string, { dump(): GraphDump }> };
  })._mainGraphCache;
  return [...cache.entries.values()].at(-1)?.dump() ?? null;
}

function drawMicroFixture(
  numeric: Awaited<ReturnType<typeof runNumericFixture>>
): void {
  const context = microCanvas.getContext("2d");
  if (context === null) throw new Error("Micro fixture 2D context is unavailable");
  microCanvas.width = numeric.cases.length * 2;
  microCanvas.height = 1;
  const image = context.createImageData(microCanvas.width, 1);
  numeric.cases.forEach((entry, index) => {
    image.data.set(entry.valid, index * 8);
    image.data.set(entry.invalid ?? [0, 0, 0, 255], index * 8 + 4);
  });
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

function configureRenderer(activeRenderer: Renderer): void {
  activeRenderer.configure({ features: {
    shadows: false, screenSpaceReflections: false, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
}

function setTranslationMatrix(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number
): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function publishResult(value: unknown): void {
  (window as unknown as { __OENGINE_FX_01_RESULT__: unknown })
    .__OENGINE_FX_01_RESULT__ = value;
}

(window as unknown as {
  __OENGINE_FX_01__: {
    renderView(name: keyof typeof DEBUG_VIEWS): Promise<unknown>;
    setDirectLight(enabled: boolean): Promise<unknown>;
    getResult(): Fx01Result | null;
  };
}).__OENGINE_FX_01__ = {
  renderView: (name) => renderView(name),
  setDirectLight,
  getResult: () => finalResult
};

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

type GraphDump = {
  passes: readonly { name: string; culled: boolean }[];
  resources: readonly { name: string }[];
};

type Fx01Result = {
  completed: true;
  passed: boolean;
  [key: string]: unknown;
};
