import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/cases/virtual-geometry-component/main.ts", import.meta.url), "utf8");

test("virtual geometry browser case executes the production MeshletWork overflow path", () => {
  for (const entryPoint of [
    "prepare_virtual_geometry_work",
    "generate_virtual_geometry_work",
    "finalize_virtual_geometry_work"
  ]) {
    assert.match(source, new RegExp(`entryPoint: [\"']${entryPoint}[\"']`, "u"));
  }
  assert.match(source, /addEvidence\(["']overflowReadback["']/u);
  assert.match(source, /attemptedCount\s*===\s*2/u);
  assert.match(source, /overflowCount\s*===\s*2/u);
  assert.match(source, /instanceCount\s*===\s*0/u);
});
