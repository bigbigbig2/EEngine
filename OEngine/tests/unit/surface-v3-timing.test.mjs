import assert from "node:assert/strict";
import test from "node:test";
import { surfaceTimingTotalsForFrame } from "../../.test-dist/debug/SurfacePhaseTiming.js";

test("V3 totals include actual dispatch labels and every material program once", () => {
  const segments = [
    ["SurfaceWork/classify", 0.4],
    ["Surface/GeometryRecord cache classify", 0.3],
    ["Surface/view epoch", 0.01],
    ["Surface/input witness", 0.2],
    ["Surface/residency epoch", 0.02],
    ["Surface/GeometryRecord miss resolve", 4],
    ["Surface/material publication kernel 0", 2],
    ["Surface/material publication kernel 1", 0.5],
    ["Surface/reconstruct", 1],
    ["Surface/diagnostics snapshot", 99],
    ["FSR3 Accumulate", 7]
  ].map(([label, durationMs]) => ({ label: `Renderer/visibility-frame/${label}`, durationMs }));
  assert.deepEqual([...surfaceTimingTotalsForFrame(segments)], [
    ["classify", 0.4], ["geometryLookup", 0.51], ["materialLookup", 0.02], ["geometryResolve", 4],
    ["materialEvaluate", 2.5], ["reconstruct", 1]
  ]);
});

test("optimization timing includes cell setup, cache maintenance and signal publication", () => {
  const labels = [
    "Surface/cell publish material constants",
    "Surface/cell publish geometry and lighting facts",
    "Surface/cell classify continuity domains 0",
    "Surface/cell compact representative work",
    "SurfaceGeometry/reset_cell_geometry",
    "SurfaceGeometry/request_cell_geometry",
    "SurfaceGeometry/finalize_cell_geometry",
    "SurfaceGeometry/build_cell_geometry",
    "Surface/FieldStore initialize",
    "Surface/FieldStore lookup",
    "Surface/FieldStore request pack",
    "Surface/FieldStore request pack after evaluation",
    "Surface/FieldStore publish after evaluation",
    "Surface/SignalStore initialize",
    "Surface/SignalStore request pack",
    "Surface/SignalStore publish",
    "Surface/reconstruct batch counts",
    "Surface/reconstruct batch 0"
  ];
  const segments = labels.map(label => ({ label: `Renderer/visibility-frame/${label}`, durationMs: 1 }));
  const totals = surfaceTimingTotalsForFrame(segments);
  assert.equal([...totals.values()].reduce((sum, value) => sum + value, 0), labels.length);
  assert.equal(totals.get("classify"), 4);
  assert.equal(totals.get("geometrySetup"), 4);
  assert.equal(totals.get("cacheMaintenance"), 7);
  assert.equal(totals.get("materialLookup"), 1);
  assert.equal(totals.get("reconstruct"), 2);
});

test("independent request chain aggregates every batch before percentiles",()=>{
 const labels=["Surface/canonical field addresses","Surface/shared field certificates family 0",
  "Surface/field value and certificate lookup","Surface/kind-specific signal value lookup",
  "Surface/emit_surface_requests","Surface/nominate_field_producers","Surface/resolve_field_producers",
  "Surface/nominate_signal_producers","Surface/resolve_signal_producers","Surface/compact_surface_groups",
  "Surface/finalize_surface_groups","Surface/order_material_groups","Surface/unique GeometryRecord",
  "Surface/material publication kernel 0","Surface/field Store 0","Surface/field Store 1","Surface/field Store 2",
  "Surface/unique dirty Lighting","Surface/signal Store 0","Surface/signal Store 1","Surface/signal Store 2",
  "Surface/reconstruct batch counts","Surface/reconstruct batch 0"];
 const segments=[...labels,...labels].map(label=>({label,durationMs:1}));
 segments.push({label:"Surface/actual batch diagnostic snapshot",durationMs:1000});
 const totals=surfaceTimingTotalsForFrame(segments);
 assert.equal([...totals.values()].reduce((a,b)=>a+b,0),labels.length*2);
 assert.equal(totals.get("lighting"),2);
 assert.equal(totals.get("cacheMaintenance"),12);
});
