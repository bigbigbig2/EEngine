import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { nativeSurfaceWgsl } from "../../.test-dist/shaders/native_surface.js";
import {
  VSM_RECEIVER_DEMAND_WGSL,
  vsmReceiverDemandDiagnosticWgsl
} from "../../.test-dist/shaders/vsm_receiver_demand.js";

test("Native diagnostic specializations retain winner predicates and G is the sole default", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output("baseColor", graph.input("vertexColor", 3, "geometry"));
  const program = lowerNativeMaterial(compileAppearanceGraph(graph.build()));
  const profile = { compact: true, productGeometry: true, unlit: false, reactive: true, physicalSun: true };
  const generated = Object.fromEntries(
    ["A", "B0", "B", "C", "D", "E", "F", "G"].map((costSlice) => [
      costSlice,
      nativeSurfaceWgsl(program, { ...profile, costSlice })
    ])
  );
  assert.equal(generated.G, nativeSurfaceWgsl(program, profile));
  const main = (source) => source.slice(source.lastIndexOf("@compute @workgroup_size("));
  for (const source of Object.values(generated)) {
    const body = main(source);
    assert.match(body, /mask & \(1u << \(lane % 32u\)\)/);
    assert.match(body, /frame_instances\[work.instance_slot\].generation != settings.dimensions.w/);
    assert.match(body, /entry.execution_bin != route.x/);
    assert.match(body, /WINNER_VALUE_VALID/);
    assert.match(body, /textureStore\(hdr/);
    assert.match(body, /native_surface_aux_write/);
  }
  assert.doesNotMatch(main(generated.A), /native_material_evaluate\(/);
  assert.match(main(generated.A), /corners.position.p0/);
  assert.match(main(generated.B0), /inputs.center\[/);
  assert.doesNotMatch(main(generated.B0), /inputs\.[xy]\[|interpolation\.(dx|dy)|native_material_evaluate\(/);
  for (const point of ["center", "x", "y"])
    assert.match(main(generated.B), new RegExp(`inputs\\.${point}\\[`));
  assert.match(main(generated.B), /interpolation.dx/);
  assert.doesNotMatch(main(generated.B), /native_material_evaluate\(/);
  assert.match(main(generated.C), /native_material_evaluate\(/);
  assert.match(main(generated.D), /re_direct_physical\(diagnostic_incident/);
  assert.doesNotMatch(main(generated.D), /native_environment\(/);
  assert.match(main(generated.E), /native_environment\(/);
  const sun = (source) =>
    source.slice(
      source.indexOf("fn native_surface_physical_sun("),
      source.indexOf("struct NativeShadingView")
    );
  assert.match(sun(generated.F), /atmosphere_sun_irradiance/);
  assert.doesNotMatch(sun(generated.F), /vsm_sample_directional\(/);
  assert.match(sun(generated.G), /vsm_sample_directional\(/);
  assert.throws(() => nativeSurfaceWgsl(program, { ...profile, costSlice: "unknown" }), /A through G/);
  assert.throws(() => nativeSurfaceWgsl(program, { ...profile, costSlice: "A", additiveSun: true }), /fused/);
});

test("VSM aggregation keeps barriers uniform and diagnostics count actual publications", () => {
  const source = vsmReceiverDemandDiagnosticWgsl();
  const main = source.slice(source.indexOf("fn main("), source.indexOf("fn mark_coarse("));
  assert.doesNotMatch(main, /return;/);
  assert.equal(main.match(/workgroupBarrier\(\)/g).length, 2);
  assert.match(main, /publish_receiver_word\(page, lane\)/);
  assert.match(main, /diagnostic_workgroups\[index \+ 1u\]/);
  assert.doesNotMatch(VSM_RECEIVER_DEMAND_WGSL, /diagnostic_/);
  assert.equal(VSM_RECEIVER_DEMAND_WGSL.match(/workgroupBarrier\(\)/g).length, 1);
  assert.equal(source.match(/atomicAdd\(&diagnostic_totals\[3\]/g).length, 2);
  assert.match(VSM_RECEIVER_DEMAND_WGSL, /attempt < 64u/);
  assert.match(VSM_RECEIVER_DEMAND_WGSL, /if \(!merged\)/);
});
