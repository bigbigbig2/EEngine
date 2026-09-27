import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildFrameProgram } from "../../.test-dist/render/program/FrameProgram.js";

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

test("FSR3 product demand includes Surface motion and the Present consumer", () => {
  const program = buildFrameProgram({ kind: "scene", intent: "present", viewFamily: "main", outputWidth: 1280, outputHeight: 720,
    outputFormat: "bgra8unorm", capabilityProfile: "test", internalWidth: 640, internalHeight: 360,
    virtualGeometry: false, virtualBankCount: 0, previousHzb: true,
    currentHzbLateRecheck: false,
    activeSets: [0], hasLit: false, physicalEnvironment: false });
  for (const product of ["visibility", "surface-radiance", "surface-motion",
    "reconstructed-color", "swapchain"]) assert.ok(program.products.includes(product), product);
  assert.deepEqual(program.facts.find(fact => fact.product === "surface-motion").consumers, ["fsr3"]);
  assert.deepEqual(program.facts.find(fact => fact.product === "reconstructed-color").consumers, ["present"]);
});

test("Surface temporal and physical-environment resources have closed bindings", () => {
  const products = read("src/render/surface/SurfaceProducts.ts");
  const bindings = read("src/render/surface/SurfaceKernelBindingPlan.ts");
  const pass = read("src/render/surface/SurfaceMaterialPass.ts");
  assert.match(products, /physical-environment-transmittance/);
  assert.match(bindings, /add\("physical-environment-transmittance"/);
  const program = buildFrameProgram({ kind: "scene", intent: "present", viewFamily: "main",
    outputWidth: 1280, outputHeight: 720, outputFormat: "bgra8unorm", capabilityProfile: "test",
    internalWidth: 640, internalHeight: 360, virtualGeometry: false, virtualBankCount: 0,
    previousHzb: false, currentHzbLateRecheck: false, activeSets: [0],
    hasLit: false, physicalEnvironment: true });
  assert.ok(program.stages.includes("physical-sky"));
  assert.ok(program.stages.includes("aerial"));
  assert.deepEqual(program.facts.find(fact => fact.product === "surface-motion").consumers, ["fsr3"]);
  assert.match(pass, /case "physical-environment-transmittance"/);
});
