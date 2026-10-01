import assert from "node:assert/strict";
import test from "node:test";
import { rewriteSurfaceWorker } from "../labs/surface-performance/ShaderSensitivity.mjs";

test("diagnostic edits require known source seams and never silently use baseline", () => {
  assert.throws(() => rewriteSurfaceWorker("fn other() {}", "material-only"), /exactly one/);
  assert.throws(() => rewriteSurfaceWorker("fn sparse_direct() {return vec3f(0.0);}", "no-ibl"), /seam/);
  assert.throws(() => rewriteSurfaceWorker("", "unknown"), /Unknown/);
  assert.equal(rewriteSurfaceWorker("unaltered", "production"), "unaltered");
});
test("function replacement handles nested braces and preserves other functions", () => {
  const source = "fn sparse_direct(a:f32)->vec3f { if a>0.0 { return vec3f(1.0); } return vec3f(0.0); }\nfn untouched(){return;}";
  const rewritten = rewriteSurfaceWorker(source, "material-only");
  assert.ok(rewritten.includes("surface.roughness"));
  assert.ok(rewritten.endsWith("fn untouched(){return;}"));
  assert.ok(!rewritten.includes("if a>0.0"));
});

test("known unlit and closure-only consumers do not pretend to contain material work", () => {
  assert.equal(rewriteSurfaceWorker("closure-only", "geometry-only", { closureLighting: true }), "closure-only");
  for (const mode of ["geometry-only", "material-only", "no-ibl", "no-direct"]) {
    assert.equal(rewriteSurfaceWorker("unlit-only", mode, { hasLit: false }), "unlit-only");
  }
  assert.throws(() => rewriteSurfaceWorker("unexpected lit source", "geometry-only", { hasLit: true }), /exactly one/);
});
test("worker statistics removal never removes correctness/control reservations", () => {
  const source = Array.from({ length: 5 }, () => "sample_add(SAMPLE_COUNTER_material,1u);").join("\n") + "sample_add(SAMPLE_COUNTER_results,needed);";
  const rewritten = rewriteSurfaceWorker(source, "no-worker-statistics");
  assert.ok(!rewritten.includes("SAMPLE_COUNTER_material"));
  assert.ok(rewritten.includes("sample_add(SAMPLE_COUNTER_results,needed);"));
});
