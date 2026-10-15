import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTiledFixture } from "../helpers/tiled-texture-fixture.mjs";
import { TiledTextureSource } from "../../.test-dist/assets/TiledTextureSource.js";
import { VirtualTextureResidency } from "../../.test-dist/gpu/VirtualTextureResidency.js";

import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { nativeSurfaceDescriptor } from "../../.test-dist/shaders/native_surface.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { textureProduct } from "../fixtures/texture-product.mjs";
import {
  validateTiledTextureMetadata,
  TILED_TEXTURE_RECIPE,
  TILED_TEXTURE_TAIL_ORIGINS,
} from "../../.test-dist/assets/TiledTextureProduct.js";
import { textureProductHash } from "../../.test-dist/assets/TextureProduct.js";

globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 };
globalThis.GPUBufferUsage = { COPY_SRC: 1, COPY_DST: 2, STORAGE: 4, MAP_READ: 8, INDIRECT: 16 };
globalThis.GPUShaderStage = { COMPUTE: 4, FRAGMENT: 2 };
globalThis.GPUMapMode = { READ: 1 };
const { TextureResidency } = await import("../../.test-dist/gpu/TextureResidency.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(cold, delay = false) {
  const loss = deferred(),
    reads = [],
    receipts = [],
    queued = [];
  const preparation = {
    evidence: () => ({ tiled: {} }),
    async readTiledPayloads(_session, _directory, ids) {
      reads.push([...ids]);
      if (delay) {
        const pending = deferred();
        queued.push(pending);
        await pending.promise;
      }
      const payloads = ids.map((id) => ({ id, bytes: cold.payloads[id].slice().buffer }));
      const receipt = {
        payloads,
        released: false,
        release() {
          assert.equal(this.released, false, "each lease is released exactly once");
          this.released = true;
          for (const value of payloads) {
            structuredClone(value.bytes, { transfer: [value.bytes] });
          }
        },
      };
      receipts.push(receipt);
      return receipt;
    },
  };
  const textures = [];
  const graphics = {
    resource_accounting: new ResourceAccounting(),
    device: {
      features: new Set(["texture-compression-bc"]),
      limits: {
        maxTextureDimension2D: 8192,
        maxTextureArrayLayers: 256,
        maxStorageBuffersPerShaderStage: 16,
        maxSampledTexturesPerShaderStage: 19,
        maxSamplersPerShaderStage: 16,
        maxBufferSize: 256 * 1024 ** 2,
        maxStorageBufferBindingSize: 128 * 1024 ** 2,
      },
      lost: loss.promise,
      createTexture(descriptor) {
        const texture = {
          ...descriptor,
          width: descriptor.size[0],
          height: descriptor.size[1],
          depthOrArrayLayers: descriptor.size[2],
          destroyed: false,
          createView() {
            return { texture };
          },
          destroy() {
            this.destroyed = true;
          },
        };
        if (descriptor.format === "rg32uint") {
          texture.words = new Uint32Array(descriptor.size[0] * descriptor.size[1] * 2);
        }
        textures.push(texture);
        return texture;
      },
      createBuffer(descriptor) {
        return {
          ...descriptor,
          bytes: new ArrayBuffer(descriptor.size),
          destroyed: false,
          getMappedRange() {
            return this.bytes;
          },
          unmap() {},
          mapAsync: () => new Promise(() => {}),
          destroy() {
            this.destroyed = true;
          },
        };
      },
      createBindGroupLayout: (value) => value,
      createBindGroup: (value) => value,
      createPipelineLayout: (value) => value,
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({}),
      queue: {
        writeTexture({ texture }, values) {
          texture.words?.set(values);
        },
        onSubmittedWorkDone: async () => {},
      },
    },
  };
  const command = () => {
    const finished = [],
      aborted = [],
      before = [],
      operations = [],
      done = deferred();
    const copies = [];
    return {
      device: graphics.device,
      closed: false,
      gpuDone: done.promise,
      copies,
      onBeforeFinish: { addOne: (fn) => before.push(fn) },
      onFinished: { addOne: (fn) => finished.push(fn) },
      onAborted: { addOne: (fn) => aborted.push(fn) },
      copyBufferToTexture(from, to, extent) {
        copies.push({ from, to, extent });
        operations.push(() => {
          if (to.texture.words) {
            const [width, height] = extent;
            const [x, y] = to.origin;
            for (let row = 0; row < height; row++) {
              const source = new Uint32Array(from.buffer.bytes, row * from.bytesPerRow, width * 2);
              to.texture.words.set(source, ((y + row) * 1024 + x) * 2);
            }
          }
        });
      },
      copyBufferToBuffer() {},
      clearBuffer() {},
      gpu_encoder: {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          dispatchWorkgroupsIndirect() {},
          end() {},
        }),
      },
      finish() {
        before.forEach((fn) => fn());
        operations.forEach((fn) => fn());
        this.closed = true;
        finished.forEach((fn) => fn());
      },
      abort() {
        this.closed = true;
        aborted.forEach((fn) => fn());
      },
      complete() {
        done.resolve();
      },
    };
  };
  return {
    graphics,
    command,
    textures,
    reads,
    receipts,
    queued,
    source: new TiledTextureSource(preparation, "test-session", cold.directory),
  };
}
const cold = await makeTiledFixture({ width: 1041, height: 133, channel: 0 });

// Fake-GPU structural fixture only; avoids a huge BC cook for capacity/state
// transitions. Real encoded filtering is independently tested on hardware.
async function capacityFixture() {
  const product = await textureProduct(2048, 2048, "occlusion-linear");
  const payloads = [],
    records = [];
  const bytes = new Uint8Array(10368),
    hash = await textureProductHash(bytes);
  const mips = product.metadata.planes[0].mips.map((mip) => {
    const tail = mip.level >= 5;
    const count = tail ? 1 : Math.ceil(mip.width / 128) * Math.ceil(mip.height / 128);
    const ids = [];
    if (mip.level > 5) ids.push(payloads.length - 1);
    else
      for (let i = 0; i < count; i++) {
        const id = payloads.length;
        payloads.push(bytes);
        records.push({ id, offset: id * 10368, byteLength: 10368, hash, shard: `${id}.bin` });
        ids.push(id);
      }
    return {
      level: mip.level,
      width: mip.width,
      height: mip.height,
      gridWidth: tail ? 1 : Math.ceil(mip.width / 128),
      gridHeight: tail ? 1 : Math.ceil(mip.height / 128),
      payloads: ids,
      ...(tail ? { tailOrigin: TILED_TEXTURE_TAIL_ORIGINS[mip.level - 5] } : {}),
    };
  });
  const metadata = {
    schemaVersion: 1,
    recipe: TILED_TEXTURE_RECIPE,
    sourceIdentity: product.identity,
    source: product.metadata,
    pack: { uri: "capacity.vtpack", byteLength: payloads.length * 10368 },
    payloads: records,
    planes: [{ sourcePlane: 0, mode: "virtual", address: "repeat", tailFirst: 5, mips }],
  };
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  return {
    payloads,
    directory: validateTiledTextureMetadata(metadata, await textureProductHash(json), json.length),
  };
}

test("working set pressure is limited, revisits rescue pages and uploads obey abort and copy budgets", async () => {
  const cold = await capacityFixture(),
    f = fixture(cold);
  const vt = new VirtualTextureResidency(f.graphics, { scalarBytes: 2654208, copies: 6 });
  const bootstrap = f.command();
  vt.stage(f.source, bootstrap);
  await vt.bootstrap(f.source, bootstrap);
  bootstrap.finish();
  bootstrap.complete();
  await tick();
  const pages = vt.snapshot.filter((page) => page && !page.pinned);
  vt.observe({ frame: 1, view: 0, snapshot: vt.snapshot, wanted: pages.map((page) => page.id), used: [] });
  assert.equal(vt.state().limited, true);
  assert.equal(vt.state().complete, false);
  assert.equal(vt.admitted.size, 255, "one protected tail consumes the remaining physical slot");
  await tick();
  const frame = f.command();
  vt.prepareFrame(frame, 2, "");
  const freeBefore = [...vt.pools.values()][0].free.length;
  const copy = frame.copyBufferToTexture;
  let calls = 0;
  frame.copyBufferToTexture = (...args) => {
    if (++calls === 2) throw new Error("controlled encoding failure");
    return copy(...args);
  };
  assert.throws(() => vt.encodeUploads(frame), /controlled encoding failure/);
  frame.abort();
  assert.equal([...vt.pools.values()][0].free.length, freeBefore, "mid-loop abort returns its reserved slot");
  const retry = f.command();
  vt.prepareFrame(retry, 3, "");
  vt.encodeUploads(retry);
  retry.finish();
  retry.complete();
  assert.equal(vt.evidence().resident, 3, "six-copy ceiling admits at most two fine uploads");
  assert.equal(vt.evidence().pinned, 1);
  assert.equal(vt.evidence().residentBytes, 3 * 10368);
  assert.equal(vt.evidence().pinnedBytes, 10368);
  vt.observe({ frame: 4, view: 0, snapshot: vt.snapshot, wanted: [], used: [] });
  const resident = [...vt.resident].find((page) => !page.pinned);
  const receipts = f.reads.length;
  vt.observe({ frame: 5, view: 0, snapshot: vt.snapshot, wanted: [resident.id], used: [resident.id] });
  assert.ok(vt.evidence().rescued > 0);
  assert.equal(f.reads.length, receipts, "rescued resident pages perform no reload IO");
  vt.destroy();
  assert.equal(vt.snapshot.length, 0, "destroy drops CPU page identity snapshots");
  assert.equal(vt.admitted.size, 0, "destroy drops retained scheduler references");
  assert.ok(f.receipts.every((lease) => lease.released));
});

test("0/50/100 percent demand cost and real eviction/reload retain bounded slots and generations", async () => {
  const cold = await capacityFixture(),
    f = fixture(cold);
  const vt = new VirtualTextureResidency(f.graphics, { scalarBytes: 2654208 });
  const bootstrap = f.command();
  vt.stage(f.source, bootstrap);
  await vt.bootstrap(f.source, bootstrap);
  bootstrap.finish();
  bootstrap.complete();
  await tick();
  const fine = vt.snapshot.filter((p) => p?.level === 0);
  let frame = 1;
  const demand = async (wanted) => {
    vt.observe({ frame: frame++, view: 0, snapshot: vt.snapshot, wanted: wanted.map((p) => p.id), used: [] });
    for (let i = 0; i < 80; i++) {
      await tick();
      const command = f.command();
      vt.prepareFrame(command, frame++, "");
      vt.encodeUploads(command);
      command.finish();
      command.complete();
      await tick();
      vt.observe({
        frame: frame++,
        view: 0,
        snapshot: vt.snapshot,
        wanted: wanted.map((p) => p.id),
        used: [],
      });
      if ([...vt.admitted].every((p) => p.slot !== 0xffffffff)) return;
    }
    assert.fail("admitted pages did not converge");
  };
  const records = [];
  for (const fraction of [0, 0.5, 1]) {
    const bytes = vt.evidence().uploadBytes,
      receipts = vt.evidence().receiptBytes;
    await demand(fine.slice(0, Math.floor(fine.length * fraction)));
    const e = vt.evidence();
    records.push({
      fraction,
      wanted: e.demand.wanted,
      pending: e.pending,
      limited: e.limited,
      encodedBytes: e.uploadBytes - bytes,
      receiptBytes: e.receiptBytes - receipts,
      allocatedBytes: e.allocatedBytes,
      stagingPeakBytes: e.stagingPeakBytes,
    });
    assert.ok(e.resident <= 256);
  }
  assert.equal(records[0].encodedBytes, 0);
  assert.ok(records[1].encodedBytes > 0 && records[2].encodedBytes > 0);
  assert.equal(records[2].limited, true);
  await demand(fine.slice(128));
  const retainedFine = [...vt.admitted].filter((page) => page.level === 0 && page.slot !== 0xffffffff);
  const priorCoarse = [...vt.admitted].filter((page) => page.level > 0).length;
  vt.observe({
    frame: frame++,
    view: 0,
    snapshot: vt.snapshot,
    wanted: fine.map((page) => page.id),
    used: retainedFine.map((page) => page.id),
  });
  const addedCoarse = [...vt.admitted].filter((page) => page.level > 0).length - priorCoarse;
  assert.ok(
    retainedFine.filter((page) => !vt.admitted.has(page)).length <= Math.max(0, addedCoarse),
    "only additional coarse dependencies may displace equal-mip resident demand",
  );
  // Every non-admitted mapped page can still be an actively sampled fallback.
  // A full pool must not read replacements until some backing is reclaimable.
  for (const page of [...vt.admitted]) {
    if (page.slot === 0xffffffff) vt.discard(page);
  }
  const readsBeforeBlocked = f.reads.length;
  for (let step = 0; step < 4; step++) {
    vt.observe({
      frame: frame++,
      view: 0,
      snapshot: vt.snapshot,
      wanted: fine.map((page) => page.id),
      used: [...vt.resident].map((page) => page.id),
    });
    await tick();
  }
  assert.equal(f.reads.length, readsBeforeBlocked, "no reclaimable backing means no speculative tile IO");
  assert.ok(vt.evidence().evictions > 0, "full pool actually reuses cold slots");
  const evicted = fine.find((p) => p.everResident && p.slot === 0xffffffff);
  assert.ok(evicted);
  const oldGeneration = Math.max(...[...vt.pools.values()][0].generations);
  const reloads = vt.evidence().reloads;
  await demand([evicted]);
  assert.notEqual(evicted.slot, 0xffffffff);
  assert.ok(vt.evidence().reloads > reloads);
  assert.ok([...vt.pools.values()][0].generations[evicted.slot] >= oldGeneration);
  console.log(
    JSON.stringify({
      name: "VT demand cost (fake GPU; bytes only)",
      records,
      evictions: vt.evidence().evictions,
      reloads: vt.evidence().reloads,
    }),
  );
  vt.destroy();
  assert.ok(f.receipts.every((receipt) => receipt.released));
});

test("VT tails, hidden upload abort/retry, NPOT parent coverage, stable identity and fenced ID reuse", async () => {
  const f = fixture(cold),
    vt = new VirtualTextureResidency(f.graphics);
  const stage = f.command();
  const routes = vt.stage(f.source, stage),
    route = routes.get(0);
  await vt.bootstrap(f.source, stage);
  assert.deepEqual(f.reads.flat(), [cold.directory.metadata.planes[0].mips[5].payloads[0]]);
  assert.ok(f.receipts.every((receipt) => receipt.released));
  const tail = route.mips[5].base,
    fine = route.mips[2].base + 2;
  assert.equal(vt.table.words[tail * 2], 0xffffffff, "candidate mapping is invisible before submit");
  stage.finish();
  stage.complete();
  await tick();
  assert.notEqual(vt.table.words[tail * 2], 0xffffffff);
  // Partial tile x=2 spans [256/261,1]: it intersects BOTH 130-wide
  // coarse tiles, unlike x>>1. Level 2 is 65-wide and has one tile.
  assert.deepEqual(vt.snapshot[fine].parents, [
    route.mips[3].base,
    route.mips[3].base + 1,
    route.mips[4].base,
    tail,
  ]);
  vt.observe({ frame: 1, view: 0, snapshot: vt.snapshot, wanted: [fine], used: [tail] });
  await tick();
  const frame = f.command();
  vt.prepareFrame(frame, 2, "");
  vt.encodeUploads(frame);
  const residentBefore = vt.evidence().resident;
  frame.abort();
  assert.equal(vt.table.words[fine * 2], 0xffffffff);
  assert.equal(vt.evidence().resident, residentBefore);
  assert.ok(vt.readyPages.size > 0, "abort retains a retryable lease");
  const retry = f.command();
  vt.prepareFrame(retry, 3, "");
  vt.encodeUploads(retry);
  retry.finish();
  assert.notEqual(vt.table.words[fine * 2], 0xffffffff);
  assert.equal(vt.evidence().resident, 5, "fine plus complete parent closure");
  assert.equal(vt.evidence().uploadBytes, 5 * 10368, "detaching leases cannot erase byte accounting");
  assert.equal(vt.state().complete, false, "publication requires a later observation");
  vt.observe({ frame: 4, view: 0, snapshot: vt.snapshot, wanted: [fine], used: [fine] });
  assert.equal(vt.state().complete, true);
  const oldSnapshot = vt.snapshot,
    generation = vt.snapshot[tail].generation;
  const fence = deferred();
  const released = vt.release(f.source, fence.promise);
  assert.equal(vt.sourceCount, 1);
  fence.resolve();
  await released;
  assert.equal(vt.sourceCount, 0);
  const replacement = f.command();
  const next = vt.stage(f.source, replacement).get(0);
  await vt.bootstrap(f.source, replacement);
  replacement.finish();
  assert.equal(next.mips[0].base, route.mips[0].base);
  assert.equal(vt.table.words[fine * 2], 0xffffffff, "recycled ID must not retain a previous mapping");
  assert.ok(vt.snapshot[next.mips[5].base].generation > generation);
  vt.observe({ frame: 5, view: 0, snapshot: oldSnapshot, wanted: [fine], used: [fine] });
  assert.equal(vt.desired.size, 0, "delayed feedback cannot acquire replacement identity");
  vt.destroy();
  retry.complete();
  replacement.complete();
});

test("late abandoned IO is released without publishing or poisoning a replacement", async () => {
  const f = fixture(cold, true),
    vt = new VirtualTextureResidency(f.graphics);
  const command = f.command();
  vt.stage(f.source, command);
  const page = vt.snapshot.find((value) => value && !value.pinned);
  vt.observe({ frame: 1, view: 0, snapshot: vt.snapshot, wanted: [page.id], used: [] });
  await tick();
  command.abort();
  f.queued.forEach((pending) => pending.resolve());
  await tick();
  assert.ok(f.receipts.every((receipt) => receipt.released));
  assert.equal(vt.batches.size, 0);
  assert.equal(vt.readyPages.size, 0);
  vt.destroy();
});

test("scheduler retries failed tile IO and reports a persistent third failure without false completion", async () => {
  const f = fixture(cold),
    vt = new VirtualTextureResidency(f.graphics);
  const bootstrap = f.command();
  vt.stage(f.source, bootstrap);
  await vt.bootstrap(f.source, bootstrap);
  bootstrap.finish();
  bootstrap.complete();
  await tick();
  let failures = 0;
  f.source.read = async () => {
    failures++;
    throw new Error("controlled range/hash failure");
  };
  const fine = vt.snapshot.find((page) => page && !page.pinned);
  vt.observe({ frame: 1, view: 0, snapshot: vt.snapshot, wanted: [fine.id], used: [] });
  await tick();
  for (let frame = 2; frame < 4; frame++) {
    const command = f.command();
    vt.prepareFrame(command, frame, "");
    command.abort();
    await tick();
  }
  assert.equal(failures, 3);
  assert.match(vt.state().error, /controlled range\/hash failure/);
  assert.equal(vt.state().complete, false);
  assert.equal(vt.batches.size, 0);
  vt.destroy();
});

test("Native VT has no whole-extent BC allocation, complete SSBO profile and exact coverage dependency admission", async () => {
  const f = fixture(cold),
    residency = new TextureResidency(f.graphics);
  const material = new StandardShadeMaterial();
  const texture = ShadeTexture.fromTiled(f.source);
  material.texture_occlusion = texture;
  const command = f.command();
  const stage = residency.stage([material], command);
  assert.throws(() => command.finish(), /before mandatory/);
  await residency.uploadTiled([material], command);
  const graph = compileCanonicalMaterial(material).appearance;
  const binding = createNativeMaterialBindings({
    graph,
    program: lowerNativeMaterial(graph),
    bindingSet: stage.bindings.bindingSets[0],
    textureRoutingRefs: stage.materialTextureRoutingRefs.get(material),
    textureMipRanges: stage.textureMipRanges,
    texturePublications: stage.surfacePublications,
    obtainSampler: (value) => value,
  });
  assert.equal(binding.program.virtualTextures, true);
  assert.equal(f.textures.filter((value) => value.format.startsWith("bc")).length, 1);
  assert.equal(f.textures.find((value) => value.format.startsWith("bc")).width, 2304);
  const descriptor = nativeSurfaceDescriptor(binding.program, binding.layoutEntries, {
    compact: true,
    productGeometry: true,
    unlit: false,
    reactive: true,
    finalPixel: true,
    reflections: "sssr-base-coat",
    physicalSun: true,
  });
  assert.equal(descriptor.groups.flat().filter((entry) => entry.buffer?.type.includes("storage")).length, 16);
  assert.equal(descriptor.groups.flat().filter((entry) => entry.storageTexture).length, 4);
  assert.equal(descriptor.groups[2].find((entry) => entry.binding === 1).buffer.type, "storage");
  assert.match(binding.program.source, /native_vt_sample/);
  const route = stage.surfacePublications.get(texture).virtual;
  const oneLevel = createNativeMaterialBindings({
    graph,
    program: lowerNativeMaterial(graph),
    bindingSet: stage.bindings.bindingSets[0],
    textureRoutingRefs: stage.materialTextureRoutingRefs.get(material),
    textureMipRanges: stage.textureMipRanges,
    texturePublications: new Map([
      [
        texture,
        {
          ...stage.surfacePublications.get(texture),
          virtual: { ...route, tailFirst: 0, mips: [route.mips.at(-1)] },
        },
      ],
    ]),
    obtainSampler: (value) => value,
  });
  assert.equal(
    oneLevel.program.key,
    binding.program.key,
    "mip count and dimensions are instance route data, never new pipeline topology",
  );
  assert.notDeepEqual(
    oneLevel.program.constants,
    binding.program.constants,
    "sharing a program preserves each texture's actual levels/tail/extent",
  );
  command.finish();
  command.complete();
  residency.destroy();

  // RGB alpha dependencies cannot silently use a coarse fallback.
  const rgb = await makeTiledFixture({ semantic: "base-color-srgb" });
  const bad = fixture(rgb),
    masked = new StandardShadeMaterial();
  masked.texture_albedo = ShadeTexture.fromTiled(bad.source);
  masked.transparency_mode = ShadeTransparencyMode.AlphaTested;
  const owner = new TextureResidency(bad.graphics);
  assert.throws(() => owner.stage([masked], bad.command()), /resident primary plane/);
  owner.destroy();
});

test("tiled bootstrap uses four shared-provider jobs and cancellation closes the entire unpublished batch", async () => {
  const f = fixture(cold),
    residency = new TextureResidency(f.graphics);
  const gates = [],
    started = [];
  let active = 0,
    peak = 0;
  const materials = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const bytes = new TextEncoder().encode(JSON.stringify(cold.directory.metadata) + " ".repeat(index));
      const directory = validateTiledTextureMetadata(
        cold.directory.metadata,
        await textureProductHash(bytes),
        bytes.length,
      );
      const source = new TiledTextureSource(f.source.preparation, "test-session", directory);
      source.read = async (ids, signal) => {
        active++;
        peak = Math.max(peak, active);
        started.push(signal);
        const gate = deferred();
        gates.push(gate);
        try {
          await new Promise((resolve, reject) => {
            gate.promise.then(resolve);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          signal.throwIfAborted();
          return await f.source.read(ids, signal);
        } finally {
          active--;
        }
      };
      const material = new StandardShadeMaterial();
      material.texture_occlusion = ShadeTexture.fromTiled(source);
      return material;
    }),
  );
  const command = f.command();
  residency.stage(materials, command);
  const ready = residency.uploadTiled(materials, command);
  await tick();
  assert.equal(started.length, 4, "bootstrap fills the existing four-Worker opportunity");
  gates.slice(0, 4).forEach((gate) => gate.resolve());
  await tick();
  assert.equal(started.length, 6);
  gates.slice(4).forEach((gate) => gate.resolve());
  await ready;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  command.finish();
  command.complete();
  assert.ok(f.receipts.every((receipt) => receipt.released));
  residency.destroy();

  const cancelled = new TextureResidency(f.graphics),
    cut = f.command();
  started.length = 0;
  cancelled.stage(materials, cut);
  const rejected = cancelled.uploadTiled(materials, cut);
  await tick();
  assert.equal(started.length, 4);
  cut.abort();
  await assert.rejects(rejected);
  assert.equal(active, 0);
  assert.ok(started.every((signal) => signal.aborted));
  assert.equal(cancelled.virtualTextures, null, "last aborted source retires the unused VT owner");
  cancelled.destroy();
});
