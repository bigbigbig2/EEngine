import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";
import {
  RenderDebugView,
  getRenderDebugViewStatus
} from "../.test-dist/debug/RenderDebugView.js";
const GTAO_EVIDENCE_SOURCE = readFileSync(
  new URL("../src/render/passes/ScreenSpaceAmbientOcclusionPass.ts", import.meta.url),
  "utf8"
);
const SSR_EVIDENCE_SOURCE = readFileSync(
  new URL("../src/render/passes/ScreenSpaceReflectionsPass.ts", import.meta.url),
  "utf8"
);
const SSR_TRACE_SOURCE = readFileSync(
  new URL("../src/shaders/ssr_trace.ts", import.meta.url),
  "utf8"
);

test("R5-Q00 additive GPU evidence ABI owns stable AO/SSR offsets", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 12);
  assert.equal(counterByteOffset("aoEvaluatedPixels"), 288);
  assert.equal(counterByteOffset("aoHistoryAcceptedPixels"), 292);
  assert.equal(counterByteOffset("aoHistoryRejectedPixels"), 296);
  assert.equal(counterByteOffset("ssrTracePixels"), 300);
  assert.equal(counterByteOffset("ssrHitPixels"), 304);
  assert.equal(counterByteOffset("ssrTraceSteps"), 308);
  assert.equal(counterByteOffset("ssrMaxTraceSteps"), 312);
  assert.equal(counterByteOffset("ssrRoughnessRejectedPixels"), 316);
  assert.equal(counterByteOffset("ssrDistanceRejectedPixels"), 320);
  assert.equal(counterByteOffset("ssrHighRoughnessTracePixels"), 324);
  assert.equal(counterByteOffset("ssrDistanceLimitExceededPixels"), 328);
  assert.equal(counterByteOffset("ssrValidationRejectedPixels"), 332);
});

test("R5-Q00 SSR trace preserves confidence low bits and emits diagnostic metadata", () => {
  assert.match(SSR_TRACE_SOURCE, /u32\(round\(saturate\(hit\.confidence\) \* 255\.0\)\) \| diagnostics/);
  assert.match(SSR_TRACE_SOURCE, /hit\.iteration_count, 255u\) << 8u/);
  assert.match(SSR_TRACE_SOURCE, /hit\.outcome & 0xffu\) << 16u/);
  assert.match(SSR_TRACE_SOURCE, /1u << 24u, hit\.distance_exceeded/);
  assert.match(SSR_TRACE_SOURCE, /1u << 25u, hit\.high_roughness/);
  assert.match(SSR_EVIDENCE_SOURCE, /atomicMax\(&counters\[\$\{SSR_MAX_TRACE_STEP_INDEX\}u\]/);
  assert.match(SSR_EVIDENCE_SOURCE, /ssrDistanceLimitExceededPixels/);
  assert.match(SSR_EVIDENCE_SOURCE, /ssrValidationRejectedPixels/);
});

test("R5-Q00 GTAO evidence reproduces the production temporal acceptance policy", () => {
  assert.match(GTAO_EVIDENCE_SOURCE, /largest_velocity/);
  assert.match(GTAO_EVIDENCE_SOURCE, /settings\.history_valid != 0u/);
  assert.match(GTAO_EVIDENCE_SOURCE, /history_weight > 0\.001/);
  assert.match(GTAO_EVIDENCE_SOURCE, /aoHistoryAcceptedPixels/);
  assert.match(GTAO_EVIDENCE_SOURCE, /aoHistoryRejectedPixels/);
});

test("R5-Q00 debug views expose each AO and SSR evidence stage", () => {
  for (const view of [
    RenderDebugView.AmbientOcclusionRaw,
    RenderDebugView.AmbientOcclusionDenoised,
    RenderDebugView.AmbientOcclusionTemporal,
    RenderDebugView.ScreenSpaceReflectionHitMiss,
    RenderDebugView.ScreenSpaceReflectionResolve,
    RenderDebugView.ScreenSpaceReflectionTemporal
  ]) {
    assert.equal(getRenderDebugViewStatus(view).status, "supported", view);
  }
});
