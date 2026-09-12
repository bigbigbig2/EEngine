import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_CAPABILITY_SCHEMA_VERSION,
  GPU_SPARSE_SHADING_CLASSIFIER_WORKGROUP_STORAGE_BYTES,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS,
  UnsupportedGpuPerformanceBaselineError
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";

const requiredFeatures = [...GPU_SPARSE_SHADING_REQUIRED_FEATURES];
const exactLimits = { ...GPU_SPARSE_SHADING_REQUIRED_LIMITS };
const adapterLimits = { ...exactLimits, subgroupMinSize: 4, subgroupMaxSize: 128 };

function adapter(overrides = {}) {
  return {
    features: overrides.features ?? requiredFeatures,
    limits: overrides.limits ?? adapterLimits
  };
}

test("ADR-0013 capability plan requests exact sparse-shading features and thresholds", () => {
  const highLimits = Object.fromEntries(
    Object.entries(adapterLimits).map(([name, value]) => [name, value * (name.startsWith("subgroup") ? 1 : 4)])
  );
  const plan = createGpuSparseShadingCapabilityPlan(adapter({ limits: highLimits }));
  assert.equal(plan.schemaVersion, GPU_SPARSE_SHADING_CAPABILITY_SCHEMA_VERSION);
  assert.deepEqual([...plan.requiredFeatures].sort(), [...requiredFeatures].sort());
  assert.deepEqual(plan.requiredLimits, Object.fromEntries(
    Object.entries(exactLimits).sort(([left], [right]) => left.localeCompare(right))
  ));
  assert.equal(plan.requiredLimits.maxComputeInvocationsPerWorkgroup, 256);
  assert.equal(plan.requiredLimits.maxComputeWorkgroupStorageSize, 768);
  assert.equal(GPU_SPARSE_SHADING_CLASSIFIER_WORKGROUP_STORAGE_BYTES, 768);
  assert.ok(!plan.requiredFeatures.includes("subgroup-size-control"));
  assert.equal(plan.subgroupMinSize, 4);
  assert.equal(plan.subgroupMaxSize, 128);
});

test("each required feature fails before device/resource creation with structured evidence", () => {
  for (const missing of requiredFeatures) {
    assert.throws(
      () => createGpuSparseShadingCapabilityPlan(adapter({
        features: requiredFeatures.filter((feature) => feature !== missing)
      })),
      (error) => {
        assert.ok(error instanceof UnsupportedGpuPerformanceBaselineError);
        assert.equal(error.failureKind, "feature");
        assert.equal(error.capability, missing);
        assert.equal(error.required, "supported");
        assert.equal(error.actual, "missing");
        assert.match(error.message, /Unsupported OEngine GPU Performance Baseline/u);
        return true;
      }
    );
  }
});

test("every required limit accepts equality and rejects exactly one below", () => {
  assert.doesNotThrow(() => createGpuSparseShadingCapabilityPlan(adapter()));
  for (const [name, required] of Object.entries(exactLimits)) {
    assert.throws(
      () => createGpuSparseShadingCapabilityPlan(adapter({
        limits: { ...adapterLimits, [name]: required - 1 }
      })),
      (error) => {
        assert.ok(error instanceof UnsupportedGpuPerformanceBaselineError);
        assert.equal(error.failureKind, "limit");
        assert.equal(error.capability, name);
        assert.equal(error.required, required);
        assert.equal(error.actual, required - 1);
        return true;
      }
    );
  }
});

test("dependency closure is merged exactly and forbidden subgroup size control is rejected", () => {
  const snapshot = adapter({
    features: [...requiredFeatures, "indirect-first-instance"],
    limits: { ...adapterLimits, maxColorAttachmentBytesPerSample: 64 }
  });
  const plan = createGpuSparseShadingCapabilityPlan(snapshot, {
    requiredFeatures: ["indirect-first-instance"],
    requiredLimits: { maxColorAttachmentBytesPerSample: 32 }
  });
  assert.ok(plan.requiredFeatures.includes("indirect-first-instance"));
  assert.equal(plan.requiredLimits.maxColorAttachmentBytesPerSample, 32);
  assert.throws(
    () => createGpuSparseShadingCapabilityPlan(adapter({
      features: [...requiredFeatures, "subgroup-size-control"]
    }), { requiredFeatures: ["subgroup-size-control"] }),
    (error) => error instanceof UnsupportedGpuPerformanceBaselineError &&
      error.capability === "subgroup-size-control"
  );
});

test("post-device record freezes actual limits, subgroup range, formats and stable fingerprint", () => {
  const plan = createGpuSparseShadingCapabilityPlan(adapter());
  const device = {
    features: [...requiredFeatures].reverse(),
    limits: { ...exactLimits, subgroupMinSize: 4, subgroupMaxSize: 128 },
    textureFormatFeatures: ["rg32uint-storage", "rgba16uint-storage"],
    formatProfile: "desktop-tier1-v1"
  };
  const first = captureGpuSparseShadingCapabilityRecord(plan, device);
  const reordered = captureGpuSparseShadingCapabilityRecord(plan, {
    ...device,
    features: [...requiredFeatures],
    textureFormatFeatures: [...device.textureFormatFeatures].reverse()
  });
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.subgroupMinSize, 4);
  assert.equal(first.subgroupMaxSize, 128);
  assert.equal(first.fingerprint, reordered.fingerprint);
  assert.notEqual(
    first.fingerprint,
    captureGpuSparseShadingCapabilityRecord(plan, {
      ...device,
      limits: { ...device.limits, subgroupMinSize: 32, subgroupMaxSize: 32 }
    }).fingerprint
  );
  assert.notEqual(
    first.fingerprint,
    captureGpuSparseShadingCapabilityRecord(plan, {
      ...device,
      formatProfile: "desktop-tier1-v2"
    }).fingerprint
  );
});

test("invalid subgroup ranges and post-device capability loss fail structurally", () => {
  const plan = createGpuSparseShadingCapabilityPlan(adapter());
  const base = {
    features: requiredFeatures,
    limits: { ...exactLimits, subgroupMinSize: 4, subgroupMaxSize: 128 },
    textureFormatFeatures: [],
    formatProfile: "desktop-tier1-v1"
  };
  for (const [minimum, maximum] of [[0, 32], [3, 32], [8, 4], [6, 32], [4, 256]]) {
    assert.throws(
      () => createGpuSparseShadingCapabilityPlan(adapter({
        limits: { ...adapterLimits, subgroupMinSize: minimum, subgroupMaxSize: maximum }
      })),
      (error) => error instanceof UnsupportedGpuPerformanceBaselineError &&
        error.failureKind === "subgroup-range"
    );
    assert.throws(
      () => captureGpuSparseShadingCapabilityRecord(plan, {
        ...base,
        limits: { ...base.limits, subgroupMinSize: minimum, subgroupMaxSize: maximum }
      }),
      (error) => error instanceof UnsupportedGpuPerformanceBaselineError &&
        error.failureKind === "subgroup-range"
    );
  }
  assert.throws(
    () => captureGpuSparseShadingCapabilityRecord(plan, {
      ...base,
      features: requiredFeatures.filter((feature) => feature !== "subgroups")
    }),
    (error) => error instanceof UnsupportedGpuPerformanceBaselineError &&
      error.capability === "subgroups"
  );
  assert.throws(
    () => captureGpuSparseShadingCapabilityRecord(plan, {
      ...base,
      limits: { ...base.limits, maxStorageTexturesPerShaderStage: 4 }
    }),
    (error) => error instanceof UnsupportedGpuPerformanceBaselineError &&
      error.capability === "maxStorageTexturesPerShaderStage"
  );
});

test("Step 2 capability code is not wired into the production Renderer before cutover", () => {
  const source = readFileSync(new URL("../src/render/pipeline/MainRenderPipeline.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /GpuSparseShadingCapability/u);
  assert.doesNotMatch(source, /createGpuSparseShadingCapabilityPlan/u);
});
