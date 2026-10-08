import test from "node:test";
import assert from "node:assert/strict";
import { textureProduct } from "../fixtures/texture-product.mjs";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { prepareMaterialTextureProducts } from "../../.test-dist/assets/PcMaterialTextures.js";

globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4 };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
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
  return {
    graphics,
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
    fence = deferred();
  return {
    device,
    closed: false,
    gpuDone: fence.promise,
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
async function material(w = 16, seed = 1, exact = false) {
  const m = new StandardShadeMaterial();
  m.texture_albedo = ShadeTexture.fromProduct(await textureProduct(w, w, "base-color-srgb", exact, seed));
  if (exact) m.transparency_mode = ShadeTransparencyMode.AlphaTested;
  return m;
}
test("tail/promotion commits atomically; exact coverage is full; stable bindings and fenced zero", async () => {
  const f = fixture(),
    r = new TextureResidency(f.graphics),
    a = await material(128),
    b = await material(17, 2, true);
  const c = command(f.graphics.device),
    s = r.stage([a, b], c);
  assert.equal(r.descriptor(s.textureRefs.get(a.texture_albedo)), null);
  c.finish();
  assert.equal(s.surfacePublications.get(a.texture_albedo).currentMinimumMip, 6);
  assert.equal(s.surfacePublications.get(b.texture_albedo).currentMinimumMip, 0);
  assert.equal(r.bindings(), r.bindings());
  const old = s.surfacePublications.get(a.texture_albedo).currentRevision;
  const p = command(f.graphics.device);
  r.promote([a], p);
  p.abort();
  assert.equal(s.surfacePublications.get(a.texture_albedo).currentRevision, old);
  const n = command(f.graphics.device);
  r.promote([a], n);
  n.finish();
  assert.equal(s.surfacePublications.get(a.texture_albedo).currentMinimumMip, 0);
  assert.notEqual(s.surfacePublications.get(a.texture_albedo).currentRevision, old);
  const rel = command(f.graphics.device);
  r.release([a, b], rel);
  rel.finish();
  assert.ok(r.evidence().allocatedBytes > 0);
  rel.complete();
  await tick();
  assert.equal(r.evidence().allocatedBytes, 0);
  assert.equal(r.evidence().bindingSetCount, 0);
});
test("shared content, aborted revival, late fence and handle generation preserve new ownership", async () => {
  const f = fixture(),
    r = new TextureResidency(f.graphics),
    a = await material(),
    b = new StandardShadeMaterial();
  b.texture_albedo = a.texture_albedo;
  const c = command(f.graphics.device),
    s = r.stage([a, b], c);
  c.finish();
  assert.equal(r.evidence().residentTextureCount, 1);
  const rel = command(f.graphics.device);
  r.release([a, b], rel);
  rel.finish();
  const revive = command(f.graphics.device);
  r.stage([a], revive);
  rel.complete();
  await tick();
  revive.abort();
  await f.drain();
  assert.equal(r.evidence().allocatedBytes, 0);
  const next = command(f.graphics.device),
    ns = r.stage([a], next);
  next.finish();
  assert.equal(r.descriptor(s.textureRefs.get(a.texture_albedo)), null);
  assert.ok(r.descriptor(ns.textureRefs.get(a.texture_albedo)));
  const release = command(f.graphics.device);
  r.release([a], release);
  assert.throws(() => r.release([a], release), /underflow/);
  release.abort();
  assert.equal(r.evidence().residentTextureCount, 1);
  r.destroy();
});
test("allocation failure and queue-written abort quarantine resources; rejected fence never frees", async () => {
  const f = fixture(),
    r = new TextureResidency(f.graphics),
    a = await material(),
    b = await material(20, 2);
  f.fail(1);
  assert.throws(() => r.stage([a, b], command(f.graphics.device)), /allocation fault/);
  assert.ok(r.evidence().allocatedBytes > 0);
  await f.drain();
  assert.equal(r.evidence().allocatedBytes, 0);
  f.fail(-1);
  const c = command(f.graphics.device);
  r.stage([a], c);
  c.abort();
  assert.equal(r.evidence().quarantinedTextureCount, 1);
  await f.drain();
  assert.equal(r.evidence().allocatedBytes, 0);
  const n = command(f.graphics.device);
  r.stage([a], n);
  n.finish();
  const rel = command(f.graphics.device);
  r.release([a], rel);
  rel.finish();
  rel.lost();
  await tick();
  assert.ok(r.evidence().allocatedBytes > 0);
  r.destroy();
  assert.equal(r.evidence().allocatedBytes, 0);
});
test("20 global segments are legal; full native descriptor fails before allocation", async () => {
  const f = fixture(),
    r = new TextureResidency(f.graphics),
    ms = [];
  for (let i = 0; i < 20; i++) ms.push(await material(8 + i * 4, i + 1));
  const c = command(f.graphics.device);
  r.stage(ms, c);
  c.finish();
  assert.equal(r.evidence().segmentCount, 20);
  assert.equal(r.evidence().bindingSetCount, 20);
  const g = fixture(16),
    other = new TextureResidency(g.graphics),
    m = new StandardShadeMaterial();
  m.clearcoat_factor = 1;
  m.clearcoat_roughness_factor = 0.3;
  m.emissive_factor.set(1, 1, 1);
  const props = [
    "texture_albedo",
    "texture_normal",
    "texture_orm",
    "texture_emissive",
    "texture_occlusion",
    "texture_clearcoat",
    "texture_clearcoat_roughness",
    "texture_clearcoat_normal",
    "texture_specular",
    "texture_specular_color",
  ];
  for (let i = 0; i < props.length; i++)
    m[props[i]] = ShadeTexture.fromProduct(
      await textureProduct(
        8 + i * 4,
        8 + i * 4,
        props[i].includes("normal")
          ? "normal-linear"
          : props[i] === "texture_emissive"
            ? "emissive-srgb"
            : props[i] === "texture_albedo" || props[i] === "texture_specular_color"
              ? "base-color-srgb"
              : "orm-linear",
        props[i] === "texture_albedo",
        i + 1,
      ),
    );
  assert.throws(() => other.stage([m], command(g.graphics.device)), /descriptor/);
  assert.equal(g.textures.length, 0);
  assert.equal(g.writes.length, 0);
  const accepted = command(f.graphics.device);
  r.stage([m], accepted);
  accepted.finish();
  // SpecularColor shares the same content/semantic identity as one existing albedo.
  assert.equal(r.evidence().residentTextureCount, 29);
  r.destroy();
  other.destroy();
});
test("cooked prepare has zero Worker; wrong semantic and detached chunks fail before GPU allocation", async () => {
  const a = await material();
  let workers = 0;
  const prior = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      workers++;
      throw new Error("no cook expected");
    }
  };
  try {
    await prepareMaterialTextureProducts([a]);
    assert.equal(workers, 0);
  } finally {
    globalThis.Worker = prior;
  }
  a.texture_normal = a.texture_albedo;
  await assert.rejects(prepareMaterialTextureProducts([a]), /semantic/);
  a.texture_normal = undefined;
  const p = a.texture_albedo.texture_product;
  structuredClone(p.chunks.get("color-mip-0").buffer, { transfer: [p.chunks.get("color-mip-0").buffer] });
  const f = fixture(),
    r = new TextureResidency(f.graphics);
  assert.throws(() => r.stage([a], command(f.graphics.device)), /detached/);
  assert.equal(f.textures.length, 0);
  r.destroy();
});

test("accepted mip writes remain counted when a later upload fails", async () => {
  const f = fixture(),
    r = new TextureResidency(f.graphics),
    m = await material(8, 1, true);
  f.failWrite(1);
  assert.throws(() => r.stage([m], command(f.graphics.device)), /upload fault/);
  assert.equal(r.evidence().uploadBytes, f.writes[0][1].byteLength);
  assert.equal(r.evidence().residentTextureCount, 0);
  assert.equal(r.evidence().quarantinedTextureCount, 1);
  await f.drain();
  assert.equal(r.evidence().allocatedBytes, 0);
  r.destroy();
});

test("cold encoded image magic routes absent MIME without duplicating container parsing", async () => {
  const { ShadeImage } = await import("../../.test-dist/texture/ShadeImage.js");
  for (const [bytes, mime] of [
    [[137, 80, 78, 71, 13, 10, 26, 10], "image/png"],
    [[255, 216, 255], "image/jpeg"],
    [[82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], "image/webp"],
    [[171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10], "image/ktx2"],
  ]) {
    assert.equal(ShadeImage.fromEncodedImage(new Uint8Array(bytes).buffer, "").encoded_mime_type, mime);
  }
  assert.throws(() => ShadeImage.fromEncodedImage(new ArrayBuffer(1), ""), /signature/);
});
