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
  assert.doesNotMatch(feature, /ShadowRasterPass/);
  assert.equal(existsSync(path.join(gpuRoot, "ShadowContext.ts")), false);
  assert.equal(existsSync(path.join(gpuRoot, "ShadowService.ts")), false);
});

test("MainRenderPipeline is the sole owner of the main graph recipe and algorithm features", () => {
  const renderer = readFileSync(path.join(sourceRoot, "render", "Renderer.ts"), "utf8");
  const pipeline = readFileSync(
    path.join(sourceRoot, "render", "pipeline", "MainRenderPipeline.ts"),
    "utf8"
  );

  assert.match(renderer, /MainRenderPipeline/);
  assert.doesNotMatch(renderer, /new FrameGraph\b|CompiledFrameGraphCache/);
  assert.doesNotMatch(renderer, /from "\.\/passes\//);
  assert.doesNotMatch(
    renderer,
    /from "\.\/features\/(?:VisibilityFeature|SurfaceFeature|LightingFeature|ShadowFeature|TransparencyFeature|AOService|ReflectionService|GIService|TemporalFeature|PostFeature)/
  );

  assert.match(pipeline, /new FrameGraph\b/);
  assert.match(pipeline, /CompiledFrameGraphCache/);
  assert.match(pipeline, /getOrCreate/);
  assert.match(pipeline, /MainFrameGraphEvidence/);
});

test("FrameContext is an immutable value contract without renderer service locators", () => {
  const frameContext = readFileSync(
    path.join(sourceRoot, "render", "pipeline", "FrameContext.ts"),
    "utf8"
  );

  assert.match(frameContext, /Readonly<|readonly /);
  assert.doesNotMatch(frameContext, /\bRenderer\b|\bGraphicsContext\b/);
  assert.match(frameContext, /resolution/);
  assert.match(frameContext, /featureTopology/);
  assert.match(frameContext, /history/);
  assert.match(frameContext, /scene/);
  assert.match(frameContext, /instrumentation/);
  assert.match(frameContext, /capture/);
});

test("main graph cache identity covers every current topology dimension", () => {
  const graphKey = readFileSync(
    path.join(sourceRoot, "render", "pipeline", "MainRenderPipelineGraphKey.ts"),
    "utf8"
  );

  for (const dimension of [
    "capability",
    "resolution",
    "featureTopology",
    "visibilityConfiguration",
    "instrumentation",
    "historyFormat",
  ]) {
    assert.match(graphKey, new RegExp(dimension), dimension);
  }
});

test("Step 7 removes the legacy render-world runtime and graph consumers", () => {
  const removed = [
    ["gpu", "GPUSceneManager.ts"],
    ["gpu", "GPUSceneContext.ts"],
    ["gpu", "GPUMaterialContext.ts"],
    ["gpu", "MaterialMetadataTable.ts"],
    ["gpu", "SceneDatabase.ts"],
    ["gpu", "MeshletDrawList.ts"],
    ["gpu", "MaterialMeshletDrawList.ts"],
    ["render", "passes", "VisibilityPass.ts"],
    ["render", "passes", "MaterialExpandPass.ts"],
    ["render", "passes", "VelocityPass.ts"],
    ["render", "passes", "TransparentOitPass.ts"],
    ["render", "passes", "ShadowRasterPass.ts"],
  ];
  for (const parts of removed) {
    assert.equal(
      existsSync(path.join(sourceRoot, ...parts)),
      false,
      parts.join("/")
    );
  }

  for (const relative of [
    ["render", "pipeline", "MainRenderPipeline.ts"],
    ["render", "pipeline", "SceneFrameBindings.ts"],
    ["render", "features", "ShadowFeature.ts"],
    ["render", "features", "TransparencyFeature.ts"],
    ["gpu", "GraphicsContext.ts"],
  ]) {
    const source = readFileSync(path.join(sourceRoot, ...relative), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:GPUSceneContext|GPUSceneManager|GPUMaterialContext|MaterialMetadataTable|SceneDatabase|MeshletDrawList|MaterialExpandPass|VelocityPass|TransparentOitPass|ShadowRasterPass)\b|kind:\s*"legacy"/,
      relative.join("/")
    );
  }
});
