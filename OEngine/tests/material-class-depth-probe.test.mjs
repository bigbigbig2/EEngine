import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  selectMaterialResolveBackend,
  setMaterialResolveBackendBenchmarkOverride
} = await import("../.test-dist/render/MaterialClassDepthProbe.js");

test("MaterialClassDepth adapter selection preserves the explicit benchmark fallback", async () => {
  setMaterialResolveBackendBenchmarkOverride("class-discard");
  const selection = await selectMaterialResolveBackend({});
  assert.deepEqual(selection, {
    backend: "class-discard",
    source: "benchmark-override",
    reason: "Rendering Lab requested class-discard"
  });
  setMaterialResolveBackendBenchmarkOverride(null);
});

test("CPU-only injected devices do not claim a successful adapter probe", async () => {
  const selection = await selectMaterialResolveBackend({});
  assert.equal(selection.backend, "class-depth");
  assert.equal(selection.source, "probe-unavailable");
});

test("Renderer records and consumes the adapter backend selection", () => {
  const source = readFileSync(new URL("../src/render/Renderer.ts", import.meta.url), "utf8");
  assert.match(source, /await selectMaterialResolveBackend\(device\)/);
  assert.match(source, /_materialResolveSelection\?\.backend \?\? "class-discard"/);
  assert.match(source, /MaterialClassDepth validation failed; using class-discard correctness fallback/);
});

test("depth-equal verification keeps read-only depth attachment fields omitted", () => {
  const source = readFileSync(new URL("../src/render/MaterialClassDepthProbe.ts", import.meta.url), "utf8");
  const verifyAttachment = source.match(/label: "MaterialClassDepth probe\/verify equal"[\s\S]*?depthStencilAttachment: \{([\s\S]*?)\n      \}/)?.[1];
  assert.ok(verifyAttachment, "verification pass depth attachment should remain explicit");
  assert.match(verifyAttachment, /depthReadOnly: true/);
  assert.doesNotMatch(verifyAttachment, /depth(?:Load|Store)Op/);
});
