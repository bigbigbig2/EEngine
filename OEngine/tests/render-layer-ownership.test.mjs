import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const oengineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(oengineRoot, "src");
const gpuRoot = path.join(sourceRoot, "gpu");

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

test("GPU data layer does not depend on render passes, views, or render camera state", () => {
  const forbidden = /(?:\.\.\/render\/(?:passes\/|ViewContext|GPUCameraState))/;
  for (const absolute of typescriptFiles(gpuRoot)) {
    const source = readFileSync(absolute, "utf8");
    assert.doesNotMatch(source, forbidden, path.relative(oengineRoot, absolute));
  }
});

test("GPU light collection publishes data without owning shadow orchestration", () => {
  const source = readFileSync(path.join(gpuRoot, "LightDatabase.ts"), "utf8");
  assert.doesNotMatch(source, /ShadowService|shadow_service/);
  assert.doesNotMatch(source, /process_lights\(\)/);
});

test("Shadow implementation is owned by the Render feature layer", () => {
  const feature = readFileSync(
    path.join(sourceRoot, "render", "features", "ShadowFeature.ts"),
    "utf8"
  );
  assert.match(feature, /export class ShadowFeature/);
  assert.match(feature, /PackedCsmShadowPass/);
  assert.match(feature, /ShadowRasterPass/);
  assert.equal(existsSync(path.join(gpuRoot, "ShadowContext.ts")), false);
  assert.equal(existsSync(path.join(gpuRoot, "ShadowService.ts")), false);
});
