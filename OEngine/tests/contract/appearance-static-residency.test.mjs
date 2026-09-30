import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceStaticResidency } from "../../.test-dist/gpu/AppearanceStaticResidency.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { cookAppearanceMipProduct } from "../../.test-dist/material/AppearanceMipCooker.js";
import { writeAppearanceAssetPackage, openAppearanceAssetPackage } from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

globalThis.GPUBufferUsage = { COPY_SRC: 4 };
globalThis.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function asset(constant = false, contentHash = "a".repeat(64)) {
  const g = new AppearanceGraphBuilder();
  if (constant) g.output("constant", g.constant([16, 0.25]));
  else {
    const uv = g.input("uv", 2, "surface", undefined, "uv0"), t = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
    for (const [name, channels] of [["r", [0]], ["rg", [0, 1]], ["rgb", [0, 1, 2]], ["rgba", [0, 1, 2, 3]]]) g.output(name, g.swizzle(t, channels));
  }
  const p = compileAppearanceGraph(g.build());
  const product = cookAppearanceMipProduct(p, p.outputs, { width: 4, height: 4, mipCount: 3, byteBudget: 8192,
    validationProbeBudget: 8192, domainMin: [0, 0], domainMax: [1, 1], error: { absolute: 0.001, relative: 0 },
    storagePrecision: "float16", sample: () => [0.5, 0.25, 0.75, 1] });
  return openAppearanceAssetPackage(await writeAppearanceAssetPackage(product, { uri: "test/static-asset", contentHash, dependencies: [] }));
}
const event = () => ({ callbacks: [], addOne(fn) { this.callbacks.push(fn); }, send() { for (const fn of this.callbacks.splice(0)) fn(); } });
function fixture(budget) {
  const textures = [], fence = deferred(), listeners = new Set();
  const device = { limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxBufferSize: 1e8 },
    queue: { onSubmittedWorkDone: () => fence.promise }, createTexture(d) {
      const texture = { ...d, width: d.size[0], height: d.size[1], depthOrArrayLayers: d.size[2], destroyed: 0,
        destroy() { this.destroyed++; } }; textures.push(texture); return texture;
    } };
  const registry = { onStopped(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const owner = new AppearanceStaticResidency(device, registry, budget);
  const makeCommand = () => ({ device, closed: false, onBeforeFinish: event(), onFinished: event(), onAborted: event(), copies: [],
    allocateTextureUploadBuffer(data) { return { size: data.byteLength }; },
    copyBufferToTexture(source, destination, size) { this.copies.push({ source, destination, size }); },
    finish() { this.onBeforeFinish.send(); this.closed = true; this.onFinished.send(); },
    abort() { this.closed = true; this.onAborted.send(); } });
  return { device, owner, textures, makeCommand, fence, stop() { for (const fn of [...listeners]) fn(); } };
}

test("equal extent/format fields share exact-sized array layers; immutable assets share across publications", async () => {
  const a = await asset(), f = fixture(), c = f.makeCommand();
  const first = f.owner.acquire(a, c), second = f.owner.acquire(a, c);
  assert.equal(f.textures.length, 3); assert.equal(c.copies.length, 12);
  assert.equal(first.destination("rgb").texture, first.destination("rgba").texture);
  assert.notEqual(first.destination("rgb").layer, first.destination("rgba").layer);
  assert.equal(first.destination("rgb").texture.depthOrArrayLayers, 2);
  assert.equal(f.owner.evidence().stagingBytes, a.residentBytes);
  assert.throws(() => f.owner.acquire(a, f.makeCommand()), /uncommitted/);
  c.finish(); assert.equal(f.owner.evidence().residentBytes, a.residentBytes);
  const third = f.owner.acquire(a, f.makeCommand()); assert.equal(f.textures.length, 3);
  first.release(); second.release(); assert.equal(f.owner.evidence().residentBytes, a.residentBytes);
  third.release(); assert.equal(f.owner.evidence().retiringBytes, a.residentBytes);
  assert.ok(f.textures.every(t => t.destroyed === 0));
  f.fence.resolve(); await tick(); assert.equal(f.owner.evidence().allocatedBytes, 0);
  assert.ok(f.textures.every(t => t.destroyed === 1)); f.owner.destroy();
});

test("abort rolls back only newly staged assets and revokes their leases; existing assets remain owned", async () => {
  const a = await asset(), f = fixture(), c = f.makeCommand(), lease = f.owner.acquire(a, c);
  c.abort(); assert.equal(f.owner.evidence().allocatedBytes, 0);
  assert.throws(() => lease.destination("r"), /consumable/); lease.release();
  const committed = f.makeCommand(), live = f.owner.acquire(a, committed); committed.finish();
  const cancelled = f.makeCommand(), ref = f.owner.acquire(a, cancelled); cancelled.abort(); ref.release();
  assert.equal(f.owner.evidence().residentBytes, a.residentBytes); assert.equal(live.destination("r").texture.destroyed, 0);
  live.release(); f.fence.resolve(); await tick(); f.owner.destroy();
});

test("physical limits include retirement; upload budget is cumulative across a single caller transaction", async () => {
  const a = await asset(), f = fixture({ maxAssets: 2, maxResidentBytes: a.residentBytes, maxUploadBytes: 10000, maxStagingBytes: 10000 });
  const c = f.makeCommand(), lease = f.owner.acquire(a, c); c.finish(); lease.release();
  assert.throws(() => f.owner.acquire(a, f.makeCommand()), /budget exhausted/);
  assert.equal(f.textures.length, 3); f.fence.resolve(); await tick(); f.owner.destroy();
  const padded = a.fields.reduce((sum, field) => sum + field.mips.reduce((total, mip) => {
    const row = mip.width * (field.width === 3 ? 4 : field.width) * 2;
    return total + Math.ceil((Math.ceil(row / 256) * 256 * (mip.height - 1) + row) / 4) * 4;
  }, 0), 0);
  const limited = fixture({ maxAssets: 4, maxResidentBytes: 100000, maxUploadBytes: padded * 2 - 1, maxStagingBytes: padded * 2 - 1 });
  const transaction = limited.makeCommand();
  const first = limited.owner.acquire(a, transaction), another = await asset(false, "b".repeat(64));
  const created = limited.textures.length, copies = transaction.copies.length;
  assert.throws(() => limited.owner.acquire(another, transaction), /budget exhausted/);
  assert.equal(limited.textures.length, created); assert.equal(transaction.copies.length, copies);
  transaction.abort(); first.release(); limited.owner.destroy();
});

test("device loss destroys resident/staging resources once and revokes future admission", async () => {
  const a = await asset(), f = fixture(), c = f.makeCommand(), lease = f.owner.acquire(a, c); c.finish();
  f.stop(); assert.equal(f.owner.evidence().allocatedBytes, 0); assert.ok(f.textures.every(t => t.destroyed === 1));
  assert.throws(() => lease.destination("r"), /consumable/); assert.throws(() => f.owner.acquire(a, f.makeCommand()), /live same-device/);
  lease.release(); f.owner.destroy(); assert.ok(f.textures.every(t => t.destroyed === 1));
});

test("constant assets need zero texture/upload/physical budget; negotiated extents reject before GPU resources", async () => {
  const constant = await asset(true), f = fixture({ maxAssets: 2, maxResidentBytes: 0, maxUploadBytes: 0, maxStagingBytes: 0 });
  const c = f.makeCommand(), lease = f.owner.acquire(constant, c); c.finish(); assert.equal(f.textures.length, 0);
  assert.equal(f.owner.evidence().allocatedBytes, 0); lease.release(); f.fence.resolve(); await tick(); f.owner.destroy();
  const a = await asset(), capped = fixture(); capped.device.limits.maxTextureArrayLayers = 1;
  assert.throws(() => capped.owner.acquire(a, capped.makeCommand()), /extent\/layers/);
  assert.equal(capped.textures.length, 0); capped.owner.destroy();
});
