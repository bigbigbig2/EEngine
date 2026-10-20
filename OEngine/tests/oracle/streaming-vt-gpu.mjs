import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { openTiledOracleFixture } from "../helpers/tiled-oracle-source.mjs";
import { nativeSurfaceDescriptor } from "../../.test-dist/shaders/native_surface.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { fixtureTexture } from "./texture-fixture.mjs";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { cookSceneGeometryProductV1 } from "../../.test-dist/assets/geometry-product/SceneGeometryCanonicalizerV1.js";
import { createDefaultWebGeometryCookerModule } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";
const check = (value, message) => {
  if (!value) {
    throw new Error(message);
  }
};

/** Offline analytic BC4 reference delivered through the real compressed Worker path. */
export async function sourceFixture() {
  return openTiledOracleFixture("analytic-bc4");
}

/** Actual dense/compact ordinary/Product VT consumers and recovery. Complete
 * Bistro/Dungeon, filtering and overflow use separate focused checks. */
export async function runStreamingVtGpuOracle() {
  let renderer = new Renderer({
    enablePhysicalEnvironment: true,
    enableVsm: true,
    autoExposure: false,
    fixedExposure: 1,
  });
  const errors = [],
    reports = [];
  const onError = (event) => errors.push(event.error.message);
  const fixture = await sourceFixture();
  const scene = new Scene(),
    geometry = new BoxGeometry(),
    material = new StandardShadeMaterial();
  material.texture_occlusion = ShadeTexture.fromTiled(fixture.source);
  scene.add(Mesh.from(geometry, material));
  const context = new OffscreenCanvas(128, 96).getContext("webgpu"),
    camera = new PerspectiveCamera();
  let device, colorReadback;
  let lastCommand, captured;
  try {
    await renderer.initialize({ context });
    device = renderer._graphics.device;
    device.addEventListener("uncapturederror", onError);
    renderer.pixel_ratio = 1;
    renderer.resize(128, 96);
    camera.aspect = 32 / 24;
    camera.near = 0.1;
    camera.far = 100;
    camera.transform.position.set(0, 0, 2);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const cooked = await cookGeometryAssetPackage(buildBoxSourceGeometry(), createGeometryCookRecipe());
    await renderer.uploadScene(scene, [{ geometry, asset: cooked.asset }]);
    const vt = renderer._graphics.texture_residency.virtualTextures;
    check(vt && vt.evidence().resident === 1, "bootstrap uploads only the protected tail");
    const prepare = renderer._surface.prepareFrameNow.bind(renderer._surface);
    renderer._surface.prepareFrameNow = (frame) => {
      captured = frame;
      return prepare(frame);
    };
    const shade = renderer._surface.encode.bind(renderer._surface);
    renderer._surface.encode = (...args) => {
      const result = shade(...args);
      const texture = renderer._surface.hdr;
      if (texture?.format === "rgba16float") {
        colorReadback ??= device.createBuffer({
          size: 128 * 96 * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        args[0].copyTextureToBuffer({ texture }, { buffer: colorReadback, bytesPerRow: 128 * 8 }, [
          texture.width,
          texture.height,
        ]);
      }
      return result;
    };
    const prepareVt = vt.prepareFrame.bind(vt);
    vt.prepareFrame = (command, ...args) => {
      lastCommand = command;
      return prepareVt(command, ...args);
    };
    const refinementDeadline = performance.now() + 45000;
    // A protected tail can report no outstanding demand before the first
    // Native invocation. Readiness polls are not completed render frames.
    while (
      !captured?.virtualFeedback ||
      vt.evidence().demand.wanted === 0 ||
      vt.evidence().resident <= 1 ||
      !vt.state().complete
    ) {
      check(performance.now() < refinementDeadline, "Initial real Native VT view did not refine");
      renderer.render(camera, scene);
      if (lastCommand?.wasSubmitted) {
        await lastCommand.gpuDone;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(captured?.virtualFeedback, "real Native Surface receives the VT feedback owner");
    check(vt.evidence().demand.wanted > 0, "real Native invocation records target mip demand");
    check(vt.evidence().resident > 1 && vt.state().complete, "normal frames refine current-view pages");
    const program = captured.publication.entries.find((entry) => entry.program.virtualTextures).program;
    const materialLayout = captured.publication.descriptor(0).groups[3];
    // Compile the actual bound material in the widest Surface profile. No
    // shortened shader, SSBO substitute, or reduced reflection output.
    const descriptor = nativeSurfaceDescriptor(program, materialLayout, {
      compact: true,
      productGeometry: true,
      unlit: false,
      physicalSun: true,
      reactive: true,
      finalPixel: true,
      reflections: "sssr-base-coat",
    });
    const storage = descriptor.groups.flat().filter((entry) => entry.buffer?.type.includes("storage")).length;
    check(storage === 16, `widest profile has ${storage} SSBO bindings`);
    const lease = renderer._graphics.appearance_programs.acquire(descriptor);
    await lease.ready;
    lease.release();
    reports.push({ name: "native-vt-current-view", ...vt.evidence(), storage });
    const memory = renderer.graphics.memoryEvidence();
    check(
      memory.owners.virtualTextures.allocatedBytes === vt.evidence().allocatedBytes,
      "graphics memory includes actual VT owner allocation",
    );
    check(
      memory.owners.virtualTextures.residentBytes === vt.evidence().residentBytes,
      "graphics memory separates mapped pages from atlas capacity",
    );
    const renderFrames = async (count) => {
      const target = renderer.frameSubmissionEvidence().submittedCount + count;
      const deadline = performance.now() + 45000;
      while (renderer.frameSubmissionEvidence().submittedCount < target) {
        check(
          performance.now() < deadline,
          `Native publication did not become ready: ${JSON.stringify(renderer.frameSubmissionEvidence())}`,
        );
        renderer.render(camera, scene);
        if (lastCommand?.wasSubmitted) await lastCommand.gpuDone;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    for (const [name, ao, reflections, scale, fsr] of [
      ["native-ao-sssr", true, true, 1, true],
      ["fsr-ao-sssr", true, true, 0.75, true],
      ["bypass-no-ao", false, false, 1, false],
    ]) {
      renderer.setAmbientOcclusionSettings({ enabled: ao });
      renderer.setScreenSpaceReflectionsSettings({ enabled: reflections });
      renderer.internal_resolution_scale = scale;
      renderer.fsr3_enabled = fsr;
      await renderFrames(3);
      reports.push({
        name,
        state: vt.state(),
        temporalPolicy: renderer.temporalHistoryEvidence().temporalPolicy,
      });
    }
    // C/X/Y-dependent custom graph runs through the actual Native owner.
    const graph = new AppearanceGraphBuilder(),
      uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    const sample = graph.texture(snapshotAppearanceTexture(material.texture_occlusion, "linear-rgb"), uv);
    graph.output("baseColor", graph.swizzle(sample, [0, 0, 0]));
    graph.output("alpha", graph.constant(1));
    material.appearance_definition = { schemaVersion: 1, graph: graph.build() };
    material.is_unlit = true;
    await renderer.resyncScene(scene, [{ geometry, asset: cooked.asset }]);
    await renderFrames(3);
    check(
      captured.publication.entries.some((entry) => entry.program.virtualTextures),
      "custom graph keeps VT Native route",
    );
    await colorReadback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint16Array(colorReadback.getMappedRange());
    check(
      [...pixels].every((value) => Number.isFinite(decodeFloat16(value))),
      "real Native VT HDR is finite",
    );
    check(
      [...pixels].some((value, index) => index % 4 !== 3 && decodeFloat16(value) > 0.05),
      JSON.stringify({
        error: "real custom VT sample reaches HDR",
        max: Math.max(...Array.from(pixels, decodeFloat16)),
        entries: captured.publication.entries.map((entry) => ({
          flags: entry.flags,
          key: entry.program.key.slice(0, 100),
        })),
        submitted: renderer.frameSubmissionEvidence(),
        demand: vt.evidence().demand,
      }),
    );
    colorReadback.unmap();
    colorReadback.destroy();
    colorReadback = undefined;
    const coverage = await fixtureTexture(
      "alpha-mask",
      [8, 4, 2, 1].map((size) => ({
        logicalWidth: size,
        logicalHeight: size,
        payload: Uint8Array.from({ length: size * size * 4 }, (_, i) =>
          i % 4 === 3 ? 255 : Math.floor(i / 4) % size < Math.max(1, size / 2) ? 255 : 0,
        ),
      })),
    );
    const masked = new AppearanceGraphBuilder();
    const maskedUv = masked.input("uv0", 2, "surface", undefined, "uv0");
    masked.output(
      "baseColor",
      masked.swizzle(
        masked.texture(snapshotAppearanceTexture(material.texture_occlusion, "linear-rgb"), maskedUv),
        [0, 0, 0],
      ),
    );
    masked.output(
      "alpha",
      masked.swizzle(masked.texture(snapshotAppearanceTexture(coverage, "linear-rgb"), maskedUv), [0]),
    );
    material.appearance_definition = { schemaVersion: 1, graph: masked.build() };
    material.transparency_mode = ShadeTransparencyMode.AlphaTested;
    await renderer.resyncScene(scene, [{ geometry, asset: cooked.asset }]);
    await renderFrames(3);
    check(
      captured.publication.entries.some((entry) => entry.program.virtualTextures),
      "R8 coverage retains virtual shading",
    );
    reports.push({ name: "custom-alpha-resident-r8-virtual-rgb", state: vt.state() });
    const productScene = new Scene();
    for (const mesh of scene.instances.instances) productScene.add(mesh.clone());
    const litMaterial = new StandardShadeMaterial();
    litMaterial.texture_occlusion = material.texture_occlusion;
    productScene.add(Mesh.from(geometry, litMaterial, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.6, 0, -0.5, 1]));
    renderer.setScreenSpaceReflectionsSettings({ enabled: true });
    const product = await cookSceneGeometryProductV1(productScene, {
      module: await createDefaultWebGeometryCookerModule(),
      producerId: "vt-acceptance",
      producerVersion: "VT3",
      maxDecodedProductBytes: 32 * 1024 * 1024,
    });
    await renderer.uploadCookedSceneProduct(productScene, product);
    await renderer.releaseScene(scene);
    const submitProduct = async () => {
      const before = renderer.frameSubmissionEvidence().submittedCount;
      const deadline = performance.now() + 45000;
      while (renderer.frameSubmissionEvidence().submittedCount < before + 3) {
        check(performance.now() < deadline, "Product VT frame admission timed out");
        renderer.render(camera, productScene);
        await device.queue.onSubmittedWorkDone();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await submitProduct();
    check(
      captured.geometry.productHeap && captured.virtualFeedback,
      "actual Product dispatch consumes VT and exact MASK",
    );
    check(
      captured.publication.bins.length > 1 && captured.reflections,
      "compact Product VT dispatch includes SSSR receivers",
    );
    reports.push({
      name: "product-mask-vt",
      state: renderer.graphics.texture_residency.virtualTextures.state(),
    });
    device.removeEventListener("uncapturederror", onError);
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    device.addEventListener("uncapturederror", onError);
    await submitProduct();
    check(renderer.deviceEpoch === 2, "VT recovery advances device epoch");
    check(
      renderer.graphics.texture_residency.virtualTextures.evidence().resident >= 1,
      "new epoch rereads protected tails",
    );
    await renderer.releaseScene(productScene);
    check(
      (renderer.graphics.texture_residency.virtualTextures?.sourceCount ?? 0) === 0,
      "release after recovery retires all VT sources",
    );
    reports.push({ name: "device-loss-reload-release", epoch: renderer.deviceEpoch });
    check(fixture.preparation.evidence().credit.used.ready === 0, "all consumed leases released");
    check(errors.length === 0, errors.join("\n"));
    return { ok: true, reports };
  } finally {
    colorReadback?.destroy();
    renderer.destroy();
    fixture.preparation.dispose();
    device?.removeEventListener("uncapturederror", onError);
  }
}
