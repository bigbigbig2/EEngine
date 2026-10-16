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
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { cookSceneGeometryProductV1 } from "../../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import { createDefaultWebGeometryCookerModule } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";
import { lowerStandardAppearanceGraph } from "../../.test-dist/material/StandardAppearanceGraph.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
const to709 = (c) => [
  1.660490394 * c[0] - 0.587639093 * c[1] - 0.072851598 * c[2],
  -0.12454997 * c[0] + 1.13289988 * c[1] - 0.008347965 * c[2],
  -0.018151119 * c[0] - 0.100578725 * c[1] + 1.11872983 * c[2]
];
const to2020 = (c) => [
  0.627404 * c[0] + 0.329282 * c[1] + 0.0433136 * c[2],
  0.069097 * c[0] + 0.91954 * c[1] + 0.0113612 * c[2],
  0.0163916 * c[0] + 0.0880132 * c[1] + 0.895595 * c[2]
];
const check = (v, m) => {
  if (!v) throw new Error(m);
};
export async function runSssrProductionGpuOracle() {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    featureLevel: "core"
  });
  check(adapter, "hardware adapter");
  const features = [
    "core-features-and-limits",
    "indirect-first-instance",
    "texture-formats-tier1",
    "texture-compression-bc"
  ];
  for (const feature of ["primitive-index", "subgroups", "timestamp-query"])
    if (adapter.features.has(feature)) features.push(feature);
  let device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 16,
      maxSampledTexturesPerShaderStage: Math.min(19, adapter.limits.maxSampledTexturesPerShaderStage)
    }
  });
  let renderer = new Renderer({
    autoExposure: false,
    fixedExposure: 1,
    enablePhysicalEnvironment: false,
    enableVsm: false
  });
  const context = new OffscreenCanvas(65, 49).getContext("webgpu"),
    errors = [],
    results = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const geometry = new BoxGeometry(),
    ground = new StandardShadeMaterial(),
    target = new StandardShadeMaterial();
  ground.roughness_factor = 0.13;
  ground.metallic_factor = 0.8;
  ground.clearcoat_factor = 0.7;
  ground.clearcoat_roughness_factor = 0.22;
  const standard = lowerStandardAppearanceGraph(ground, []);
  const coatNormal = standard.nodes.length;
  ground.appearance_definition = {
    schemaVersion: 1,
    graph: {
      nodes: [...standard.nodes, { kind: "constant", width: 3, value: [0.3, 0, 0.9539392014] }],
      outputs: { ...standard.outputs, coatNormalTS: coatNormal }
    }
  };
  target.is_unlit = true;
  target.diffuse_color.set(8, 2, 0.5, 1);
  const scene = new Scene();
  scene.add(Mesh.from(geometry, ground, [8, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 8, 0, 0, -0.7, 0, 1]));
  const bright = Mesh.from(geometry, target, [1, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]);
  scene.add(bright);
  const image = new ShadeImage();
  image.width = image.height = 7;
  image.depth = 1;
  image.data_type = "float32";
  image.color_space = 2;
  const env = new Float32Array(7 * 7 * 4);
  for (let i = 0; i < 49; i++) env.set([0.4, 0.2, 0.1, 1], i * 4);
  image.source = env.buffer;
  scene.lights.environment = ShadeTexture.from(image);
  const camera = new PerspectiveCamera();
  let currentScene = scene,
    captured,
    colorReset;
  const observations = new Map();
  let observeEnabled = true,
    abortAfter = false,
    lastHistory = false,
    baselineCheck = true;
  const work = [];
  const instrumented = new WeakSet();
  const observe = (encoder, name, texture) => {
    if (!observeEnabled) return;
    texture = texture.gpu_texture ?? texture;
    const width = texture.width,
      height = texture.height,
      row = Math.ceil((width * 8) / 256) * 256,
      size = row * height;
    let pair = observations.get(name);
    if (!pair || pair.size !== size) {
      pair?.buffer.destroy();
      pair = {
        size,
        width,
        height,
        row,
        buffer: device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      };
      observations.set(name, pair);
    }
    encoder.copyTextureToBuffer({ texture }, { buffer: pair.buffer, bytesPerRow: row }, [width, height]);
  };
  const read = async (name) => {
    const pair = observations.get(name);
    check(pair, "missing " + name);
    await pair.buffer.mapAsync(GPUMapMode.READ);
    const words = new Uint16Array(pair.buffer.getMappedRange()),
      values = [];
    for (let y = 0; y < pair.height; y++)
      for (let x = 0; x < pair.width * 4; x++) values.push(decodeFloat16(words[(y * pair.row) / 2 + x]));
    pair.buffer.unmap();
    return values;
  };
  const instrumentOwner = () => {
    const owner = renderer._reflections;
    if (!owner || instrumented.has(owner)) return;
    instrumented.add(owner);
    const encode = owner.encode.bind(owner);
    owner.encode = (encoder) => {
      const input = owner.pending.input;
      lastHistory = owner.frame.historyValid;
      const original = encoder.beginComputePass.bind(encoder);
      let dispatches = 0;
      encoder.beginComputePass = (...args) => {
        dispatches++;
        return original(...args);
      };
      let result;
      try {
        result = encode(encoder);
      } finally {
        encoder.beginComputePass = original;
      }
      const counts = owner.frame.counts,
        staging = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyBufferToBuffer(counts, 0, staging, 0, 8);
      work.push({
        staging,
        dispatches,
        capacity: owner.frame.capacity,
        allocated: owner.allocatedBytes,
        reserved: owner.reservedBytes
      });
      for (const [name, texture] of Object.entries({
        prefilterBase: owner.frame.basePrefilter,
        prefilterCoat: owner.frame.coatPrefilter,
        H: input.opaqueRadiance,
        Qbase: owner.frame.base,
        Qcoat: owner.frame.coat,
        corrected: result
      }))
        observe(encoder, name, texture);
      if (abortAfter) {
        abortAfter = false;
        throw new Error("SSSR after-encode abort");
      }
      return result;
    };
  };
  const inspectEnergy = async () => {
    const records = await receiver(),
      H = await read("H"),
      base = await read("Qbase"),
      coat = await read("Qcoat"),
      out = await read("corrected");
    let maxError = 0,
      maxBaselineError = 0,
      selected = 0;
    for (let p = 0; p < H.length / 4; p++) {
      const r = records.slice(p * 16, p * 16 + 16),
        qb = to709(base.slice(p * 4, p * 4 + 3)),
        qc = to709(coat.slice(p * 4, p * 4 + 3));
      const replacement = to2020(qb.map((v, c) => r[8 + c] * v + r[11] * qc[c]));
      for (let c = 0; c < 3; c++) {
        const expected =
          H[p * 4 + c] + renderer.screenSpaceReflectionsSettings.strength * (replacement[c] - r[12 + c]);
        const bound = Math.max(2 ** -22, Math.abs(expected) * 2 ** -9) + 2e-6;
        const error = Math.abs(out[p * 4 + c] - expected);
        check(
          Number.isFinite(out[p * 4 + c]) && error <= bound,
          "production HDR replacement " + p + "/" + c + ": " + error + " > " + bound
        );
        maxError = Math.max(maxError, error);
      }
      if (r[15] & 6) {
        selected++;
        if (!baselineCheck) continue;
        const expected = to2020([0.4, 0.2, 0.1].map((v, c) => v * (r[8 + c] + r[11])));
        for (let c = 0; c < 3; c++) {
          const error = Math.abs(r[12 + c] - expected[c]);
          check(
            error < Math.max(2 ** -14, Math.abs(expected[c]) * 0.004),
            "authored baseline differs from selected W"
          );
          maxBaselineError = Math.max(maxBaselineError, error);
        }
      }
    }
    check(selected > 0, "energy receivers");
    return { maxError, maxBaselineError, selected };
  };
  const instrument = () => {
    const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (input) => {
      captured = input;
      return prepare(input);
    };
    const debug = renderer._sssrDebug.encode.bind(renderer._sssrDebug);
    renderer._sssrDebug.encode = (command, output, ...rest) => {
      debug(command, output, ...rest);
      observe(command.gpu_encoder, "debug", output);
    };
    const native = renderer._nativeTemporal.prepareFrame.bind(renderer._nativeTemporal);
    renderer._nativeTemporal.prepareFrame = (command, input) => {
      colorReset = input.reset;
      return native(command, input);
    };
  };
  const tick = async () => {
    const start = renderer.frame_count,
      end = performance.now() + 45000;
    while (renderer.frame_count === start && performance.now() < end) {
      instrumentOwner();
      renderer.render(camera, currentScene);
      await device.queue.onSubmittedWorkDone();
      if (renderer.frame_count === start) await new Promise((r) => setTimeout(r, 5));
    }
    check(renderer.frame_count === start + 1, `deferred ${renderer._lastFrameDeferral}`);
    check(errors.length === 0, errors.join("\n"));
  };
  const receiver = async () => {
    const source = captured.reflections.receivers,
      staging = device.createBuffer({
        size: source.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(source, 0, staging, 0, source.size);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange()),
      out = Array.from({ length: words.length * 2 }, (_, i) =>
        decodeFloat16((words[i >> 1] >>> ((i & 1) * 16)) & 65535)
      );
    staging.unmap();
    staging.destroy();
    return out;
  };
  try {
    await renderer.initialize({ adapter, device, context });
    renderer.pixel_ratio = 1;
    renderer.resize(65, 49);
    renderer.temporal_jitter_enabled = false;
    renderer.bloom_enabled = false;
    renderer.setAmbientOcclusionSettings({ enabled: false });
    camera.aspect = renderer.aspect_ratio;
    camera.near = 0.1;
    camera.far = 100;
    camera.transform.position.set(2, 2, 5);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(), createGeometryCookRecipe());
    await renderer.uploadScene(scene, [{ geometry, asset: cooked.asset }]);
    instrument();
    await tick();
    check(renderer._reflections === null, "off owner absent");
    renderer.setScreenSpaceReflectionsSettings({ enabled: true });
    await tick();
    const records = await receiver();
    let base = 0,
      coat = 0,
      unlit = 0,
      background = 0;
    for (let p = 0; p < 65 * 49; p++) {
      const flags = records[p * 16 + 15];
      if (flags & 2) base++;
      if (flags & 4) coat++;
      if (flags === 1) unlit++;
      if (flags === 0) background++;
      check(records.slice(p * 16, p * 16 + 16).every(Number.isFinite), "finite record");
      if (!flags)
        check(
          records.slice(p * 16, p * 16 + 16).every((v) => v === 0),
          "background clear"
        );
      if (flags === 1)
        check(
          records.slice(p * 16 + 8, p * 16 + 15).every((v) => v === 0),
          "unlit zero response"
        );
    }
    check(
      records.some((v, i) => i % 16 < 3 && Math.abs(v - records[i + 4]) > 0.05),
      "independent coat normal survives"
    );
    check(
      base > 0 && coat > 0 && unlit > 0 && background > 0,
      `mixed receiver domain ${base}/${coat}/${unlit}/${background}`
    );
    check(renderer._lastFrameGraph.program.stages.includes("sssr"), "production SSSR topology");
    results.push({
      name: "mixed-native-base-coat-unlit",
      base,
      coat,
      unlit,
      background,
      energy: await inspectEnergy()
    });
    const previewH = await read("H"),
      previewFinal = await read("corrected");
    const preview = new OffscreenCanvas(130, 49),
      paint = preview.getContext("2d"),
      pixels = paint.createImageData(130, 49);
    for (let y = 0; y < 49; y++)
      for (let x = 0; x < 130; x++) {
        const source = x < 65 ? previewH : previewFinal,
          at = (y * 65 + (x % 65)) * 4,
          out = (y * 130 + x) * 4;
        for (let c = 0; c < 3; c++) {
          const linear = Math.max(0, source[at + c]),
            mapped = linear / (1 + linear);
          pixels.data[out + c] = Math.round(255 * mapped ** (1 / 2.2));
        }
        pixels.data[out + 3] = 255;
      }
    paint.putImageData(pixels, 0, 0);
    const previewBytes = new Uint8Array(
      await (await preview.convertToBlob({ type: "image/png" })).arrayBuffer()
    );
    results.push({
      name: "HDR-preview-left-baseline-right-corrected",
      pngBase64: btoa(String.fromCharCode(...previewBytes)),
      note: "Working RGB tone mapped for diagnosis; not final display colorimetry."
    });
    const graph = renderer._lastFrameGraph.compiled,
      owner = renderer._reflections;
    await tick();
    check(lastHistory, "warm SSR history");
    check(colorReset === false, "warm color");
    renderer.setScreenSpaceReflectionsSettings({ strength: 0.5 });
    const phase = owner.phase;
    await tick();
    check(owner.phase === phase + 1 && lastHistory, "strength history phase");
    await inspectEnergy();
    check(
      colorReset === true && renderer._lastFrameGraph.compiled === graph,
      "strength late-bound/color only reset"
    );
    renderer.setScreenSpaceReflectionsSettings({
      quality: "high",
      maxRoughness: 0.7,
      thicknessMeters: 0.03,
      metersPerWorldUnit: 2,
      temporalStability: 0.6
    });
    await tick();
    check(
      renderer._lastFrameGraph.compiled === graph && !lastHistory,
      "numeric topology stable and history reset"
    );
    await tick();
    check(lastHistory, "numeric reset commits once");
    camera.transform.position.x += 0.05;
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    await tick();
    check(lastHistory, "ordinary motion retains SSR");
    const beforeMovement = await read("Qbase");
    bright.transform_local.position.x += 0.5;
    await tick();
    await inspectEnergy();
    const afterMovement = await read("Qbase");
    check(
      afterMovement.some((v, i) => i % 4 !== 3 && Math.abs(v - beforeMovement[i]) > 0.01),
      "moving bright target changes actual reflected radiance"
    );
    bright.transform_local.position.x = 20;
    for (let frame = 0; frame < 6; frame++) {
      await tick();
      await inspectEnergy();
    }
    const departed = await read("Qbase"),
      departedRecords = await receiver();
    let maxDeparted = 0;
    for (let p = 0; p < departed.length / 4; p++)
      if (departedRecords[p * 16 + 15] & 2)
        maxDeparted = Math.max(maxDeparted, ...to709(departed.slice(p * 4, p * 4 + 3)));
    // Only the constant environment remains in this receiver domain. Four half
    // ULPs cover physical storage and the working/algorithm color conversions.
    check(
      maxDeparted <= 0.4 + 4 * 2 ** -10 * 0.4 + 2e-6,
      "departed bright target cannot leave persistent reflection energy"
    );
    results.push({ name: "moving-target-and-six-frame-departure", maxDeparted709: maxDeparted });
    bright.transform_local.position.x = 0.5;
    await tick();
    const before = owner.phase;
    const committedKey = renderer._committedReflectionColorKey;
    renderer.setScreenSpaceReflectionsSettings({ strength: 0.625 });
    const nativeScene = renderer.graphics.render_world.runtime(scene).nativeMaterials,
      ready = nativeScene.canPrepareFrame;
    nativeScene.canPrepareFrame = () => false;
    const deferred = renderer.frame_count;
    try {
      renderer.render(camera, currentScene);
    } finally {
      nativeScene.canPrepareFrame = ready;
    }
    check(
      renderer.frame_count === deferred && renderer._committedReflectionColorKey === committedKey,
      "defer keeps desired changes pending"
    );
    abortAfter = true;
    try {
      renderer.render(camera, currentScene);
      throw new Error("abort not raised");
    } catch (e) {
      check(e.message.includes("SSSR after-encode abort"), e.message);
    }
    check(
      owner.phase === before && renderer._committedReflectionColorKey === committedKey,
      "abort no SSR publication"
    );
    await tick();
    check(colorReset === true && lastHistory, "retry commits color-only strength reset");
    renderer.setScreenSpaceReflectionsSettings({ maxRoughness: 0.18 });
    await tick();
    const onlyBase = await receiver();
    check(
      onlyBase.some((v, i) => i % 16 === 15 && v === 3),
      "base selected alone"
    );
    await inspectEnergy();
    renderer.setScreenSpaceReflectionsSettings({ maxRoughness: 0.7 });
    await tick();
    for (const mode of [
      RenderDebugView.ScreenSpaceReflectionHitMiss,
      RenderDebugView.ScreenSpaceReflectionResolve,
      RenderDebugView.ScreenSpaceReflectionTemporal,
      RenderDebugView.ScreenSpaceReflectionHistoryConfidence
    ]) {
      renderer.render_debug_view = mode;
      renderer.screenSpaceReflectionDebugLobe = 1;
      await tick();
      renderer.screenSpaceReflectionDebugLobe = 0;
      await tick();
      const debugValues = await read("debug");
      check(debugValues.every(Number.isFinite), "finite debug " + mode);
      if (
        mode === RenderDebugView.ScreenSpaceReflectionResolve ||
        mode === RenderDebugView.ScreenSpaceReflectionTemporal
      ) {
        const expected = await read(
          mode === RenderDebugView.ScreenSpaceReflectionResolve ? "prefilterBase" : "Qbase"
        );
        for (let p = 0; p < expected.length; p++)
          if (p % 4 !== 3) check(debugValues[p] === expected[p], "debug exact selected stage");
      } else {
        check(
          debugValues.every((v, i) => i % 4 === 3 || (v >= 0 && v <= 1)),
          "actual diagnostic [0,1]"
        );
      }
    }
    renderer.setScreenSpaceReflectionsSettings({ enabled: false });
    await tick();
    check(
      (await read("debug")).every((v, i) => v === (i % 4 === 3 ? 1 : 0)),
      "disabled SSR debug is inactive"
    );
    renderer.setScreenSpaceReflectionsSettings({ enabled: true });
    await tick();
    renderer.render_debug_view = RenderDebugView.None;
    renderer.resize(67, 51);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    await tick();
    renderer.fsr3_enabled = false;
    await tick();
    renderer.fsr3_enabled = true;
    renderer.setResolutionScale(0.75);
    await tick();
    renderer.setResolutionScale(1);
    await tick();
    let releaseRetirement;
    const retirementGate = new Promise((resolve) => {
      releaseRetirement = resolve;
    });
    const retireReflections = renderer.retireReflections.bind(renderer);
    renderer.retireReflections = (fence) => retireReflections(Promise.all([fence, retirementGate]));
    renderer.setScreenSpaceReflectionsSettings({ strength: 0 });
    await tick();
    check(renderer._reflections === null && !captured.reflections, "strength0 releases");
    renderer.setScreenSpaceReflectionsSettings({ strength: 1 });
    const beforeRetirement = renderer.frame_count;
    renderer.render(camera, currentScene);
    check(
      renderer.frame_count === beforeRetirement &&
        renderer._reflections === null &&
        renderer._lastFrameDeferral === "gpu-completion",
      "re-enable waits for prior owner retirement"
    );
    releaseRetirement();
    renderer.retireReflections = retireReflections;
    await tick();
    currentScene = new Scene();
    await tick();
    check(renderer._reflections === null, "empty releases");
    currentScene = scene;
    await tick();
    results.push({
      name: "settings-debug-abort-resize-native-fsr-empty",
      phase: renderer._reflections.phase
    });
    ground.is_unlit = true;
    await tick();
    check(
      renderer._reflections === null && !renderer._lastFrameGraph.program.stages.includes("sssr"),
      "all-unlit releases"
    );
    ground.is_unlit = false;
    await tick();
    // A single material forces the dense ordinary route, without a second fixture.
    const denseScene = new Scene();
    denseScene.lights.environment = scene.lights.environment;
    denseScene.add(Mesh.from(geometry, ground, [8, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 8, 0, 0, -0.7, 0, 1]));
    await renderer.uploadScene(denseScene, [{ geometry, asset: cooked.asset }]);
    currentScene = denseScene;
    await tick();
    check(captured.publication.bins.length === 1, "dense ordinary route");
    await inspectEnergy();
    currentScene = scene;
    await tick();
    // Same real Material/Geometry producers, now the normal Product path and MASK.
    ground.metallic_factor = 0;
    ground.transparency_mode = ShadeTransparencyMode.AlphaTested;
    const productScene = new Scene();
    productScene.lights.environment = scene.lights.environment;
    for (const mesh of scene.instances.instances) productScene.add(mesh.clone());
    const product = await cookSceneGeometryProductV1(productScene, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "sssr-production-oracle",
      producerVersion: "SSR2",
      maxDecodedProductBytes: 32 * 1024 * 1024
    });
    await renderer.uploadCookedSceneProduct(productScene, product);
    check(
      renderer.graphics.render_world.runtime(productScene).nativeMaterials.reflectionProfile === "sssr-base-coat",
      "Enabled SSSR must prepare the actual initial Product material output",
    );
    currentScene = productScene;
    await tick();
    check(captured.geometry.productHeap, "Product route consumes compact Pages");
    const entries = captured.publication.entries;
    let widest = 0;
    for (const entry of entries) {
      const descriptor = captured.publication.descriptor(entry.programIndex);
      widest = Math.max(
        widest,
        descriptor.groups.flat().filter((e) => e.buffer && e.buffer.type !== "uniform").length
      );
      check(
        descriptor.groups.flat().filter((e) => e.storageTexture).length === 4,
        "Surface four storage textures"
      );
      check(
        descriptor.groups[0].find((e) => e.binding === 15)?.buffer.type === "storage",
        "all routes share receiver profile"
      );
    }
    check(widest === 15, "merged Native publication leaves fifteen storage buffers without VT feedback");
    await inspectEnergy();
    check(captured.publication.rasterClasses.length > 0, "real MASK raster class");
    const maskedCount = (await receiver()).filter((v, i) => i % 16 === 15 && v & 2).length;
    ground.diffuse_color.a = 0;
    await tick();
    const clippedCount = (await receiver()).filter((v, i) => i % 16 === 15 && v & 2).length;
    check(maskedCount > 0 && clippedCount === 0, "MASK visibility controls receiver writes");
    ground.diffuse_color.a = 1;
    await tick();
    const denseProductScene = new Scene();
    denseProductScene.lights.environment = scene.lights.environment;
    denseProductScene.add(Mesh.from(geometry, ground, [8, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 8, 0, 0, -0.7, 0, 1]));
    const denseProduct = await cookSceneGeometryProductV1(denseProductScene, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "sssr-dense",
      producerVersion: "SSR2",
      maxDecodedProductBytes: 32 * 1024 * 1024
    });
    await renderer.uploadCookedSceneProduct(denseProductScene, denseProduct);
    currentScene = denseProductScene;
    await tick();
    check(captured.geometry.productHeap && captured.publication.bins.length === 1, "dense Product route");
    await inspectEnergy();
    currentScene = productScene;
    await tick();
    results.push({ name: "Product-MASK-profile", widest });
    observeEnabled = false;
    renderer.resize(1920, 1080);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    const start = performance.now();
    await tick();
    const costMs = performance.now() - start;
    const reflectionOwner = renderer._reflections;
    const observation = work.at(-1);
    await observation.staging.mapAsync(GPUMapMode.READ);
    const counters = Array.from(new Uint32Array(observation.staging.getMappedRange()));
    observation.staging.unmap();
    check(counters[0] <= 1920 * 1080 && counters[1] <= 240 * 135, "1080p full work capacity");
    check(observation.dispatches === 22, "two full lobe chains plus depth/noise/snapshot/composite");
    check(
      reflectionOwner.allocatedBytes < reflectionOwner.reservedBytes,
      "actual owner excludes borrowed receiver/output"
    );
    results.push({
      name: "1080p-real-resources",
      ownedBytes: reflectionOwner.allocatedBytes,
      reservedBytes: reflectionOwner.reservedBytes,
      receiverBytes: captured.reflections.receivers.size,
      coatRays: counters[0],
      coatTiles: counters[1],
      computePasses: observation.dispatches,
      transitionOwnerBytes: observation.allocated,
      transitionReservedBytes: observation.reserved,
      singleColdFrameCpuAndQueueMs: costMs,
      note: "Includes CPU preparation and queue wait; not GPU frame time or speedup."
    });
    renderer.resize(65, 49);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    await tick();
    for (const pair of observations.values()) pair.buffer.destroy();
    observations.clear();
    for (const item of work) item.staging.destroy();
    work.length = 0;
    const desired = renderer.screenSpaceReflectionsSettings;
    renderer.screenSpaceReflectionDebugLobe = 1;
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    check(
      JSON.stringify(renderer.screenSpaceReflectionsSettings) === JSON.stringify(desired) &&
        renderer.screenSpaceReflectionDebugLobe === 1,
      "recovery preserves desired settings"
    );
    renderer.temporal_jitter_enabled = false;
    renderer.bloom_enabled = false;
    instrument();
    await tick();
    results.push({ name: "controlled-device-loss-recovery", phase: renderer._reflections.phase });
    // Short wiring check against the real physical IBL/Sky/Aerial producers.
    renderer.destroy();
    renderer = new Renderer({
      autoExposure: false,
      fixedExposure: 1,
      enablePhysicalEnvironment: true,
      enableVsm: false,
      screenSpaceReflections: { enabled: true }
    });
    await renderer.initialize({ context });
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    renderer.pixel_ratio = 1;
    renderer.resize(65, 49);
    renderer.temporal_jitter_enabled = false;
    renderer.bloom_enabled = false;
    const physicalScene = new Scene();
    for (const mesh of scene.instances.instances) physicalScene.add(mesh.clone());
    await renderer.uploadScene(physicalScene, [{ geometry, asset: cooked.asset }]);
    currentScene = physicalScene;
    baselineCheck = false;
    observeEnabled = true;
    instrument();
    await tick();
    await inspectEnergy();
    check(
      renderer._lastFrameGraph.program.stages.includes("physical-sky") &&
        renderer._lastFrameGraph.program.stages.includes("aerial"),
      "physical chain follows correction"
    );
    results.push({ name: "physical-IBL-Sky-Aerial-wiring" });
    return { ok: true, results, errors };
  } finally {
    for (const item of work) item.staging.destroy();
    for (const pair of observations.values()) pair.buffer.destroy();
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    device.destroy();
  }
}
