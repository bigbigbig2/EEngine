import "../webgpu-test-globals.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureImageSource } from "../oracle/texture-fixture.mjs";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}
function fixture(sampled = 19) {
  const writes = [],
    textures = [],
    fences = [];
  let failAt = -1,
    writeFailAt = -1;
  const graphics = {
    resource_accounting: new ResourceAccounting(),
    device: {
      features: new Set(["texture-compression-bc"]),
      limits: {
        maxSampledTexturesPerShaderStage: sampled,
        maxSamplersPerShaderStage: 16,
        maxTextureDimension2D: 8192,
        maxTextureArrayLayers: 256,
        maxBufferSize: 256 * 1024 ** 2,
      },
      createBuffer(descriptor) {
        const bytes = new ArrayBuffer(descriptor.size);
        return { size: descriptor.size, getMappedRange: () => bytes, unmap() {}, destroy() {} };
      },
      copy(...args) {
        if (writes.length === writeFailAt) throw new Error("upload fault");
        writes.push(args);
      },
      createTexture(d) {
        if (textures.length === failAt) throw new Error("allocation fault");
        const t = {
          ...d,
          dimension: "2d",
          sampleCount: 1,
          width: d.size[0],
          height: d.size[1],
          depthOrArrayLayers: d.size[2],
          destroyed: false,
          createView() {
            return { texture: t };
          },
          destroy() {
            t.destroyed = true;
          },
        };
        textures.push(t);
        return t;
      },
      queue: {
        writeTexture(...args) {
          if (writes.length === writeFailAt) throw new Error("upload fault");
          writes.push(args);
        },
        onSubmittedWorkDone() {
          const f = deferred();
          fences.push(f);
          return f.promise;
        },
      },
    },
  };
  const transcoder = {
    record() { return "recorded"; }, recordExact() {}, evidence() { return {}; }
  };
  graphics.prepareImageTranscoder = async () => transcoder;
  return {
    graphics,
    transcoder,
    writes,
    textures,
    fences,
    fail(i) {
      failAt = i;
    },
    failWrite(i) {
      writeFailAt = i;
    },
    async drain() {
      for (const f of fences.splice(0)) f.resolve();
      await tick();
    },
  };
}
function command(device) {
  const finished = [],
    aborted = [],
    before = [],
    fence = deferred();
  return {
    device,
    closed: false,
    gpuDone: fence.promise,
    copyBufferToTexture(...args) {
      device.copy(...args);
    },
    onBeforeFinish: { addOne(fn) { before.push(fn); } },
    onFinished: {
      addOne(fn) {
        finished.push(fn);
      },
    },
    onAborted: {
      addOne(fn) {
        aborted.push(fn);
      },
    },
    finish() {
      for (const fn of before) fn();
      this.closed = true;
      for (const fn of finished) fn();
    },
    abort() {
      this.closed = true;
      for (const fn of aborted) fn();
    },
    complete() {
      fence.resolve();
    },
    lost() {
      fence.reject(new Error("loss"));
    },
  };
}

async function material(seed = 1) {
  const inputs = [8, 4, 2, 1].map((size) => ({width: size, height: size,
    rgba: new Uint8Array(size * size * 4).fill(seed)}));
  const cold = await fixtureImageSource("color-rgba", inputs, {exactAlpha: true});
  // Structural GPU-owner checks inject already admitted exact-sized inputs.
  // Real assigned-Worker provenance is covered by image-texture-preparation.
  cold.source.read = async (ids) => ids.map((id) => ({item: cold.source.directory.items[id], close() {}}));
  const material = new StandardShadeMaterial();
  material.texture_albedo = ShadeTexture.fromImageSource(cold.source);
  return {material, cold};
}
async function publish(owner, f, material) {
  await owner.prepare();
  const upload = command(f.graphics.device);
  const staged = owner.stage([material], upload);
  await owner.uploadImages([material], upload, async (record) => record({}));
  upload.finish(); upload.complete();
  return staged;
}
test("schema4 mandatory images cannot publish half initialized allocations", async () => {
  const f = fixture(), owner = new TextureResidency(f.graphics);
  const {material: m, cold} = await material();
  try {
    await owner.prepare();
    const upload = command(f.graphics.device);
    owner.stage([m], upload);
    assert.throws(() => upload.finish(), /mandatory/);
    upload.abort(); await f.drain();
    await publish(owner, f, m);
    assert.equal(owner.fullyResident([m]), true);
    assert.ok(owner.evidence().physicalCopyBytes > 0);
  } finally { owner.destroy(); cold.preparation.dispose(); }
});
for (const rejectFence of [false, true]) {
  test("schema4 query allocation survives material release; rejected fence=" + rejectFence, async () => {
    const f = fixture(), owner = new TextureResidency(f.graphics);
    const {material: m, cold} = await material();
    try {
      await publish(owner, f, m);
      const query = owner.retainQuery([m]);
      const release = command(f.graphics.device);
      owner.release([m], release); release.finish(); release.complete(); await tick();
      assert.ok(owner.evidence().allocatedBytes > 0);
      if (rejectFence) {
        await assert.rejects(query.releaseAfter(Promise.reject(new Error("query fence lost"))), /query fence lost/);
        query.release(); await tick();
        assert.equal(query.valid, false);
        assert.ok(owner.evidence().allocatedBytes > 0);
      } else {
        const fence = deferred();
        const retirement = query.releaseAfter(fence.promise);
        await tick(); assert.ok(owner.evidence().allocatedBytes > 0);
        fence.resolve(); await retirement; await tick();
        assert.equal(owner.evidence().allocatedBytes, 0);
      }
    } finally { owner.destroy(); cold.preparation.dispose(); }
  });
}
test("cold encoded image signatures select the new import owner", async () => {
  const { ShadeImage } = await import("../../.test-dist/texture/ShadeImage.js");
  for (const [bytes, mime] of [
    [[137,80,78,71,13,10,26,10], "image/png"], [[255,216,255], "image/jpeg"],
    [[82,73,70,70,0,0,0,0,87,69,66,80], "image/webp"],
    [[171,75,84,88,32,50,48,187,13,10,26,10], "image/ktx2"]
  ]) assert.equal(ShadeImage.fromEncodedImage(new Uint8Array(bytes).buffer, "").encoded_mime_type, mime);
  assert.throws(() => ShadeImage.fromEncodedImage(new ArrayBuffer(1), ""), /signature/);
});
