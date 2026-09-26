import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("Physical Environment production consumers share the pinned runtime transport", () => {
  const sky = read("src/render/passes/PhysicalSkyPass.ts");
  const aerial = read("src/render/passes/AerialPerspectivePass.ts");
  const runtime = read("src/shaders/atmosphere/runtime.ts");
  assert.match(sky, /texture_3d<f32>/);
  assert.match(aerial, /atmosphere_to_point/);
  assert.match(runtime, /atmosphere_scattering_coord/);
  assert.match(runtime, /atmosphere_segment_transmittance/);
  assert.doesNotMatch(aerial, /d \* 0\.02/);
  assert.doesNotMatch(aerial, /mix\(scene/);
  assert.match(aerial, /node\.write\(output\)/);
});

test("FSR3 production path consumes Surface motion in the unified frame graph", () => {
  const surface = read("src/render/surface/SurfaceMaterialPass.ts");
  const fsr3 = read("src/render/passes/fsr3/Fsr3UpscalerRuntime.ts");
  const renderer = read("src/render/pipeline/RendererCore.ts");
  assert.match(surface, /motionOutput/);
  assert.match(surface, /return \{ radiance: output, motion \}/);
  assert.match(fsr3, /this\.prepareInputs\.addToGraph/);
  assert.match(fsr3, /this\.accumulate\.addToGraph/);
  assert.match(fsr3, /this\.rcas\.addToGraph/);
  assert.match(renderer, /this\._fsr3\.addToGraph/);
  assert.doesNotMatch(renderer, /AnalyticTemporalBaselinePass|TemporalGpuHistory/);
  assert.match(renderer, /markProduced\("motion"\)/);
  assert.match(renderer, /_temporal\.abort\(frameIndex\)/);
});

test("Surface temporal and physical-environment resources have closed bindings", () => {
  const products = read("src/render/surface/SurfaceProducts.ts");
  const bindings = read("src/render/surface/SurfaceKernelBindingPlan.ts");
  const pass = read("src/render/surface/SurfaceMaterialPass.ts");
  assert.match(products, /physical-environment-transmittance/);
  assert.match(bindings, /add\("physical-environment-transmittance"/);
  assert.match(pass, /readonly motionOutput: ResourceId/);
  assert.match(pass, /case "physical-environment-transmittance"/);
});
