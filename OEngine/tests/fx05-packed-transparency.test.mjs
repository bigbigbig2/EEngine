import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MBOIT_SINGLE_PRECISION_BIAS,
  accumulatePowerMoments4,
  resolvePowerMoments4,
  sortedAlphaComposite,
  totalMomentTransmittance
} from "../.test-dist/render/MomentOitReference.js";
import { GPU_INSTANCE_FLAGS } from "../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_SECONDARY_RASTER_FLAGS } from "../.test-dist/gpu/GpuSecondaryRasterAbi.js";
import {
  GPU_WORK_QUEUE_INVALID_OFFSET,
  createWorkQueueReservationState,
  reserveWorkQueueGroupReference
} from "../.test-dist/gpu/GpuWorkGenerationAbi.js";
import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";

test("FX-05 freezes BLEND classification in the shared SecondaryRasterWork ABI", () => {
  assert.equal(GPU_SECONDARY_RASTER_FLAGS.Transparent, GPU_INSTANCE_FLAGS.Transparent);
  assert.notEqual(GPU_INSTANCE_FLAGS.Transparent, GPU_INSTANCE_FLAGS.AlphaTested);
  assert.notEqual(GPU_INSTANCE_FLAGS.Transparent, GPU_INSTANCE_FLAGS.DoubleSided);
});

test("FX-05 four-power accumulation is order independent and finite for 2/3/4 layers", () => {
  const layers = [
    { depth: 0.15, opacity: 0.2 },
    { depth: 0.42, opacity: 0.45 },
    { depth: 0.71, opacity: 0.7 },
    { depth: 0.91, opacity: 0.93 }
  ];
  for (let count = 2; count <= 4; count++) {
    const forward = accumulatePowerMoments4(layers.slice(0, count));
    const reverse = accumulatePowerMoments4(layers.slice(0, count).reverse());
    assert.ok(Math.abs(reverse.b0 - forward.b0) <= 1e-12);
    for (let index = 0; index < 4; index++) {
      assert.ok(Math.abs(reverse.moments[index] - forward.moments[index]) <= 1e-12);
    }
    for (const depth of [0, 0.25, 0.5, 0.75, 1]) {
      const transmittance = resolvePowerMoments4(depth, forward);
      assert.ok(Number.isFinite(transmittance));
      assert.ok(transmittance >= 0 && transmittance <= 1);
    }
  }
});

test("FX-05 degenerate moments fail finite and conservatively", () => {
  const degenerate = accumulatePowerMoments4([
    { depth: 0.5, opacity: 0.4 },
    { depth: 0.5, opacity: 0.8 }
  ]);
  const resolved = resolvePowerMoments4(0.5, degenerate);
  assert.ok(Number.isFinite(resolved));
  assert.ok(resolved >= totalMomentTransmittance(degenerate.b0));
  assert.ok(resolved <= 1);
  assert.equal(resolvePowerMoments4(0.5, { b0: Number.NaN, moments: [0, 0, 0, 0] }), 1);
  assert.equal(MBOIT_SINGLE_PRECISION_BIAS, 5e-7);
});

test("FX-05 sorted-alpha CPU quality oracle is deterministic", () => {
  const fragments = [
    { depth: 0.2, opacity: 0.5, color: [1, 0, 0] },
    { depth: 0.8, opacity: 0.5, color: [0, 0, 1] }
  ];
  assert.deepEqual(sortedAlphaComposite(fragments), sortedAlphaComposite([...fragments].reverse()));
  assert.deepEqual(sortedAlphaComposite(fragments), [0.5, 0, 0.25, 0.75]);
});

test("FX-05 transparent work uses all-or-nothing bounded reservations", () => {
  const queue = createWorkQueueReservationState(8);
  assert.equal(reserveWorkQueueGroupReference(queue, 5), 0);
  assert.equal(reserveWorkQueueGroupReference(queue, 4), GPU_WORK_QUEUE_INVALID_OFFSET);
  assert.deepEqual(queue, {
    capacity: 8,
    written: 5,
    attempted: 9,
    peak: 5,
    overflow: 1,
    fallback: 1
  });
});

test("FX-05 sampled evidence extends the additive counter ABI without fake zeros", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 8);
  assert.equal(GPU_COUNTER_BYTE_SIZE, 512);
  assert.equal(counterByteOffset("transparentRasterWork"), 256);
  assert.equal(counterByteOffset("transparentTriangles"), 260);
  assert.equal(counterByteOffset("transparentReactivePixels"), 264);
  assert.equal(counterByteOffset("transparentMomentFiniteFailures"), 268);
  assert.equal(counterByteOffset("transparentQueueOverflowMask"), 272);
});

test("FX-05 production source excludes BLEND from opaque and CSM and has no per-material Packed loop", async () => {
  const [hierarchy, visibility, shadow, loader, pass, shader, renderer, ledger] = await Promise.all([
    readFile(new URL("../src/render/HierarchicalWorkGenerator.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render/passes/PackedVisibilityPass.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render/passes/PackedCsmShadowPass.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/loaders/load_gltf.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render/passes/PackedTransparentOitPass.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/shaders/packed_transparent_oit.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8"),
    readFile(new URL("../../docs/references/porting/R5-03-packed-mboit-transparency.md", import.meta.url), "utf8")
  ]);
  assert.match(hierarchy, /excludedInstanceFlags/);
  assert.match(visibility, /excludedInstanceFlags:\s*GPU_INSTANCE_FLAGS\.Transparent/);
  assert.match(shadow, /excludedInstanceFlags:\s*GPU_INSTANCE_FLAGS\.Transparent/);
  assert.match(loader, /GPU_INSTANCE_FLAGS\.Transparent/);
  assert.match(pass, /pass\.drawIndirect\(generated\.drawIndirect, 0\)/);
  assert.match(pass, /lastDrawCount = 3/);
  assert.match(pass, /transientBytesPerPixel = 29/);
  assert.doesNotMatch(pass, /MaterialMeshletDrawList|for \(const material/);
  assert.match(shader, /textureSampleGrad/);
  assert.match(shader, /shade_standard_material_direct/);
  assert.match(shader, /moments = mix\(moments, vec4f\(0\.0, 0\.375, 0\.0, 0\.375\), 0\.0000005\)/);
  assert.match(renderer, /this\._packedTransparentOit \?\?= new PackedTransparentOitPass/);
  assert.match(ledger, /3A09C53B232908B356633D7BC1D9D651AE502E9A73E4E161527A73305B55C1FC/);
  assert.match(ledger, /CC0/);
  assert.match(ledger, /computeTransmittanceAtDepthFrom4PowerMoments/);
});
