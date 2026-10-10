import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { cookSceneGeometryProductV1 } from "../../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import { createDefaultWebGeometryCookerModule } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function runVsmR1ProductionGpuOracle({ r2Lifecycle = false } = {}) {
  let renderer = new Renderer({ autoExposure: false, fixedExposure: 1 });
  const canvas = new OffscreenCanvas(192, 128);
  await renderer.initialize({ context: canvas.getContext("webgpu") });
  renderer.resize(192, 128);
  renderer.fsr3_enabled = false;
  renderer.temporal_jitter_enabled = false;
  let device = renderer.device;
  const errors = [],
    retained = [],
    boundsPasses = [];
  const beginComputePass = ShadeGPUCommandContext.prototype.beginComputePass;
  ShadeGPUCommandContext.prototype.beginComputePass = function (descriptor) {
    if (
      descriptor?.label === "VSM/complete caster bounds" ||
      descriptor?.label === "VSM/publish stable depth"
    )
      boundsPasses.push(descriptor.label);
    return beginComputePass.call(this, descriptor);
  };
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const scene = new Scene(),
    geometry = new BoxGeometry(1, 1, 1),
    material = new StandardShadeMaterial();
  material.metalness = 0;
  const caster = Mesh.from(geometry, material);
  const ground = Mesh.from(geometry, material, [12, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 12, 0, 0, -0.8, 0, 1]);
  const disabled = Mesh.from(geometry, material, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]);
  disabled.castShadow = false;
  disabled.receiveShadow = false;
  scene.add([caster, ground, disabled]);
  let activeScene = scene;
  const sun = [0.4, 1, 0.3].map((value) => value / Math.hypot(0.4, 1, 0.3));
  scene.physical_environment.setSun(sun, [2, 2, 2]);
  const camera = new PerspectiveCamera();
  camera.aspect = 1.5;
  camera.far = 256;
  camera.transform.position.set(0.21, 4, 7);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  let frame = null,
    abort = false;
  const instrument = () => {
    const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (input, ...rest) => {
      frame = input;
      return prepare(input, ...rest);
    };
    const encode = renderer._surface.encode.bind(renderer._surface);
    renderer._surface.encode = (encoder) => {
      encode(encoder);
      if (abort) throw new Error("injected VSM R1 abort after encoding");
    };
  };
  instrument();
  const tick = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      const before = renderer.frame_count,
        deadline = performance.now() + 60000;
      while (renderer.frame_count === before && performance.now() < deadline) {
        renderer.render(camera, activeScene);
        await device.queue.onSubmittedWorkDone();
        if (renderer.frame_count === before) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      check(renderer.frame_count !== before, `Production readiness timeout: ${renderer._lastFrameDeferral}`);
    }
  };
  const inspect = async () => {
    const runtime = renderer.graphics.render_world.runtime(activeScene),
      vsm = renderer._vsm;
    const sourceBuffers = {
      pages: vsm.pageTable,
      depth: vsm.depthRange,
      caster: vsm.casterRecords,
      demand: vsm.demand,
      instances: renderer.graphics.gpu_scene.bindings().instances,
    };
    const encoder = device.createCommandEncoder({ label: "VSM R1 diagnostics only" });
    const readbacks = {};
    for (const [name, source] of Object.entries(sourceBuffers)) {
      const size =
        name === "instances"
          ? runtime.instanceCount * 176
          : name === "pages" || name === "caster"
            ? source.size
            : 16;
      const target = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      retained.push(target);
      encoder.copyBufferToBuffer(
        source,
        name === "instances" ? runtime.instanceBegin * 176 : 0,
        target,
        0,
        size,
      );
      readbacks[name] = target;
    }
    const width = frame.output.width,
      height = frame.output.height;
    const pitch = Math.ceil((width * 8) / 256) * 256;
    const hdr = device.createBuffer({
      size: pitch * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    retained.push(hdr);
    encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: hdr, bytesPerRow: pitch }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    const words = {};
    for (const [name, target] of Object.entries(readbacks)) {
      await target.mapAsync(GPUMapMode.READ);
      words[name] = new Uint32Array(target.getMappedRange().slice(0));
      target.unmap();
    }
    await hdr.mapAsync(GPUMapMode.READ);
    const pixels = new Uint16Array(hdr.getMappedRange().slice(0));
    hdr.unmap();
    let luminance = 0;
    for (let i = 0; i < pixels.length; i += 4)
      luminance += decodeFloat16(pixels[i]) + decodeFloat16(pixels[i + 1]) + decodeFloat16(pixels[i + 2]);
    const pages = [];
    for (let i = 0; i < words.pages.length; i += 12) {
      if (
        (words.pages[i + 3] & 11) === 9 &&
        words.pages[i + 4] === renderer._vsmGeneration.currentGeneration
      ) {
        pages.push({
          index: i / 12,
          key: [words.pages[i + 7], words.pages[i + 8] | 0, words.pages[i + 9] | 0, words.pages[i + 10]],
          version: words.pages[i + 6],
        });
      }
    }
    const casterCounts = new Array(runtime.instanceCount).fill(0);
    const casterPages = new Set();
    for (let index = 0; index < words.caster[1]; index++) {
      const instance = words.caster[4 + index * 8] - runtime.instanceBegin;
      check(instance >= 0 && instance < runtime.instanceCount, "Caster record references another Scene");
      casterCounts[instance]++;
      casterPages.add(words.caster[4 + index * 8 + 5]);
    }
    return {
      generation: renderer._vsmGeneration.currentGeneration,
      depth: [...new Float32Array(words.depth.buffer)],
      flags: Array.from({ length: runtime.instanceCount }, (_, i) => words.instances[i * 44 + 2]),
      pages,
      emptyReadyPages: pages.filter((page) => !casterPages.has(page.index)).length,
      caster: [...words.caster.slice(0, 4)],
      casterCounts,
      demand: [...words.demand],
      luminance,
    };
  };
  try {
    const cooked = await cookSceneGeometryProductV1(scene, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "vsm-v4-r1-oracle",
      producerVersion: "1",
      maxDecodedProductBytes: 32 * 1024 * 1024,
    });
    check(
      cooked.canonicalization.instances[0].flags === 6 && cooked.canonicalization.instances[2].flags === 0,
      "WASM Scene source lost explicit off/default",
    );
    await renderer.uploadCookedSceneProduct(scene, cooked);
    await tick(5);
    const initial = await inspect();
    check(
      initial.pages.length > 0 && initial.caster[2] === 0,
      `Production VSM must publish ready pages without caster overflow: ${JSON.stringify(initial)}; errors=${errors}`,
    );
    check(
      (initial.flags[0] & 6) === 6 && (initial.flags[2] & 6) === 0,
      "Cook/binary/GPU semantic flags disagree",
    );
    const initialBoundsPassCount = boundsPasses.length;
    check(initialBoundsPassCount === 2, "Steady epoch repeated caster depth reduction");
    const origin = camera.transform.position.toArray();
    camera.transform.position.x += 0.001;
    camera.update();
    await tick();
    const within = await inspect();
    check(
      within.generation === initial.generation &&
        JSON.stringify(within.depth) === JSON.stringify(initial.depth),
      "Page-interior camera motion changed projection/depth",
    );
    camera.transform.position.set(origin[0] + 0.4, origin[1] + 1, origin[2] + 0.3);
    camera.update();
    await tick();
    const axial = await inspect();
    check(
      axial.generation === initial.generation &&
        JSON.stringify(axial.depth) === JSON.stringify(initial.depth),
      "Light-axis camera motion changed stable depth",
    );
    camera.transform.position.x += 1;
    camera.update();
    await tick();
    const rolled = await inspect();
    check(rolled.generation === initial.generation, "Window roll changed the projection epoch");
    const oldPages = new Map(initial.pages.map((page) => [JSON.stringify(page.key), page.version]));
    const common = rolled.pages.filter((page) => oldPages.has(JSON.stringify(page.key)));
    check(
      common.length > 0 && common.every((page) => page.version === oldPages.get(JSON.stringify(page.key))),
      "Rolling re-rasterized intersection pages",
    );
    check(boundsPasses.length === initialBoundsPassCount, "Camera movement executed epoch depth reduction");
    scene.physical_environment.setSun(sun, [3, 3, 3]);
    await tick();
    const intensity = await inspect();
    check(intensity.generation === rolled.generation, "Only Sun intensity invalidated depth");
    caster.receiveShadow = false;
    ground.receiveShadow = false;
    await tick(3);
    const receiversOff = await inspect();
    check(
      receiversOff.demand[0] === 0 && receiversOff.flags.every((flags) => (flags & 4) === 0),
      "ReceivesShadow off still generated receiver demand",
    );
    check(
      receiversOff.luminance > intensity.luminance,
      "Surface receive-off did not bypass actual shadowed Sun",
    );
    ground.receiveShadow = true;
    caster.receiveShadow = true;
    await tick(3);
    const beforeAbort = renderer._vsmGeneration.currentGeneration;
    scene.physical_environment.setSun(
      [-0.3, 1, 0.4].map((value) => value / Math.hypot(-0.3, 1, 0.4)),
      [3, 3, 3],
    );
    abort = true;
    let rejected = false;
    try {
      renderer.render(camera, scene);
    } catch (error) {
      check(String(error).includes("injected VSM R1 abort"), `Unexpected production failure: ${error}`);
      rejected = true;
    }
    check(
      rejected && renderer._vsmGeneration.currentGeneration === beforeAbort,
      "Aborted frame advanced submitted VSM epoch",
    );
    abort = false;
    await tick(3);
    const retry = await inspect();
    check(
      retry.generation > beforeAbort && retry.pages.length > 0,
      "Sun direction retry did not republish new ready content",
    );
    caster.castShadow = false;
    await tick();
    const castsOff = await inspect();
    check(
      (castsOff.flags[0] & 2) === 0 && castsOff.casterCounts[0] === 0 && castsOff.casterCounts[1] > 0,
      "Live cast-off did not remove the instance from actual shadow work",
    );
    caster.castShadow = true;
    await tick();
    const castsOn = await inspect();
    check(
      (castsOn.flags[0] & 6) === 6 && castsOn.casterCounts[0] > 0,
      "Live cast-on did not publish actual shadow work",
    );
    caster.transform_local.position.y = 5;
    await tick();
    const transformed = await inspect();
    check(
      transformed.generation > castsOn.generation &&
        JSON.stringify(transformed.depth) !== JSON.stringify(castsOn.depth) &&
        (transformed.flags[0] & 6) === 6,
      "Transform patch lost shadow semantics or retained old caster depth",
    );
    ground.receiveShadow = false;
    caster.receiveShadow = false;
    await tick();
    const priorNamespace = renderer._vsm.namespace;
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    renderer.fsr3_enabled = false;
    renderer.temporal_jitter_enabled = false;
    instrument();
    await tick(3);
    const recovered = await inspect();
    check(
      renderer.deviceEpoch === 2 && renderer._vsm.namespace !== priorNamespace,
      "Device recovery retained the old page namespace",
    );
    check(
      recovered.flags.every((flags) => (flags & 4) === 0) &&
        recovered.demand[0] === 0 &&
        recovered.depth[3] === 1,
      "Device recovery lost submitted receive semantics or stable projection",
    );
    check(errors.length === 0, errors.join("\n"));
    let lifecycle = null;
    if (r2Lifecycle) {
      caster.receiveShadow = true;
      ground.receiveShadow = true;
      await tick(3);
      const restored = await inspect();
      check(restored.emptyReadyPages > 0, "Real cleared pages without caster pairs did not complete");
      renderer.resize(256, 128);
      camera.aspect = 2;
      camera.update();
      await tick(3);
      const resized = await inspect();
      check(
        resized.generation === restored.generation && resized.pages.length > 0,
        "Resize lost stable VSM content",
      );
      renderer.shadowVisibilityEnabled = false;
      check(renderer.shadowVisibilityEnabled === false, "Public VSM toggle did not disable visibility");
      await tick();
      renderer.shadowVisibilityEnabled = true;
      await tick(3);
      const toggled = await inspect();
      check(
        toggled.pages.length > 0 && toggled.generation > resized.generation,
        "VSM toggle failed to invalidate and republish usable content",
      );
      caster.castShadow = false;
      ground.castShadow = false;
      await tick(3);
      const noCasters = await inspect();
      check(
        noCasters.depth[3] === 1 &&
          noCasters.caster[1] === 0 &&
          noCasters.pages.length > 0 &&
          noCasters.emptyReadyPages === noCasters.pages.length,
        `No-caster Scene retained stale shadow content: ${JSON.stringify({ depth: noCasters.depth, caster: noCasters.caster, pages: noCasters.pages.length, flags: noCasters.flags })}`,
      );
      const replacement = new Scene();
      replacement.add(Mesh.from(geometry, material));
      replacement.physical_environment.setSun(sun, [3, 3, 3]);
      const replacementProduct = await cookSceneGeometryProductV1(replacement, {
        module: await createDefaultWebGeometryCookerModule(),
        producerId: "vsm-r2-replacement",
        producerVersion: "1",
        maxDecodedProductBytes: 32 * 1024 * 1024,
      });
      await renderer.uploadCookedSceneProduct(replacement, replacementProduct);
      activeScene = replacement;
      await tick(3);
      const replaced = await inspect();
      check(
        replaced.generation > noCasters.generation &&
          replaced.flags.length === 1 &&
          replaced.pages.length > 0,
        "Scene replacement sampled old residency",
      );
      await renderer.releaseScene(scene);
      await tick();
      check((await inspect()).pages.length > 0, "Releasing old Scene invalidated new Scene products");
      await renderer.releaseScene(replacement);
      lifecycle = {
        emptyReadyPages: restored.emptyReadyPages,
        resize: true,
        toggle: true,
        noCasters: { depthValid: noCasters.depth[3], ready: noCasters.pages.length },
        replacementGeneration: replaced.generation,
        release: true,
      };
      check(errors.length === 0, errors.join("\n"));
    }
    return {
      initial,
      within,
      axial,
      rolled,
      intensity,
      receiversOff,
      retry,
      castsOff,
      castsOn,
      transformed,
      recovered,
      commonPagesRetained: common.length,
      initialBoundsPassCount,
      cameraMovementBoundsPassCount: 0,
      boundsPasses,
      deviceEpoch: renderer.deviceEpoch,
      errors,
      lifecycle,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    renderer.destroy();
    for (const resource of retained) resource.destroy();
    device.destroy();
    ShadeGPUCommandContext.prototype.beginComputePass = beginComputePass;
  }
}
