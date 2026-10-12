import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { FRAME_GEOMETRY_ARENA_VERSION } from "../../.test-dist/gpu/GpuFrameGeometryArenaAbi.js";
import { FRAME_GEOMETRY_MESHLET_STRIDE } from "../../.test-dist/gpu/GpuWinnerInterpolationAbi.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";
import { geometryProductGpuBudgetEvidence } from "../../.test-dist/gpu/GeometryProductGpuBudget.js";
import {
  buildVirtualGeometrySceneSourceV1,
  mergeVirtualGeometryProductSceneSourcesV1,
} from "../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { VSM_FILTER_DATA_BYTES, VSM_FILTER_MODES } from "../../.test-dist/gpu/GpuVsmFilterAbi.js";
import { VSM_DEFAULT_SETTINGS } from "../../.test-dist/render/vsm/VsmSettings.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { DirectionalLight } from "../../.test-dist/light/DirectionalLight.js";
import { ShadeTexture, ShadeImage } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeTransparencyMode, ShadeDrawSide } from "../../.test-dist/material/enums.js";
import { fixtureTexture } from "./texture-fixture.mjs";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { RenderDebugView } from "../../.test-dist/debug/RenderDebugView.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_OFFSETS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { createPackedSceneSourceFromScene } from "../../.test-dist/gpu/GpuSceneAdapter.js";
import { cookSceneGeometryProductV1 } from "../../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import { createDefaultWebGeometryCookerModule } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";

const check = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const convert = ([r, g, b]) => [
  0.627404 * r + 0.329282 * g + 0.0433136 * b,
  0.069097 * r + 0.91954 * g + 0.0113612 * b,
  0.0163916 * r + 0.0880132 * g + 0.895595 * b,
];

/** Real Renderer demand closure. The bounded case projects a 2048 capability
 * ceiling onto a real device: core WebGPU clamps requests below its default,
 * so this tests the bounded production graph, not adapter limit negotiation. */
export async function runFinalPixelFeatureDemandGpuOracle() {
  const { installDungeonGpuAudit } = await import("../../../validation/tools/dungeon-gpu-audit.mjs");
  installDungeonGpuAudit();
  const cases = [];
  for (const { physicalSun, authoredIbl } of [
    { physicalSun: false, authoredIbl: false },
    { physicalSun: false, authoredIbl: true },
    { physicalSun: true, authoredIbl: false },
  ]) {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
      featureLevel: "core",
    });
    check(adapter, "Feature demand oracle requires a hardware adapter");
    const features = [
      "core-features-and-limits",
      "indirect-first-instance",
      "texture-formats-tier1",
      "texture-compression-bc",
    ];
    for (const optional of ["primitive-index", "subgroups", "timestamp-query"]) {
      if (adapter.features.has(optional)) features.push(optional);
    }
    const actualDevice = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    });
    const errors = [];
    actualDevice.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const boundedLimits = new Proxy(actualDevice.limits, {
      get(target, key) {
        return key === "maxTextureDimension2D" ? 2048 : Reflect.get(target, key, target);
      },
    });
    const device = physicalSun
      ? new Proxy(actualDevice, {
          get(target, key) {
            if (key === "limits") return boundedLimits;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : actualDevice;
    const renderer = new Renderer({ autoExposure: false, fixedExposure: 1 });
    const actualContext = new OffscreenCanvas(192, 128).getContext("webgpu");
    // WebIDL requires the real device at the canvas boundary. All allocation
    // and encoding methods above likewise bind directly to the real device.
    const context = physicalSun
      ? new Proxy(actualContext, {
          get(target, key) {
            if (key === "configure")
              return (options) => target.configure({ ...options, device: actualDevice });
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : actualContext;
    let readback = null;
    let frame = null;
    try {
      await renderer.initialize({
        device,
        adapter,
        context,
        config: { enablePhysicalEnvironment: physicalSun },
      });
      renderer.resize(192, 128);
      check(
        physicalSun ? renderer._vsm?.profile === "vsm-directional-bounded" : renderer._vsm === null,
        "VSM allocation did not follow Physical Sun/profile demand",
      );
      const scene = new Scene();
      if (authoredIbl) {
        const image = new ShadeImage();
        image.width = image.height = 7;
        image.depth = 1;
        image.data_type = "float32";
        image.color_space = 2;
        image.source = new Float32Array(7 * 7 * 4).fill(0.25).buffer;
        scene.lights.environment = ShadeTexture.from(image);
      }
      const geometry = new BoxGeometry();
      const material = new StandardShadeMaterial();
      scene.add(Mesh.from(geometry, material));
      const sun = new DirectionalLight();
      sun.intensity = 2;
      sun.forward = [0.3, -1, -0.4];
      scene.add(sun);
      const point = new PointLight();
      point.intensity = 2;
      point.distance = 15;
      point.position.set(0, 1, 3);
      scene.add(point);
      const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(), createGeometryCookRecipe());
      const adapted = createPackedSceneSourceFromScene(scene, [{ geometry, asset: cooked.asset }]);
      adapted.source.flags.fill(GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.ReceivesShadow);
      await renderer.uploadPackedScene(scene, adapted.source);
      const camera = new PerspectiveCamera();
      camera.aspect = 192 / 128;
      camera.transform.position.set(0, 0, 4);
      camera.transform.lookAt({ x: 0, y: 0, z: 0 });
      camera.update();
      const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
      renderer._surface.prepareFrameNow = (input, ...rest) => {
        frame = input;
        return prepare(input, ...rest);
      };
      const encode = renderer._surface.encode.bind(renderer._surface);
      renderer._surface.encode = (encoder) => {
        encode(encoder);
        if (readback) {
          encoder.copyTextureToBuffer(
            { texture: frame.output },
            { buffer: readback, bytesPerRow: 1536 },
            [192, 128],
          );
        }
      };
      const tick = async () => {
        const start = renderer.frame_count;
        const deadline = performance.now() + 60_000;
        while (renderer.frame_count === start && performance.now() < deadline) {
          renderer.render(camera, scene);
          await actualDevice.queue.onSubmittedWorkDone();
          if (renderer.frame_count === start) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        check(
          renderer.frame_count !== start,
          `Feature demand frame deferred: ${renderer._lastFrameDeferral}`,
        );
      };
      const domains = [];
      for (const scale of [1, 0.73, 1]) {
        renderer.setResolutionScale(scale);
        await tick();
        const program = renderer._lastFrameGraph.program;
        check(program.stages.includes("vsm") === physicalSun, "VSM stage has no Physical Sun consumer");
        check(program.products.includes("shadow-sampling") === physicalSun, "Shadow product demand mismatch");
        check(program.stages.includes(scale === 1 ? "native-temporal" : "fsr3"), "Temporal domain mismatch");
        domains.push({ scale, stages: program.stages });
      }
      // Pause/step belongs to the caller's render loop: no render call must
      // advance histories, and one resumed successful call advances once.
      const pausedCount = renderer.frame_count;
      const pausedSeed = renderer._temporalSeed.readIndex;
      const pausedColor = renderer._nativeTemporal.readIndex;
      await actualDevice.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 20));
      check(
        renderer.frame_count === pausedCount &&
          renderer._temporalSeed.readIndex === pausedSeed &&
          renderer._nativeTemporal.readIndex === pausedColor,
        "Paused caller advanced Temporal ownership",
      );
      await tick();
      check(
        renderer.frame_count === pausedCount + 1 &&
          renderer._temporalSeed.readIndex !== pausedSeed &&
          renderer._nativeTemporal.readIndex !== pausedColor,
        "Single-step did not publish exactly one Temporal frame",
      );
      readback = actualDevice.createBuffer({
        size: 1536 * 128,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      await tick();
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Uint16Array(readback.getMappedRange());
      let positive = 0;
      for (let i = 0; i < values.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
          const value = decodeFloat16(values[i + channel]);
          check(Number.isFinite(value), "Feature demand produced nonfinite HDR");
          if (value > 0) positive++;
        }
      }
      check(
        positive > 0,
        `Lights produced no radiance: physicalSun=${physicalSun}, authoredIbl=${authoredIbl}`,
      );
      readback.unmap();
      readback.destroy();
      readback = null;
      material.is_unlit = true;
      await tick();
      check(!renderer._lastFrameGraph.program.stages.includes("vsm"), "All-unlit retained VSM work");
      material.is_unlit = false;
      await tick();
      check(
        renderer._lastFrameGraph.program.stages.includes("vsm") === physicalSun,
        "Lit return lost VSM demand",
      );
      check(errors.length === 0, `Feature demand validation errors: ${errors}`);
      cases.push({
        physicalSun,
        authoredIbl,
        profile: renderer._vsm?.profile ?? "absent",
        domains,
        positive,
        callerPauseStep: true,
        errors,
      });
    } finally {
      readback?.destroy();
      renderer.destroy();
      await actualDevice.queue.onSubmittedWorkDone();
      actualDevice.destroy();
    }
  }
  const audit = window.dungeonGpuAudit.snapshot();
  check(
    audit.bytes === 0 && audit.unknownFormats.length === 0,
    `Feature demand leaked ${audit.bytes} API bytes`,
  );
  return {
    cases,
    releaseBytes: audit.bytes,
    scope: "Real no-Sun Renderer and capability-projected bounded Renderer; no adapter negotiation claim",
  };
}

export async function authoredTexture(semantic, texel, extent = 16) {
  const mips = Array.from({ length: Math.log2(extent) + 1 }, (_, level) => {
    const size = extent >> level;
    const payload = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        payload.set(texel(x, y, size), (y * size + x) * 4);
      }
    }
    return {
      level,
      logicalWidth: size,
      logicalHeight: size,
      physicalWidth: size,
      physicalHeight: size,
      payload,
    };
  });
  return fixtureTexture(semantic, mips, semantic === "base-color-srgb");
}

/** Real Renderer entry, with readback instrumentation after actual native shading.
 * No replacement output, correctness shortcut or isolated renderer is installed.
 * The renderer negotiates its own device because its complete capability profile
 * is larger than the component-oracle host's profile. Its errors are checked here.
 */
export async function runNativeSurfaceProductionGpuOracle(
  _device,
  productGeometry = false,
  authoredEnvironment = false,
) {
  const { installDungeonGpuAudit } = await import("../../../validation/tools/dungeon-gpu-audit.mjs");
  installDungeonGpuAudit();
  let renderer = new Renderer({ autoExposure: false, fixedExposure: 1 });
  const canvas = new OffscreenCanvas(384, 224);
  const context = canvas.getContext("webgpu");
  check(context !== null, "Production oracle needs a WebGPU canvas");
  await renderer.initialize({ context });
  renderer.resize(384, 224);
  let device = renderer.device;
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const scene = new Scene();
  if (authoredEnvironment) {
    const image = new ShadeImage();
    image.width = image.height = 7;
    image.depth = 1;
    image.data_type = "float32";
    image.color_space = 2;
    image.source = new Float32Array(7 * 7 * 4).fill(0.25).buffer;
    scene.lights.environment = ShadeTexture.from(image);
  }
  const geometry = new BoxGeometry(1.4, 1.4, 1.4);
  const cooked = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(1.4, 1.4, 1.4),
    createGeometryCookRecipe(),
  );
  const graph = new AppearanceGraphBuilder();
  graph.output("baseColor", graph.input("tint", 3, "dynamic", { low: 0, high: 1 }));
  graph.output("alpha", graph.constant(1));
  const definition = { schemaVersion: 1, graph: graph.build() };
  const materials = Array.from({ length: 5 }, () => new StandardShadeMaterial());
  materials.forEach((material, index) => {
    material.is_unlit = index < 4;
    material.diffuse_color.r = 0.2 + index * 0.08;
    material.diffuse_color.g = 0.3;
    material.diffuse_color.b = 0.1;
    if (index === 2 || index === 3) {
      material.appearance_definition = definition;
      material.appearance_inputs.set("tint", [0.1 + index * 0.1, 0.6, 0.2]);
    }
    if (index === 4) {
      material.clearcoat_factor = 0.4;
      material.roughness_factor = 0.4;
    }
  });
  materials[1].texture_albedo = await authoredTexture("base-color-srgb", () => [255, 255, 255, 102]);
  materials[1].transparency_mode = ShadeTransparencyMode.AlphaTested;
  materials[1].alpha_cutoff = 0.2;
  materials[4].texture_normal = await authoredTexture("normal-linear", (x, _y, size) => [
    x < size / 2 ? 144 : 112,
    128,
    253,
    255,
  ]);
  materials[4].texture_orm = await authoredTexture("orm-linear", (x, _y, size) => [
    255,
    x < size / 2 ? 153 : 204,
    51,
    255,
  ]);
  materials[4].metallic_factor = 0.6;
  materials[3].draw_side = ShadeDrawSide.Double;
  const meshes = materials.map((material, index) => {
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    matrix[12] = index < 4 ? -2.4 + index * 1.6 : 0;
    matrix[13] = index < 4 ? 0 : 1.6;
    if (index === 4) {
      // Prepared world attributes must match source reconstruction under a
      // mirrored nonuniform/sheared transform, including normal-map tangents.
      matrix[0] = -0.8;
      matrix[4] = 0.1;
      matrix[5] = 1.1;
      matrix[10] = 0.9;
    }
    return Mesh.from(geometry, material, matrix);
  });
  scene.add(meshes);
  for (let index = 0; index < 8; index++) {
    const light = new PointLight();
    light.intensity = 2;
    light.distance = 15;
    light.position.set((index % 4) - 1.5, 2, 4);
    scene.add(light);
  }
  const sun = new DirectionalLight();
  sun.intensity = 2;
  sun.forward = [0.3, -1, -0.4];
  scene.add(sun);
  const camera = new PerspectiveCamera();
  camera.aspect = 384 / 224;
  camera.fov_degrees = 60;
  camera.transform.position.set(0, 0.5, 7);
  camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  camera.update();
  const buffers = [];
  let capture = null;
  let fail = false;
  let actualFrame = null;
  let forcePreparationMiss = false;
  let hdrSnapshot = null;
  const occlusionCases = [];
  let arenaOwnerPeakBytes = 0;
  const WorkerClass = globalThis.Worker;
  let textureWorkerCount = 0;
  globalThis.Worker = class extends WorkerClass {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes("pc-texture-worker")) textureWorkerCount++;
    }
  };
  const instrument = () => {
    const arenaOwner = renderer.graphics.frame_geometry_arena;
    const prepareArena = arenaOwner.prepare.bind(arenaOwner);
    arenaOwner.prepare = (...args) => {
      const prepared = prepareArena(...args);
      arenaOwnerPeakBytes = Math.max(arenaOwnerPeakBytes, arenaOwner.allocatedBytes);
      check(
        arenaOwner.allocatedBytes <= 256 * 1024 * 1024,
        "Arena replacement exceeded cumulative owner budget",
      );
      return prepared;
    };
    const visibility = renderer._visibilityFeature;
    const prepareVisibility = visibility.prepare.bind(visibility);
    visibility.prepare = (job, ...rest) =>
      prepareVisibility(
        forcePreparationMiss
          ? {
              ...job,
              frameGeometryBudget: { vertexCapacity: 1, triangleCapacity: 1, maxBytes: 16 * 1024 * 1024 },
            }
          : job,
        ...rest,
      );
    const surface = renderer._surface;
    const prepare = surface.prepareFrameNow.bind(surface);
    surface.prepareFrameNow = (frame, ...rest) => {
      actualFrame = frame;
      return prepare(frame, ...rest);
    };
    const encode = surface.encode.bind(surface);
    surface.encode = (encoder) => {
      encode(encoder);
      const frame = actualFrame;
      const pitch = Math.ceil((frame.width * 8) / 256) * 256;
      const keyPitch = Math.ceil((frame.width * 4) / 256) * 256;
      const make = (size) => {
        const buffer = device.createBuffer({
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        buffers.push(buffer);
        return buffer;
      };
      const hdr = make(pitch * frame.height),
        winner = make(keyPitch * frame.height),
        work = make(frame.geometry.meshletWork.size);
      encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: hdr, bytesPerRow: pitch }, [
        frame.width,
        frame.height,
      ]);
      encoder.copyTextureToBuffer({ texture: frame.visibility }, { buffer: winner, bytesPerRow: keyPitch }, [
        frame.width,
        frame.height,
      ]);
      encoder.copyBufferToBuffer(frame.geometry.meshletWork, 0, work, 0, work.size);
      const instances = make(frame.geometry.instances.size);
      const arena = make(frame.geometry.arena.size);
      encoder.copyBufferToBuffer(frame.geometry.instances, 0, instances, 0, instances.size);
      encoder.copyBufferToBuffer(frame.geometry.arena, 0, arena, 0, arena.size);
      capture = {
        hdr,
        winner,
        work,
        instances,
        arena,
        pitch,
        keyPitch,
        width: frame.width,
        height: frame.height,
      };
      if (fail) {
        throw new Error("injected native production abort");
      }
    };
  };
  instrument();
  const tick = async (renderScene = scene) => {
    const before = renderer.frame_count;
    // A code-class mutation may compile new PSOs. Bound wall time, not 200
    // readiness polls (~1s); the required submitted frame/outputs stay exact.
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      renderer.render(camera, renderScene);
      await device.queue.onSubmittedWorkDone();
      if (renderer.frame_count !== before) {
        check(capture !== null, "Production Surface did not encode");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const native = renderer.graphics.render_world.runtime(renderScene).nativeMaterials;
    throw new Error(
      `Native production readiness never completed: ${renderer._lastFrameDeferral}; ` +
        `candidateReady=${native.candidate?.ready}, surfaceReady=${renderer._surface.canPrepareFrame()}`,
    );
  };
  const inspectVsm = async () => {
    const resources = renderer._vsm;
    check(resources?.pageTable && resources?.casterRecords, "Production VSM is disabled");
    const pages = device.createBuffer({
      size: resources.pageTable.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const casters = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(pages, casters);
    const encoder = device.createCommandEncoder({ label: "oracle/production VSM readback" });
    encoder.copyBufferToBuffer(resources.pageTable, 0, pages, 0, pages.size);
    encoder.copyBufferToBuffer(resources.casterRecords, 0, casters, 0, 16);
    device.queue.submit([encoder.finish()]);
    await Promise.all([pages, casters].map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
    const words = new Uint32Array(pages.getMappedRange());
    let allocated = 0,
      contentValid = 0;
    for (let word = 0; word < words.length; word += 12) {
      if ((words[word + 3] & 1) !== 0) {
        allocated++;
      }
      if ((words[word + 3] & 8) !== 0) {
        contentValid++;
      }
    }
    const count = new Uint32Array(casters.getMappedRange()).slice();
    pages.unmap();
    casters.unmap();
    check(
      allocated > 0 && contentValid > 0 && count[1] > 0,
      `Production VSM must publish real pages/casters: ${allocated}/${contentValid}/${count}`,
    );
    return {
      allocatedPages: allocated,
      contentValidPages: contentValid,
      writtenCasters: count[1],
      overflow: count[2],
    };
  };
  const inspect = async (alphaVisible = true, requiredMaterials = [0, 1, 2, 3, 4]) => {
    check(errors.length === 0, `Production WebGPU errors: ${errors.join(" | ")}`);
    const current = capture;
    await Promise.all(
      [current.hdr, current.winner, current.work, current.instances, current.arena].map((buffer) =>
        buffer.mapAsync(GPUMapMode.READ),
      ),
    );
    const hdr = new Uint16Array(current.hdr.getMappedRange());
    const winner = new Uint32Array(current.winner.getMappedRange());
    const work = new Uint32Array(current.work.getMappedRange());
    const arenaWords = new Uint32Array(current.arena.getMappedRange());
    const runtime = renderer.graphics.render_world.runtime(scene);
    const sourceBySlot = new Map(
      runtime.nativeMaterials.materialSources.map((source) => [source.materialSlot, source.material]),
    );
    const counts = new Map();
    let maximumError = 0;
    for (let y = 0; y < current.height; y++) {
      for (let x = 0; x < current.width; x++) {
        const key = winner[(y * current.keyPitch) / 4 + x];
        if (key === 0xffffffff) {
          continue;
        }
        const slot = key & GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK;
        const materialSlot = work[8 + slot * 6 + 3];
        const material = sourceBySlot.get(materialSlot);
        check(material !== undefined, "Winner refers to unpublished native material");
        counts.set(material, (counts.get(material) ?? 0) + 1);
        const actual = [0, 1, 2].map((channel) =>
          decodeFloat16(hdr[(y * current.pitch) / 2 + x * 4 + channel]),
        );
        check(actual.every(Number.isFinite), "Native production HDR is not finite");
        if (!material.is_unlit) {
          check(
            actual.some((value) => value > 0),
            "Real lit winner has no radiance",
          );
          continue;
        }
        const tint = material.appearance_definition
          ? Array.from(material.appearance_inputs.get("tint"))
          : [material.diffuse_color.r, material.diffuse_color.g, material.diffuse_color.b];
        const expected = convert(tint);
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(actual[channel] - expected[channel]);
          maximumError = Math.max(maximumError, error);
          check(error < 0.002, `Native production color differs: ${actual[channel]} vs ${expected[channel]}`);
        }
      }
    }
    check(
      requiredMaterials.every((index) =>
        index === 1 && !alphaVisible
          ? (counts.get(materials[index]) ?? 0) === 0
          : (counts.get(materials[index]) ?? 0) > 20,
      ),
      `Every native program/material must have actual winners: ${materials.map((material) => counts.get(material) ?? 0)}; queue=${work.slice(0, 38)}; instance=${new Uint32Array(current.instances.getMappedRange()).slice(0, 80)}; arena=${arenaWords.slice(actualFrame.geometry.sourcePayload[3], actualFrame.geometry.sourcePayload[3] + 32)}`,
    );
    hdrSnapshot = hdr.slice();
    const header = actualFrame.geometry.sourcePayload[3] & 0x7fffffff;
    check(
      arenaWords[header] === FRAME_GEOMETRY_ARENA_VERSION,
      "Production consumed an obsolete frame geometry layout",
    );
    const directory = arenaWords[header + (actualFrame.geometry.sourcePayload[3] >>> 31 ? 5 : 4)];
    let cachedMeshlets = 0;
    for (let slot = 0; slot < arenaWords[directory]; slot++) {
      if (arenaWords[directory + 4 + (slot * FRAME_GEOMETRY_MESHLET_STRIDE) / 4 + 2] !== 0) cachedMeshlets++;
    }
    const arenaBytes = current.arena.size;
    const preparedVertices = arenaWords[directory + 2];
    const preparedTriangles = arenaWords[directory + 3];
    [current.hdr, current.winner, current.work, current.instances, current.arena].forEach((buffer) =>
      buffer.unmap(),
    );
    return {
      visiblePixels: [...counts.values()].reduce((a, b) => a + b, 0),
      maximumError,
      cachedMeshlets,
      arenaBytes,
      preparedVertices,
      preparedTriangles,
      arenaOwnerBytes: renderer.graphics.frame_geometry_arena.allocatedBytes,
      programs: new Set(runtime.nativeMaterials.publication.entries.map((entry) => entry.programIndex)).size,
      bins: runtime.nativeMaterials.publication.bins.length,
      bindingSets: new Set(runtime.nativeMaterials.publication.bins.map((bin) => bin.bindingSet)).size,
    };
  };
  try {
    if (productGeometry) {
      const product = await cookSceneGeometryProductV1(scene, {
        module: await createDefaultWebGeometryCookerModule(),
        producerId: "native-production-oracle",
        producerVersion: "S2",
        maxDecodedProductBytes: 32 * 1024 * 1024,
      });
      for (const instance of product.canonicalization.instances) {
        instance.flags = GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.ReceivesShadow;
      }
      if (productGeometry === "multi") {
        const runtime = new GeometryProductMultiRuntimeV1(device);
        const original = (await product.provider.revisions()[Symbol.asyncIterator]().next()).value;
        let leases = 2;
        const parts = [];
        const shards = [];
        for (let shardIndex = 0; shardIndex < 2; shardIndex++) {
          // Two slot/generations of exactly the same revision are intentional.
          const source = {
            descriptor: original.descriptor,
            readPage: (pageId, signal) => original.readPage(pageId, signal),
            release() {
              if (--leases === 0) original.release();
            },
          };
          const shard = await runtime.load(source);
          shards.push(shard);
          const instances = product.canonicalization.instances.filter(
            (_instance, index) => index % 2 === shardIndex,
          );
          const mapped = buildVirtualGeometrySceneSourceV1(
            source.descriptor,
            product.canonicalization.profiles,
            instances,
            product.canonicalization.materials,
          );
          parts.push({
            source: { ...mapped.source, meshes: meshes.filter((_mesh, index) => index % 2 === shardIndex) },
            productTableSlot: shard.productTableSlot,
            productGeneration: shard.productGeneration,
            assetReferenceBegin: shard.assetReferenceBegin,
          });
        }
        const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
        const streaming = new GeometryPageStreamingRuntimeV1(device, shards[0].residency);
        for (const shard of shards)
          streaming.registerProduct(shard.residency.sourceForStreaming(), shard.residency);
        await renderer.uploadVirtualGeometryScene(
          scene,
          combined,
          shards[0].residency,
          streaming,
          undefined,
          {
            bindings: runtime.bindings(),
            assetCount: combined.assetCount,
            registerStreaming: false,
            multiRuntime: runtime,
          },
        );
      } else {
        await renderer.uploadCookedSceneProduct(scene, product);
      }
    } else {
      const adapted = createPackedSceneSourceFromScene(scene, [{ geometry, asset: cooked.asset }]);
      adapted.source.flags.fill(GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.ReceivesShadow);
      await renderer.uploadPackedScene(scene, adapted.source);
    }
    await tick();
    const first = await inspect();
    const vsm = await inspectVsm();
    materials[4].is_unlit = true;
    await tick();
    const unlitPublication = renderer.graphics.render_world.runtime(scene).nativeMaterials;
    check(!unlitPublication.hasLit, "Native all-unlit publication retained lighting demand");
    check(
      !renderer._lastFrameGraph.program.products.includes("local-light-work"),
      "All-unlit frame generated local-light work from stale Scene classification",
    );
    check(
      renderer._localLightWork.allocatedBytes === 0 && renderer._finalPixelLighting.allocatedBytes === 0,
      "All-unlit replacement retained unused lighting frame pools",
    );
    await inspect();
    materials[4].is_unlit = false;
    materials[0].diffuse_color.r = 0.7;
    materials[2].appearance_inputs.set("tint", [0.8, 0.2, 0.1]);
    const publication = renderer.graphics.render_world.runtime(scene).nativeMaterials.active;
    fail = true;
    let aborted = false;
    for (let attempt = 0; attempt < 200 && !aborted; attempt++) {
      try {
        renderer.render(camera, scene);
      } catch (error) {
        check(
          error.message ===
            "RenderPass 'SurfaceV4/native opaque' failed to execute: Error: injected native production abort",
          `Unexpected abort: ${error.message}`,
        );
        aborted = true;
      }
      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(aborted, "Required production abort was not exercised");
    check(
      renderer.graphics.render_world.runtime(scene).nativeMaterials.active === publication,
      "Aborted frame published native candidate",
    );
    fail = false;
    await tick();
    const retry = await inspect();
    check(
      renderer.graphics.render_world.runtime(scene).nativeMaterials.hasLit &&
        renderer._lastFrameGraph.program.products.includes("local-light-work"),
      "Lit retry failed to restore native lighting work",
    );
    await tick();
    const stable = await inspect();
    check(stable.cachedMeshlets > 0, "Lean prepared geometry must be consumed");
    // Compare the same raster sample positions. Other lifecycle/Temporal cases
    // retain normal production jitter; changing jitter cannot test hit/miss math.
    renderer.temporal_jitter_enabled = false;
    await tick();
    const preparedFixed = await inspect();
    const preparedHdr = hdrSnapshot;
    forcePreparationMiss = true;
    await tick();
    const residentMiss = await inspect();
    check(residentMiss.cachedMeshlets === 0, "Capacity miss failed to exercise resident reconstruction");
    check(
      residentMiss.visiblePixels === preparedFixed.visiblePixels,
      `Prepared miss changed winner coverage: ${preparedFixed.visiblePixels} -> ${residentMiss.visiblePixels}`,
    );
    let preparedMissMaximumError = 0;
    for (let i = 0; i < preparedHdr.length; i++) {
      const delta = Math.abs(decodeFloat16(preparedHdr[i]) - decodeFloat16(hdrSnapshot[i]));
      preparedMissMaximumError = Math.max(preparedMissMaximumError, delta);
    }
    check(preparedMissMaximumError <= 0.002, `Prepared/resident HDR diverged: ${preparedMissMaximumError}`);
    forcePreparationMiss = false;
    await tick();
    const preparedRestored = await inspect();
    check(preparedRestored.cachedMeshlets > 0, "Restored preparation remained stale");
    if (productGeometry) {
      // A deliberately stale prediction must recover every candidate from an
      // empty current depth. This exercises the actual production owner and
      // raster namespace, rather than accepting a vacuous no-occlusion fixture.
      const prediction = device.createTexture({
        size: [1, 1],
        format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: prediction }, new Float32Array([1]), {}, [1, 1]);
      const owner = renderer.graphics.current_hzb_recheck;
      const originalTransform = Float32Array.from(meshes[0].transform_global.matrix);
      const predict = owner.predict.bind(owner);
      const forcedView = prediction.createView();
      owner.predict = (encoder, prepared, _view, previousClip) => {
        check(previousClip !== null, "Settled prediction has no previous camera");
        predict(encoder, prepared, forcedView, previousClip);
      };
      try {
        for (const offset of [0, 0.025, 0.4, -0.35]) {
          const expected = hdrSnapshot;
          // Keep this pose's independent full-work reference for the forced
          // prediction frame. Jitter and radiometry are fixed in this fixture.
          if (offset !== 0) {
            owner.predict = predict;
            if (offset === -0.35) {
              const movedTransform = originalTransform.slice();
              movedTransform[12] += 0.1;
              movedTransform[14] += 0.15;
              renderer.queuePackedScenePatch(scene, {
                frameId: renderer.frame_count,
                transforms: { indices: new Uint32Array([0]), transforms: movedTransform },
              });
            }
            camera.transform.position.set(offset, 0.5, 7);
            camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
            await tick();
            await inspect();
            owner.predict = (encoder, prepared, _view, previousClip) =>
              predict(encoder, prepared, forcedView, previousClip);
          }
          const reference = offset === 0 ? expected : hdrSnapshot;
          await tick();
          const recoveredFrame = await inspect();
          let maximumError = 0;
          for (let i = 0; i < reference.length; i++)
            maximumError = Math.max(
              maximumError,
              Math.abs(decodeFloat16(reference[i]) - decodeFloat16(hdrSnapshot[i])),
            );
          check(maximumError <= 0.002, `Recovered winner HDR diverged: ${maximumError}`);
          const runtime = renderer.graphics.render_world.runtime(scene);
          const prepared = renderer._visibilityFeature.implementation.currentHzbPrepared.get(runtime);
          check(
            prepared?.queue === actualFrame.geometry.meshletWork,
            "Recovery replaced the source namespace",
          );
          const readback = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          buffers.push(readback);
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(prepared.deferred, 0, readback, 0, 32);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const counts = [...new Uint32Array(readback.getMappedRange()).slice(0, 4)];
          readback.unmap();
          check(
            counts[0] > 0 && counts[1] === 0 && counts[2] === counts[0] && counts[3] === 0,
            `Forced disocclusion did not recover all slots: ${counts}`,
          );
          occlusionCases.push({
            cameraOffset: offset,
            dynamicInstance: offset === -0.35,
            counts,
            maximumError,
            visiblePixels: recoveredFrame.visiblePixels,
          });
        }
      } finally {
        owner.predict = predict;
        prediction.destroy();
        camera.transform.position.set(0, 0.5, 7);
        camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
        renderer.queuePackedScenePatch(scene, {
          frameId: renderer.frame_count,
          transforms: { indices: new Uint32Array([0]), transforms: originalTransform },
        });
      }
      await tick();
      await inspect();
      // Exercise the direct public GPU Scene patch seam, outside render-world's
      // queued patch accounting. VSM must observe its committed publication.
      const runtime = renderer.graphics.render_world.runtime(scene);
      const generation = renderer._vsmGeneration.currentGeneration;
      const snapshot = renderer._vsmDepthBounds.snapshots;
      const directOriginal = Float32Array.from(meshes[0].transform_global.matrix);
      const moved = directOriginal.slice();
      moved[12] += 0.02;
      const patch = ShadeGPUCommandContext.create(renderer.graphics, "GraphicsContext/one-shot-maintenance");
      renderer.patchInstances(
        runtime.instanceHandle,
        {
          frameId: renderer.frame_count,
          transforms: { indices: new Uint32Array([0]), transforms: moved },
        },
        patch,
      );
      patch.finish();
      await patch.gpuDone;
      await tick();
      await inspect();
      check(
        renderer._vsmGeneration.currentGeneration === generation,
        "direct patch must retain projection epoch",
      );
      const copy = device.createBuffer({
        size: snapshot.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(copy);
      const read = device.createCommandEncoder();
      read.copyBufferToBuffer(snapshot, 0, copy, 0, copy.size);
      device.queue.submit([read.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const translationWord = (GPU_INSTANCE_RECORD_OFFSETS.current_affine + 12) / 4;
      check(
        new Float32Array(copy.getMappedRange())[translationWord] === moved[12],
        "direct patch did not update VSM caster snapshot",
      );
      copy.unmap();
      const restore = ShadeGPUCommandContext.create(
        renderer.graphics,
        "GraphicsContext/one-shot-maintenance",
      );
      renderer.patchInstances(
        runtime.instanceHandle,
        {
          frameId: renderer.frame_count,
          transforms: { indices: new Uint32Array([0]), transforms: directOriginal },
        },
        restore,
      );
      restore.finish();
      await restore.gpuDone;
      await tick();
      await inspect();
    }
    const originalNear = camera.near;
    camera.near = 6.4;
    camera.update();
    await tick();
    // Front-only faces can be wholly clipped in this camera. Require exposed
    // side faces, the two-sided instance and the mirrored PBR/normal-map instance;
    // every ordinary lifecycle frame above/below still requires all programs.
    const nearClipPrepared = await inspect(true, [0, 3, 4]);
    const nearClipHdr = hdrSnapshot;
    check(
      nearClipPrepared.visiblePixels > 100 && nearClipPrepared.visiblePixels < preparedFixed.visiblePixels,
      "Near-plane fixture did not clip real source triangles",
    );
    forcePreparationMiss = true;
    await tick();
    const nearClipResident = await inspect(true, [0, 3, 4]);
    check(
      nearClipResident.cachedMeshlets === 0 &&
        nearClipResident.visiblePixels === nearClipPrepared.visiblePixels,
      "Near-plane prepared/resident coverage diverged",
    );
    let nearClipMaximumError = 0;
    for (let i = 0; i < nearClipHdr.length; i++) {
      nearClipMaximumError = Math.max(
        nearClipMaximumError,
        Math.abs(decodeFloat16(nearClipHdr[i]) - decodeFloat16(hdrSnapshot[i])),
      );
    }
    check(nearClipMaximumError <= 0.002, `Near-plane HDR/LOD diverged: ${nearClipMaximumError}`);
    forcePreparationMiss = false;
    camera.near = originalNear;
    camera.update();
    renderer.temporal_jitter_enabled = true;
    check(first.bindingSets > 1, "Production must exercise multiple complete physical BindingSets");
    materials[1].alpha_cutoff = 0.5;
    await tick();
    const alphaRejected = await inspect(false);
    materials[1].alpha_cutoff = 0.2;
    await tick();
    const alphaRestored = await inspect();
    renderer.resize(512, 256);
    camera.aspect = 2;
    await tick();
    const resized = await inspect();
    camera.transform.position.set(0.25, 0.5, 7);
    camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
    await tick();
    const moved = await inspect();
    renderer.invalidateTemporalHistory();
    check(
      !renderer._temporal.histories.state("identity").readValid,
      "Explicit camera cut kept identity history valid",
    );
    await tick();
    check(!renderer._temporalSeed.inputHistoryValid, "Camera-cut frame consumed stale native identity");
    const cameraCut = await inspect();
    await tick();
    check(renderer._temporalSeed.inputHistoryValid, "Settled retry did not restore native Temporal identity");
    check(renderer._temporalPolicy === "native", "Actual 1:1 Renderer missed Native Temporal");
    const nativePolicyGeneration = renderer._nativeTemporal.generation;
    renderer.setResolutionScale(0.75);
    await tick();
    check(renderer._fsr3.policy === "upscale", "Actual upscale frame used the native-only filter");
    check(renderer._nativeTemporal.active === null, "Upscale retained active Native histories");
    const upscalePolicyGeneration = renderer._fsr3.generation;
    const upscaled = await inspect();
    renderer.setResolutionScale(1);
    await tick();
    check(renderer._temporalPolicy === "native", "Native policy was not restored after upscale");
    check(
      renderer._nativeTemporal.generation > nativePolicyGeneration && renderer._fsr3.policy === null,
      "Native return reused inactive upscale histories",
    );
    const nativeGraph = renderer._lastFrameGraph.compiled.dump();
    check(
      nativeGraph.passes.some((p) => p.name === "Native Temporal V2/Analyze"),
      "Native graph lacks Analyze",
    );
    check(
      nativeGraph.passes.some((p) => p.name === "Native Temporal V2/Shading Pyramid"),
      "Native graph lacks its shading producer",
    );
    check(
      nativeGraph.passes.some((p) => p.name === "Native Temporal V2/Shading Change" && !p.culled),
      "Native graph lacks its half-domain shading-change producer",
    );
    check(
      !nativeGraph.passes.some((p) =>
        /FSR3\/(Prepare Inputs|Clear reconstructed|Luma Pyramid|Shading Change)|Temporal\/Seed classification|Native Temporal\/(Resolve|Depth Classification)/.test(
          p.name,
        ),
      ),
      "Retired native work remains in production",
    );
    renderer.fsr3_enabled = false;
    await tick();
    check(
      renderer._temporalPolicy === "bypass" && !renderer._temporal.histories.state("color").valid,
      "Bypass published phantom color history",
    );
    check(
      renderer._nativeTemporal.active === null && renderer._fsr3.policy === null,
      "Bypass retained active color domains",
    );
    check(
      !renderer._lastFrameGraph.compiled.dump().passes.some((p) => p.name === "Temporal/Seed classification"),
      "Bypass generated an unused classifier",
    );
    renderer.render_debug_view = RenderDebugView.Reactive;
    await tick();
    check(
      renderer._lastFrameGraph.compiled.dump().passes.some((p) => p.name === "Temporal/Seed classification"),
      "Bypass debug lost its demanded classification",
    );
    renderer.render_debug_view = RenderDebugView.None;
    renderer.fsr3_enabled = true;
    await tick();
    check(
      renderer._temporalPolicy === "native" &&
        renderer._nativeTemporal.readIndex === renderer._temporalSeed.readIndex,
      "AA return misaligned Seed/color roles",
    );
    const nativeRestored = await inspect();
    renderer.render_debug_view = RenderDebugView.Velocity;
    await tick();
    check(
      renderer._lastFrameGraph.compiled.dump().passes.some((p) => p.name === "Temporal/Seed classification"),
      "Native debug lost its demanded classification",
    );
    renderer.render_debug_view = RenderDebugView.None;
    const sceneRuntimeBeforeEmpty = renderer._historyRuntime;
    const nativeBeforeEmpty = renderer._nativeTemporal.active;
    const roleBeforeEmpty = renderer._nativeTemporal.readIndex;
    const submitBeforeEmpty = renderer._frameCoordinator.submitFrame;
    renderer._frameCoordinator.submitFrame = () => {
      throw new Error("injected empty replacement abort");
    };
    try {
      let rejected = false;
      try {
        renderer.render(camera, new Scene());
      } catch (error) {
        check(
          error.message.includes("injected empty replacement abort"),
          `Unexpected empty abort: ${error.message}`,
        );
        rejected = true;
      }
      check(rejected, "Empty replacement abort was not exercised");
    } finally {
      renderer._frameCoordinator.submitFrame = submitBeforeEmpty;
    }
    check(
      renderer._historyRuntime === sceneRuntimeBeforeEmpty &&
        renderer._nativeTemporal.active === nativeBeforeEmpty &&
        renderer._nativeTemporal.readIndex === roleBeforeEmpty,
      "Failed empty replacement retired the committed scene",
    );
    await tick(new Scene());
    check(
      renderer._temporalPolicy === null &&
        renderer._nativeTemporal.active === null &&
        renderer._fsr3.policy === null,
      "Empty scene retained active Temporal color domains",
    );
    check(
      renderer._temporalSeed.allocatedBytes === 0 &&
        renderer._surface.state === null &&
        renderer._localLightWork.allocatedBytes === 0 &&
        renderer._finalPixelLighting.allocatedBytes === 0,
      "Empty replacement retained scene-dependent Final Pixel products",
    );
    await tick();
    check(!renderer._temporalSeed.inputHistoryValid, "Scene return reused pre-empty identity history");
    await tick();
    const restoredSeedIndex = renderer._temporalSeed.readIndex;
    const restoredSeedBytes = renderer._temporalSeed.allocatedBytes;
    const restoredReadIndex = renderer._nativeTemporal.readIndex;
    const restoredGeneration = renderer._nativeTemporal.generation;
    fail = true;
    let temporalAborted = false;
    try {
      renderer.render(camera, scene);
    } catch (error) {
      check(
        error.message.includes("injected native production abort"),
        `Unexpected native abort: ${error.message}`,
      );
      temporalAborted = true;
    }
    fail = false;
    check(temporalAborted, "Native temporal abort was not exercised");
    check(
      renderer._nativeTemporal.readIndex === restoredReadIndex &&
        renderer._nativeTemporal.generation === restoredGeneration,
      "Aborted native frame advanced physical history",
    );
    check(
      renderer._temporalSeed.readIndex === restoredSeedIndex &&
        renderer._temporalSeed.allocatedBytes === restoredSeedBytes,
      "Aborted Native Seed advanced identity or changed its physical allocation",
    );
    await tick();
    await Promise.resolve();
    renderer.frameAdmissionProfile = "throughput";
    const burstBegin = renderer.frame_count;
    for (let i = 0; i < 3; i++) {
      renderer.render(camera, scene);
      check(renderer.frame_count === burstBegin + i + 1, "Three-frame production burst deferred prematurely");
    }
    const burstAdmission = renderer.frameSubmissionEvidence();
    check(burstAdmission.inFlight === 3, "Production burst did not retain all three bounded slots");
    const deferredSeedIndex = renderer._temporalSeed.readIndex;
    const deferredTemporalIndex = renderer._nativeTemporal.readIndex;
    const deferredTemporalJitter = renderer._nativeTemporal.jitterEvidence();
    renderer.render(camera, scene);
    check(renderer.frame_count === burstBegin + 3, "Fourth production frame bypassed bounded admission");
    check(
      renderer._nativeTemporal.readIndex === deferredTemporalIndex &&
        JSON.stringify(renderer._nativeTemporal.jitterEvidence()) === JSON.stringify(deferredTemporalJitter),
      "Admission-deferred frame advanced native history/jitter",
    );
    check(renderer._temporalSeed.readIndex === deferredSeedIndex, "Admission defer advanced Seed roles");
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    await Promise.resolve();
    check(
      renderer.frameSubmissionEvidence().inFlight === 0,
      "Production frame fences did not release admission",
    );
    const burst = await inspect();
    renderer.frameAdmissionProfile = "latency";
    const featureCombinations = [];
    for (const [shadow, ao, bloom, scale] of [
      [false, false, false, 1],
      [true, true, true, 1],
      [false, true, false, 0.73],
      [true, false, true, 0.73],
    ]) {
      renderer.shadowVisibilityEnabled = shadow;
      renderer.xe_gtao_enabled = ao;
      renderer.bloom_enabled = bloom;
      renderer.setResolutionScale(scale);
      await tick();
      const dump = renderer._lastFrameGraph.compiled.dump();
      const stages = renderer._lastFrameGraph.program.stages;
      check(stages.includes("vsm") === shadow, "Feature graph ignored VSM demand");
      check(stages.includes("xe-gtao") === ao, "Feature graph ignored AO demand");
      check(dump.passes.some((p) => /Bloom\//.test(p.name)) === bloom, "Feature graph ignored Bloom demand");
      check(
        renderer._temporalPolicy === (scale === 1 ? "native" : "upscale"),
        "Noninteger domain used wrong Temporal owner",
      );
      check(
        renderer._temporalSeed.readIndex ===
          (scale === 1 ? renderer._nativeTemporal.readIndex : renderer._fsr3.readIndex),
        "Feature combination published divergent Temporal roles",
      );
      featureCombinations.push({ shadow, ao, bloom, scale, passes: dump.passes.map((p) => p.name) });
    }
    renderer.shadowVisibilityEnabled = true;
    renderer.xe_gtao_enabled = true;
    renderer.bloom_enabled = true;
    renderer.setResolutionScale(1);
    for (const debugView of [RenderDebugView.HistoryValidity, RenderDebugView.MaterialId]) {
      renderer.render_debug_view = debugView;
      await tick();
      check(
        renderer._lastFrameGraph.program.stages.includes("temporal-classification") ===
          (debugView === RenderDebugView.HistoryValidity),
        "Identity debug added an unused classifier or lost validity",
      );
    }
    renderer.render_debug_view = RenderDebugView.None;
    for (const debugView of ["visibility", "clip-level", "page-state", "none"]) {
      renderer.setVsmSettings({ debugView });
      await tick();
      check(
        !renderer._lastFrameGraph.compiled.dump().passes.some((p) => /Shadow Resolve/.test(p.name)),
        "Shadow debug restored standalone receiver reconstruction",
      );
    }
    const filterTransitions = [];
    const filterReadback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(filterReadback);
    for (const [filterMode, temporal, radius] of [
      ["disk4", true, 1.5],
      ["gather2x2", true, 1.5],
      ["point", true, 1.5],
      ["disk4", true, 0],
      ["disk4", false, 1.5],
      ["disk4", true, 1.5],
    ]) {
      renderer.setVsmSettings({ ...VSM_DEFAULT_SETTINGS, filterMode, filterRadiusTexels: radius });
      renderer.fsr3_enabled = temporal;
      await tick();
      const encoder = device.createCommandEncoder({ label: "oracle/VSM filter publication" });
      encoder.copyBufferToBuffer(renderer._vsm.pageConstants, 0, filterReadback, 0, 256);
      device.queue.submit([encoder.finish()]);
      await filterReadback.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(filterReadback.getMappedRange()),
        floats = new Float32Array(words.buffer);
      const effectiveMode = filterMode === "disk4" && radius === 0 ? "point" : filterMode;
      check(words[46] === VSM_FILTER_MODES[effectiveMode], "Cached graph retained the old VSM filter mode");
      check(
        floats[48] === 1 && floats[49] === 1 && floats[51] === radius,
        "Actual filter publication lost default bias/radius",
      );
      check(
        words[47] === (temporal ? (renderer.frame_count - 1) % 64 : 0),
        "VSM noise phase did not follow submitted frame/AA-off policy",
      );
      const directory = actualFrame.lightingEntries.find((entry) => entry.binding === 2).resource.buffer;
      const allocation = renderer._finalPixelLighting.allocations.find((value) => value.buffer === directory);
      check(allocation, "Actual Native did not consume the current lighting container");
      check(
        allocation.plan.filterNoiseBytes === (effectiveMode === "disk4" ? VSM_FILTER_DATA_BYTES : 0),
        "Noiseless kernel allocated an unused STBN segment",
      );
      if (effectiveMode === "disk4") {
        check(
          words[59] * 4 === allocation.plan.filterNoiseOffset,
          "Noise base disagrees with actual Native binding",
        );
      }
      filterTransitions.push({
        filterMode,
        effectiveMode,
        radius,
        temporal,
        phase: words[47],
        noiseBytes: allocation.plan.filterNoiseBytes,
      });
      filterReadback.unmap();
    }
    // Small diagnostic cost sample, not the large-scene acceptance matrix.
    renderer.profiler.setMode("record");
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 1,
      gpuTimingMode: "full",
      historyCapacity: 128,
    });
    const timingBegin = renderer.frame_count;
    for (let i = 0; i < 16; i++) await tick();
    for (let wait = 0; wait < 100; wait++) {
      const ready = renderer.profiler.history.filter(
        (p) =>
          p.frameIndex >= timingBegin && p.frameIndex < timingBegin + 16 && p.gpu.sampled && !p.gpu.pending,
      );
      if (ready.length === 16) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const timingProfiles = renderer.profiler.history.filter(
      (p) =>
        p.frameIndex >= timingBegin && p.frameIndex < timingBegin + 16 && p.gpu.sampled && !p.gpu.pending,
    );
    check(
      timingProfiles.length === 16 &&
        timingProfiles.every((p) => !p.counters["gpu.timing.truncated"] && p.submits.count === 1),
      "Missing complete single-submit diagnostic timestamps",
    );
    check(
      timingProfiles.every((profile) => profile.gpu.cost.surfaceEvaluationMs !== null),
      "Current production winner shading was not attributed to Surface evaluation",
    );
    check(
      timingProfiles.every((profile) => profile.graph.cacheHits === 1 && profile.graph.cacheMisses === 0),
      "Stable production FrameGraph was rebuilt after Lighting cutover",
    );
    const localEpochOwner = renderer._localLightWork;
    check(localEpochOwner.allocatedBytes > 0, "Production Lighting owner has no frame products");
    const passLabels = [
      ...new Set(
        timingProfiles.flatMap((p) => p.gpu.segments.filter((s) => s.scope === "pass").map((s) => s.label)),
      ),
    ];
    const diagnosticPassMs = Object.fromEntries(
      passLabels.map((label) => {
        const values = timingProfiles
          .map((p) =>
            p.gpu.segments
              .filter((s) => s.scope === "pass" && s.label === label)
              .reduce((sum, s) => sum + s.durationMs, 0),
          )
          .sort((a, b) => a - b);
        return [
          label,
          { samples: values.length, median: values[8], minimum: values[0], maximum: values[15] },
        ];
      }),
    );
    const dump = renderer.mainFrameGraphEvidence();
    check(
      JSON.stringify(dump).includes("SurfaceV4/native opaque"),
      "Production FrameProgram did not use SurfaceV4",
    );
    check(
      !JSON.stringify(dump).match(
        /SurfaceWork|closure cache|six.signal|reconstruct bank|LightCluster|light-cluster/i,
      ),
      "Retired Surface is in the production graph",
    );
    await device.queue.onSubmittedWorkDone();
    check(errors.length === 0, `Production WebGPU errors: ${errors.join(" | ")}`);
    const alternateScene = new Scene();
    alternateScene.add(
      meshes.map((mesh, index) =>
        Mesh.from(geometry, materials[index], Float32Array.from(mesh.transform_global.matrix)),
      ),
    );
    const alternateLight = new PointLight();
    alternateLight.position.set(0, 2, 4);
    alternateLight.distance = 15;
    alternateScene.add(alternateLight);
    const alternateSource = createPackedSceneSourceFromScene(alternateScene, [
      { geometry, asset: cooked.asset },
    ]);
    await renderer.uploadPackedScene(alternateScene, alternateSource.source);
    await tick(alternateScene);
    check(
      actualFrame.lightingEntries[0].resource.buffer ===
        renderer._environments.get(alternateScene).lights.buffer_data,
      "Scene switch retained the previous LightDatabase",
    );
    await tick();
    check(
      actualFrame.lightingEntries[0].resource.buffer === renderer._environments.get(scene).lights.buffer_data,
      "Scene switch back retained alternate Lighting",
    );
    await renderer.releaseScene(alternateScene);
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    check(localEpochOwner.allocatedBytes === 0, "Old epoch retained LocalLightWork allocations");
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    instrument();
    await tick();
    const recovered = await inspect();
    if (authoredEnvironment) {
      const owner = renderer._environments.get(scene).lights.authoredIbl;
      const entries = actualFrame.lightingEntries;
      for (const [binding, resource] of [
        [5, owner.views.diffuse],
        [6, owner.views.specular],
        [7, owner.views.dfg],
        [15, owner.sampler],
      ]) {
        check(
          entries.find((entry) => entry.binding === binding)?.resource === resource,
          `Actual Native binding ${binding} did not consume the recovered authored IBL publication`,
        );
      }
    }
    if (productGeometry === "multi") {
      const streaming = renderer.geometryStreamingEvidence(scene);
      check(streaming.products.length === 2, "Recovery dropped an active Product");
      check(
        new Set(streaming.products.map((product) => product.productGeneration)).size === 2,
        "Recovery aliased Product generations",
      );
    }
    check(renderer.geometryStreamingError() === null, "Production streaming error is observable");
    check(renderer.deviceEpoch === 2, "Production recovery did not advance the device epoch");
    const ledger = renderer.graphics.resource_accounting;
    const nativeOwners = [
      "SurfaceV4",
      "NativeExecutionBins",
      "NativeVisibilityPass",
      "NativeRasterWorkPartitions",
      "GpuNativeMaterialPublication",
      "LocalLightWork",
      "FinalPixelLighting",
    ];
    const temporalOwners = ["NativeTemporalSeed", "NativeTemporalV2", "Fsr3UpscalerRuntime"];
    const beforeDestroy = ledger.snapshot();
    check(
      nativeOwners.every((owner) => (beforeDestroy.owners[owner]?.buffer ?? 0) > 0),
      "Native resources are missing from physical accounting",
    );
    const memory = renderer.graphics.memoryEvidence();
    for (const [name, owner] of [
      ["NativeTemporalSeed", renderer._temporalSeed],
      ["NativeTemporalV2", renderer._nativeTemporal],
      ["Fsr3UpscalerRuntime", renderer._fsr3],
    ]) {
      const bytes = beforeDestroy.owners[name];
      check(
        (bytes?.texture ?? 0) + (bytes?.buffer ?? 0) === owner.allocatedBytes,
        `${name} omitted physical active/candidate/retiring allocations`,
      );
    }
    check(!renderer._vsmShadowResolve, "Retired standalone Shadow owner survived production cutover");
    check(!("continuation" in actualFrame.publication), "Retired Sun continuation publication survived");
    const finalLightingBytes = renderer._finalPixelLighting.allocatedBytes;
    check(
      finalLightingBytes > 0 && memory.owners.finalPixelLighting.allocatedBytes === finalLightingBytes,
      "Final lighting container missing from physical memory evidence",
    );
    check(
      actualFrame.lightingEntries.some((entry) => entry.binding === 9),
      "Production Native omitted final lighting range contract",
    );
    const scratchBytes = nativeOwners
      .slice(0, 4)
      .reduce(
        (total, owner) =>
          total + (beforeDestroy.owners[owner]?.buffer ?? 0) + (beforeDestroy.owners[owner]?.texture ?? 0),
        0,
      );
    check(
      memory.owners.nativeSurfaceScratch.allocatedBytes === scratchBytes,
      "Memory evidence omitted or double-counted native scratch",
    );
    if (productGeometry) {
      check(
        geometryProductGpuBudgetEvidence(device).totalBytes > 0,
        "Recovered Product allocations were not accounted",
      );
      await renderer.releaseScene(scene);
      const released = geometryProductGpuBudgetEvidence(device);
      check(
        released.totalBytes === 0 && released.allocations === 0 && released.metadataAllocations === 0,
        "Recovered Scene unload retained Product ownership before Renderer destruction",
      );
      await renderer.releaseScene(scene);
      const textures = renderer.graphics.texture_residency.evidence();
      check(
        textures.allocatedBytes === 0 &&
          textures.residentTextureCount === 0 &&
          textures.retiringTextureCount === 0,
        "Recovered Scene unload retained texture residency",
      );
    }
    check(textureWorkerCount === 0, "Cooked Renderer unexpectedly initialized a texture codec Worker");
    const textureEvidence = renderer.graphics.texture_residency.evidence();
    check(
      textureEvidence.resizeDispatchCount === 0 &&
        textureEvidence.runtimeMipGenerationCount === 0 &&
        textureEvidence.uncompressedFallbackCount === 0 &&
        textureEvidence.copyBytes === 0,
      "Cooked Renderer used a retired raw material route",
    );
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    await Promise.resolve();
    const afterDestroy = ledger.snapshot();
    check(
      [...nativeOwners, ...temporalOwners].every((owner) => afterDestroy.owners[owner] === undefined),
      "Native resource ledger leaked after fenced teardown",
    );
    for (const buffer of buffers) buffer.destroy();
    const audit = window.dungeonGpuAudit.snapshot();
    check(
      audit.unknownFormats.length === 0 && audit.bytes === 0,
      `Explicit GPU API allocations leaked after release: ${audit.bytes}; ${JSON.stringify(audit.resources.filter((r) => !r.destroyed && r.bytes > 0))}`,
    );
    return {
      verdict: "passed",
      first,
      retry,
      stable,
      preparedFixed,
      residentMiss,
      preparedRestored,
      nearClipPrepared,
      nearClipResident,
      nearClipMaximumError,
      preparedMissMaximumError,
      occlusionCases,
      arenaOwnerPeakBytes,
      diagnosticPassMs,
      alphaRejected,
      alphaRestored,
      resized,
      moved,
      cameraCut,
      temporalPolicyTransitions: { upscaled, nativeRestored, abortRestored: true, deferRetained: true },
      featureCombinations,
      filterTransitions,
      physicalMemory: {
        peakBytes: audit.peakBytes,
        ownersAtPeak: audit.ownersAtPeak,
        releaseBytes: audit.bytes,
        scope: audit.scope,
      },
      burstAdmission: {
        capacity: burstAdmission.frameContextCapacity,
        inFlight: burstAdmission.inFlight,
        burst,
      },
      recovered,
      vsm,
      scratchBytes,
      normalOrm: true,
      alpha: true,
      controlledDeviceRecovery: true,
      localLightSceneSwap: true,
      localLightEpochRetired: true,
      stableGraphCacheHits: timingProfiles.length,
      recoveredSceneRelease: Boolean(productGeometry),
      abortRetry: true,
      nativeLightingMutation: true,
      authoredEnvironment,
      actualRenderer: true,
      cookedTextureWorkerCount: textureWorkerCount,
      textureEvidence,
      productGeometry,
      limitations: [
        "Correctness closure only; no S3 P50/P95 or image acceptance",
        "Resident cooked geometry, no streamed VG acceptance",
      ],
    };
  } finally {
    globalThis.Worker = WorkerClass;
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    buffers.forEach((buffer) => buffer.destroy());
    device.destroy();
  }
}

export async function runNativeSurfaceProductProductionGpuOracle(device) {
  return runNativeSurfaceProductionGpuOracle(device, true);
}

export async function runNativeSurfaceAuthoredIblProductionGpuOracle(device) {
  return runNativeSurfaceProductionGpuOracle(device, false, true);
}

export async function runNativeSurfaceMultiProductProductionGpuOracle(device) {
  return runNativeSurfaceProductionGpuOracle(device, "multi");
}
