import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(root, "src");
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), "utf8");

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? typescriptFiles(absolute)
      : entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

test("GPU data ownership does not depend on render passes or camera state", () => {
  for (const absolute of typescriptFiles(path.join(sourceRoot, "gpu"))) {
    assert.doesNotMatch(
      readFileSync(absolute, "utf8"),
      /(?:\.\.\/render\/(?:passes\/|ViewContext|GPUCameraState))/u,
      path.relative(root, absolute)
    );
  }
});

test("Phase 1 has one Renderer graph and no old effect composition", () => {
  const entry = read("render", "Renderer.ts");
  const core = read("render", "pipeline", "RendererCore.ts");
  assert.match(entry, /RendererCore\.js/u);
  assert.doesNotMatch(entry, /extends|MainRenderPipeline/u);
  assert.match(core, /new FrameGraph\(/u);
  assert.match(core, /encodeCompiledGraph\(/u);
  assert.match(core, /_frameCoordinator\.submitFrame\(/u);
  assert.match(core, /executionMode: "none"/u);
  assert.match(core, /addCurrentHzbLateRecheckToGraph/u);
  assert.match(core, /_present\.addToGraph\(/u);
  assert.doesNotMatch(core, /SparseShadingPublicationCoordinator|OptionalFrameFeatures|\.traverse\(/u);
  for (const relative of [
    ["render", "pipeline", "MainRenderPipeline.ts"],
    ["render", "pipeline", "FramePlan.ts"],
    ["render", "pipeline", "OptionalFrameFeatures.ts"],
    ["render", "features", "GIService.ts"],
    ["render", "features", "ShadowFeatureManager.ts"]
  ]) {
    assert.equal(existsSync(path.join(sourceRoot, ...relative)), false, relative.join("/"));
  }
});
