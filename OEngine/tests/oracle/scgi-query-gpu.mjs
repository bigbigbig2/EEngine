import assert from "node:assert/strict";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GpuNativeMaterialScene } from "../../.test-dist/gpu/GpuNativeMaterialScene.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import {
  ShaderModuleCache,
  PipelineLayoutCache,
  RenderPipelineCache,
} from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ScgiQueryArena } from "../../.test-dist/render/gi/ScgiQueryArena.js";
import { ScgiQueryScene } from "../../.test-dist/render/gi/ScgiQueryScene.js";
import { ScgiQueryBatch } from "../../.test-dist/render/gi/ScgiQueryBatch.js";
import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { scgiGraphics, scgiCommand } from "./scgi-fixture.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function bytes(device, graphics, buffer, offset, size) {
  const read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const command = scgiCommand(graphics);
    command.copyBufferToBuffer(buffer, offset, read, 0, size);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const value = read.getMappedRange().slice(0);
    read.unmap();
    return value;
  } finally {
    read.destroy();
  }
}

function triangle(origin, direction, vertices, tMin, tMax) {
  // Independent double-precision plane + dot-product barycentric oracle.
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const e1 = sub(vertices[1], vertices[0]),
    e2 = sub(vertices[2], vertices[0]);
  const n = cross(e1, e2),
    denominator = dot(n, direction);
  if (!denominator) return null;
  const t = dot(n, sub(vertices[0], origin)) / denominator;
  if (t < tMin || t > tMax) return null;
  const relative = sub(
    origin.map((v, i) => v + t * direction[i]),
    vertices[0],
  );
  const a = dot(e1, e1),
    b = dot(e1, e2),
    c = dot(e2, e2);
  const u = (dot(relative, e1) * c - dot(relative, e2) * b) / (a * c - b * b);
  const v = (dot(relative, e2) * a - dot(relative, e1) * b) / (a * c - b * b);
  return u >= 0 && v >= 0 && u + v <= 1 ? { t, u, v, front: denominator < 0 } : null;
}

export async function runScgiQueryGpuOracle(device) {
  const graphics = scgiGraphics(device);
  graphics.appearance_programs = new AppearanceProgramRegistry(device);
  graphics.samplers = new GPUSamplerCache(device);
  graphics.render_pipelines = new RenderPipelineCache(
    device,
    new PipelineLayoutCache(device),
    new ShaderModuleCache(device),
  );
  // No sampled textures in this fixture. VT has a separate real atlas oracle.
  graphics.texture_residency = { virtualTextures: null, retainQuery: () => ({ valid: true, release() {} }) };
  const scene = new GpuScene(device, {});
  const products = new GeometryProductMultiRuntimeV1(device);
  const buffers = [],
    scenes = [],
    batches = [];
  let native;
  let querySet;
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
          decodedPageHash128: hash,
        };
      },
      release() {},
    });
    const material = new StandardShadeMaterial(),
      alpha = new StandardShadeMaterial();
    alpha.transparency_mode = 1;
    const graph = (alphaValue) => {
      const builder = new AppearanceGraphBuilder();
      builder.output("baseColor", builder.constant([0.2, 0.4, 0.8]));
      builder.output("emissive", builder.input("cameraPosition", 3, "view"));
      builder.output("alpha", builder.constant(alphaValue));
      return compileAppearanceGraph(builder.build());
    };
    const count = 84;
    const transforms = new Float32Array(count * 16);
    const flags = new Uint32Array(count).fill(1 | 8);
    for (let i = 0; i < count; i++) transforms.set(identity, i * 16);
    // 81 rejected coplanar MASK layers, then opaque / mirrored / double-sided.
    transforms[81 * 16 + 14] = -1;
    transforms[82 * 16] = -2;
    transforms[82 * 16 + 5] = 3;
    transforms[82 * 16 + 10] = 0.5;
    transforms[82 * 16 + 12] = 2;
    transforms[82 * 16 + 14] = -0.5;
    transforms[83 * 16 + 12] = -2;
    transforms[83 * 16 + 14] = -0.5;
    flags[81] = flags[82] = 1;
    flags[83] = 1 | 16;
    const materials = new Uint32Array(count);
    materials.fill(1, 81);
    const upload = scgiCommand(graphics);
    const handle = scene.instantiate(
      {
        count,
        geometryHandles: [],
        virtualGeometry: {
          productTableSlot: product.productTableSlot,
          productGeneration: product.productGeneration,
          assetCount: 1,
        },
        geometryIndices: new Uint32Array(count).fill(product.assetReferenceBegin),
        materialHandles: materials,
        currentTransforms: transforms,
        flags,
        boundsSpheres: new Float32Array(count * 4).fill(1),
        boundsMin: new Float32Array(Array.from({ length: count }, () => [-0.5, -0.5, 0]).flat()),
        boundsMax: new Float32Array(Array.from({ length: count }, () => [0.5, 0.5, 0]).flat()),
      },
      upload,
    );
    native = new GpuNativeMaterialScene(
      graphics,
      [
        { materialSlot: 0, material: alpha, graph: graph(0), textureBindingSetId: 0, textureRefs: new Map() },
        { materialSlot: 1, material, graph: graph(1), textureBindingSetId: 0, textureRefs: new Map() },
      ],
      () => [{ id: 0, generation: 1, textureBanks: [] }],
      new Map(),
      new Map(),
      upload,
      true,
      false,
    );
    await native.ready;
    upload.finish();
    await upload.gpuDone;
    native.setQueryProjectionEnabled(true);
    const deadline = performance.now() + 30000;
    while (!native.canPrepareFrame()) {
      assert.ok(performance.now() < deadline, "Native query projection preparation timed out");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const prepare = scgiCommand(graphics);
    native.prepareFrame(prepare);
    prepare.finish();
    await prepare.gpuDone;
    const runtime = { nativeMaterials: native, virtualGeometry: products };
    const profile = {
      deviceEpoch: 1,
      originEpoch: 0,
      primitiveCapacity: 8,
      maximumBytes: 16 * 1024 ** 2,
      subgroup: false,
      directorySegmentBytes: 160,
      domain: { min: [-20, -20, -20], max: [20, 20, 20] },
    };
    const create = async (previous) => {
      const value = await ScgiQueryScene.create(
        device,
        profile,
        runtime,
        scene,
        [product.residency],
        undefined,
        undefined,
        undefined,
        previous,
      );
      scenes.push(value);
      return value;
    };
    const first = await create();
    assert.equal(first.arenas.length, 1, "one arena spans the complete scene, not source-slot windows");
    assert.equal(first.geometries.length, 1, "one source BLAS for all instances");
    const rayCount = 137;
    const allocate = (size, usage) => {
      const buffer = device.createBuffer({
        size,
        usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      buffers.push(buffer);
      return buffer;
    };
    const batch = allocate(rayCount * 80, GPUBufferUsage.STORAGE);
    const output = allocate(rayCount * 64, GPUBufferUsage.STORAGE);
    const gpuCount = allocate(4, GPUBufferUsage.STORAGE);
    const rays = new ArrayBuffer(rayCount * 48),
      rf = new Float32Array(rays),
      ru = new Uint32Array(rays);
    let random = 0x8a123f17;
    const next = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0) / 2 ** 32;
    };
    for (let i = 0; i < rayCount; i++) {
      rf.set([(next() - 0.5) * 6, (next() - 0.5) * 3, i & 1 ? 1 : -2, 0, 0, 0, i & 1 ? -1 : 1, 10], i * 12);
      ru[i * 12 + 9] = 0xffffffff;
    }
    for (const [i, ray] of [
      [0, [0, 0, 1, 0, 0, 0, -1, 10]],
      [1, [2, 0, 1, 0, 0, 0, -1, 10]],
      [2, [-2, 0, -2, 0, 0, 0, 1, 10]],
      [3, [0, 0, 1, 0, 0, 0, 0, 10]],
      [4, [-0.5, -0.5, 1, 0, 0, 0, -1, 10]],
      [5, [0, 0, 1, 0, 1, 0, 0, 10]],
      [6, [0, 0, 1, 3, 0, 0, -1, 10]],
      [7, [0, 0, -1, 0.001, 0, 0, -1, 10]],
      [8, [0, 0, 1, 0, 0, 0, -1e-20, 10]],
      [9, [0, 0, 1, 0, 0, 0, -1e20, 10]],
      [10, [NaN, 0, 1, 0, 0, 0, -1, 10]],
    ])
      rf.set(ray, i * 12);
    const settings = {
      diagnostics: true,
      batch,
      rayCount,
      resultByteOffset: rayCount * 48,
      output,
      view: identity,
      camera: [2, 3, 4],
      coneWidth: 0.01,
      coneSpread: 0.001,
      count: { buffer: gpuCount, byteOffset: 0 },
    };
    const query = await ScgiQueryBatch.create(device, first, settings);
    batches.push(query);
    assert.equal(query.viewDependent, true);
    querySet = device.createQuerySet({ type: "timestamp", count: 8 });
    const stamp = (command, index, end = false) => {
      const pass = command.gpu_encoder.beginComputePass({
        timestampWrites: {
          querySet,
          ...(end ? { endOfPassWriteIndex: index } : { beginningOfPassWriteIndex: index }),
        },
      });
      pass.end();
    };
    const buildCommand = scgiCommand(graphics);
    buildCommand.uploadRegions([
      { destination: batch, destinationOffset: 0, bytes: new Uint8Array(rays) },
      {
        destination: gpuCount,
        destinationOffset: 0,
        bytes: new Uint8Array(new Uint32Array([rayCount]).buffer),
      },
    ]);
    stamp(buildCommand, 0);
    first.encode(buildCommand);
    stamp(buildCommand, 1, true);
    stamp(buildCommand, 4);
    query.encode(buildCommand);
    stamp(buildCommand, 5, true);
    buildCommand.finish();
    await buildCommand.gpuDone;
    const result = await bytes(device, graphics, batch, rayCount * 48, rayCount * 32);
    const u = new Uint32Array(result),
      f = new Float32Array(result);
    const local = [
      [-0.5, -0.5, 0],
      [0.5, -0.5, 0],
      [0, 0.5, 0],
    ];
    for (let ray = 0; ray < rayCount; ray++) {
      if (ray === 3 || ray === 10) {
        assert.equal(u[ray * 8 + 3], 5, "zero direction is a numerical fault");
        continue;
      }
      if (ray === 9) {
        assert.equal(u[ray * 8 + 3], 2, "finite ray escaping the certified domain is unknown");
        continue;
      }
      const origin = [...rf.subarray(ray * 12, ray * 12 + 3)],
        direction = [...rf.subarray(ray * 12 + 4, ray * 12 + 7)];
      let expected = null;
      for (let instance = 81; instance < count; instance++) {
        const m = transforms.subarray(instance * 16, instance * 16 + 16);
        const vertices = local.map((p) => [m[0] * p[0] + m[12], m[5] * p[1] + m[13], m[10] * p[2] + m[14]]);
        const hit = triangle(origin, direction, vertices, rf[ray * 12 + 3], rf[ray * 12 + 7]);
        if (hit && (!expected || hit.t < expected.t)) expected = { ...hit, instance };
      }
      const status = expected ? (!expected.front && !(flags[expected.instance] & 16) ? 3 : 0) : 1;
      assert.equal(u[ray * 8 + 3], status, `independent brute force ray ${ray}`);
      if (expected) {
        assert.ok(Math.abs(f[ray * 8] - expected.t) < 1e-5);
        assert.ok(Math.abs(f[ray * 8 + 1] - expected.u) < 1e-5);
        assert.ok(Math.abs(f[ray * 8 + 2] - expected.v) < 1e-5);
        assert.equal(u[ray * 8 + 4], scene.range(handle).start + expected.instance);
        assert.equal(u[ray * 8 + 7], Number(expected.front));
      }
    }
    const routeValues = new Uint32Array(
      await bytes(device, graphics, query.routeCounters, 0, query.routeCounters.size),
    );
    assert.ok(routeValues[0] < rayCount, "spatial routing excludes unrelated rays");
    assert.ok(routeValues[1] > 0 && routeValues[2] > 0, "diagnostics observe actual node and triangle work");
    assert.equal(routeValues[7], rayCount);
    const shaded = new Float32Array(await bytes(device, graphics, output, 0, rayCount * 64));
    assert.deepEqual([...shaded.subarray(4, 7)], [2, 3, 4], "real camera survives diffuse projection");
    assert.ok(Math.abs(shaded[0] - 0.2 / Math.PI) < 1e-7);
    const geometryOutput = allocate(rayCount * 96, GPUBufferUsage.STORAGE);
    const geometryQuery = await ScgiQueryBatch.create(device, first, {
      ...settings,
      output: geometryOutput,
      outputStride: 96,
      kind: "geometry",
    });
    batches.push(geometryQuery);
    const geometric = scgiCommand(graphics);
    geometryQuery.encode(geometric);
    geometric.finish();
    await geometric.gpuDone;
    const geometryValues = new Float32Array(await bytes(device, graphics, geometryOutput, 0, 96));
    assert.deepEqual(
      [...geometryValues.subarray(0, 8)],
      Array(8).fill(0),
      "geometry-only closest does not evaluate camera-dependent diffuse or emission",
    );
    assert.equal(geometryValues[11], 1);
    assert.deepEqual([...geometryValues.subarray(12, 15)], [0, 0, -1]);
    assert.ok(geometryValues[23] > 0, "geometry closest supplies a positive ray-origin error bound");
    assert.deepEqual([...new Uint32Array(geometryValues.buffer).subarray(16, 20)], [0, 0, 0, 0]);
    assert.ok(geometryQuery.cost.descriptors.storage <= 15);
    // Same-source candidate copies the previous topology; static BLAS is retained.
    const unchanged = await create(first);
    assert.equal(unchanged.geometries[0].blas, first.geometries[0].blas);
    assert.equal(
      unchanged.arenas[0].buffer,
      first.arenas[0].buffer,
      "rigid scene publications share packed AS and positions",
    );
    const unchangedCommand = scgiCommand(graphics);
    unchanged.encode(unchangedCommand);
    unchangedCommand.finish();
    await unchangedCommand.gpuDone;
    const clean = new Uint32Array(await bytes(device, graphics, unchanged.arenas[0].routes[0].tlas, 0, 64));
    assert.equal(clean[8], 0, "GPU dirty policy skips unchanged topology");
    const moved = [...identity];
    moved[14] = -1.5;
    const patch = scgiCommand(graphics);
    scene.patch(
      handle,
      { frameId: 1, transforms: { indices: new Uint32Array([81]), transforms: new Float32Array(moved) } },
      patch,
    );
    patch.finish();
    await patch.gpuDone;
    transforms.set(moved, 81 * 16);
    const update = await create(unchanged);
    const updateCommand = scgiCommand(graphics);
    stamp(updateCommand, 2);
    update.encode(updateCommand);
    stamp(updateCommand, 3, true);
    updateCommand.finish();
    await updateCommand.gpuDone;
    const changed = new Uint32Array(await bytes(device, graphics, update.arenas[0].routes[0].tlas, 0, 64));
    assert.ok(changed[8] === 1 || changed[8] === 2, "GPU dirty leaf chooses refit/restructure");
    assert.equal(changed[2], 0, "updated topology remains valid");
    const queryUpdated = await ScgiQueryBatch.create(device, update, { ...settings });
    batches.push(queryUpdated);
    let previousResult;
    for (const actual of [1, 0, rayCount + 1, rayCount]) {
      const command = scgiCommand(graphics);
      command.uploadRegions([
        {
          destination: gpuCount,
          destinationOffset: 0,
          bytes: new Uint8Array(new Uint32Array([actual]).buffer),
        },
      ]);
      queryUpdated.encode(command);
      command.finish();
      await command.gpuDone;
      const result = new Uint32Array(await bytes(device, graphics, batch, rayCount * 48, rayCount * 32));
      if (actual > rayCount)
        assert.ok(Array.from({ length: rayCount }, (_, i) => result[i * 8 + 3]).every((s) => s === 5));
      else if (actual === 0)
        assert.deepEqual(result, previousResult, "zero count does not touch inactive result records");
      else
        assert.equal(
          new Float32Array(result.buffer)[0],
          2.5,
          "updated rigid transform consumed by traversal",
        );
      previousResult = result;
    }
    const any = await ScgiQueryBatch.create(device, update, {
      ...settings,
      anyHit: true,
    });
    batches.push(any);
    const shadow = scgiCommand(graphics);
    any.encode(shadow);
    shadow.finish();
    await shadow.gpuDone;
    const shadowResult = new Uint32Array(await bytes(device, graphics, batch, rayCount * 48, rayCount * 32));
    assert.equal(shadowResult[1 * 8 + 3], 0, "accepted backface can occlude without fake diffuse response");
    assert.equal(shadowResult[3 * 8 + 3], 5, "occlusion still rejects malformed rays");
    const resolved = allocate(48, GPUBufferUsage.QUERY_RESOLVE);
    const resolve = scgiCommand(graphics);
    resolve.gpu_encoder.resolveQuerySet(querySet, 0, 6, resolved, 0);
    resolve.finish();
    await resolve.gpuDone;
    const timestamps = new BigUint64Array(await bytes(device, graphics, resolved, 0, 48));
    const gpuMs = {
      build: Number(timestamps[1] - timestamps[0]) / 1e6,
      update: Number(timestamps[3] - timestamps[2]) / 1e6,
      query: Number(timestamps[5] - timestamps[4]) / 1e6,
    };
    const warm = [];
    for (const [name, actual, x] of [
      ["alpha-dense", rayCount, 0],
      ["alpha-one", 1, 0],
      ["opaque-one", 1, -2],
      ["empty", 0, 0],
    ]) {
      const command = scgiCommand(graphics);
      rf[0] = x;
      command.uploadRegions([
        {
          destination: gpuCount,
          destinationOffset: 0,
          bytes: new Uint8Array(new Uint32Array([actual]).buffer),
        },
        { destination: batch, destinationOffset: 0, bytes: new Uint8Array(rays, 0, 48) },
      ]);
      stamp(command, 6);
      queryUpdated.encode(command);
      stamp(command, 7, true);
      command.gpu_encoder.resolveQuerySet(querySet, 6, 2, resolved, 0);
      command.finish();
      await command.gpuDone;
      const sample = new BigUint64Array(await bytes(device, graphics, resolved, 0, 16));
      warm.push({ name, actual, milliseconds: Number(sample[1] - sample[0]) / 1e6 });
    }
    // Active membership changes cannot reuse a refit-only topology.
    const hide = scgiCommand(graphics);
    scene.patch(
      handle,
      { frameId: 2, visibility: { indices: new Uint32Array([83]), flags: new Uint32Array([0]) } },
      hide,
    );
    hide.finish();
    await hide.gpuDone;
    const changedMembership = await create(update);
    const rebuild = scgiCommand(graphics);
    changedMembership.encode(rebuild);
    rebuild.finish();
    await rebuild.gpuDone;
    const rebuiltHeader = new Uint32Array(
      await bytes(device, graphics, changedMembership.arenas[0].routes[0].tlas, 0, 64),
    );
    assert.equal(rebuiltHeader[8], 3, "GPU membership change requires rebuild");
    assert.equal(rebuiltHeader[0], 2, "complete compact window excludes exactly one inactive slot");
    const abandoned = await create(changedMembership);
    const cancel = scgiCommand(graphics);
    abandoned.encode(cancel);
    cancel.abort(new Error("SCGI-5 update abort fixture"));
    assert.equal(abandoned.valid, false);
    const retry = await create(changedMembership);
    const retryCommand = scgiCommand(graphics);
    retry.encode(retryCommand);
    retryCommand.finish();
    await retryCommand.gpuDone;
    assert.equal(retry.valid, true, "aborted candidate did not modify its committed update source");
    // Exercise physical arena boundaries with the exact same production arena,
    // builder and query owners, without allocating hundreds of MiB just to hit
    // a device's maximum binding size in this small semantic fixture.
    const extraFixture = triangleProductFixture();
    extraFixture.descriptor.productId.fill(17);
    extraFixture.descriptor.pageRecords.set(hash);
    const extraProduct = await products.load({
      descriptor: extraFixture.descriptor,
      async readPage(pageId) {
        return {
          productId: extraFixture.descriptor.productId,
          revision: extraFixture.descriptor.revision,
          pageId,
          bytes: extraFixture.page.slice().buffer,
          decodedHash128: hash,
          decodedPageHash128: hash,
        };
      },
      release() {},
    });
    const extraUpload = scgiCommand(graphics);
    const extraHandle = scene.instantiate(
      {
        count: 2,
        geometryHandles: [],
        virtualGeometry: {
          productTableSlot: extraProduct.productTableSlot,
          productGeneration: extraProduct.productGeneration,
          assetCount: 1,
        },
        geometryIndices: new Uint32Array(2).fill(extraProduct.assetReferenceBegin),
        materialHandles: new Uint32Array(2).fill(1),
        currentTransforms: new Float32Array([...identity, ...identity]),
        flags: new Uint32Array([1, 1]),
        boundsSpheres: new Float32Array(8).fill(1),
        boundsMin: new Float32Array([-0.5, -0.5, 0, -0.5, -0.5, 0]),
        boundsMax: new Float32Array([0.5, 0.5, 0, 0.5, 0.5, 0]),
      },
      extraUpload,
    );
    extraUpload.finish();
    await extraUpload.gpuDone;
    const multi = await ScgiQueryScene.create(device, profile, runtime, scene, [
      product.residency,
      extraProduct.residency,
    ]);
    scenes.push(multi);
    assert.equal(multi.geometries.length, 2, "complete multi-Product geometry publication");
    const sharedShardCapacity = Math.max(...multi.geometries.map((geometry) => geometry.primitiveCount));
    assert.ok(
      multi.blasPlan.primitiveCapacity >= sharedShardCapacity && multi.blasPlan.primitiveCapacity <= 4096,
      "shared build ceiling follows the largest admitted shard within the bounded size class",
    );
    for (const geometry of multi.geometries) {
      assert.equal(geometry.entry.plan.primitiveCapacity, geometry.primitiveCount,
        "persistent BLAS capacity follows its chunk, not the shared build ceiling");
      assert.ok(geometry.entry.buffer.size <= multi.blasPlan.hierarchy.bytes,
        "persistent BLAS capacity stays within the shared build ceiling");
    }
    for (const arena of multi.arenas) arena.destroy();
    multi.arenas.length = 0;
    for (const geometry of multi.geometries) {
      multi.arenas.push(
        await ScgiQueryArena.create(
          device,
          [geometry],
          multi.sourceInstances,
          multi.transforms,
          multi.materialPublication,
          false,
          profile.domain,
        ),
      );
    }
    const multiQuery = await ScgiQueryBatch.create(device, multi, settings);
    batches.push(multiQuery);
    const multiple = scgiCommand(graphics);
    rf.set([0, 0, 1, 0, 0, 0, -1, 10], 0);
    multiple.uploadRegions([
      { destination: gpuCount, destinationOffset: 0, bytes: new Uint8Array(new Uint32Array([1]).buffer) },
      { destination: batch, destinationOffset: 0, bytes: new Uint8Array(rays, 0, 48) },
    ]);
    multi.encode(multiple);
    multiQuery.encode(multiple);
    multiple.finish();
    await multiple.gpuDone;
    const multiHit = new Uint32Array(await bytes(device, graphics, batch, rayCount * 48, 32));
    assert.equal(multiHit[3], 0);
    assert.equal(new Float32Array(multiHit.buffer)[0], 1, "global closest merges both physical arenas");
    assert.equal(
      multiHit[4],
      scene.range(extraHandle).start,
      "equal-t deterministically chooses the first stable scene slot",
    );
    const multiCounters = new Uint32Array(
      await bytes(device, graphics, multiQuery.routeCounters, 0, multiQuery.routeCounters.size),
    );
    assert.ok(multiCounters.filter((_, i) => i % 8 === 0).some((value) => value > 0));
    return {
      multiProductPhysicalArenas: multi.arenas.length,
      equalTAcrossInstances: true,
      randomBruteForceRays: rayCount,
      coplanarRejectedLayers: 81,
      sharedAffine: true,
      staticBlasReuse: true,
      gpuDirtyRefit: true,
      sceneArenas: first.arenas.length,
      routeCounters: [...routeValues],
      gpuCountEmptyOverflowRetry: true,
      insideAndDoubleSided: true,
      closestAndOcclusion: true,
      geometryOnlyAndSharedPackedArena: true,
      membershipRebuildAndAbortRetry: true,
      queryBytes: first.byteLength,
      batchCost: query.cost,
      updatedBatchCost: queryUpdated.cost,
      gpuMs,
      warm,
      scope: "small owner/correctness and coarse GPU cost fixture; no full Renderer performance claim",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const query of batches) query.destroy();
    for (const scene of scenes) {
      if (scene.valid) await scene.releaseAfter(Promise.resolve());
      else scene.destroy();
    }
    native?.destroy();
    products.destroy();
    scene.destroy();
    querySet?.destroy();
    for (const buffer of buffers) buffer.destroy();
    graphics.appearance_programs.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
