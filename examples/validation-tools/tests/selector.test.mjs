import test from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainV1Z, selectCasesForPaths } from "../selector.mjs";

test("working tree parser includes staged, unstaged, untracked, renamed and deleted paths", () => {
  const output = [
    "M  OEngine/src/render/Renderer.ts",
    " M OEngine/src/gpu/GraphicsContext.ts",
    "?? examples/validation/smoke/main.ts",
    "D  OEngine/src/material/OldMaterial.ts",
    "R  OEngine/src/render/NewName.ts",
    "OEngine/src/render/OldName.ts",
    ""
  ].join("\0");
  assert.deepEqual(parsePorcelainV1Z(output), [
    "OEngine/src/gpu/GraphicsContext.ts",
    "OEngine/src/material/OldMaterial.ts",
    "OEngine/src/render/NewName.ts",
    "OEngine/src/render/OldName.ts",
    "OEngine/src/render/Renderer.ts",
    "examples/validation/smoke/main.ts"
  ]);
});

test("unmapped OEngine source escalates to conservative cases", () => {
  const selection = selectCasesForPaths(["OEngine/src/new-domain/Unknown.ts"]);
  assert.deepEqual(selection.unmappedPaths, ["OEngine/src/new-domain/Unknown.ts"]);
  assert.deepEqual(selection.caseIds, [
    "smoke.basic",
    "lifecycle.init-destroy",
    "visibility.basic"
  ]);
});

test("visibility changes select visibility cases through the registry", () => {
  const selection = selectCasesForPaths([
    "OEngine/src/render/HierarchicalWorkGenerator.ts"
  ]);
  assert.ok(selection.domains.includes("visibility"));
  assert.ok(selection.caseIds.includes("visibility.basic"));
  assert.ok(selection.caseIds.includes("visibility.occlusion"));
});

test("cross-cutting renderer changes stay within the lightweight registry set", () => {
  const selection = selectCasesForPaths(["OEngine/src/render/Renderer.ts"]);
  assert.deepEqual(selection.caseIds, [
    "smoke.basic",
    "lifecycle.init-destroy",
    "visibility.basic"
  ]);
});
