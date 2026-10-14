import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeImage, ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { RenderDebugView } from "../../.test-dist/debug/RenderDebugView.js";
import { resolveTextureView } from "../../.test-dist/render/RenderTargetViews.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { AMBIENT_OCCLUSION_DEFAULT_SETTINGS as defaults } from "../../.test-dist/render/ao/AmbientOcclusionSettings.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const bytes = (samples) => samples.filter((_, i) => i % 4 === 0).map((v) => Math.round(v * 255));
const maxDifference = (a, b) => a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i])), 0);

/** Small production scene; observers only read real products in the ordinary
 * frame encoder. They do not substitute shaders, AO output or renderer control. */
export async function runAoFunctionalityGpuOracle() {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    featureLevel: "core"
  });
  check(adapter, "AO requires a hardware adapter");
  const features = [
    "core-features-and-limits",
    "indirect-first-instance",
    "texture-formats-tier1",
    "texture-compression-bc"
  ];
  for (const optional of ["primitive-index", "subgroups", "timestamp-query"]) {
    if (adapter.features.has(optional)) features.push(optional);
  }
  let device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
  });
  let renderer = new Renderer({ autoExposure: false, fixedExposure: 1, enablePhysicalEnvironment: false });
  const context = new OffscreenCanvas(192, 128).getContext("webgpu");
  const errors = [];
  const reports = [];
  let observations = true;
  let scalar = null,
    debug = null,
    raw = null,
    actualFrame = null,
    colorReset = null,
    seedPreviousValid = null;
  let upscaleReset = null;
  let abortNext = false;
  const buffers = new Map();
  let observerPipeline;
  let scalarPipeline;
  const createObservers = () => {
    const shader = (isScalar) => /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
${isScalar ? "@group(0) @binding(1) var depth: texture_depth_2d; @group(0) @binding(2) var raw: texture_2d<f32>;" : ""}
@group(0) @binding(${isScalar ? 3 : 1}) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(source);
  if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy);
  output[id.y * size.x + id.x] = ${
    isScalar
      ? "vec4f(textureLoad(source, p, 0).r, textureLoad(depth, p, 0), textureLoad(raw, p, 0).r, 1.0)"
      : "textureLoad(source, p, 0)"
  };
}`;
    observerPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: shader(false) }), entryPoint: "main" }
    });
    scalarPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: shader(true) }), entryPoint: "main" }
    });
  };
  const observe = (graph, name, product, depth, rawAo) => {
    const pipeline = depth === undefined ? observerPipeline : scalarPipeline;
    const pass = graph.add(`AO oracle/${name}`, {}, (_data, resources, execution) => {
      if (!observations) return;
      const texture = resources.get(product);
      const size = texture.width * texture.height * 16;
      let pair = buffers.get(name);
      if (!pair || pair.size !== size) {
        pair?.gpu.destroy();
        pair?.cpu.destroy();
        pair = {
          size,
          gpu: device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          cpu: device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        };
        buffers.set(name, pair);
      }
      const entries = [{ binding: 0, resource: resolveTextureView(texture) }];
      if (depth !== undefined)
        entries.push(
          { binding: 1, resource: resolveTextureView(resources.get(depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(rawAo)) }
        );
      entries.push({ binding: depth === undefined ? 1 : 3, resource: { buffer: pair.gpu } });
      const command = execution.encoder;
      const encode = command.beginComputePass({ label: `AO oracle/${name}` });
      encode.setPipeline(pipeline);
      encode.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      encode.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
      encode.end();
      command.copyBufferToBuffer(pair.gpu, 0, pair.cpu, 0, size);
    });
    pass.read(product);
    if (depth !== undefined) {
      pass.read(depth);
      pass.read(rawAo);
    }
    pass.make_side_effect();
  };
  const instrument = () => {
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    createObservers();
    const denoise = renderer._xeGtaoDenoise.addToGraph.bind(renderer._xeGtaoDenoise);
    renderer._xeGtaoDenoise.addToGraph = (graph, input) => {
      const result = denoise(graph, input);
      observe(graph, "scalar", result.scalarTexture, input.prepared.depth, input.main.rawAo);
      return result;
    };
    const debugPass = renderer._renderDebugViewPass.addToGraph.bind(renderer._renderDebugViewPass);
    renderer._renderDebugViewPass.addToGraph = (graph, ...args) => {
      const result = debugPass(graph, ...args);
      observe(graph, "debug", result);
      return result;
    };
    const surface = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (input, ...rest) => {
      actualFrame = input;
      return surface(input, ...rest);
    };
    const encode = renderer._surface.encode.bind(renderer._surface);
    renderer._surface.encode = (...args) => {
      if (abortNext) {
        abortNext = false;
        throw new Error("AO injected abort");
      }
      return encode(...args);
    };
    const temporal = renderer._nativeTemporal.prepareFrame.bind(renderer._nativeTemporal);
    renderer._nativeTemporal.prepareFrame = (command, input) => {
      colorReset = input.reset;
      seedPreviousValid = renderer._temporalSeed.frame.previousValid;
      return temporal(command, input);
    };
    const upscale = renderer._fsr3.prepareFrame.bind(renderer._fsr3);
    renderer._fsr3.prepareFrame = (command, input) => {
      upscaleReset = input.reset;
      seedPreviousValid = renderer._temporalSeed.frame.previousValid;
      return upscale(command, input);
    };
  };
  const read = async (name) => {
    const pair = buffers.get(name);
    check(pair, `Missing ${name} GPU observation`);
    await pair.cpu.mapAsync(GPUMapMode.READ);
    const result = Float32Array.from(new Float32Array(pair.cpu.getMappedRange()));
    pair.cpu.unmap();
    return result;
  };
  const graph = () => renderer._lastFrameGraph.compiled.dump();
  const liveAo = () =>
    graph().passes.filter(
      (pass) => !pass.culled && pass.name.startsWith("XeGTAO/") && !pass.name.includes("update preparation")
    );
  const scene = new Scene();
  const geometry = new BoxGeometry();
  const material = new StandardShadeMaterial();
  material.roughness_factor = 1;
  const transforms = [
    [6, 0.2, 6, 0, -0.6, 0],
    [1, 1, 1, 0, 0, 0],
    [6, 3, 0.2, 0, 0.8, -1.5]
  ];
  const meshes = transforms.map(([x, y, z, px, py, pz]) =>
    Mesh.from(geometry, material, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, px, py, pz, 1])
  );
  for (const mesh of meshes) scene.add(mesh);
  const image = new ShadeImage();
  image.width = image.height = 7;
  image.depth = 1;
  image.data_type = "float32";
  image.color_space = 2;
  image.source = new Float32Array(7 * 7 * 4).fill(0.4).buffer;
  scene.lights.environment = ShadeTexture.from(image);
  const camera = new PerspectiveCamera();
  const placeCamera = (units = 1, offset = 0) => {
    camera.aspect = renderer.aspect_ratio;
    camera.near = 0.1 * units;
    camera.far = 100 * units;
    camera.transform.position.set((2 + offset) * units, 2 * units, 5 * units);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
  };
  let currentScene = scene;
  const tick = async () => {
    const start = renderer.frame_count;
    const deadline = performance.now() + 60_000;
    while (renderer.frame_count === start && performance.now() < deadline) {
      renderer.render(camera, currentScene);
      await device.queue.onSubmittedWorkDone();
      if (renderer.frame_count === start) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(renderer.frame_count === start + 1, `AO frame deferred: ${renderer._lastFrameDeferral}`);
    check(errors.length === 0, errors.join("\n"));
  };
  const snapshot = async () => {
    await tick();
    scalar = await read("scalar");
    debug = await read("debug");
    for (let p = 0; p < scalar.length; p += 4) {
      const expected = scalar[p + 1] > 0 ? scalar[p] : 1;
      for (let c = 0; c < 3; c++) {
        check(
          Math.abs(debug[p + c] - expected) <= 1 / 255,
          "AO debug is not the final scalar/neutral background"
        );
      }
    }
    return bytes(scalar);
  };
  const hdr = async () => {
    const texture = actualFrame.output;
    const row = Math.ceil((texture.width * 8) / 256) * 256;
    const buffer = device.createBuffer({
      size: row * texture.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const command = device.createCommandEncoder();
    command.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
    // Readback after a completed production frame; this submit contains no render work/control.
    device.queue.submit([command.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const packed = new Uint16Array(buffer.getMappedRange());
    const result = [];
    for (let y = 0; y < texture.height; y++)
      for (let x = 0; x < texture.width; x++) {
        for (let c = 0; c < 3; c++) result.push(decodeFloat16(packed[(y * row) / 2 + x * 4 + c]));
      }
    buffer.unmap();
    buffer.destroy();
    check(result.every(Number.isFinite), "Nonfinite AO Surface HDR");
    return result;
  };
  try {
    await renderer.initialize({ adapter, device, context });
    renderer.pixel_ratio = 1;
    renderer.resize(192, 128);
    renderer.temporal_jitter_enabled = false;
    renderer.bloom_enabled = false;
    renderer.render_debug_view = RenderDebugView.AmbientOcclusion;
    const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(), createGeometryCookRecipe());
    await renderer.uploadScene(scene, [{ geometry, asset: cooked.asset }]);
    placeCamera();
    instrument();
    const owners = [renderer._xeGtaoMain, renderer._xeGtaoDenoise, renderer._xeGtaoPreparation];
    const lut = renderer._xeGtaoMain.hilbertLut;
    const full = await snapshot();
    const fullHdr = await hdr();
    const pipelines = [
      renderer._xeGtaoMain.pipelines.medium,
      renderer._xeGtaoMain.pipelines.high,
      renderer._xeGtaoDenoise.intermediatePipeline,
      renderer._xeGtaoDenoise.finalPipeline,
      renderer._xeGtaoDenoise.disabledPipeline
    ];
    check(Math.min(...full) < 240, "Scene has no meaningful AO contact");
    const baseGraph = renderer._lastFrameGraph.compiled;
    await snapshot();
    check(colorReset === false && seedPreviousValid, "Warm frame did not retain histories");
    const exposureGeneration = renderer._radiometry.generationValue;
    renderer.setAmbientOcclusionSettings({ strength: 0.5 });
    const half = await snapshot();
    const halfHdr = await hdr();
    check(renderer._lastFrameGraph.compiled === baseGraph, "Numeric AO edit rebuilt the graph");
    check(colorReset === true && seedPreviousValid, "AO edit reset identity or retained stale color");
    check(renderer._radiometry.generationValue === exposureGeneration, "AO edit reset exposure");
    const strengthError = maxDifference(
      half,
      full.map((v) => Math.floor(255 - 0.5 * (255 - v) + 0.5))
    );
    check(strengthError <= 1, `Independent R8 strength formula differs by ${strengthError} bytes`);
    check(
      halfHdr.some((v, i) => v > fullHdr[i] + 1e-4),
      "Native diffuse IBL did not consume AO strength"
    );
    check(
      halfHdr.every((v, i) => v >= fullHdr[i] - 0.002),
      "AO strength unexpectedly darkened Native HDR"
    );
    await snapshot();
    check(colorReset === false, "AO color reset repeated after successful commit");
    renderer.setAmbientOcclusionSettings({ strength: 0 });
    await tick();
    check(liveAo().length === 0, "Zero strength retained AO work");
    const neutral = await read("debug");
    check(
      neutral.every((v) => v === 1),
      "Disabled AO debug is not neutral white"
    );
    await tick();
    const offGraph = renderer._lastFrameGraph.compiled;
    renderer.setAmbientOcclusionSettings({ radiusMeters: 2, quality: "medium", denoisePasses: 3 });
    await tick();
    check(
      colorReset === false && renderer._lastFrameGraph.compiled === offGraph,
      "Inactive settings invalidated color or graph"
    );
    renderer.setAmbientOcclusionSettings(defaults);
    const restored = await snapshot();
    check(maxDifference(full, restored) === 0, "Default restoration changed the deterministic scalar");
    renderer.setAmbientOcclusionSettings({ radiusMeters: 2 });
    const larger = await snapshot();
    check(maxDifference(full, larger) > 1, "Radius did not reach cached preparation constants");
    renderer.setAmbientOcclusionSettings({ radiusMeters: 1, metersPerWorldUnit: 0.5 });
    const sameRadius = await snapshot();
    check(
      maxDifference(larger, sameRadius) === 0 && colorReset === false,
      "Equivalent physical radius reset or changed output"
    );
    renderer.setAmbientOcclusionSettings(defaults);
    for (const [index, mesh] of meshes.entries()) {
      const [x, y, z, px, py, pz] = transforms[index].map((value) => value * 16);
      mesh.transform_local.fromMatrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, px, py, pz, 1]);
      mesh.updateMatrices();
    }
    renderer.setAmbientOcclusionSettings({ metersPerWorldUnit: 1 / 16 });
    placeCamera(16);
    renderer.invalidateTemporalHistory();
    const scaledScene = await snapshot();
    const unitError = maxDifference(full, scaledScene);
    check(unitError <= 1, `Same physical scene in 16x world units differs by ${unitError} R8 bytes`);
    for (const [index, mesh] of meshes.entries()) {
      const [x, y, z, px, py, pz] = transforms[index];
      mesh.transform_local.fromMatrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, px, py, pz, 1]);
      mesh.updateMatrices();
    }
    placeCamera();
    renderer.invalidateTemporalHistory();
    renderer.setAmbientOcclusionSettings({ ...defaults, quality: "medium", denoisePasses: 0 });
    await snapshot();
    const noFilter = bytes(scalar);
    raw = scalar.filter((_, i) => i % 4 === 2).map((v) => Math.round(v * 255));
    check(
      maxDifference(
        noFilter,
        raw.map((v) => Math.min(255, Math.floor(v * 1.5 + 0.5)))
      ) <= 1,
      "D=0 lost the donor final 1.5 restore"
    );
    check(
      liveAo().some((pass) => pass.name === "XeGTAO/Main scalar medium"),
      "Medium did not execute"
    );
    for (const count of [2, 3]) {
      renderer.setAmbientOcclusionSettings({ denoisePasses: count });
      const filtered = await snapshot();
      check(
        liveAo().filter((pass) => pass.name.startsWith("XeGTAO/denoise")).length === count,
        "Denoise count changed algorithm work"
      );
      renderer.setAmbientOcclusionSettings({ strength: 0.5 });
      const mixed = await snapshot();
      check(
        maxDifference(
          mixed,
          filtered.map((v) => Math.floor(255 - 0.5 * (255 - v) + 0.5))
        ) <= 1,
        "Strength was applied before the final denoise pass"
      );
      renderer.setAmbientOcclusionSettings({ strength: 1 });
    }
    check(
      owners[0] === renderer._xeGtaoMain &&
        owners[1] === renderer._xeGtaoDenoise &&
        owners[2] === renderer._xeGtaoPreparation &&
        lut === renderer._xeGtaoMain.hilbertLut,
      "Setting changes recreated AO owners/LUT"
    );
    check(
      pipelines.every(
        (value, index) =>
          value ===
          [
            renderer._xeGtaoMain.pipelines.medium,
            renderer._xeGtaoMain.pipelines.high,
            renderer._xeGtaoDenoise.intermediatePipeline,
            renderer._xeGtaoDenoise.finalPipeline,
            renderer._xeGtaoDenoise.disabledPipeline
          ][index]
      ),
      "Setting changes recreated fixed PSOs"
    );
    renderer.setAmbientOcclusionSettings(defaults);
    await snapshot();
    const committed = renderer._committedAmbientOcclusionKey;
    renderer.setAmbientOcclusionSettings({ strength: 0.375, finalValuePower: 1.7 });
    const runtime = renderer.graphics.render_world.runtime(scene);
    const canPrepare = runtime.nativeMaterials.canPrepareFrame;
    runtime.nativeMaterials.canPrepareFrame = () => false;
    const deferredFrame = renderer.frame_count;
    try {
      renderer.render(camera, scene);
    } finally {
      runtime.nativeMaterials.canPrepareFrame = canPrepare;
    }
    check(
      renderer.frame_count === deferredFrame && renderer._committedAmbientOcclusionKey === committed,
      "Deferred publication committed desired AO content"
    );
    abortNext = true;
    let aborted = false;
    try {
      await tick();
    } catch (error) {
      check(error.message.includes("AO injected abort"), error.message);
      aborted = true;
    }
    check(
      aborted && renderer._committedAmbientOcclusionKey === committed,
      "Abort committed desired AO content"
    );
    await snapshot();
    check(
      colorReset === true && renderer._committedAmbientOcclusionKey !== committed,
      "Retry dropped pending AO reset"
    );
    await snapshot();
    check(colorReset === false, "Retry never committed AO content");
    renderer.setAmbientOcclusionSettings({ strength: 1 });
    const curved = await snapshot();
    check(maxDifference(full, curved) > 1, "Final power did not reach Main constants");
    placeCamera(1, 0.05);
    await snapshot();
    check(colorReset === false && seedPreviousValid, "Ordinary motion lost AO/Temporal continuity");
    renderer.resize(193, 129);
    placeCamera();
    await snapshot();
    renderer.setResolutionScale(0.73);
    await tick();
    check(renderer._lastFrameGraph.program.stages.includes("fsr3"), "AO upscale consumer did not execute");
    await tick();
    check(upscaleReset === false, "Warm upscale did not retain color");
    renderer.setAmbientOcclusionSettings({ strength: 0.5 });
    await tick();
    check(upscaleReset === true && seedPreviousValid, "AO edit did not reset upscale color alone");
    await tick();
    check(upscaleReset === false, "Upscale AO reset repeated after commit");
    renderer.setResolutionScale(1);
    await snapshot();
    renderer.setAmbientOcclusionSettings({ enabled: false });
    await tick();
    check(liveAo().length === 0, "Disabled AO retained production work");
    renderer.setAmbientOcclusionSettings({ enabled: true });
    await snapshot();
    renderer.setAmbientOcclusionSettings(defaults);
    observations = false;
    renderer.resize(1920, 1080);
    placeCamera();
    const start = performance.now();
    await tick();
    const costMs = performance.now() - start;
    const costPasses = liveAo().map((pass) => pass.name);
    check(costPasses.length === 5, `Default AO dispatch count is ${costPasses.length}`);
    check(!costPasses.some((name) => name.includes("pack")), "Unused packed consumer survived");
    const costGraph = renderer._lastFrameGraph.compiled.graph;
    const liveWrites = new Set(
      graph()
        .passes.filter((pass) => !pass.culled && pass.name.startsWith("XeGTAO/"))
        .flatMap((pass) => pass.writes)
    );
    let logicalBytes = 0;
    for (const id of liveWrites) {
      const descriptor = costGraph.getDescriptor(id);
      if (descriptor?.kind === "transient_texture") {
        logicalBytes += descriptor.width * descriptor.height * (descriptor.format === "r8unorm" ? 1 : 4);
      }
    }
    const expectedBytes = 7 * 1920 * 1080 + (4 * 1920 * 1088 * 341) / 256;
    check(
      logicalBytes === expectedBytes,
      `AO logical textures differ from Cost Card: ${logicalBytes} vs ${expectedBytes}`
    );
    const memory = renderer.memoryEvidence();
    const accounting = renderer.graphics.resource_accounting.snapshot();
    check(
      accounting.peakBytes >= accounting.totalBytes &&
        Number.isSafeInteger(memory.transientPoolBytes) && memory.transientPoolBytes >= 0,
      "Invalid shared allocator/retirement accounting"
    );
    renderer.resize(192, 128);
    placeCamera();
    observations = true;
    renderer.setAmbientOcclusionSettings({
      strength: 0.625,
      finalValuePower: 1.8,
      quality: "medium",
      denoisePasses: 2
    });
    const wanted = renderer.ambientOcclusionSettings;
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    check(
      JSON.stringify(renderer.ambientOcclusionSettings) === JSON.stringify(wanted),
      "Device recovery lost runtime AO settings"
    );
    renderer.temporal_jitter_enabled = false;
    renderer.bloom_enabled = false;
    renderer.render_debug_view = RenderDebugView.AmbientOcclusion;
    for (const pair of buffers.values()) {
      pair.gpu.destroy();
      pair.cpu.destroy();
    }
    buffers.clear();
    instrument();
    await snapshot();
    const unlitScene = new Scene();
    const unlit = new StandardShadeMaterial();
    unlit.is_unlit = true;
    unlitScene.add(Mesh.from(geometry, unlit));
    await renderer.uploadScene(unlitScene, [{ geometry, asset: cooked.asset }]);
    currentScene = unlitScene;
    await tick();
    check(
      liveAo().length === 0 && (await read("debug")).every((v) => v === 1),
      "Unlit AO debug forced AO work"
    );
    currentScene = new Scene();
    await tick();
    check(
      renderer._lastFrameGraph.program.stages.length === 1 && renderer._committedAmbientOcclusionKey === null,
      "Empty scene retained AO ownership"
    );
    reports.push({
      strengthErrorBytes: strengthError,
      physicalUnitErrorBytes: unitError,
      defaultRestoreExact: true,
      radiusLateBinding: true,
      finalPowerLateBinding: true,
      quality: ["medium", "high"],
      denoise: [0, 1, 2, 3],
      abortRetry: true,
      defer: true,
      motion: true,
      oddResize: true,
      upscale: true,
      recovery: true,
      unlitEmpty: true,
      cost: {
        output: [1920, 1080],
        dispatches: costPasses,
        logicalBytes,
        registeredBytes: accounting.totalBytes,
        registeredPeakBytes: accounting.peakBytes,
        registeredRetiredBytes: accounting.retiredBytes,
        sharedTransientPoolBytes: memory.transientPoolBytes,
        singleFrameCpuAndQueueMs: costMs,
        note: "One cold production frame plus debug/observers; not a GPU timing or speedup claim."
      },
      exposureGeneration
    });
    check(errors.length === 0, errors.join("\n"));
    return { cases: reports, gpuErrors: errors };
  } finally {
    for (const pair of buffers.values()) {
      pair.gpu.destroy();
      pair.cpu.destroy();
    }
    renderer.destroy();
    device.destroy();
  }
}
