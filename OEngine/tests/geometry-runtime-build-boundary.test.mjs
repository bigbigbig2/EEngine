import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("R2-B-06 package open has no runtime Cooker, meshoptimizer or GPU dependency", async () => {
  const source = await readFile(
    new URL("../src/assets/GeometryAssetPackage.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /from\s+["'][^"']*GeometryCooker/);
  assert.doesNotMatch(source, /from\s+["'][^"']*meshoptimizer/);
  assert.doesNotMatch(source, /from\s+["'][^"']*niMeshlets/);
  assert.doesNotMatch(source, /\bGPUDevice\b|\bGPUBuffer\b|\bRenderer\b/);
  assert.match(source, /openRuntimeAssetPackage/);
});
