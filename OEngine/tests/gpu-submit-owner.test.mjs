import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyGpuSubmitLabel,
  submitGpuCommands
} from "../.test-dist/gpu/GpuQueueEvidence.js";

const MAIN_FRAME_MODULES = [
  "src/render/Renderer.ts",
  "src/render/ViewManager.ts",
  "src/gpu/GraphicsContext.ts",
  "src/gpu/GPUSceneContext.ts",
  "src/gpu/ShadowContext.ts",
  "src/render/ViewContext.ts",
  "src/gpu/LightDatabase.ts",
  "src/gpu/GPUVolumetrics.ts",
  "src/gpu/GeometryBlasPool.ts",
  "src/gpu/TopLevelAccelerationStructure.ts"
];

test("main render modules cannot own an encoder or submit", () => {
  for (const relativePath of MAIN_FRAME_MODULES) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /createCommandEncoder\s*\(/, relativePath);
    assert.doesNotMatch(source, /submitGpuCommands\s*\(/, relativePath);
    if (
      relativePath !== "src/gpu/GraphicsContext.ts" &&
      relativePath !== "src/render/Renderer.ts"
    ) {
      assert.doesNotMatch(source, /ShadeGPUCommandContext\.create\s*\(/, relativePath);
    }
  }
});

test("Renderer command contexts are limited to classified Packed Scene tools", () => {
  const source = readFileSync(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  const labels = [...source.matchAll(/ShadeGPUCommandContext\.create\(\s*this\._graphics,\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(labels.sort(), [
    "Renderer/PackedScene/release-transaction",
    "Renderer/PackedScene/residency-transaction"
  ]);
  for (const label of labels) assert.equal(classifyGpuSubmitLabel(label), "tool");
});

test("database debug readback remains classified but grow never self-submits", () => {
  const source = readFileSync(
    new URL("../src/gpu/GPUDatabase.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /GPUDatabase\/grow/);
  assert.match(source, /GPUDatabase\/read/);
});

test("main-command mipmap resources are deferred until submit", () => {
  const source = readFileSync(
    new URL("../src/gpu/MipmapGenerator.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /command\.destroyAfterSubmit\(params\)/);
  assert.match(source, /command\.destroyAfterSubmit\(texture\)/);
  assert.doesNotMatch(source, /else\s*\{\s*params\.destroy\(\)/);
});

test("every known submit label has an explicit owner class", () => {
  const expected = new Map([
    ["Renderer/main-0", "render-frame"],
    ["GraphicsContext/one-shot-maintenance", "one-shot"],
    ["GPUResidentMaterialContext/one-shot-update", "one-shot"],
    ["LPV/generate-locations", "tool"],
    ["LPV/dering", "tool"],
    ["LPV/bake", "tool"],
    ["GPUCameraState/copy", "tool"],
    ["GPUDatabase/read", "debug-readback"],
    ["GPUCollectionLimits/read", "debug-readback"],
    ["LightProbeVolume/read", "debug-readback"],
    ["GPUIndexedRecordTable/read", "debug-readback"],
    ["SceneSdf/read", "debug-readback"],
    ["GPUTextureContext/resize-copy", "recovery"],
    ["MeshletGpuPool/compact", "tool"],
    ["MipmapGenerator/generate", "one-shot"],
    ["Renderer/PackedScene/residency-transaction", "tool"],
    ["Renderer/PackedScene/release-transaction", "tool"],
    ["Renderer/View/release", "tool"]
  ]);
  for (const [label, kind] of expected) {
    assert.equal(classifyGpuSubmitLabel(label), kind, label);
  }
  assert.equal(classifyGpuSubmitLabel(""), undefined);
  assert.equal(classifyGpuSubmitLabel("new/unreviewed-submit"), undefined);
});

test("unclassified submit labels fail before touching the GPU queue", () => {
  let submitted = false;
  const device = {
    queue: {
      submit() {
        submitted = true;
      }
    }
  };
  assert.throws(
    () => submitGpuCommands(device, "new/unreviewed-submit", []),
    /Unclassified GPU submit owner/
  );
  assert.equal(submitted, false);
});
