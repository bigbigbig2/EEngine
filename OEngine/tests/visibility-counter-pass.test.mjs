import test from "node:test";
import assert from "node:assert/strict";

import {
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";

globalThis.GPUShaderStage ??= { COMPUTE: 1 };

const {
  VISIBILITY_COUNTER_WORKGROUP_SIZE,
  VISIBILITY_COUNTER_WGSL,
  visibilityCounterDispatchSize
} = await import("../.test-dist/render/passes/VisibilityCounterPass.js");

test("visibility counter shader targets the fixed GPU counter ABI", () => {
  const shadedIndex = counterByteOffset("shadedPixels") / Uint32Array.BYTES_PER_ELEMENT;
  const emptyIndex = counterByteOffset("emptyVisibilityPixels") /
    Uint32Array.BYTES_PER_ELEMENT;
  const invalidIndex = counterByteOffset("invalidVisibilityKeys") /
    Uint32Array.BYTES_PER_ELEMENT;

  assert.match(VISIBILITY_COUNTER_WGSL, /const MESH_SENTINEL: u32 = 16777216u;/);
  assert.match(VISIBILITY_COUNTER_WGSL, /fn count_legacy_ids/);
  assert.match(VISIBILITY_COUNTER_WGSL, /fn count_visibility_keys/);
  assert.match(VISIBILITY_COUNTER_WGSL, /oengine_visibility_key_is_valid/);
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`atomicAdd\\(&frame_counters\\[${shadedIndex}u\\]`)
  );
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`atomicAdd\\(&frame_counters\\[${emptyIndex}u\\]`)
  );
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`atomicAdd\\(&frame_counters\\[${invalidIndex}u\\]`)
  );
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`@workgroup_size\\(${VISIBILITY_COUNTER_WORKGROUP_SIZE}, ${VISIBILITY_COUNTER_WORKGROUP_SIZE}\\)`)
  );
});

test("visibility counter dispatch covers partial edge workgroups", () => {
  assert.deepEqual(visibilityCounterDispatchSize(1, 1), [1, 1]);
  assert.deepEqual(visibilityCounterDispatchSize(8, 8), [1, 1]);
  assert.deepEqual(visibilityCounterDispatchSize(9, 17), [2, 3]);
  assert.throws(() => visibilityCounterDispatchSize(0, 1), /width/);
  assert.throws(() => visibilityCounterDispatchSize(1, -1), /height/);
});
