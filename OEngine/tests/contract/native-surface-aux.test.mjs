import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import {
  NativeSurfaceAuxResources,
  nativeSurfaceAuxLayoutEntries,
  nativeSurfaceAuxFsrInputs,
  nativeSurfaceMotion,
  nativeSurfaceTemporalMask,
  nativeSurfaceTemporalMaterialSignature
} from "../../.test-dist/render/surface/NativeSurfaceAux.js";

function device() {
  const textures = [];
  return {
    textures,
    lost: new Promise(() => {}),
    limits: { maxTextureDimension2D: 8192, maxStorageTexturesPerShaderStage: 4 },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        createView: () => ({ texture }),
        destroy() {
          this.destroyed = true;
        }
      };
      textures.push(texture);
      return texture;
    }
  };
}

test("Base demands no Aux while Temporal has only the actual opaque reactive consumer", () => {
  const gpu = device();
  const owner = new NativeSurfaceAuxResources(gpu);
  const base = owner.prepare("Base", 1920, 1080);
  assert.equal(base.allocatedBytes, 0);
  assert.equal(base.opaqueReactive, null);
  owner.abort();
  const temporal = owner.prepare("Temporal", 1920, 1080);
  assert.equal(temporal.allocatedBytes, 1920 * 1080 * 4);
  assert.equal(temporal.opaqueReactive.descriptor.format, "rgba8unorm");
  assert.equal(gpu.textures.length, 1);
  assert.equal(nativeSurfaceAuxLayoutEntries("Temporal", 8)[0].binding, 8);
  owner.abort();
  assert.equal(gpu.textures[0].destroyed, true);
  assert.throws(() => owner.prepare("ReflectionGI", 1, 1), /consumer/);
});

test("Aux resize candidates abort without replacing committed resources and retire against the actual fence", async () => {
  const gpu = device();
  const owner = new NativeSurfaceAuxResources(gpu);
  const first = owner.prepare("Temporal", 2, 2);
  let finish;
  const fence = new Promise((resolve) => {
    finish = resolve;
  });
  owner.commit(fence);
  const aborted = owner.prepare("Temporal", 3, 3);
  owner.abort();
  assert.equal(aborted.opaqueReactive.destroyed, true);
  assert.equal(first.opaqueReactive.destroyed, false);
  assert.equal(owner.prepare("Temporal", 2, 2).opaqueReactive, first.opaqueReactive);
  owner.abort();
  owner.prepare("Temporal", 3, 3);
  owner.commit(Promise.resolve());
  assert.equal(first.opaqueReactive.destroyed, false);
  finish();
  await fence;
  await Promise.resolve();
  assert.equal(first.opaqueReactive.destroyed, true);
  owner.destroy();
});

test("motion uses jittered clip coordinates and rejects out-of-domain reprojection and camera cuts", () => {
  const result = nativeSurfaceMotion([0.2, -0.2, 0.5, 1], [0.1, 0.2, 0.5, 1], true);
  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.motion[0] - 0.05) < 1e-7);
  assert.ok(Math.abs(result.motion[1] - 0.2) < 1e-7);
  for (const prior of [
    [2, 0, 0.5, 1],
    [0, 0, -0.1, 1],
    [0, 0, 0, 0],
    [NaN, 0, 0, 1]
  ]) {
    assert.deepEqual(nativeSurfaceMotion([0, 0, 0.5, 1], prior, true), { motion: [0, 0], valid: false });
  }
  assert.deepEqual(nativeSurfaceMotion([0, 0, 0.5, 1], [0, 0, 0.5, 1], false), {
    motion: [0, 0],
    valid: false
  });
});

test("Temporal mask preserves identity mismatch versus transform-only change and invalid/reactive semantics", () => {
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 5], true, true, 0, 0), [
    0,
    1,
    0,
    8 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 9, 4], true, true, 0.25, 64), [
    1,
    1,
    1,
    68 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 4], false, false, 0, 0), [
    1,
    0,
    1,
    16 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 4], false, true, 0, 0), [
    1,
    0,
    1,
    16 / 255
  ]);
});

test("FSR mapping consumes the merged TemporalFacts reactive and validity channels", () => {
  assert.deepEqual(nativeSurfaceAuxFsrInputs({ motion: 3, mask: 4, identity: 5 }), {
    motion: 3,
    validityMask: 4,
    reactiveMask: 4
  });
});

test("native Temporal signatures change for material versions and conservatively distinguish equal-content slots", () => {
  const input = { materialHandle: 7, instanceFlags: 0, materialSlot: 1, signature: 23, valueRevision: 1 };
  const first = nativeSurfaceTemporalMaterialSignature(input);
  assert.equal(nativeSurfaceTemporalMaterialSignature(input), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, materialSlot: 2 }), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, valueRevision: 2 }), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, signature: 24 }), first);
  assert.throws(() => nativeSurfaceTemporalMaterialSignature({ ...input, signature: -1 }), /u32/);
});
