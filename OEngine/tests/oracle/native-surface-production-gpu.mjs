import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";
import { buildVirtualGeometrySceneSourceV1, mergeVirtualGeometryProductSceneSourcesV1 } from "../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { DirectionalLight } from "../../.test-dist/light/DirectionalLight.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeTransparencyMode, ShadeDrawSide } from "../../.test-dist/material/enums.js";
import {
  writeEncodedTextureAssetPackageV2,
  openTextureAssetPackageV2
} from "../../.test-dist/assets/TextureAssetPackage.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { GPU_INSTANCE_FLAGS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
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
  0.0163916 * r + 0.0880132 * g + 0.895595 * b
];

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
      payload
    };
  });
  const asset = await openTextureAssetPackageV2(
    await writeEncodedTextureAssetPackageV2(
      {
        width: extent,
        height: extent,
        rgba8: mips[0].payload,
        semantic,
        sourceUri: `fixture://s2-${semantic}`
      },
      [
        {
          profile: "portable-rgba8",
          semantic,
          format: "rgba8unorm",
          blockWidth: 1,
          blockHeight: 1,
          bytesPerBlock: 4,
          codecId: "authored-mips",
          codecRevision: "v1",
          codecBinaryHash: "1".repeat(64),
          mips
        }
      ]
    )
  );
  return ShadeTexture.fromAssetPackageV2(asset);
}

/** Real Renderer entry, with readback instrumentation after actual native shading.
 * No replacement output, correctness shortcut or isolated renderer is installed.
 * The renderer negotiates its own device because its complete capability profile
 * is larger than the component-oracle host's profile. Its errors are checked here.
 */
export async function runNativeSurfaceProductionGpuOracle(_device, productGeometry = false) {
  let renderer = new Renderer({ autoExposure: false, fixedExposure: 1, textureMaxResolution: 256 });
  const canvas = new OffscreenCanvas(384, 224);
  const context = canvas.getContext("webgpu");
  check(context !== null, "Production oracle needs a WebGPU canvas");
  await renderer.initialize({ context });
  renderer.resize(384, 224);
  let device = renderer.device;
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const scene = new Scene();
  const geometry = new BoxGeometry(1.4, 1.4, 1.4);
  const cooked = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(1.4, 1.4, 1.4),
    createGeometryCookRecipe()
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
    255
  ]);
  materials[4].texture_orm = await authoredTexture("orm-linear", (x, _y, size) => [
    255,
    x < size / 2 ? 153 : 204,
    51,
    255
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
  let arenaOwnerPeakBytes = 0;
  const instrument = () => {
    const arenaOwner = renderer.graphics.frame_geometry_arena;
    const prepareArena = arenaOwner.prepare.bind(arenaOwner);
    arenaOwner.prepare = (...args) => {
      const prepared = prepareArena(...args);
      arenaOwnerPeakBytes = Math.max(arenaOwnerPeakBytes, arenaOwner.allocatedBytes);
      check(arenaOwner.allocatedBytes <= 256 * 1024 * 1024, "Arena replacement exceeded cumulative owner budget");
      return prepared;
    };
    const visibility = renderer._visibilityFeature;
    const prepareVisibility = visibility.prepare.bind(visibility);
    visibility.prepare = (job, ...rest) => prepareVisibility(
      forcePreparationMiss ? {
        ...job,
        frameGeometryBudget: { vertexCapacity: 1, triangleCapacity: 1, maxBytes: 16 * 1024 * 1024 }
      } : job,
      ...rest
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
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        buffers.push(buffer);
        return buffer;
      };
      const hdr = make(pitch * frame.height),
        winner = make(keyPitch * frame.height),
        work = make(frame.geometry.meshletWork.size);
      encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: hdr, bytesPerRow: pitch }, [
        frame.width,
        frame.height
      ]);
      encoder.copyTextureToBuffer({ texture: frame.visibility }, { buffer: winner, bytesPerRow: keyPitch }, [
        frame.width,
        frame.height
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
        height: frame.height
      };
      if (fail) {
        throw new Error("injected native production abort");
      }
    };
  };
  instrument();
  const tick = async () => {
    const before = renderer.frame_count;
    for (let attempt = 0; attempt < 200; attempt++) {
      renderer.render(camera, scene);
      await device.queue.onSubmittedWorkDone();
      if (renderer.frame_count !== before) {
        check(capture !== null, "Production Surface did not encode");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Native production readiness never completed");
  };
  const inspectVsm = async () => {
    const resources = renderer._vsm;
    check(resources?.pageTable && resources?.casterRecords, "Production VSM is disabled");
    const pages = device.createBuffer({
      size: resources.pageTable.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const casters = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
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
    for (let word = 0; word < words.length; word += 8) {
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
      `Production VSM must publish real pages/casters: ${allocated}/${contentValid}/${count}`
    );
    return {
      allocatedPages: allocated,
      contentValidPages: contentValid,
      writtenCasters: count[1],
      overflow: count[2]
    };
  };
  const inspect = async (alphaVisible = true, requiredMaterials = [0, 1, 2, 3, 4]) => {
    check(errors.length === 0, `Production WebGPU errors: ${errors.join(" | ")}`);
    const current = capture;
    await Promise.all(
      [current.hdr, current.winner, current.work, current.instances, current.arena].map((buffer) =>
        buffer.mapAsync(GPUMapMode.READ)
      )
    );
    const hdr = new Uint16Array(current.hdr.getMappedRange());
    const winner = new Uint32Array(current.winner.getMappedRange());
    const work = new Uint32Array(current.work.getMappedRange());
    const arenaWords = new Uint32Array(current.arena.getMappedRange());
    const runtime = renderer.graphics.render_world.runtime(scene);
    const sourceBySlot = new Map(
      runtime.nativeMaterials.materialSources.map((source) => [source.materialSlot, source.material])
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
          decodeFloat16(hdr[(y * current.pitch) / 2 + x * 4 + channel])
        );
        check(actual.every(Number.isFinite), "Native production HDR is not finite");
        if (!material.is_unlit) {
          check(
            actual.some((value) => value > 0),
            "Real lit winner has no radiance"
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
        index === 1 && !alphaVisible ? (counts.get(materials[index]) ?? 0) === 0 : (counts.get(materials[index]) ?? 0) > 20
      ),
      `Every native program/material must have actual winners: ${materials.map((material) => counts.get(material) ?? 0)}; queue=${work.slice(0, 38)}; instance=${new Uint32Array(current.instances.getMappedRange()).slice(0, 80)}; arena=${arenaWords.slice(actualFrame.geometry.sourcePayload[3], actualFrame.geometry.sourcePayload[3] + 32)}`
    );
    hdrSnapshot = hdr.slice();
    const header = actualFrame.geometry.sourcePayload[3] & 0x7fffffff;
    check(arenaWords[header] === 4, "Production consumed an obsolete frame geometry layout");
    const directory = arenaWords[header + ((actualFrame.geometry.sourcePayload[3] >>> 31) ? 5 : 4)];
    let cachedMeshlets = 0;
    for (let slot = 0; slot < arenaWords[directory]; slot++) {
      if (arenaWords[directory + 4 + slot * 4 + 2] !== 0) cachedMeshlets++;
    }
    const arenaBytes = current.arena.size;
    const preparedVertices = arenaWords[directory + 2];
    const preparedTriangles = arenaWords[directory + 3];
    [current.hdr, current.winner, current.work, current.instances, current.arena].forEach((buffer) =>
      buffer.unmap()
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
      bindingSets: new Set(runtime.nativeMaterials.publication.bins.map((bin) => bin.bindingSet)).size
    };
  };
  try {
    if (productGeometry) {
      const product = await cookSceneGeometryProductV1(scene, {
        module: await createDefaultWebGeometryCookerModule(),
        producerId: "native-production-oracle",
        producerVersion: "S2",
        maxDecodedProductBytes: 32 * 1024 * 1024
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
          const source = { descriptor: original.descriptor,
            readPage: (pageId, signal) => original.readPage(pageId, signal),
            release() { if (--leases === 0) original.release(); } };
          const shard = await runtime.load(source);
          shards.push(shard);
          const instances = product.canonicalization.instances.filter((_instance, index) => index % 2 === shardIndex);
          const mapped = buildVirtualGeometrySceneSourceV1(source.descriptor,
            product.canonicalization.profiles, instances, product.canonicalization.materials);
          parts.push({ source: { ...mapped.source, meshes: meshes.filter((_mesh, index) => index % 2 === shardIndex) },
            productTableSlot: shard.productTableSlot, productGeneration: shard.productGeneration,
            assetReferenceBegin: shard.assetReferenceBegin });
        }
        const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
        const streaming = new GeometryPageStreamingRuntimeV1(device, shards[0].residency);
        for (const shard of shards) streaming.registerProduct(shard.residency.sourceForStreaming(), shard.residency);
        await renderer.uploadVirtualGeometryScene(scene, combined, shards[0].residency, streaming, undefined,
          { bindings: runtime.bindings(), assetCount: combined.assetCount, registerStreaming: false, multiRuntime: runtime });
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
          `Unexpected abort: ${error.message}`
        );
        aborted = true;
      }
      await device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    check(aborted, "Required production abort was not exercised");
    check(
      renderer.graphics.render_world.runtime(scene).nativeMaterials.active === publication,
      "Aborted frame published native candidate"
    );
    fail = false;
    await tick();
    const retry = await inspect();
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
    check(residentMiss.visiblePixels === preparedFixed.visiblePixels,
      `Prepared miss changed winner coverage: ${preparedFixed.visiblePixels} -> ${residentMiss.visiblePixels}`);
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
    const originalNear = camera.near;
    camera.near = 6.4;
    camera.update();
    await tick();
    // Front-only faces can be wholly clipped in this camera. Require exposed
    // side faces, the two-sided instance and the mirrored PBR/normal-map instance;
    // every ordinary lifecycle frame above/below still requires all programs.
    const nearClipPrepared = await inspect(true, [0, 3, 4]);
    const nearClipHdr = hdrSnapshot;
    check(nearClipPrepared.visiblePixels > 100 && nearClipPrepared.visiblePixels < preparedFixed.visiblePixels,
      "Near-plane fixture did not clip real source triangles");
    forcePreparationMiss = true;
    await tick();
    const nearClipResident = await inspect(true, [0, 3, 4]);
    check(nearClipResident.cachedMeshlets === 0 && nearClipResident.visiblePixels === nearClipPrepared.visiblePixels,
      "Near-plane prepared/resident coverage diverged");
    let nearClipMaximumError = 0;
    for (let i = 0; i < nearClipHdr.length; i++) {
      nearClipMaximumError = Math.max(nearClipMaximumError,
        Math.abs(decodeFloat16(nearClipHdr[i]) - decodeFloat16(hdrSnapshot[i])));
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
    check(!renderer._temporal.histories.state("identity").readValid, "Explicit camera cut kept identity history valid");
    await tick();
    check(!renderer._temporalFacts.readValid, "Camera-cut frame consumed stale native identity");
    const cameraCut = await inspect();
    await tick();
    check(renderer._temporalFacts.readValid, "Settled retry did not restore native Temporal identity");
    // Small diagnostic cost sample, not the large-scene acceptance matrix.
    renderer.profiler.setMode("record");
    renderer.profiler.configure({ enabled: true, gpuSampleInterval: 1, gpuTimingMode: "full", historyCapacity: 128 });
    const timingBegin = renderer.frame_count;
    for (let i = 0; i < 16; i++) await tick();
    for (let wait = 0; wait < 100; wait++) {
      const ready = renderer.profiler.history.filter((p) => p.frameIndex >= timingBegin &&
        p.frameIndex < timingBegin + 16 && p.gpu.sampled && !p.gpu.pending);
      if (ready.length === 16) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const timingProfiles = renderer.profiler.history.filter((p) => p.frameIndex >= timingBegin &&
      p.frameIndex < timingBegin + 16 && p.gpu.sampled && !p.gpu.pending);
    check(timingProfiles.length === 16 && timingProfiles.every((p) =>
      !p.counters["gpu.timing.truncated"] && p.submits.count === 1), "Missing complete single-submit diagnostic timestamps");
    const passLabels = [...new Set(timingProfiles.flatMap((p) => p.gpu.segments
      .filter((s) => s.scope === "pass").map((s) => s.label)))];
    const diagnosticPassMs = Object.fromEntries(passLabels.map((label) => {
      const values = timingProfiles.map((p) => p.gpu.segments.filter((s) => s.scope === "pass" &&
        s.label === label).reduce((sum, s) => sum + s.durationMs, 0)).sort((a,b) => a-b);
      return [label, { samples: values.length, median: values[8], minimum: values[0], maximum: values[15] }];
    }));
    const dump = renderer.mainFrameGraphEvidence();
    check(
      JSON.stringify(dump).includes("SurfaceV4/native opaque"),
      "Production FrameProgram did not use SurfaceV4"
    );
    check(
      !JSON.stringify(dump).match(/SurfaceWork|closure cache|six.signal|reconstruct bank/i),
      "Retired Surface is in the production graph"
    );
    await device.queue.onSubmittedWorkDone();
    check(errors.length === 0, `Production WebGPU errors: ${errors.join(" | ")}`);
    device.destroy();
    await device.lost;
    renderer = await renderer.recoverAfterDeviceLoss();
    device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    instrument();
    await tick();
    const recovered = await inspect();
    if (productGeometry === "multi") {
      const streaming = renderer.geometryStreamingEvidence(scene);
      check(streaming.products.length === 2, "Recovery dropped an active Product");
      check(new Set(streaming.products.map((product) => product.productGeneration)).size === 2,
        "Recovery aliased Product generations");
    }
    check(renderer.geometryStreamingError() === null, "Production streaming error is observable");
    check(renderer.deviceEpoch === 2, "Production recovery did not advance the device epoch");
    const ledger = renderer.graphics.resource_accounting;
    const nativeOwners = [
      "SurfaceV4",
      "NativeExecutionBins",
      "NativeVisibilityPass",
      "NativeRasterWorkPartitions",
      "GpuNativeMaterialPublication"
    ];
    const beforeDestroy = ledger.snapshot();
    check(
      nativeOwners.every((owner) => (beforeDestroy.owners[owner]?.buffer ?? 0) > 0),
      "Native resources are missing from physical accounting"
    );
    const memory = renderer.graphics.memoryEvidence();
    const scratchBytes = nativeOwners
      .slice(0, 4)
      .reduce(
        (total, owner) =>
          total + (beforeDestroy.owners[owner]?.buffer ?? 0) + (beforeDestroy.owners[owner]?.texture ?? 0),
        0
      );
    check(
      memory.owners.nativeSurfaceScratch.allocatedBytes === scratchBytes,
      "Memory evidence omitted or double-counted native scratch"
    );
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    await Promise.resolve();
    const afterDestroy = ledger.snapshot();
    check(
      nativeOwners.every((owner) => afterDestroy.owners[owner] === undefined),
      "Native resource ledger leaked after fenced teardown"
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
      arenaOwnerPeakBytes,
      diagnosticPassMs,
      alphaRejected,
      alphaRestored,
      resized,
      moved,
      cameraCut,
      recovered,
      vsm,
      scratchBytes,
      normalOrm: true,
      alpha: true,
      controlledDeviceRecovery: true,
      abortRetry: true,
      actualRenderer: true,
      productGeometry,
      limitations: [
        "Correctness closure only; no S3 P50/P95 or image acceptance",
        "Resident cooked geometry, no streamed VG acceptance"
      ]
    };
  } finally {
    renderer.destroy();
    await device.queue.onSubmittedWorkDone();
    buffers.forEach((buffer) => buffer.destroy());
    device.destroy();
  }
}

export async function runNativeSurfaceProductProductionGpuOracle(device) {
  return runNativeSurfaceProductionGpuOracle(device, true);
}

export async function runNativeSurfaceMultiProductProductionGpuOracle(device) {
  return runNativeSurfaceProductionGpuOracle(device, "multi");
}
