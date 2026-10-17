import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GpuNativeMaterialScene } from "../../.test-dist/gpu/GpuNativeMaterialScene.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import {
  ShaderModuleCache,
  PipelineLayoutCache,
  RenderPipelineCache
} from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { lowerStandardAppearanceGraph } from "../../.test-dist/material/StandardAppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { FrameInstanceTransforms } from "../../.test-dist/render/FrameInstanceTransforms.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import {
  packGpuMeshletWorkQueueHeader,
  packGpuMeshletRasterWork
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import { ScgiAnchors } from "../../.test-dist/render/gi/ScgiAnchors.js";
import { ScgiCache } from "../../.test-dist/render/gi/ScgiCache.js";
import { ScgiFilter } from "../../.test-dist/render/gi/ScgiFilter.js";
import { filterSettings } from "./scgi-filter-gpu.mjs";
import { packScgiIrradiance } from "../../.test-dist/render/gi/ScgiAbi.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { scgiCommand, scgiGraphics, scgiProfile } from "./scgi-fixture.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const expectThrow = (action, pattern) => {
  let failure;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  check(pattern.test(String(failure)), `expected ${pattern}, got ${failure}`);
};

/** Tiny real owner chain, without Renderer activation or an estimator fixture.
 * Visibility is one authored winner; the history radiance is an isolated input.
 * Scene, Product, frame transforms, Native publication, anchor, allocation and
 * seed are the actual owners used by the engine. */
export async function runScgiAnchorPublicationGpuOracle(device) {
  const graphics = scgiGraphics(device);
  graphics.appearance_programs = new AppearanceProgramRegistry(device);
  graphics.samplers = new GPUSamplerCache(device);
  graphics.render_pipelines = new RenderPipelineCache(
    device,
    new PipelineLayoutCache(device),
    new ShaderModuleCache(device)
  );
  // Texture-free material: no texture owner is substituted for a sampled input.
  graphics.texture_residency = { retainQuery: () => ({ valid: true, release() {} }) };
  const resources = [];
  const leases = [];
  const storage = (data, usage = GPUBufferUsage.STORAGE) => {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    device.queue.writeBuffer(buffer, 0, data);
    resources.push(buffer);
    return buffer;
  };
  const products = new GeometryProductMultiRuntimeV1(device);
  const scene = new GpuScene(device, {});
  const frames = new FrameInstanceTransforms(device);
  const runtime = new ScgiRuntime(device, 1);
  let native;
  try {
    const { descriptor, page } = triangleProductFixture();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page)).slice(0, 16);
    descriptor.pageRecords.set(hash);
    const product = await products.load({
      descriptor,
      async readPage(pageId) {
        return {
          productId: descriptor.productId,
          revision: descriptor.revision,
          pageId,
          bytes: page.slice().buffer,
          decodedHash128: hash,
          decodedPageHash128: hash
        };
      },
      release() {}
    });
    const current = [...identity];
    current[0] = -2;
    current[5] = 3;
    current[10] = 0.5;
    current[14] = 0.5;
    const source = () => ({
      count: 1,
      geometryHandles: [],
      virtualGeometry: {
        productTableSlot: product.productTableSlot,
        productGeneration: product.productGeneration,
        assetCount: 1
      },
      geometryIndices: new Uint32Array([product.assetReferenceBegin]),
      materialHandles: new Uint32Array([0]),
      currentTransforms: new Float32Array(current),
      previousTransforms: new Float32Array(current),
      boundsSpheres: new Float32Array([0, 0, 0, 1]),
      boundsMin: new Float32Array([-0.5, -0.5, 0]),
      boundsMax: new Float32Array([0.5, 0.5, 0])
    });
    const upload = scgiCommand(graphics);
    let handle = scene.instantiate(source(), upload);
    const material = new StandardShadeMaterial();
    native = new GpuNativeMaterialScene(
      graphics,
      [
        {
          materialSlot: 0,
          material,
          graph: compileAppearanceGraph(lowerStandardAppearanceGraph(material, [])),
          textureBindingSetId: 0,
          textureRefs: new Map()
        }
      ],
      () => [{ id: 0, generation: 1, textureBanks: [] }],
      new Map(),
      new Map(),
      upload,
      true,
      false
    );
    await native.ready;
    await frames.ready;
    upload.finish();
    await upload.gpuDone;
    const profile = { ...scgiProfile, width: 1, height: 1 };
    const plan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      profile
    );
    const anchors = await ScgiAnchors.create(device, plan, true);
    const cache = await ScgiCache.create(device, plan);
    const cameraBytes = new Float32Array(PACKED_CAMERA_TYPE.size / 4);
    cameraBytes.set(identity, PACKED_CAMERA_TYPE.get("view_projection_matrix").offset / 4);
    const camera = storage(cameraBytes, GPUBufferUsage.UNIFORM);
    const workBytes = new Uint8Array(56);
    workBytes.set(
      packGpuMeshletWorkQueueHeader({
        attemptedCount: 1,
        writtenCount: 1,
        consumedCount: 0,
        capacity: 1,
        overflowCount: 0,
        generation: 11,
        invalidCount: 0
      })
    );
    const workRecord = {
      instanceSlot: scene.range(handle).start,
      geometrySlot: product.assetReferenceBegin,
      meshletSlot: products.tableRecord(product.productTableSlot).groupBegin * 128,
      materialSlotOrRange: 0,
      packedRasterFlags: 0,
      packedProfileLod: 0
    };
    workBytes.set(packGpuMeshletRasterWork(workRecord), 32);
    const work = storage(workBytes);
    const unused = storage(new Uint32Array(4));
    const visibility = device.createTexture({
      size: [1, 1],
      format: "r32uint",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
    });
    resources.push(visibility);
    device.queue.writeTexture({ texture: visibility }, new Uint32Array([0]), {}, [1, 1]);
    const viewMatrix = [...identity];
    viewMatrix[14] = -1;
    const previousProjection = [...identity];
    previousProjection[14] = 1;
    const view = {
      currentView: viewMatrix,
      inverseViewProjection: identity,
      previousView: viewMatrix,
      previousProjection,
      previousInverseViewProjection: identity,
      camera: [0, 0, 1],
      previousValid: true
    };
    const settings = {
      frame: 1,
      originEpoch: 1,
      camera: [0, 0, 0],
      voxelSize: 1,
      bounceEnabled: false,
      evictionAge: 100,
      moveBudget: 0,
      normalCosine: 0.9,
      planeDistanceScale: 0.1,
      updateAge: 4,
      varianceThreshold: 1
    };
    const read = (command, source) => {
      const buffer = device.createBuffer({
        size: source.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      resources.push(buffer);
      command.copyBufferToBuffer(source, 0, buffer, 0, source.size);
      return async () => {
        await buffer.mapAsync(GPUMapMode.READ);
        const bytes = buffer.getMappedRange().slice(0);
        buffer.unmap();
        return bytes;
      };
    };
    const begin = (command = scgiCommand(graphics)) => {
      const tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      const bindings = scene.queryBindings(command);
      const prepared = frames.prepare({
        camera,
        source: bindings.instances,
        work,
        workCapacity: 1,
      });
      frames.encode(command.gpu_encoder, prepared);
      command.gpuDone.then(
        () => frames.release(prepared),
        () => frames.release(prepared)
      );
      const lease = native.retainQuery(command);
      leases.push(lease);
      anchors.encodeSceneAnchors(
        tx,
        {
          scene,
          frameOwner: frames,
          frameInstances: prepared,
          work,
          metadata: unused,
          vertices: unused,
          materials: lease,
          visibility: visibility.createView(),
          product: products.bindings(),
          source: [0, 0, 0, 0],
          sourcePayload: [0, 0, 0, 0]
        },
        view
      );
      return tx;
    };
    const first = begin();
    cache.encode(first, settings);
    const getFirst = read(first.command, first.publication.anchors[0].buffer);
    first.command.finish();
    await first.completion;
    const firstBytes = await getFirst();
    const firstWords = new Uint32Array(firstBytes);
    const firstFloats = new Float32Array(firstBytes);
    check(
      firstFloats[3] === 1 && firstFloats[11] === 1 && Math.abs(firstFloats[2] - 0.5) < 1e-6,
      "real Product + shared frame producer yields current/previous anchor"
    );
    check(
      Math.abs(firstFloats[4]) < 1e-6 &&
        Math.abs(firstFloats[5]) < 1e-6 &&
        Math.abs(firstFloats[6] + 1) < 1e-6,
      "negative/nonuniform transform preserves geometric winding (f32 normalized cross product)"
    );
    const exactIdentity = firstWords.slice(16, 32);
    check(
      exactIdentity[2] === 0 &&
        exactIdentity[4] === product.productTableSlot &&
        exactIdentity[5] === product.productGeneration &&
        exactIdentity[6] === 0 &&
        exactIdentity[10] === native.publication.entries[0].valueRevision,
      "anchor consumes exact GpuScene lineage, Product identity and real material revision"
    );
    const coefficients = [2, 3, 4, 0.25, -0.5, 0.75, 1, -1, 2, 0.5, 0.25, -0.25];
    const authorHistory = async () => {
      const command = scgiCommand(graphics);
      const tx = runtime.prepare(command, { scene: 1, view: 1 });
      runtime.encode(tx);
      const bytes = new ArrayBuffer(112),
        u = new Uint32Array(bytes),
        f = new Float32Array(bytes);
      u.set(packScgiIrradiance(coefficients, 2));
      f[8] = 0.5;
      u[9] = 0x7fff7fff; // -Z, matching the negative determinant
      u[11] = 3 | (127 << 2) | (65535 << 10);
      u.set(exactIdentity, 12);
      const map = new Uint32Array(plan.cells * 2);
      for (let cell = 0; cell < plan.cells; cell++) map[cell * 2] = 0xffffffff;
      // Let the real cache initialize header/cascades, then author only its
      // empty map/liveness and the deliberately isolated prior field.
      cache.encode(tx, { ...settings, frame: ++settings.frame });
      command.uploadRegions([
        {
          destination: tx.publication.candidateWorld.buffer,
          destinationOffset: plan.world.ranges.map.offset,
          bytes: new Uint8Array(map.buffer)
        },
        {
          destination: tx.publication.candidateWorld.buffer,
          destinationOffset: 64,
          bytes: new Uint8Array(16)
        },
        {
          destination: tx.publication.candidateWorldField.segments[0].buffer,
          destinationOffset: 0,
          bytes: new Uint8Array(bytes)
        }
      ]);
      command.clearBuffer(
        tx.publication.candidateWorld.buffer,
        plan.world.ranges.cacheState.offset,
        plan.world.ranges.cacheState.bytes
      );
      tx.markFieldComplete(2);
      command.finish();
      await tx.completion;
    };
    const seed = async (name, expected, command) => {
      const tx = begin(command);
      cache.encode(tx, { ...settings, frame: ++settings.frame });
      anchors.encodeSeeds(tx, { distance: 0.1, normalCosine: 0.9, tangentDistance: 1 });
      const getWorld = read(tx.command, tx.publication.candidateWorld.buffer);
      const getAnchor = read(tx.command, tx.publication.anchors[0].buffer);
      tx.command.finish();
      await tx.completion;
      const bytes = await getWorld(),
        u = new Uint32Array(bytes),
        f = new Float32Array(bytes);
      let live = 0,
        seeded = 0;
      for (let slot = 0; slot < profile.patches; slot++) {
        if (!u[plan.world.ranges.cacheState.offset / 4 + slot * 4 + 3]) continue;
        live++;
        const at = plan.world.ranges.patches.offset / 4 + slot * 76;
        if (u[at + 69]) {
          seeded++;
          check(u[at + 24] === 0, `${name}: seed cannot fabricate query samples`);
          for (let lane = 0; lane < 12; lane++) {
            check(
              Math.abs(f[at + 40 + lane] - coefficients[lane]) <= 0.0025 * coefficients[lane % 3] &&
                Math.abs(f[at + 52 + lane] - coefficients[lane]) <= 0.0025 * coefficients[lane % 3],
              `${name}: normalized half L0+q quantization bound lane${lane}, actual${f[at + 40 + lane]}`
            );
          }
        }
      }
      check(live === 1 && seeded === Number(expected), `${name}: ${seeded}/${live}`);
      return new Uint32Array(await getAnchor()).slice(16, 32);
    };
    // A real filtered field must also be consumable by the real seed owner.
    // Clear only the world allocation after producing the field to model cold
    // patch allocation while preserving the submitted screen history.
    const filter = await ScgiFilter.create(device, plan);
    const filteredHistory = begin();
    cache.encode(filteredHistory, { ...settings, frame: ++settings.frame });
    const raw = new ArrayBuffer(profile.updates * 64);
    const rawFloats = new Float32Array(raw),
      rawWords = new Uint32Array(raw);
    for (let i = 0; i < profile.updates; i++) {
      rawFloats.set(coefficients, i * 16);
      rawWords.set([8, 8, 1, 0], i * 16 + 12);
    }
    filteredHistory.command.uploadRegions([
      {
        destination: filteredHistory.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.raw.offset,
        bytes: new Uint8Array(raw)
      }
    ]);
    filteredHistory.publication.estimateComplete = true;
    filter.encode(filteredHistory, { ...filterSettings, frame: settings.frame, post: true });
    const emptyMap = new Uint32Array(plan.cells * 2);
    for (let i = 0; i < plan.cells; i++) emptyMap[i * 2] = 0xffffffff;
    filteredHistory.command.uploadRegions([
      {
        destination: filteredHistory.publication.candidateWorld.buffer,
        destinationOffset: plan.world.ranges.map.offset,
        bytes: new Uint8Array(emptyMap.buffer)
      }
    ]);
    filteredHistory.command.clearBuffer(filteredHistory.publication.candidateWorld.buffer, 64, 16);
    filteredHistory.command.clearBuffer(
      filteredHistory.publication.candidateWorld.buffer,
      plan.world.ranges.cacheState.offset,
      plan.world.ranges.cacheState.bytes
    );
    filteredHistory.command.finish();
    await filteredHistory.completion;
    await seed("actual A0/A1/A2 field feeds real publication seed", true);
    await authorHistory();
    await seed("real publication accepts world-only seed", true);
    await authorHistory();
    const aborted = begin();
    const serial = runtime.sampleSerial;
    scene.patch(
      handle,
      {
        frameId: 7,
        transforms: {
          indices: new Uint32Array([0]),
          transforms: new Float32Array(current)
        }
      },
      aborted.command
    );
    expectThrow(() => aborted.command.finish(), /publication changed/);
    check(
      !aborted.command.wasSubmitted && runtime.sampleSerial === serial,
      "late same-buffer scene mutation aborts without publishing anchor/history roles"
    );
    await seed("fresh capture after abort", true);
    await authorHistory();
    const replace = scgiCommand(graphics);
    scene.release(handle, replace);
    handle = scene.instantiate(source(), replace);
    const replacementIdentity = await seed("same physical instance range has a new lifetime", false, replace);
    check(
      replacementIdentity[1] !== exactIdentity[1] && replacementIdentity[10] === exactIdentity[10],
      "instance replacement changes lifetime while retaining material identity"
    );
    exactIdentity.set(replacementIdentity);
    await authorHistory();
    material.roughness_factor = 0.33;
    const deadline = performance.now() + 15000;
    while (!native.canPrepareFrame()) {
      check(performance.now() < deadline, "material preparation timeout");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const lateMaterial = begin();
    native.prepareFrame(lateMaterial.command);
    expectThrow(() => lateMaterial.command.finish(), /publication changed/);
    check(!lateMaterial.command.wasSubmitted, "late material candidate cannot submit stale anchor bytes");
    const changed = scgiCommand(graphics);
    native.prepareFrame(changed);
    const materialIdentity = await seed("new real material value revision rejects old field", false, changed);
    check(
      materialIdentity[1] === exactIdentity[1] && materialIdentity[10] !== exactIdentity[10],
      "material rejection is isolated from instance lifetime rejection"
    );
    return {
      realSceneFrameProductMaterialChain: true,
      exactIdentity: [...exactIdentity],
      acceptedSeed: true,
      sameBufferLateMutationRejected: true,
      abortRetry: true,
      reusedInstanceLifetimeRejected: true,
      changedMaterialRevisionRejected: true,
      lateMaterialRejected: true,
      scope: "one authored visibility winner and world-only history; no estimator/full Renderer claim"
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const lease of leases) lease.release();
    runtime.destroy();
    frames.destroy();
    native?.destroy();
    scene.destroy();
    products.destroy();
    graphics.appearance_programs.destroy();
    for (const resource of resources) resource.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
