import assert from "node:assert/strict";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { Mesh } from "../../.test-dist/scene/Mesh.js";
import { BoxGeometry, buildBoxSourceGeometry } from "../../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../../.test-dist/geometry/GeometryCooker.js";
import { createGeometryCookRecipe } from "../../.test-dist/assets/GeometryCookRecipe.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { createPackedSceneSourceFromScene } from "../../.test-dist/gpu/GpuSceneAdapter.js";
import { GPU_INSTANCE_FLAGS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { GPU_COUNTER_BYTE_SIZE, counterByteOffset } from "../../.test-dist/debug/GpuFrameCounters.js";
import { authoredTexture } from "./native-surface-production-gpu.mjs";
import { VsmCasterRecordPass } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";

// Exercise the production caster/finalize pipelines with independently authored
// headers. No pages means this isolates header rejection, not shading performance.
async function checkCasterHeaders(device) {
  const retained = [],
    owner = new VsmCasterRecordPass(device);
  const make = (size, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
    const buffer = device.createBuffer({ size, usage });
    retained.push(buffer);
    return buffer;
  };
  const work = make(80),
    allocation = make(48),
    pages = make(32),
    instances = make(176);
  const caster = make(80, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  const telemetry = make(32),
    indirect = make(48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const read = make(64, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const constants = new Uint32Array(64);
  constants.set([1, 128, 0, 128], 40);
  constants.set([17, 2, 2, 1], 44);
  const group = device.createBindGroup({
    layout: owner.casterLayout,
    entries: [
      { binding: 0, resource: { buffer: owner.constants } },
      { binding: 1, resource: { buffer: allocation } },
      { binding: 2, resource: { buffer: pages } },
      { binding: 3, resource: { buffer: work } },
      { binding: 4, resource: { buffer: instances } },
      { binding: 5, resource: { buffer: caster } },
      { binding: 6, resource: { buffer: telemetry } },
    ],
  });
  const final = device.createBindGroup({
    layout: owner.finalizeLayout,
    entries: [
      { binding: 0, resource: { buffer: owner.constants } },
      { binding: 1, resource: { buffer: allocation } },
      { binding: 5, resource: { buffer: caster } },
      { binding: 7, resource: { buffer: indirect } },
    ],
  });
  const cases = [];
  try {
    for (const [name, written, capacity, invalid, overflow, controlCapacity, expectedFailure] of [
      ["empty", 0, 2, 0, 0, 2, 0],
      ["one", 1, 2, 0, 0, 2, 0],
      ["full", 2, 2, 0, 0, 2, 0],
      ["invalid", 1, 2, 1, 0, 2, 1],
      ["overflow", 1, 2, 0, 1, 2, 1],
      ["header-bound", 2, 1, 0, 0, 2, 1],
      ["physical-bound", 3, 3, 0, 0, 3, 1],
      ["consumer-bound", 2, 2, 0, 0, 1, 1],
    ]) {
      constants[45] = controlCapacity;
      device.queue.writeBuffer(owner.constants, 0, constants);
      device.queue.writeBuffer(
        work,
        0,
        new Uint32Array([written, written, 0, capacity, overflow, 11, invalid, 0]),
      );
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(caster);
      encoder.clearBuffer(telemetry);
      const pass = encoder.beginComputePass();
      pass.setPipeline(owner.casterPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      const finalize = encoder.beginComputePass();
      finalize.setPipeline(owner.finalizePipeline);
      finalize.setBindGroup(0, final);
      finalize.dispatchWorkgroups(1);
      finalize.end();
      encoder.copyBufferToBuffer(caster, 0, read, 0, 16);
      encoder.copyBufferToBuffer(indirect, 0, read, 16, 48);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = [...new Uint32Array(read.getMappedRange().slice(0))];
      read.unmap();
      assert.equal(values[2], expectedFailure, `${name}: exact malformed-header rejection`);
      assert.equal(values[3], 17, `${name}: current caster generation`);
      assert.equal(values[5], 0, `${name}: no partial draw without pages`);
      cases.push({ name, overflow: values[2], generation: values[3] });
    }
    return cases;
  } finally {
    await device.queue.onSubmittedWorkDone();
    owner.destroy();
    retained.forEach((buffer) => buffer.destroy());
  }
}

/** Actual Renderer/VSM/Surface chain. Counterfactual control copies main
 * selected work into shadow inputs only in the oracle; no production switch. */
export async function runGeometryShadowViewGpuOracle() {
  const width = 384,
    height = 224;
  const renderer = new Renderer({
    autoExposure: false,
    fixedExposure: 1,
    requiredFeatures: ["timestamp-query"],
  });
  const canvas = new OffscreenCanvas(width, height);
  await renderer.initialize({ context: canvas.getContext("webgpu") });
  renderer.resize(width, height);
  renderer.temporal_jitter_enabled = false;
  const device = renderer.device,
    errors = [],
    retained = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  const scene = new Scene();
  scene.physical_environment.setSun([0, 5 / Math.hypot(5, 3), 3 / Math.hypot(5, 3)], [8, 8, 8]);
  scene.physical_environment.setSkyLuminanceScale(0);
  const geometry = new BoxGeometry(1, 1, 1);
  const asset = await cookGeometryAssetPackage(buildBoxSourceGeometry(1, 1, 1), createGeometryCookRecipe());
  const receiverMaterial = new StandardShadeMaterial();
  const casterMaterial = new StandardShadeMaterial();
  casterMaterial.transparency_mode = ShadeTransparencyMode.AlphaTested;
  casterMaterial.texture_albedo = await authoredTexture("base-color-srgb", () => [255, 255, 255, 102]);
  casterMaterial.alpha_cutoff = 0.2;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const receiverMatrix = [...identity],
    casterMatrix = [...identity];
  receiverMatrix[0] = 6;
  receiverMatrix[5] = 6;
  receiverMatrix[10] = 0.1;
  casterMatrix[13] = 5;
  casterMatrix[14] = 3;
  const receiver = Mesh.from(geometry, receiverMaterial, receiverMatrix);
  const caster = Mesh.from(geometry, casterMaterial, casterMatrix);
  const occluderMatrix = [...identity];
  occluderMatrix[0] = 1.6;
  occluderMatrix[5] = 1.6;
  occluderMatrix[12] = 10000;
  occluderMatrix[13] = 1.2;
  occluderMatrix[14] = 5;
  const occluder = Mesh.from(geometry, receiverMaterial, occluderMatrix);
  scene.add([receiver, caster, occluder]);
  const distant = [];
  for (let index = 0; index < 128; index++) {
    const matrix = [...casterMatrix];
    matrix[12] = 5000 + index;
    const mesh = Mesh.from(geometry, casterMaterial, matrix);
    distant.push(mesh);
  }
  scene.add(distant);
  const adapted = createPackedSceneSourceFromScene(scene, [{ geometry, asset: asset.asset }]);
  const receiverSlot = adapted.meshes.indexOf(receiver),
    casterSlot = adapted.meshes.indexOf(caster);
  const occluderSlot = adapted.meshes.indexOf(occluder);
  adapted.source.flags[receiverSlot] = GPU_INSTANCE_FLAGS.ReceivesShadow;
  adapted.source.flags[casterSlot] = GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.AlphaTested;
  adapted.source.flags[occluderSlot] = GPU_INSTANCE_FLAGS.ReceivesShadow;
  for (const mesh of distant)
    adapted.source.flags[adapted.meshes.indexOf(mesh)] =
      GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.AlphaTested;
  const camera = new PerspectiveCamera();
  camera.aspect = width / height;
  camera.fov_degrees = 60;
  camera.transform.position.set(0, 0, 8);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  const makeRead = (size) => {
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    retained.push(buffer);
    return buffer;
  };
  let actualFrame,
    actualJob,
    capture,
    baseline = false,
    abort = false,
    broad = false,
    clipOverride = null;
  let shadowCpuMs = 0;
  const shadowCounters = device.createBuffer({
    size: GPU_COUNTER_BYTE_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  retained.push(shadowCounters);
  const mainCounters = device.createBuffer({
    size: GPU_COUNTER_BYTE_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  retained.push(mainCounters);
  const visibility = renderer._visibilityFeature,
    prepare = visibility.prepare.bind(visibility);
  visibility.prepare = (job, ...rest) => {
    const prepared = prepare({ ...job, countersEnabled: true }, mainCounters, ...rest.slice(1));
    actualJob = { ...job, prepared };
    return prepared;
  };
  const mainHierarchy = visibility.implementation.hierarchyGenerator,
    encodeMain = mainHierarchy.encode.bind(mainHierarchy);
  mainHierarchy.encode = (encoder, ...rest) => {
    encoder.clearBuffer(mainCounters);
    return encodeMain(encoder, ...rest);
  };
  const shadowOwner = visibility.shadow,
    encodeShadow = shadowOwner.encode.bind(shadowOwner);
  const prepareShadowHierarchy = shadowOwner.hierarchy.prepare.bind(shadowOwner.hierarchy);
  shadowOwner.hierarchy.prepare = (scene, config) =>
    prepareShadowHierarchy(
      { ...scene, counterBuffer: shadowCounters },
      { ...config, countersEnabled: true, diagnosticsEnabled: true },
    );
  shadowOwner.encode = (job, prepared, command) => {
    const start = performance.now();
    command.gpu_encoder.clearBuffer(shadowCounters);
    // Oracle-only pass labels distinguish views without modifying production shaders.
    const encoder = command.gpu_encoder;
    const scopedEncoder = new Proxy(encoder, {
      get(target, key) {
        if (key === "beginComputePass")
          return (descriptor) =>
            target.beginComputePass({
              ...descriptor,
              label: `Shadow/${descriptor?.label ?? "work"}`,
            });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scopedCommand = new Proxy(command, {
      get(target, key) {
        if (key === "gpu_encoder") return scopedEncoder;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clips = clipOverride ?? (broad ? [[-10000, -10000, 20000, 1]] : null);
    const shadowJob = clips ? { ...job, shadowFrame: { ...job.shadowFrame, clipOriginExtent: clips } } : job;
    encodeShadow(shadowJob, prepared, scopedCommand);
    if (baseline) {
      const main = actualJob.prepared.workSet;
      command.gpu_encoder.copyBufferToBuffer(
        main.meshletWorkCandidate.queue,
        0,
        prepared.work.queue,
        0,
        main.meshletWorkCandidate.queue.size,
      );
    }
    shadowCpuMs = performance.now() - start;
  };
  const surface = renderer._surface,
    prepareSurface = surface.prepareFrameNow.bind(surface);
  surface.prepareFrameNow = (frame, ...rest) => {
    actualFrame = frame;
    return prepareSurface(frame, ...rest);
  };
  const encodeSurface = surface.encode.bind(surface);
  surface.encode = (encoder) => {
    encodeSurface(encoder);
    if (abort) throw new Error("injected shadow chain abort");
    const pitch = Math.ceil((width * 8) / 256) * 256;
    const hdr = makeRead(pitch * height),
      main = makeRead(actualFrame.geometry.meshletWork.size);
    const shadow = makeRead(actualJob.prepared.shadowGeometry.work.queue.size);
    const casters = makeRead(renderer._vsm.casterRecords.size);
    const keyPitch = Math.ceil((width * 4) / 256) * 256,
      winner = makeRead(keyPitch * height);
    const shadowStats = makeRead(GPU_COUNTER_BYTE_SIZE * 2),
      selectedStats = makeRead(64);
    encoder.copyBufferToBuffer(shadowCounters, 0, shadowStats, 0, GPU_COUNTER_BYTE_SIZE);
    encoder.copyBufferToBuffer(mainCounters, 0, shadowStats, GPU_COUNTER_BYTE_SIZE, GPU_COUNTER_BYTE_SIZE);
    encoder.copyBufferToBuffer(
      actualJob.prepared.workSet.hierarchy.generated.visibleClusters,
      0,
      selectedStats,
      0,
      32,
    );
    encoder.copyBufferToBuffer(
      actualJob.prepared.shadowGeometry.hierarchy.generated.visibleClusters,
      0,
      selectedStats,
      32,
      32,
    );
    encoder.copyTextureToBuffer({ texture: actualFrame.output }, { buffer: hdr, bytesPerRow: pitch }, [
      width,
      height,
    ]);
    encoder.copyTextureToBuffer(
      { texture: actualFrame.visibility },
      { buffer: winner, bytesPerRow: keyPitch },
      [width, height],
    );
    for (const [source, destination] of [
      [actualFrame.geometry.meshletWork, main],
      [actualJob.prepared.shadowGeometry.work.queue, shadow],
      [renderer._vsm.casterRecords, casters],
    ]) {
      encoder.copyBufferToBuffer(source, 0, destination, 0, destination.size);
    }
    capture = { hdr, main, shadow, casters, pitch, winner, keyPitch, shadowStats, selectedStats };
  };
  const tick = async () => {
    const frame = renderer.frame_count;
    for (let attempt = 0; attempt < 200; attempt++) {
      renderer.render(camera, scene);
      await device.queue.onSubmittedWorkDone();
      if (renderer.frame_count > frame) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Shadow production readiness timed out");
  };
  const inspect = async (name) => {
    assert.deepEqual(errors, [], `${name}: production device errors`);
    const reads = [
      capture.hdr,
      capture.main,
      capture.shadow,
      capture.casters,
      capture.winner,
      capture.shadowStats,
      capture.selectedStats,
    ];
    await Promise.all(reads.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
    const [hdr, main, shadow, casters, winner, shadowStats, selectedStats] = reads.map((buffer) =>
      buffer.getMappedRange().slice(0),
    );
    reads.forEach((buffer) => buffer.unmap());
    const selected = (bytes) => {
      const words = new Uint32Array(bytes);
      assert.equal(words[4] + words[6], 0, `${name}: complete work`);
      return [...new Set(Array.from({ length: words[1] }, (_, index) => words[8 + index * 6]))].sort();
    };
    const casterWords = new Uint32Array(casters);
    assert.equal(casterWords[2], 0, `${name}: caster queue cannot truncate`);
    const casterInstances = [
      ...new Set(Array.from({ length: casterWords[1] }, (_, index) => casterWords[4 + index * 8])),
    ].sort();
    const values = new Uint16Array(hdr);
    let radiance = 0,
      samples = 0;
    const winnerCounts = {},
      keys = new Uint32Array(winner),
      mainWords = new Uint32Array(main);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const key = keys[(y * capture.keyPitch) / 4 + x];
        if (key === 0xffffffff) continue;
        assert.ok(key !== 0xfffffffe && (key & 0xffffff) < mainWords[1], `${name}: valid winner`);
        const instance = mainWords[8 + (key & 0xffffff) * 6];
        winnerCounts[instance] = (winnerCounts[instance] ?? 0) + 1;
      }
    // The independent light ray from (0,5,3) lands near the receiver center.
    for (let y = height / 2 - 6; y < height / 2 + 6; y++) {
      for (let x = width / 2 - 6; x < width / 2 + 6; x++) {
        const value = decodeFloat16(values[(y * capture.pitch + x * 8) / 2]);
        assert.ok(Number.isFinite(value) && value >= 0, `${name}: finite HDR`);
        radiance += value;
        samples++;
      }
    }
    const counter = (name, main = false) =>
      new Uint32Array(shadowStats)[counterByteOffset(name) / 4 + (main ? GPU_COUNTER_BYTE_SIZE / 4 : 0)];
    return {
      name,
      mainInstances: selected(main),
      shadowInstances: selected(shadow),
      casterInstances,
      winnerCounts,
      workCounts: {
        mainH: counter("geometryNodesTested", true),
        mainE: counter("traversalQueueReservations", true),
        mainC: new Uint32Array(selectedStats)[0],
        mainM: mainWords[1],
        shadowH: counter("geometryNodesTested"),
        shadowE: counter("traversalQueueReservations"),
        shadowC: new Uint32Array(selectedStats)[8],
        shadowM: new Uint32Array(shadow)[1],
      },
      casterRecords: casterWords[1],
      receiverRadiance: radiance / samples,
      shadowQueueBytes: capture.shadow.size,
      shadowInstancesBytes: actualJob.prepared.shadowGeometry.instances.byteLength,
    };
  };
  try {
    await renderer.uploadPackedScene(scene, adapted.source);
    const instanceBegin = renderer.graphics.render_world.runtime(scene).instanceBegin;
    const receiverIndex = instanceBegin + receiverSlot,
      casterIndex = instanceBegin + casterSlot;
    baseline = true;
    await tick();
    const old = await inspect("main-selected-counterfactual");
    assert.deepEqual(
      old.mainInstances,
      [receiverIndex],
      `Caster must really be outside main camera: ${JSON.stringify(old)}`,
    );
    assert.deepEqual(old.casterInstances, [], "Main selected work misses off-camera caster");
    baseline = false;
    renderer.invalidateTemporalHistory();
    await tick();
    const independent = await inspect("independent-shadow-view");
    assert.deepEqual(independent.mainInstances, [receiverIndex]);
    assert.deepEqual(independent.shadowInstances, [casterIndex]);
    assert.deepEqual(independent.casterInstances, [casterIndex]);
    assert.ok(
      independent.receiverRadiance < old.receiverRadiance * 0.8,
      `Off-camera caster must darken visible receiver: ${JSON.stringify({ old, independent })}`,
    );
    casterMaterial.alpha_cutoff = 0.8;
    await tick();
    const alphaDiscard = await inspect("alpha-discard");
    assert.ok(
      alphaDiscard.receiverRadiance > independent.receiverRadiance * 1.2,
      "VSM must respect native alpha",
    );
    casterMaterial.alpha_cutoff = 0.2;
    abort = true;
    const before = renderer._temporal.histories.state("identity").readIndex;
    let failure;
    for (let attempt = 0; attempt < 200 && !failure; attempt++) {
      try {
        renderer.render(camera, scene);
      } catch (error) {
        failure = error;
      }
      if (!failure) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      failure?.message.includes("injected shadow chain abort"),
      "Expected shadow-chain abort must propagate",
    );
    assert.equal(
      renderer._temporal.histories.state("identity").readIndex,
      before,
      "Abort cannot publish history",
    );
    abort = false;
    await tick();
    const retry = await inspect("abort-retry");
    assert.deepEqual(retry.casterInstances, [casterIndex]);
    assert.ok(retry.receiverRadiance < alphaDiscard.receiverRadiance * 0.8);
    caster.transform_local.position.set(2, 5, 3);
    caster.transform_local.updateMatrix();
    caster.updateMatrices();
    caster.needsUpdate = true;
    renderer.graphics.render_world.queuePatch(scene, {
      frameId: renderer.frame_count,
      transforms: {
        indices: new Uint32Array([casterSlot]),
        transforms: new Float32Array(caster.transform_global.matrix),
      },
    });
    await tick();
    const casterMoved = await inspect("caster-moved");
    assert.ok(
      casterMoved.receiverRadiance > independent.receiverRadiance + 0.1,
      `Moving caster must update shadow: ${JSON.stringify({ casterMoved, matrix: [...caster.transform_global.matrix], generation: actualJob.shadowFrame.generation })}`,
    );
    caster.transform_local.position.set(0, 5, 3);
    caster.transform_local.updateMatrix();
    caster.updateMatrices();
    caster.needsUpdate = true;
    receiver.transform_local.position.set(0.5, 0, 0);
    receiver.transform_local.updateMatrix();
    receiver.updateMatrices();
    receiver.needsUpdate = true;
    renderer.graphics.render_world.queuePatch(scene, {
      frameId: renderer.frame_count,
      transforms: {
        indices: new Uint32Array([casterSlot, receiverSlot]),
        transforms: new Float32Array([
          ...caster.transform_global.matrix,
          ...receiver.transform_global.matrix,
        ]),
      },
    });
    await tick();
    const receiverMoved = await inspect("receiver-moved");
    assert.deepEqual(receiverMoved.mainInstances, [receiverIndex]);
    assert.deepEqual(receiverMoved.casterInstances, [casterIndex]);
    renderer.profiler.setMode("record");
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 1,
      gpuTimingMode: "full",
      historyCapacity: 128,
    });
    for (let frame = 0; frame < 32; frame++) await tick();
    const measurements = [];
    for (const mode of ["clipmap", "broad", "clipmap-control", "clean-clipmap", "empty"]) {
      broad = mode.startsWith("broad");
      clipOverride = mode.startsWith("empty") ? [[20000, 20000, 1, 1]] : null;
      const first = renderer.frame_count;
      const cpuSamples = [];
      for (let sample = 0; sample < 16; sample++) {
        // Same mathematical Sun; an authored publication makes pages dirty.
        if (mode !== "clean-clipmap")
          scene.physical_environment.setSun([0, 5 / Math.hypot(5, 3), 3 / Math.hypot(5, 3)], [8, 8, 8]);
        await tick();
        cpuSamples.push(shadowCpuMs);
      }
      const selected = await inspect(mode);
      for (let wait = 0; wait < 100; wait++) {
        if (
          renderer.profiler.history.filter((p) => p.frameIndex >= first && p.gpu.sampled && !p.gpu.pending)
            .length === 16
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const profiles = renderer.profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + 16 && p.gpu.sampled && !p.gpu.pending,
      );
      assert.equal(profiles.length, 16, "Complete diagnostic GPU sample set");
      assert.ok(
        profiles.every((p) => !p.counters["gpu.timing.truncated"] && p.submits.count === 1),
        "Complete single-submit work",
      );
      const labels = [
        ...new Set(
          profiles.flatMap((p) => p.gpu.segments.filter((s) => s.scope === "pass").map((s) => s.label)),
        ),
      ];
      const passMs = Object.fromEntries(
        labels.map((label) => {
          const values = profiles
            .map((p) =>
              p.gpu.segments
                .filter((s) => s.scope === "pass" && s.label === label)
                .reduce((sum, s) => sum + s.durationMs, 0),
            )
            .sort((a, b) => a - b);
          return [label, { p50: values[7], p95: values[15] }];
        }),
      );
      const percentile = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return { p50: sorted[7], p95: sorted[15] };
      };
      const totals = (pattern) =>
        percentile(
          profiles.map((p) =>
            p.gpu.segments
              .filter((s) => s.scope === "pass" && pattern.test(s.label))
              .reduce((sum, s) => sum + s.durationMs, 0),
          ),
        );
      measurements.push({
        mode,
        selected,
        passMs,
        shadowEncodeMs: percentile(cpuSamples),
        mainGpuMs: totals(/^(?!.*\/Shadow\/).*(R3-D|MeshletWork|frame_instance)/),
        shadowGpuMs: totals(/\/Shadow\//),
        casterGpuMs: totals(/VSM.*caster|VSM\/finalize raster indirect/),
        shadowPassCount: profiles[0].gpu.segments.filter(
          (s) => s.scope === "pass" && s.label.includes("/Shadow/"),
        ).length,
        shadowHierarchyBytes: shadowOwner.hierarchy.evidence(actualJob.prepared.shadowGeometry.hierarchy)
          .transientBytes,
        mainInstances: actualJob.prepared.workSet.frameInstances.byteLength,
        shadowHierarchyDepth: actualJob.runtime.hierarchyMaxDepth,
        shadowRounds: actualJob.prepared.shadowGeometry.hierarchy.generated.encodedRoundCount,
      });
      const empty = mode.startsWith("empty");
      assert.equal(
        selected.shadowInstances.length,
        empty ? 0 : broad ? 129 : 1,
        `${mode}: the counterfactual must actually change selected work`,
      );
      assert.deepEqual(
        selected.casterInstances,
        empty || mode === "clean-clipmap" ? [] : [casterIndex],
        `${mode}: complete dirty-page caster set`,
      );
      if (!empty)
        assert.ok(
          selected.receiverRadiance < old.receiverRadiance * 0.8,
          `${mode}: same visible receiver shadow`,
        );
    }
    broad = false;
    clipOverride = null;
    // Visible to the camera frustum but hidden by a non-shadow-casting blocker.
    // The light direction still projects this caster onto the visible center.
    scene.physical_environment.setSun([0, 2 / Math.hypot(2, 3), 3 / Math.hypot(2, 3)], [8, 8, 8]);
    caster.transform_local.position.set(0, 2, 3);
    caster.transform_local.updateMatrix();
    caster.updateMatrices();
    receiver.transform_local.position.set(0, 0, 0);
    receiver.transform_local.updateMatrix();
    receiver.updateMatrices();
    occluder.transform_local.position.set(0, 1.2, 5);
    occluder.transform_local.updateMatrix();
    occluder.updateMatrices();
    renderer.graphics.render_world.queuePatch(scene, {
      frameId: renderer.frame_count,
      transforms: {
        indices: new Uint32Array([casterSlot, receiverSlot, occluderSlot]),
        transforms: new Float32Array([
          ...caster.transform_global.matrix,
          ...receiver.transform_global.matrix,
          ...occluder.transform_global.matrix,
        ]),
      },
    });
    for (let frame = 0; frame < 8; frame++) await tick();
    const cameraOccluded = await inspect("camera-occluded-caster");
    assert.equal(
      cameraOccluded.winnerCounts[casterIndex] ?? 0,
      0,
      `Caster must be camera-occluded; conservative main work may survive: ${JSON.stringify(cameraOccluded)}`,
    );
    assert.deepEqual(cameraOccluded.shadowInstances, [casterIndex]);
    scene.physical_environment.setSun([0, 2 / Math.hypot(2, 3), 3 / Math.hypot(2, 3)], [8, 8, 8]);
    await tick();
    const occludedDirty = await inspect("camera-occluded-dirty-caster");
    assert.deepEqual(occludedDirty.casterInstances, [casterIndex]);
    casterMaterial.alpha_cutoff = 0.8;
    await tick();
    const occludedDiscard = await inspect("camera-occluded-alpha-discard");
    assert.ok(
      occludedDiscard.receiverRadiance > occludedDirty.receiverRadiance + 0.1,
      `Camera-hidden caster must affect HDR: ${JSON.stringify({ occludedDirty, occludedDiscard })}`,
    );
    const lightView = actualJob.shadowFrame.lightView;
    const lightX = lightView[4] * 2 + lightView[8] * 3 + lightView[12];
    const lightY = lightView[5] * 2 + lightView[9] * 3 + lightView[13];
    // Geometry-only light-prism edge controls: retain intersecting bounds,
    // reject only when the complete caster lies beyond the prism.
    clipOverride = [[lightX + 0.49, lightY - 0.5, 1, 1]];
    await tick();
    const clipEdge = await inspect("light-clip-edge");
    assert.deepEqual(clipEdge.shadowInstances, [casterIndex]);
    clipOverride = [[lightX + 3, lightY - 0.5, 1, 1]];
    await tick();
    const clipOutside = await inspect("light-clip-outside");
    assert.deepEqual(clipOutside.shadowInstances, []);
    clipOverride = null;
    const headerCases = await checkCasterHeaders(device);
    assert.deepEqual(errors, []);
    return {
      verdict: "passed",
      old,
      independent,
      alphaDiscard,
      retry,
      casterMoved,
      receiverMoved,
      measurements,
      cameraOccluded,
      occludedDirty,
      occludedDiscard,
      clipEdge,
      clipOutside,
      headerCases,
      limitations: "Small ordinary Geometry; Product paging/deep/scale and recovery use separate oracles.",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    renderer.destroy();
    for (const buffer of retained) buffer.destroy();
  }
}
