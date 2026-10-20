import test from "node:test";
import assert from "node:assert/strict";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { ChangeSignal } from "../../.test-dist/core/Signal.js";

function fixture(read) {
  const device = {
    features: new Set(["texture-compression-bc"]),
    limits: { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 }
  };
  const owner = new TextureResidency({ device });
  owner.prepare = async () => undefined;
  const command = { device, closed: false, onAborted: new ChangeSignal(), onFinished: new ChangeSignal() };
  const closed = [], recorded = [];
  owner.transcoder = { record() { return "recorded"; } };
  const materials = [0, 1, 2, 3].map((id) => {
    const material = {};
    const source = {
      directory: { planes: [{ target: "bc7-rgb", mips: "runtime" }], items: [{ id, plane: 0, x: 0, y: 0 }] },
      async read(ids, signal) {
        await read(id, signal);
        return [{ close() { closed.push(id); } }];
      }
    };
    const layout = { plane: 0, levels: [{ mip: 0 }], bytesPerLayer: 16 };
    const entry = { staging: command, product: { source, planes: [layout] }, planes: [{ layout, segment: { texture: {} }, layer: id }] };
    owner.materials.set(material, { entries: [entry] });
    return material;
  });
  let tail = Promise.resolve();
  const batch = (record) => {
    const next = tail.then(async () => { recorded.push(1); record({}); });
    tail = next;
    return next;
  };
  return { owner, command, materials, closed, recorded, batch };
}

test("resident bootstrap overlaps at most two CPU reads while retaining every item through GPU batch completion", async () => {
  let active = 0, peak = 0;
  const f = fixture(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  });
  await f.owner.uploadImages(f.materials, f.command, f.batch);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(f.recorded.length, 4);
  assert.deepEqual(f.closed.sort(), [0, 1, 2, 3]);
  assert.equal(f.owner.mipUploads, 4);
  // Reusing preparation never schedules the same mandatory item twice.
  await f.owner.uploadImages(f.materials, f.command, f.batch);
  assert.equal(f.recorded.length, 4);
});

test("a failed bootstrap aborts its sibling and waits for cleanup before reporting failure", async () => {
  const visited = [];
  let siblingSettled = false;
  const f = fixture(async (id, signal) => {
    visited.push(id);
    if (id === 0) throw new Error("bad image");
    await new Promise((resolve) => setTimeout(resolve, 5));
    siblingSettled = true;
    signal.throwIfAborted();
  });
  await assert.rejects(f.owner.uploadImages(f.materials, f.command, f.batch), /bad image/);
  assert.equal(siblingSettled, true);
  assert.deepEqual(visited, [0, 1]);
  assert.equal(f.recorded.length, 0);
});

test("late sibling input is released without recording after another reader fails", async () => {
  const f = fixture(async (id) => {
    if (id === 0) throw new Error("bad image");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await assert.rejects(f.owner.uploadImages(f.materials, f.command, f.batch), /bad image/);
  assert.deepEqual(f.closed, [1]);
  assert.equal(f.recorded.length, 0);
});
