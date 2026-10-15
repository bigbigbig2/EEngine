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
        }
      };
      receipts.push(receipt);
      return receipt;
    }
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
        maxStorageBufferBindingSize: 128 * 1024 ** 2
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
          }
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
          }
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
        onSubmittedWorkDone: async () => {}
      }
    }
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
          end() {}
        })
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
      }
    };
  };
  return {
    graphics,
    command,
    textures,
    reads,
    receipts,
    queued,
    source: new TiledTextureSource(preparation, "test-session", cold.directory)
  };
}
const cold = await makeTiledFixture({ width: 1041, height: 133, channel: 0 });

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
    tail
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
    obtainSampler: (value) => value
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
    physicalSun: true
  });
  assert.equal(descriptor.groups.flat().filter((entry) => entry.buffer?.type.includes("storage")).length, 16);
  assert.equal(descriptor.groups.flat().filter((entry) => entry.storageTexture).length, 4);
  assert.equal(descriptor.groups[2].find((entry) => entry.binding === 1).buffer.type, "storage");
  assert.match(binding.program.source, /native_vt_sample/);
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
