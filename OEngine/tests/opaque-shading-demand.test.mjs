import assert from "node:assert/strict";
import test from "node:test";

import { RenderDebugView } from "../.test-dist/debug/RenderDebugView.js";
import { GPU_SHADING_OUTPUT_DEPENDENCY } from
  "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";
import { GpuShadingPublicationStore } from
  "../.test-dist/gpu/GpuShadingPublicationPlan.js";
import { deriveOpaqueShadingDemand } from
  "../.test-dist/render/pipeline/OpaqueShadingDemand.js";
import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";

const S = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite;
const D = GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
const V = GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
const I = GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL;

function demand(overrides = {}) {
  return deriveOpaqueShadingDemand({
    opaqueLitReceiverCount: 1,
    opaqueUnlitReceiverCount: 0,
    shadows: false,
    gtao: false,
    ssgi: false,
    ssr: false,
    needsPreviousDepth: false,
    motionBlur: false,
    debugView: RenderDebugView.None,
    ...overrides
  });
}

test("effects-off lit and unlit publications request only their real products", () => {
  const lit = demand();
  assert.deepEqual(lit, {
    hasOpaqueReceiver: true,
    hasOpaqueLitReceiver: true,
    hasOpaqueUnlitReceiver: false,
    needsHdr: true,
    needsSurface: false,
    needsDiffuseSurface: false,
    needsVelocity: false,
    needsPreviousDepth: false,
    needsIndirectComponents: false,
    needsLightingDebug: false,
    needsEnvironmentIbl: true,
    shadowSamplingEnabled: false,
    outputDependencyMask: I
  });
  assert.equal(Object.isFrozen(lit), true);

  const unlit = demand({ opaqueLitReceiverCount: 0, opaqueUnlitReceiverCount: 2 });
  assert.equal(unlit.needsHdr, true);
  assert.equal(unlit.needsEnvironmentIbl, false);
  assert.equal(unlit.outputDependencyMask, 0);

  const empty = demand({ opaqueLitReceiverCount: 0, opaqueUnlitReceiverCount: 0, shadows: true });
  assert.equal(empty.hasOpaqueReceiver, false);
  assert.equal(empty.needsHdr, false);
  assert.equal(empty.shadowSamplingEnabled, false);
  assert.equal(empty.outputDependencyMask, 0);
});

test("advanced indirect consumers request both compact surfaces and move IBL after receiver", () => {
  for (const feature of ["gtao", "ssgi", "ssr"]) {
    const value = demand({ [feature]: true });
    assert.equal(value.needsSurface, true, feature);
    assert.equal(value.needsDiffuseSurface, true, feature);
    assert.equal(value.needsIndirectComponents, true, feature);
    assert.equal(value.needsEnvironmentIbl, false, feature);
    assert.equal(value.outputDependencyMask, S | D, feature);
  }

  for (const debugView of [RenderDebugView.IndirectDiffuse, RenderDebugView.IndirectSpecular]) {
    const value = demand({ debugView });
    assert.equal(value.needsLightingDebug, true, debugView);
    assert.equal(value.needsIndirectComponents, true, debugView);
    assert.equal(value.needsSurface, true, debugView);
    assert.equal(value.needsDiffuseSurface, true, debugView);
    assert.equal(value.needsEnvironmentIbl, false, debugView);
    assert.equal(value.outputDependencyMask, S | D, debugView);
  }

  const linearHdr = demand({ debugView: RenderDebugView.LinearHdr });
  assert.equal(linearHdr.needsLightingDebug, false);
  assert.equal(linearHdr.outputDependencyMask, I);
});

test("temporal, motion and surface debug products remain independently demand-driven", () => {
  const temporal = demand({ needsPreviousDepth: true });
  assert.equal(temporal.needsSurface, true);
  assert.equal(temporal.needsVelocity, true);
  assert.equal(temporal.outputDependencyMask, S | V | I);

  const unlitTemporal = demand({
    opaqueLitReceiverCount: 0,
    opaqueUnlitReceiverCount: 1,
    needsPreviousDepth: true
  });
  assert.equal(unlitTemporal.needsSurface, true);
  assert.equal(unlitTemporal.needsVelocity, true);
  assert.equal(unlitTemporal.outputDependencyMask, S | V);

  const motion = demand({ motionBlur: true });
  assert.equal(motion.needsSurface, false);
  assert.equal(motion.needsVelocity, true);
  assert.equal(motion.outputDependencyMask, V | I);

  const velocityDebug = demand({ debugView: RenderDebugView.Velocity });
  assert.equal(velocityDebug.needsSurface, true);
  assert.equal(velocityDebug.needsVelocity, true);
  assert.equal(velocityDebug.outputDependencyMask, S | V | I);

  const baseColorDebug = demand({ debugView: RenderDebugView.BaseColor });
  assert.equal(baseColorDebug.needsSurface, false);
  assert.equal(baseColorDebug.needsDiffuseSurface, true);
  assert.equal(baseColorDebug.outputDependencyMask, D | I);
});

test("shadow demand is lit-only and invalid demand inputs fail before publication", () => {
  assert.equal(demand({ shadows: true }).shadowSamplingEnabled, true);
  assert.equal(demand({
    opaqueLitReceiverCount: 0,
    opaqueUnlitReceiverCount: 1,
    shadows: true
  }).shadowSamplingEnabled, false);
  assert.throws(() => demand({ opaqueLitReceiverCount: -1 }), /non-negative/u);
  assert.throws(() => demand({ debugView: "unknown" }), /Unknown render debug view/u);
});

test("publication freezes demand and revisions when a demand field changes", () => {
  const adapter = {
    features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
    limits: { ...GPU_SPARSE_SHADING_REQUIRED_LIMITS },
    info: { subgroupMinSize: 4, subgroupMaxSize: 128 }
  };
  const plan = createGpuSparseShadingCapabilityPlan(adapter);
  const capability = captureGpuSparseShadingCapabilityRecord(plan, {
    features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
    limits: { ...GPU_SPARSE_SHADING_REQUIRED_LIMITS },
    textureFormatFeatures: ["texture-formats-tier1"],
    formatProfile: "desktop-tier1-v1"
  });
  const limits = {
    maxTextureDimension2D: 32768,
    maxBufferSize: 8 * 1024 * 1024 * 1024,
    maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65535
  };
  const firstDemand = demand();
  const store = new GpuShadingPublicationStore({
    width: 320,
    height: 180,
    opaqueDemand: firstDemand,
    outputDependencyMask: firstDemand.outputDependencyMask,
    shadowSamplingEnabled: firstDemand.shadowSamplingEnabled,
    capability,
    sizingLimits: limits
  });
  const first = store.currentSnapshot();
  assert.notStrictEqual(first.context.opaqueDemand, firstDemand);
  assert.equal(Object.isFrozen(first.context.opaqueDemand), true);

  const nextDemand = demand({ needsPreviousDepth: true });
  const second = store.beginTransaction().updateContext({
    width: 320,
    height: 180,
    opaqueDemand: nextDemand,
    outputDependencyMask: nextDemand.outputDependencyMask,
    shadowSamplingEnabled: nextDemand.shadowSamplingEnabled,
    capability,
    sizingLimits: limits
  }).commit(1);
  assert.ok(second.revision > first.revision);

  assert.throws(() => new GpuShadingPublicationStore({
    width: 320,
    height: 180,
    opaqueDemand: { ...nextDemand, outputDependencyMask: 0 },
    outputDependencyMask: 0,
    shadowSamplingEnabled: false,
    capability,
    sizingLimits: limits
  }), /fields do not match/u);
});
