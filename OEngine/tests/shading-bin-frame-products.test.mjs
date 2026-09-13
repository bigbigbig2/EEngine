import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  shadingBinFrame,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";

function validFrame() {
  return {
    abiVersion: 1,
    heap: 10,
    indirectArgs: 11,
    generation: 7,
    activeBinMaskLo: 0x8000_0001,
    activeBinMaskHi: 0x4000_0002,
    microtileWidth: 8,
    microtileHeight: 8,
    domain: textureDomain("internal-full", 1920, 1080, 1)
  };
}

test("ADR-0013 ShadingBinFrame freezes the GPU queue consumer identity", () => {
  const frame = shadingBinFrame(validFrame());
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(frame.domain), true);
  assert.deepEqual(frame, validFrame());

  assert.throws(() => shadingBinFrame({ ...frame, abiVersion: 2 }), /ABI/u);
  assert.throws(() => shadingBinFrame({ ...frame, heap: null }), /must not be null/u);
  assert.throws(() => shadingBinFrame({ ...frame, indirectArgs: -1 }), /resource id/u);
  assert.throws(() => shadingBinFrame({ ...frame, generation: 0 }), /positive/u);
  assert.throws(
    () => shadingBinFrame({ ...frame, activeBinMaskLo: -1 }),
    /u32/u
  );
  assert.throws(
    () => shadingBinFrame({ ...frame, activeBinMaskHi: 0x1_0000_0000 }),
    /u32/u
  );
  assert.throws(
    () => shadingBinFrame({ ...frame, microtileHeight: 16 }),
    /microtile shape/u
  );
  assert.throws(
    () => shadingBinFrame({
      ...frame,
      domain: textureDomain("internal-half", 960, 540, 0.5)
    }),
    /internal-full/u
  );
});

test("candidate composition publishes and consumes the formal ShadingBinFrame", async () => {
  const pipeline = await readFile(
    new URL("../src/render/pipeline/SparseShadingCandidatePipeline.ts", import.meta.url),
    "utf8"
  );
  const executor = await readFile(
    new URL("../src/render/pipeline/SparseShadingCandidateExecutor.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    pipeline,
    /mutable\.indirectArgs = finalizer\.write[\s\S]*?mutable\.shadingBins = shadingBinFrame/u
  );
  assert.match(pipeline, /activeBinMaskLo: snapshot\.summary\.activeBinMaskLo/u);
  assert.match(pipeline, /activeBinMaskHi: snapshot\.summary\.activeBinMaskHi/u);
  assert.match(executor, /assertShadingBinProduct\(frame, activeBins\)/u);
  assert.match(executor, /FrameProduct does not match the active-bin consumer set/u);
});
