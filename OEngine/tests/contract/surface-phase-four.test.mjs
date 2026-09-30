import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildFrameProgram } from "../../.test-dist/render/program/FrameProgram.js";
import { surfaceSampleCapacity } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";

const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
const limits = Object.freeze({
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxTextureDimension2D: 8192,
  maxComputeWorkgroupsPerDimension: 65535
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("Surface production source has no retired frequency or dense owner", async () => {
  const files = await sourceFiles(join(sourceRoot, "render", "surface"));
  files.push(...await sourceFiles(join(sourceRoot, "shaders")));
  const source = (await Promise.all(files.map(path => readFile(path, "utf8")))).join("\n");
  for (const pattern of [
    /SurfaceFrequencyResolvePass/u,
    /ShadingWorkPass/u,
    /SurfaceExecutionAbi/u,
    /surface_frequency/u,
    /shading_frequency/u,
    /surface_execution/u,
    /activeExceptionLanes/u
  ]) {
    assert.doesNotMatch(source, pattern, `retired Surface owner remains: ${pattern}`);
  }
  assert.match(source, /Surface\/coarse sample Resolve/u);
  assert.match(source, /Surface\/tile Work Builder/u);
});

test("Surface capacity and Frame Program boundaries remain lifecycle-safe", () => {
  const first = buildFrameProgram({
    kind: "scene", intent: "present", viewFamily: "main", outputWidth: 1280,
    outputHeight: 720, outputFormat: "bgra8unorm", capabilityProfile: "epoch-1",
    internalWidth: 640, internalHeight: 360, virtualGeometry: false,
    virtualBankCount: 0, previousHzb: true, currentHzbLateRecheck: false,
    activeSets: [0], hasLit: true, physicalEnvironment: false
  });
  const resized = buildFrameProgram({ ...first.request, internalWidth: 800 });
  assert.notEqual(first.key, resized.key);
  assert.deepEqual(first.facts.find(fact => fact.product === "reconstructed-color").consumers,
    ["bloom", "radiometry"]);
  assert.deepEqual(first.facts.find(fact => fact.product === "temporal-motion").consumers,
    ["temporal-facts", "fsr3"]);

  const capacity = surfaceSampleCapacity(1919, 1079, limits, { records: 0, results: 0 });
  assert.equal(capacity.tileCount, 240 * 135);
  assert.equal(capacity.recordCapacity, 0);
  assert.equal(capacity.resultCapacity, 0);
  assert.throws(() => surfaceSampleCapacity(8193, 1, limits), /extent/u);
  assert.throws(() => surfaceSampleCapacity(8, 8, limits, { records: 65, results: 0 }), /capacity/u);
});
