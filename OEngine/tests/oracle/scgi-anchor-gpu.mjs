import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import { ScgiCache } from "../../.test-dist/render/gi/ScgiCache.js";
import { ScgiAnchors } from "../../.test-dist/render/gi/ScgiAnchors.js";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { packScgiCoefficients } from "../../.test-dist/render/gi/ScgiAbi.js";
import { scgiGraphics, scgiCommand, scgiProfile } from "./scgi-fixture.mjs";
import { createNativeSurfaceFixture, identity } from "./native-surface-fixture.mjs";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import {
  packGpuInstanceRecord,
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_WGSL,
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { FINAL_PIXEL_DIRECTORY_WGSL } from "../../.test-dist/gpu/FinalPixelAbi.js";
import { nativeTemporalSeedWgsl } from "../../.test-dist/shaders/native_temporal_seed.js";
import { SCGI_ABI_WGSL } from "../../.test-dist/render/gi/ScgiAbi.js";
import {
  GPU_FRAME_INSTANCE_STRIDE,
  GPU_FRAME_INSTANCE_OFFSETS,
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import {
  packGpuMeshletWorkQueueHeader,
  packGpuMeshletRasterWork,
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

export async function runScgiAnchorGpuOracle(device) {
  const graphics = scgiGraphics(device);
  const runtime = new ScgiRuntime(device, 1);
  const fixture = await createNativeSurfaceFixture(device, {
    width: 8,
    height: 8,
    cellPixels: 4,
    instanceCount: 1,
  });
  const resources = [];
  const storage = (data) => {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(buffer, 0, data);
    resources.push(buffer);
    return buffer;
  };
  try {
    const profile = { ...scgiProfile, width: 7, height: 5, patches: 32, requests: 32, updates: 8 };
    const plan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      profile,
    );
    const anchors = await ScgiAnchors.create(device, plan, false);
    // Compile the mixed Product decoder too; this alone is not Product runtime evidence.
    await ScgiAnchors.create(device, plan, true);
    const cache = await ScgiCache.create(device, plan);
    const lineage = storage(new Uint32Array([1, 7, 0, 7]));
    const material = storage(new Uint32Array([4, 1, 12, 0, 0, 0, 0, 0, 0, 23, 0, 0]));
    // Existing fixture has a +Z plane at .5. A view with z translation -1
    // gives positive .5 depth, and inverse projection retains exact raster clip.
    const currentView = [...identity];
    currentView[14] = -1;
    const previousProjection = [...identity];
    previousProjection[14] = 1;
    const view = {
      currentView,
      inverseViewProjection: identity,
      previousView: currentView,
      previousProjection,
      previousInverseViewProjection: identity,
      camera: [0, 0, 1],
      previousValid: true,
    };
    // Set dynamic revision zero in the authoritative fixture record. No fake
    // deformation publication is installed; missing-previous rejection is tested below.
    device.queue.writeBuffer(fixture.geometry.instances, 160, new Uint32Array([0]));
    const input = {
      work: fixture.geometry.meshletWork,
      metadata: fixture.sparseShading.assetMetadataHeap,
      vertices: fixture.geometry.vertexPayload,
      instances: fixture.geometry.instances,
      identities: lineage,
      materials: material,
      visibility: fixture.visibility.createView(),
      source: fixture.geometry.source,
      sourcePayload: fixture.geometry.sourcePayload,
    };
    const keys = new Uint32Array(64).fill(0xffffffff);
    // Single primitive across all pixels; plane oracle doesn't require rasterization.
    // Visibility is fixture input, not evidence for the query/coverage producer.
    keys.fill(0);
    device.queue.writeTexture({ texture: fixture.visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
    const settings = {
      frame: 1,
      originEpoch: 1,
      camera: [0, 0, 0],
      voxelSize: 1,
      bounceEnabled: true,
      evictionAge: 100,
      moveBudget: 0,
      normalCosine: 0.9,
      planeDistanceScale: 0.1,
      updateAge: 4,
      varianceThreshold: 1,
    };
    const read = (command, buffer) => {
      const target = device.createBuffer({
        size: buffer.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      resources.push(target);
      command.copyBufferToBuffer(buffer, 0, target, 0, buffer.size);
      return async () => {
        await target.mapAsync(GPUMapMode.READ);
        const bytes = target.getMappedRange().slice(0);
        target.unmap();
        return bytes;
      };
    };
    const command = scgiCommand(graphics);
    const tx = runtime.prepare(command, { scene: 1, view: 1 });
    runtime.encode(tx);
    anchors.encodeAnchors(tx, input, view);
    cache.encode(tx, settings);
    anchors.encodeSeeds(tx, { distance: 0.1, normalCosine: 0.9, tangentDistance: 1 });
    const getAnchors = read(command, tx.publication.anchors[0].buffer);
    const getWorld = read(command, tx.publication.candidateWorld.buffer);
    command.finish();
    await command.gpuDone;
    const anchorBytes = await getAnchors();
    const floats = new Float32Array(anchorBytes);
    const words = new Uint32Array(anchorBytes);
    for (let h = 0; h < plan.halfPixels; h++) {
      const at = h * 32;
      check(floats[at + 3] === 1, `anchor ${h} valid`);
      const source = words[at + 7];
      const x = source % 7,
        y = Math.floor(source / 7);
      check(x === (h % 4) * 2 && y === Math.floor(h / 4) * 2, `odd extent source ${h}`);
      check(Math.abs(floats[at] - (((x + 0.5) / 7) * 2 - 1)) < 1e-5, "analytic world X");
      check(Math.abs(floats[at + 1] - (1 - ((y + 0.5) / 5) * 2)) < 1e-5, "analytic world Y");
      check(Math.abs(floats[at + 2] - 0.5) < 1e-5, "analytic world plane");
      check(
        floats[at + 11] === 1 && Math.abs(floats[at + 12]) < 1e-7 && Math.abs(floats[at + 13]) < 1e-7,
        `stationary jitter-consistent motion ${h}: ${floats[at + 11]}, ${floats[at + 12]}, ${floats[at + 13]}`,
      );
      check(
        words[at + 16] === 1 && words[at + 17] === 7 && words[at + 26] === 23,
        "full exact scene/material identity",
      );
    }
    const world = new Uint32Array(await getWorld());
    check(world[18] > 0, "real anchor requests feed cache allocation");
    await checkNativeParity(device, graphics, runtime, anchors, input, view, storage, resources);
    await checkRigidAnchors(device, graphics, runtime, anchors, input, view, read);
    let frame = 1;
    const coefficients = [2, 3, 4, 0.25, -0.5, 0.75, 1, -1, 2, 0.5, 0.25, -0.25];
    const resetHistory = async (change = () => {}) => {
      // Authored committed world-only field fixture. This is not an estimator;
      // its purpose is to isolate the real history acceptance/initialization.
      const command = scgiCommand(graphics);
      const tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      const fields = new ArrayBuffer(plan.halfPixels * 112);
      const u = new Uint32Array(fields),
        f = new Float32Array(fields);
      for (let h = 0; h < plan.halfPixels; h++) {
        const at = h * 28;
        u.set(packScgiCoefficients(coefficients, 2), at);
        f[at + 8] = 0.5;
        u[at + 9] = 0; // oct +Z
        u[at + 10] = Math.floor(h / 4) * 2 * 7 + (h % 4) * 2;
        u[at + 11] = 1;
        u.set(words.subarray(16, 32), at + 12);
        change(u, f, at);
      }
      command.uploadRegions([
        {
          destination: tx.publication.candidateWorldField.segments[0].buffer,
          destinationOffset: 0,
          bytes: new Uint8Array(fields),
        },
      ]);
      // Empty previous world forces allocation without falsifying newness after
      // allocation. Map and liveness form a consistent fixture publication.
      const map = new Uint32Array(plan.cells * 2);
      for (let cell = 0; cell < plan.cells; cell++) map[cell * 2] = 0xffffffff;
      command.uploadRegions([
        {
          destination: tx.publication.candidateWorld.buffer,
          destinationOffset: plan.world.ranges.map.offset,
          bytes: new Uint8Array(map.buffer),
        },
        {
          destination: tx.publication.candidateWorld.buffer,
          destinationOffset: 64,
          bytes: new Uint8Array(16),
        },
      ]);
      command.gpu_encoder.clearBuffer(
        tx.publication.candidateWorld.buffer,
        plan.world.ranges.cacheState.offset,
        plan.world.ranges.cacheState.bytes,
      );
      tx.markFieldComplete(2);
      command.finish();
      await command.gpuDone;
    };
    const seedCase = async (name, accepted, options = {}) => {
      await resetHistory(options.change);
      const command = scgiCommand(graphics);
      const tx = runtime.prepare(command, { scene: 1, view: options.viewEpoch ?? 1 });
      runtime.encode(tx);
      const testView = { ...view, previousValid: options.previousValid ?? true };
      anchors.encodeAnchors(tx, input, testView);
      cache.encode(tx, { ...settings, frame: ++frame, originEpoch: options.originEpoch ?? 1 });
      anchors.encodeSeeds(tx, { distance: 0.1, normalCosine: 0.9, tangentDistance: 2 });
      if (options.abort) {
        const serial = runtime.sampleSerial;
        command.abort(new Error("seed fixture abort"));
        check(runtime.sampleSerial === serial, "aborted seed cannot advance phase");
        frame--;
        return seedCase(name + " retry", accepted, { ...options, abort: false });
      }
      const get = read(command, tx.publication.candidateWorld.buffer);
      command.finish();
      await command.gpuDone;
      const bytes = await get();
      const u = new Uint32Array(bytes),
        f = new Float32Array(bytes);
      let live = 0,
        seeded = 0;
      for (let slot = 0; slot < profile.patches; slot++) {
        if (!u[plan.world.ranges.cacheState.offset / 4 + slot * 4 + 3]) continue;
        live++;
        const at = plan.world.ranges.patches.offset / 4 + slot * 76;
        if (u[at + 69]) {
          seeded++;
          for (let lane = 0; lane < 12; lane++) {
            check(
              f[at + 40 + lane] === coefficients[lane] && f[at + 52 + lane] === coefficients[lane],
              `${name}: A0/A2 preserve previous coefficient scale`,
            );
          }
          check(u[at + 24] === 0 && u[at + 25] === 0, `${name}: seed is not a query cohort`);
          check(f[at + 35] === 1 && f[at + 39] === 1, `${name}: statistics validity`);
        }
      }
      check(live > 0 && (accepted ? seeded === live : seeded === 0), `${name}: ${seeded}/${live}`);
    };
    await seedCase("committed field", true);
    await seedCase("abort", true, { abort: true });
    await seedCase("instance slot reuse", false, {
      change: (u, f, at) => {
        u[at + 12]++;
      },
    });
    await seedCase("same primitive in another local instance", false, {
      change: (u, f, at) => {
        u[at + 14]++;
      },
    });
    await seedCase("same set and slot with another lifetime", false, {
      change: (u, f, at) => {
        u[at + 15]++;
      },
    });
    await seedCase("material value", false, {
      change: (u, f, at) => {
        u[at + 22]++;
      },
    });
    await seedCase("local primitive", false, {
      change: (u, f, at) => {
        u[at + 24]++;
      },
    });
    await seedCase("opposite normal", false, {
      change: (u, f, at) => {
        u[at + 9] = 0x7fff7fff;
      },
    });
    await seedCase("behind receiver", false, {
      change: (u, f, at) => {
        f[at + 8] = 0.9;
      },
    });
    await seedCase("in front of receiver", false, {
      change: (u, f, at) => {
        f[at + 8] = 0.1;
      },
    });
    await seedCase("invalid depth", false, {
      change: (u, f, at) => {
        f[at + 8] = NaN;
      },
    });
    await seedCase("camera cut", false, { previousValid: false });
    await seedCase("view epoch", false, { viewEpoch: 2 });
    await seedCase("origin epoch", false, { originEpoch: 2 });
    device.queue.writeBuffer(fixture.geometry.instances, 160, new Uint32Array([1]));
    await seedCase("no previous deformation", false);
    device.queue.writeBuffer(fixture.geometry.instances, 160, new Uint32Array([0]));
    // Camera publication is captured by anchor encoding. A later caller mutation
    // must not reinterpret these anchors with another previous view.
    await resetHistory();
    const capturedCommand = scgiCommand(graphics);
    const capturedTx = runtime.prepare(capturedCommand, { scene: 1, view: 1 });
    runtime.encode(capturedTx);
    const mutablePrevious = [...view.previousView];
    anchors.encodeAnchors(capturedTx, input, { ...view, previousView: mutablePrevious });
    mutablePrevious[14] = -200;
    cache.encode(capturedTx, { ...settings, frame: ++frame });
    anchors.encodeSeeds(capturedTx, { distance: 0.1, normalCosine: 0.9, tangentDistance: 2 });
    const getCaptured = read(capturedCommand, capturedTx.publication.candidateWorld.buffer);
    capturedCommand.finish();
    await capturedCommand.gpuDone;
    const captured = new Uint32Array(await getCaptured());
    let capturedSeeds = 0;
    for (let slot = 0; slot < profile.patches; slot++) {
      capturedSeeds += Number(captured[plan.world.ranges.patches.offset / 4 + slot * 76 + 69] !== 0);
    }
    check(capturedSeeds > 0, "seed uses the camera snapshot captured by anchors");
    await checkProductAnchors(device, graphics, runtime, plan, fixture, input, view, storage, read);
    // Sky must overwrite the complete previous valid anchor domain.
    keys.fill(0xffffffff);
    device.queue.writeTexture({ texture: fixture.visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
    const skyCommand = scgiCommand(graphics);
    const skyTx = runtime.prepare(skyCommand, { scene: 1, view: 1 });
    runtime.encode(skyTx);
    anchors.encodeAnchors(skyTx, input, view);
    const getSky = read(skyCommand, skyTx.publication.anchors[0].buffer);
    skyCommand.finish();
    await skyCommand.gpuDone;
    const sky = new Float32Array(await getSky());
    for (let h = 0; h < plan.halfPixels; h++) check(sky[h * 32 + 3] === 0, "sky complete invalid write");
    const fairPlan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      { ...profile, requests: 3 },
    );
    const fairAnchors = await ScgiAnchors.create(device, fairPlan, false);
    keys.fill(0);
    device.queue.writeTexture({ texture: fixture.visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
    const visited = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 1) {
        const command = scgiCommand(graphics);
        const tx = runtime.prepare(command, { scene: 1, view: 1 });
        runtime.encode(tx);
        fairAnchors.encodeAnchors(tx, input, view);
        const serial = runtime.sampleSerial;
        command.abort(new Error("bounded request window abort"));
        check(runtime.sampleSerial === serial, "aborted request window retains exact phase");
      }
      const command = scgiCommand(graphics);
      const tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      fairAnchors.encodeAnchors(tx, input, view);
      const get = read(command, tx.publication.privateScratch.buffer);
      const getAnchor = read(command, tx.publication.anchors[0].buffer);
      const start = Number((BigInt(tx.publication.sampleSerial) * 3n) % 12n);
      command.finish();
      await command.gpuDone;
      const u = new Uint32Array(await get());
      const records = fairPlan.scratch.ranges.requests.offset / 4;
      const selected = Array.from({ length: 3 }, (_, index) => u[records + index * 28 + 22]);
      const expected = Array.from({ length: 3 }, (_, index) => (start + index) % 12);
      check(
        expected.every((value) => selected.includes(value)),
        "bounded global request window exact membership",
      );
      selected.forEach((value) => visited.add(value));
      const a = new Uint32Array(await getAnchor());
      const corner = tx.publication.sampleSerial % 4;
      check(a[7] === (corner & 1) + (corner >> 1) * 7, "actual 2x2 winner rotates only on submit");
    }
    check(visited.size === 12, "every anchor receives service within the complete Q/H cycle");
    await checkSegmentedSeed(device, graphics, fixture, input, view, settings, resources);
    await checkSceneLineage(device, graphics, resources);
    const dimensions = [];
    for (const [width, height] of [
      [1, 1],
      [1919, 1079],
    ]) {
      const sizeProfile = { ...profile, width, height, requests: 3 };
      const sizePlan = await runtime.configure(
        { enabled: true, hasGeometry: true, hasLitMaterials: true },
        sizeProfile,
      );
      const sizeAnchors = await ScgiAnchors.create(device, sizePlan, false);
      const texture = device.createTexture({
        size: [width, height],
        format: "r32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resources.push(texture);
      const values = new Uint32Array(width * height).fill(0xffffffff);
      const expected = [];
      // A one-pixel rod at odd coordinate must be found even when the preferred
      // corner is empty. Last odd row/column also has a valid receiver.
      for (let h = 0; h < sizePlan.halfPixels; h++) {
        const x = Math.min(width - 1, (h % sizePlan.halfWidth) * 2 + 1);
        const y = Math.min(height - 1, Math.floor(h / sizePlan.halfWidth) * 2 + 1);
        values[y * width + x] = 0;
        expected.push(y * width + x);
      }
      device.queue.writeTexture({ texture }, values, { bytesPerRow: width * 4 }, [width, height]);
      const command = scgiCommand(graphics);
      const tx = runtime.prepare(command, { scene: 1, view: 1 });
      check(
        tx.publication.previousWorldField === null && tx.publication.activeWorld !== null,
        "resize resets only screen roles",
      );
      runtime.encode(tx);
      const start = performance.now();
      sizeAnchors.encodeAnchors(tx, { ...input, visibility: texture.createView() }, view);
      const get = read(command, tx.publication.anchors[0].buffer);
      const getScratch = read(command, tx.publication.privateScratch.buffer);
      command.finish();
      await command.gpuDone;
      const bytes = await get();
      const u = new Uint32Array(bytes),
        f = new Float32Array(bytes);
      for (let h = 0; h < sizePlan.halfPixels; h++) {
        check(f[h * 32 + 3] === 1 && u[h * 32 + 7] === expected[h], "complete odd/rod anchor source");
      }
      const scratch = new Uint32Array(await getScratch());
      const control = sizePlan.scratch.ranges.cacheControl.offset / 4;
      check(scratch[control] === Math.min(3, sizePlan.halfPixels), "bounded GPU demand count");
      check(scratch[control + 7] === Math.max(0, sizePlan.halfPixels - 3), "observable deferred demand");
      dimensions.push({
        width,
        height,
        halfPixels: sizePlan.halfPixels,
        anchorBytes: sizePlan.anchorBytes,
        wallMs: performance.now() - start,
        includesReadback: true,
      });
    }
    return {
      passed: true,
      results: [
        "odd half extent, independent plane/motion oracle, exact lineage and GPU anchor-to-cache",
        "Native seed same-primitive parity and independent camera translation/rotation/180-degree/teleport projection oracle",
        "nonuniform and negative rigid scale current/previous world positions, geometric normal orientation and motion",
        "committed world-only seed A0/A2/count/scale, abort retry, identity/normal/bidirectional depth/cut/origin/deformation rejection, complete sky writes",
        "real multi-Product resident page decode, exact local asset identity and physical page relocation invariance",
        "complete bounded request fairness cycle, actual winner phase and abort retry",
        "forced three-segment anchor/history allocation, cross-segment seed addressing and unique patch writes",
        "real GpuScene identity upload/grow/abort/retry/same-range replacement lifecycle",
        "1x1 and 1919x1079 complete receiver domain, one-pixel rods, resize world retention and bounded deferred requests",
      ],
      dimensions,
      scope: "SCGI-4 infrastructure; shared SCGI-2 deformation/coverage prerequisite still incomplete",
    };
  } finally {
    runtime.destroy();
    await device.queue.onSubmittedWorkDone();
    for (const buffer of resources) buffer.destroy();
    fixture.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}

async function checkRigidAnchors(device, graphics, runtime, anchors, input, view, read) {
  for (const scale of [
    [2, 0.5, 1],
    [-1, 2, 0.5],
  ]) {
    const fixture = await createNativeSurfaceFixture(device, {
      width: 8,
      height: 8,
      cellPixels: 4,
      instanceCount: 1,
      scale,
    });
    try {
      device.queue.writeBuffer(fixture.geometry.instances, 160, new Uint32Array([0]));
      device.queue.writeTexture(
        { texture: fixture.visibility },
        new Uint32Array(64),
        { bytesPerRow: 32 },
        [8, 8],
      );
      const command = scgiCommand(graphics),
        tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      anchors.encodeAnchors(
        tx,
        {
          ...input,
          work: fixture.geometry.meshletWork,
          instances: fixture.geometry.instances,
          metadata: fixture.sparseShading.assetMetadataHeap,
          vertices: fixture.geometry.vertexPayload,
          visibility: fixture.visibility.createView(),
          source: fixture.geometry.source,
          sourcePayload: fixture.geometry.sourcePayload,
        },
        view,
      );
      const get = read(command, tx.publication.anchors[0].buffer);
      command.finish();
      await command.gpuDone;
      const bytes = await get(),
        f = new Float32Array(bytes),
        u = new Uint32Array(bytes);
      for (let h = 0; h < 12; h++) {
        const at = h * 32,
          pixel = u[at + 7],
          x = pixel % 7,
          y = Math.floor(pixel / 7);
        const position = [((x + 0.5) / 7) * 2 - 1, 1 - ((y + 0.5) / 5) * 2, scale[2] * 0.5];
        check(f[at + 3] === 1, "rigid anchor remains valid");
        for (let lane = 0; lane < 3; lane++) {
          check(Math.abs(f[at + lane] - position[lane]) < 1e-6, "rigid current world position");
          check(
            Math.abs(f[at + 8 + lane] - position[lane] / scale[lane]) < 1e-6,
            "rigid previous world position from inverse current transform",
          );
        }
        check(
          Math.abs(f[at + 6] - Math.sign(scale[0] * scale[1])) < 1e-6,
          "geometric normal follows negative determinant winding",
        );
        const previousUV = [(position[0] / scale[0]) * 0.5 + 0.5, -(position[1] / scale[1]) * 0.5 + 0.5];
        const valid = previousUV.every((value) => value >= 0 && value < 1);
        check(f[at + 11] === Number(valid), "rigid previous viewport validity");
        check(
          Math.abs(f[at + 14] - 0.5) < 1e-6 && Math.abs(f[at + 15] - (1 - position[2])) < 1e-6,
          "rigid positive depths",
        );
        if (valid) {
          check(
            Math.abs(f[at + 12] - ((x + 0.5) / 7 - previousUV[0])) < 1e-6 &&
              Math.abs(f[at + 13] - ((y + 0.5) / 5 - previousUV[1])) < 1e-6,
            "rigid analytic motion",
          );
        }
      }
    } finally {
      await device.queue.onSubmittedWorkDone();
      fixture.destroy();
    }
  }
}

async function checkSceneLineage(device, graphics, resources) {
  const scene = new GpuScene(device, { publicationIdentity: () => ({ slot: 1, generation: 3 }) });
  const source = (count) => {
    const transforms = new Float32Array(count * 16);
    for (let index = 0; index < count; index++) transforms.set(identity, index * 16);
    return {
      count,
      geometryHandles: [{}],
      geometryIndices: new Uint32Array(count),
      materialHandles: new Uint32Array(count),
      currentTransforms: transforms,
      boundsSpheres: new Float32Array(count * 4).fill(1),
    };
  };
  const observe = async () => {
    const command = scgiCommand(graphics),
      buffer = scene.bindings().identities;
    const read = device.createBuffer({
      size: buffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(read);
    command.copyBufferToBuffer(buffer, 0, read, 0, buffer.size);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    return words;
  };
  try {
    const command = scgiCommand(graphics),
      handle = scene.instantiate(source(2), command);
    command.finish();
    await command.gpuDone;
    const initial = await observe(),
      initialBuffer = scene.bindings().identities;
    check(
      initial[4] === 1 && initial[5] === 1 && initial[6] === 0 && initial[7] === 1,
      "real scene exact lineage record",
    );
    const aborted = scgiCommand(graphics);
    scene.append(handle, source(32), new Uint32Array(2), aborted);
    aborted.abort(new Error("lineage growth abort"));
    check(
      scene.bindings().identities === initialBuffer && scene.range(handle).count === 2,
      "abort retains instance and identity publication together",
    );
    const afterAbort = await observe();
    check(
      initial.every((value, lane) => value === afterAbort[lane]),
      "aborted upload cannot mutate active lineage",
    );
    const retry = scgiCommand(graphics);
    scene.append(handle, source(32), new Uint32Array(2), retry);
    retry.finish();
    await retry.gpuDone;
    const grown = await observe();
    check(scene.bindings().identities !== initialBuffer, "growth replaces identity buffer");
    for (let index = 0; index < 34; index++) {
      const at = (index + 1) * 4;
      check(
        grown[at] === 1 && grown[at + 1] === 1 && grown[at + 2] === index && grown[at + 3] === 1,
        "growth copies old lineage and appends exact local slots",
      );
    }
    const replacementCommand = scgiCommand(graphics);
    scene.release(handle, replacementCommand);
    const replacement = scene.instantiate(source(2), replacementCommand);
    replacementCommand.finish();
    await replacementCommand.gpuDone;
    const replaced = await observe();
    check(
      scene.range(replacement).start === 1 &&
        replaced[4] === initial[4] &&
        replaced[6] === initial[6] &&
        replaced[5] > initial[5] &&
        replaced[7] > initial[7],
      "same physical range changes exact lifetime",
    );
  } finally {
    await device.queue.onSubmittedWorkDone();
    scene.destroy();
  }
}

async function checkSegmentedSeed(device, graphics, fixture, input, view, settings, resources) {
  // Smaller binding limit exercises production segmentation on a tiny domain;
  // actual shaders, resources and command owner still execute on the real device.
  const limitedDevice = new Proxy(device, {
    get(target, key) {
      if (key === "limits") {
        return new Proxy(target.limits, {
          get(limits, name) {
            return name === "maxStorageBufferBindingSize" ? 65536 : Reflect.get(limits, name, limits);
          },
        });
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = new ScgiRuntime(limitedDevice, 1);
  const limitedGraphics = { ...graphics, device: limitedDevice };
  const width = 65,
    height = 65;
  const profile = { ...scgiProfile, width, height, patches: 16, requests: 16 };
  const texture = device.createTexture({
    size: [width, height],
    format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  resources.push(texture);
  device.queue.writeTexture({ texture }, new Uint32Array(width * height), { bytesPerRow: width * 4 }, [
    width,
    height,
  ]);
  const read = (command, source) => {
    const buffer = device.createBuffer({
      size: source.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(buffer);
    command.copyBufferToBuffer(source, 0, buffer, 0, source.size);
    return async () => {
      await buffer.mapAsync(GPUMapMode.READ);
      const result = buffer.getMappedRange().slice(0);
      buffer.unmap();
      return result;
    };
  };
  try {
    const plan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      profile,
    );
    check(plan.anchors.length === 3 && plan.screen.length === 3, "forced segmented physical profile");
    const owner = await ScgiAnchors.create(limitedDevice, plan, false);
    const cache = await ScgiCache.create(limitedDevice, plan);
    const selectedInput = { ...input, visibility: texture.createView() };
    const firstCommand = scgiCommand(limitedGraphics);
    const first = runtime.prepare(firstCommand, { scene: 1, view: 1 });
    runtime.encode(first);
    owner.encodeAnchors(first, selectedInput, view);
    cache.encode(first, settings);
    const getAnchors = first.publication.anchors.map((segment) => read(firstCommand, segment.buffer));
    firstCommand.finish();
    await firstCommand.gpuDone;
    const bytes = await getAnchors[0]();
    const identityWords = new Uint32Array(bytes).slice(16, 32);
    for (let index = 1; index < getAnchors.length; index++) {
      const words = new Uint32Array(await getAnchors[index]());
      check(words[7] !== 0xffffffff && words[16] === identityWords[0], "complete anchor segment writes");
    }
    // Rotate the global window to a receiver in segment 1, not just segment 0.
    while ((runtime.sampleSerial * profile.requests) % plan.halfPixels < 512) {
      const command = scgiCommand(limitedGraphics),
        tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      command.finish();
      await command.gpuDone;
    }
    const historyCommand = scgiCommand(limitedGraphics);
    const history = runtime.prepare(historyCommand, { scene: 1, view: 1 });
    runtime.encode(history);
    let firstPixel = 0;
    for (const segment of history.publication.candidateWorldField.segments) {
      const count = segment.plan.ranges.worldField.count;
      const values = new ArrayBuffer(count * 112),
        words = new Uint32Array(values),
        floats = new Float32Array(values);
      for (let local = 0; local < count; local++) {
        const h = firstPixel + local,
          at = local * 28;
        words.set(packScgiCoefficients([2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1), at);
        floats[at + 8] = 0.5;
        words[at + 10] = Math.floor(h / 33) * 2 * width + (h % 33) * 2;
        words[at + 11] = 1;
        words.set(identityWords, at + 12);
      }
      historyCommand.uploadRegions([
        { destination: segment.buffer, destinationOffset: 0, bytes: new Uint8Array(values) },
      ]);
      firstPixel += count;
    }
    const map = new Uint32Array(plan.cells * 2);
    for (let cell = 0; cell < plan.cells; cell++) map[cell * 2] = 0xffffffff;
    historyCommand.uploadRegions([
      {
        destination: history.publication.candidateWorld.buffer,
        destinationOffset: plan.world.ranges.map.offset,
        bytes: new Uint8Array(map.buffer),
      },
    ]);
    historyCommand.clearBuffer(
      history.publication.candidateWorld.buffer,
      plan.world.ranges.cacheState.offset,
      plan.world.ranges.cacheState.bytes,
    );
    history.markFieldComplete();
    historyCommand.finish();
    await historyCommand.gpuDone;
    const command = scgiCommand(limitedGraphics),
      tx = runtime.prepare(command, { scene: 1, view: 1 });
    runtime.encode(tx);
    owner.encodeAnchors(tx, selectedInput, view);
    cache.encode(tx, { ...settings, frame: settings.frame + 1 });
    owner.encodeSeeds(tx, { distance: 0.1, normalCosine: 0.9, tangentDistance: 1 });
    const get = read(command, tx.publication.candidateWorld.buffer);
    const getScratch = read(command, tx.publication.privateScratch.buffer);
    command.finish();
    await command.gpuDone;
    const world = new Uint32Array(await get()),
      scratch = new Uint32Array(await getScratch());
    let seeds = 0;
    for (let slot = 0; slot < profile.patches; slot++) {
      const at = plan.world.ranges.patches.offset / 4 + slot * 76;
      if (world[at + 69]) {
        const source = scratch[plan.scratch.ranges.seedSources.offset / 4 + slot] - 1;
        check(source >= 512 && source < 1024, "seed receiver and previous history cross segment zero");
        check(new Float32Array(world.buffer)[at + 40] === 2, "segmented seed coefficient");
        seeds++;
      }
    }
    check(seeds > 0, "segmented seed has real valid writes");
  } finally {
    runtime.destroy();
    await device.queue.onSubmittedWorkDone();
  }
}

async function checkNativeParity(device, graphics, runtime, anchors, input, view, storage, resources) {
  const module = device.createShaderModule({
    label: "SCGI anchor to actual Native seed parity",
    code: `${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${FINAL_PIXEL_DIRECTORY_WGSL}
${SCGI_ABI_WGSL}
${nativeTemporalSeedWgsl(0, 1, 2, 3)}
@group(0) @binding(0) var<uniform> camera: NativeTemporalSeedView;
@group(0) @binding(4) var<storage, read> primary: array<ScgiAnchor>;
@group(0) @binding(5) var<storage, read> instances: array<OEngineInstanceRecord>;
fn seed_view() -> NativeTemporalSeedView { return camera; }
@compute @workgroup_size(1)
fn main() {
  let anchor = primary[0];
  let pixel = vec2u(anchor.sourcePixel % camera.control.x, anchor.sourcePixel / camera.control.x);
  var work: OEngineMeshletRasterWork;
  var entry: NativeMaterialDirectoryEntry;
  entry.value_revision = 23u;
  let currentView = mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,-1,1));
  seed_surface(pixel, vec3f(anchor.positionValid[0], anchor.positionValid[1], anchor.positionValid[2]),
    currentView, instances[0], work, entry, false);
}`,
  });
  const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
  check(errors.length === 0, errors.map((value) => value.message).join("\n"));
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const texture = (format) => {
    const value = device.createTexture({
      size: [7, 5],
      format,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    resources.push(value);
    return value;
  };
  const seed = texture("rgba32float"),
    response = texture("rgba8unorm"),
    identityTexture = texture("rgba32uint");
  const sourceInstance = storage(
    packGpuInstanceRecord({
      geometryRecordIndex: 1,
      geometryGeneration: 3,
      instanceSetGeneration: 7,
      materialHandle: 0,
      flags: GPU_INSTANCE_FLAGS.Active,
      debugId: 0,
      boundsSphere: [0, 0, 0, 2],
      boundsMin: [-1, -1, 0],
      boundsMax: [1, 1, 1],
      currentObjectToWorld: identity,
      previousObjectToWorld: identity,
      dynamicRevision: 0,
    }),
  );
  const rotate = (angle) => {
    const matrix = [...view.previousView];
    matrix[0] = matrix[5] = Math.cos(angle);
    matrix[1] = Math.sin(angle);
    matrix[4] = -Math.sin(angle);
    return matrix;
  };
  const translated = [...view.previousView];
  translated[12] = 0.05;
  const teleport = [...view.previousView];
  teleport[12] = 10;
  for (const previousView of [view.previousView, translated, rotate(0.1), rotate(Math.PI), teleport]) {
    const command = scgiCommand(graphics);
    const tx = runtime.prepare(command, { scene: 1, view: 1 });
    runtime.encode(tx);
    anchors.encodeAnchors(tx, input, { ...view, previousView });
    const bytes = new ArrayBuffer(272),
      floats = new Float32Array(bytes),
      words = new Uint32Array(bytes);
    floats.set(identity, 0);
    floats.set(identity, 16);
    floats.set(previousView, 32);
    floats.set(view.previousProjection, 48);
    words.set([7, 5, 1, 0], 64);
    const camera = device.createBuffer({
      size: 272,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    resources.push(camera);
    device.queue.writeBuffer(camera, 0, bytes);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: camera } },
        { binding: 1, resource: seed.createView() },
        { binding: 2, resource: response.createView() },
        { binding: 3, resource: identityTexture.createView() },
        { binding: 4, resource: { buffer: tx.publication.anchors[0].buffer } },
        { binding: 5, resource: { buffer: sourceInstance } },
      ],
    });
    const pass = command.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    const read = device.createBuffer({
      size: 256 * 5 + 128,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const anchorRead = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(read, anchorRead);
    command.gpu_encoder.copyTextureToBuffer({ texture: seed }, { buffer: read, bytesPerRow: 256 }, [7, 5]);
    command.copyBufferToBuffer(tx.publication.anchors[0].buffer, 0, anchorRead, 0, 128);
    command.finish();
    await command.gpuDone;
    await anchorRead.mapAsync(GPUMapMode.READ);
    await read.mapAsync(GPUMapMode.READ);
    const mappedAnchor = anchorRead.getMappedRange();
    const af = new Float32Array(mappedAnchor),
      au = new Uint32Array(mappedAnchor);
    const source = au[7],
      x = source % 7,
      y = Math.floor(source / 7);
    const actual = new Float32Array(read.getMappedRange(), y * 256 + x * 16, 4);
    const multiply = (matrix, value) =>
      Array.from(
        { length: 4 },
        (_, row) =>
          matrix[row] * value[0] +
          matrix[row + 4] * value[1] +
          matrix[row + 8] * value[2] +
          matrix[row + 12] * value[3],
      );
    const position = [af[0], af[1], af[2], 1];
    const old = multiply(previousView, position),
      clip = multiply(view.previousProjection, old);
    const uv = [(clip[0] / clip[3]) * 0.5 + 0.5, (-clip[1] / clip[3]) * 0.5 + 0.5];
    const valid = uv.every((value) => value >= 0 && value < 1) && clip[2] >= 0 && clip[2] <= clip[3];
    check(af[11] === Number(valid), "independent camera projection validity");
    const expected = [
      valid ? (x + 0.5) / 7 - uv[0] : 0,
      valid ? (y + 0.5) / 5 - uv[1] : 0,
      Math.max(-old[2], 0),
      0.5,
    ];
    for (let lane = 0; lane < 4; lane++) {
      const anchorValue = lane < 2 && !valid ? 0 : af[12 + lane];
      check(
        Math.abs(actual[lane] - anchorValue) < 1e-6,
        "Native seed and anchor same-primitive motion/depth parity",
      );
      check(Math.abs(actual[lane] - expected[lane]) < 1e-6, "independent camera motion/depth projection");
    }
    read.unmap();
    anchorRead.unmap();
  }
}

async function checkProductAnchors(device, graphics, runtime, plan, fixture, input, view, storage, read) {
  const products = new GeometryProductMultiRuntimeV1(device);
  try {
    const handles = [];
    const pages = [];
    for (let index = 0; index < 2; index++) {
      const { descriptor, page } = triangleProductFixture();
      descriptor.productId.fill(index + 17);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page)).slice(0, 16);
      descriptor.pageRecords.set(hash);
      handles.push(
        await products.load({
          descriptor,
          async readPage(pageId) {
            check(pageId === 0, "Product fixture page");
            return {
              productId: descriptor.productId,
              revision: descriptor.revision,
              pageId,
              decodedHash128: hash,
              decodedPageHash128: hash,
              bytes: page.slice().buffer,
            };
          },
          release() {},
        }),
      );
      pages.push(page);
    }
    const owner = await ScgiAnchors.create(device, plan, true);
    const current = [...identity];
    current[14] = 0.5;
    const values = [];
    for (let index = 0; index < handles.length; index++) {
      const handle = handles[index];
      const frame = new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);
      frame.set(
        packGpuInstanceRecord({
          geometryRecordIndex: handle.assetReferenceBegin,
          geometryGeneration: handle.productGeneration,
          productTableSlot: handle.productTableSlot,
          instanceSetGeneration: 7,
          materialHandle: 0,
          flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry,
          debugId: 0,
          boundsSphere: [0, 0, 0, 1],
          boundsMin: [-1, -1, 0],
          boundsMax: [1, 1, 0],
          currentObjectToWorld: current,
          previousObjectToWorld: current,
          dynamicRevision: 0,
        }),
      );
      new Float32Array(frame.buffer).set(current, GPU_FRAME_INSTANCE_OFFSETS.objectToClip / 4);
      new DataView(frame.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation, 11, true);
      const work = new Uint8Array(56);
      work.set(
        packGpuMeshletWorkQueueHeader({
          attemptedCount: 1,
          writtenCount: 1,
          consumedCount: 0,
          capacity: 1,
          overflowCount: 0,
          generation: 11,
          invalidCount: 0,
        }),
      );
      work.set(
        packGpuMeshletRasterWork({
          instanceSlot: 0,
          geometrySlot: handle.assetReferenceBegin,
          meshletSlot: products.tableRecord(handle.productTableSlot).groupBegin * 128,
          materialSlotOrRange: 0,
          packedRasterFlags: 0,
          packedProfileLod: 0,
        }),
        32,
      );
      const binding = products.bindings();
      const product = [binding.metadata, ...binding.banks];
      const productInput = { ...input, instances: storage(frame), work: storage(work), product };
      const evaluate = async (selected) => {
        const command = scgiCommand(graphics);
        const tx = runtime.prepare(command, { scene: 1, view: 1 });
        runtime.encode(tx);
        owner.encodeAnchors(tx, selected, view);
        const get = read(command, tx.publication.anchors[0].buffer);
        command.finish();
        await command.gpuDone;
        const bytes = await get();
        const u = new Uint32Array(bytes),
          f = new Float32Array(bytes);
        check(
          f[3] === 1 && Math.abs(f[2] - 0.5) < 1e-6,
          `real resident Product position ${index}: ${[...f.slice(0, 4)]}, identity ${[...u.slice(16, 32)]}, reference ${handle.assetReferenceBegin}, slot ${handle.productTableSlot}`,
        );
        check(
          u[20] === handle.productTableSlot &&
            u[21] === handle.productGeneration &&
            u[22] === 0 &&
            u[24] === 0,
          "global Product reference resolves exact local asset zero",
        );
        return u.slice(16, 32);
      };
      const before = await evaluate(productInput);
      // Physical-address perturbation isolates identity from residency. Original
      // pages come from the real owner above; this deliberate address-table input
      // is not evidence for SCGI-2 page-lease/relocation transaction completion.
      const location = handle.residency.pageLocation(0);
      const address = products.pageLocationAddress(handle.productTableSlot, handle.productGeneration, 0);
      const relocated = new Uint8Array(512 + pages[index].byteLength);
      relocated.set(pages[index], 512);
      const replacement = storage(relocated);
      const alteredBanks = [...product];
      alteredBanks[location.bankIndex + 1] = replacement;
      device.queue.writeBuffer(address.buffer, address.byteOffset + 4, new Uint32Array([512]));
      const after = await evaluate({ ...productInput, product: alteredBanks });
      check(
        before.every((value, lane) => value === after[lane]),
        "page relocation preserves exact identity",
      );
      device.queue.writeBuffer(
        address.buffer,
        address.byteOffset + 4,
        new Uint32Array([location.byteOffset]),
      );
      values.push(before);
    }
    check(values[0][4] !== values[1][4], "same asset and primitive in different Products never alias");
  } finally {
    await device.queue.onSubmittedWorkDone();
    products.destroy();
  }
}
