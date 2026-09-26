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

test("Temporal production path materializes motion and GPU history", () => {
  const surface = read("src/render/surface/SurfaceMaterialPass.ts");
  const baseline = read("src/render/passes/AnalyticTemporalBaselinePass.ts");
  const renderer = read("src/render/pipeline/RendererCore.ts");
  assert.match(surface, /motionOutput/);
  assert.match(baseline, /EEngine Analytic Temporal Baseline/);
  assert.match(baseline, /previousColor/);
  assert.match(baseline, /outputMotionHistory/);
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
