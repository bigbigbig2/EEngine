import assert from "node:assert/strict";
import test from "node:test";
import { classifySurfaceTimingPhase, surfaceTimingTotalsForFrame } from "../../.test-dist/debug/SurfacePhaseTiming.js";
import { SurfaceFieldLookupPass } from "../../.test-dist/render/surface/SurfaceFieldLookupPass.js";
import '../webgpu-test-globals.mjs';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256 };

test('current Field lookup encoder labels all contribute to Surface timing', () => {
  const callbacks = [], labels = [], entryPoints = [];
  const device = {
    createBuffer: descriptor => ({ ...descriptor, destroy() {} }),
    createBindGroupLayout: descriptor => descriptor,
    createPipelineLayout: descriptor => descriptor,
    createShaderModule: descriptor => descriptor,
    createComputePipeline: descriptor => descriptor,
    createBindGroup: descriptor => descriptor
  };
  const graph = {
    import_resource: () => ({}),
    add(name, data, callback) {
      callbacks.push(() => callback(data, { get: () => ({}) }, { encoder: command }));
      return { read() {}, write: id => id, create: () => ({}) };
    }
  };
  const command = {
    writeBuffer() {}, gpu_encoder: { copyBufferToBuffer() {} },
    beginComputePass({ label }) {
      labels.push(label);
      return {
        setPipeline: pipeline => entryPoints.push(pipeline.compute.entryPoint),
        setBindGroup() {}, dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {}
      };
    }
  };
  const owner = new SurfaceFieldLookupPass(device, null);
  owner.addToGraph(graph, {
    batchTiles: 1, tileCount: 1, referenceCapacity: 64,
    width: 8, height: 8, viewRevision: { value: 1 }, diagnostics: false,
    publication: { surfaceMetadataOffsets: { fieldIdentities: 0, constantFields: 0 } },
    bind: (_name, resolve) => resolve(), workspace: {}, geometry: {}, metadata: {}, versions: {}, activeIndirect: {}
  });
  callbacks.forEach(callback => callback());
  assert.equal(labels.length, 4);
  assert.deepEqual(labels, entryPoints.map(entryPoint => `Surface/${entryPoint}`));
  for (const label of labels) assert.equal(classifySurfaceTimingPhase({ label }), 'materialLookup', label);
  assert.equal(surfaceTimingTotalsForFrame(labels.map(label => ({ label, durationMs: 1 }))).get('materialLookup'), 4);
  assert.equal(classifySurfaceTimingPhase({ label: 'Surface/Field support publish indirect' }), null,
    'Pass-external copy has no compute timestamp and is reported in the copy/span cost');
  owner.destroy();
});

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
    "Surface/current radiometry envelope",
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
  assert.equal(totals.get("classify"), 5);
  assert.equal(totals.get("geometrySetup"), 4);
  assert.equal(totals.get("cacheMaintenance"), 7);
  assert.equal(totals.get("materialLookup"), 1);
  assert.equal(totals.get("reconstruct"), 2);
});

test("independent request chain aggregates every batch before percentiles",()=>{
 const labels=["Surface/canonical field addresses","Surface/shared field certificates family 0",
  "Surface/field value and certificate lookup","Surface/kind-specific signal value lookup",
  "Surface/emit_surface_requests","Surface/emit_signal_cache_requests","Surface/nominate_field_producers","Surface/resolve_field_producers",
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

test("coverage, memo publication and output-domain passes are included in Surface totals", () => {
  const labels = [
    "Surface/single coverage scan", "Surface/publish actual active range",
    "SurfaceGeometry/publish_cell_geometry_memo", "SurfaceGeometry/commit_cell_geometry_memo",
    "Surface/background write domain", "Surface/present radiance"
  ];
  const totals = surfaceTimingTotalsForFrame(labels.map(label => ({ label, durationMs: 1 })));
  assert.equal(totals.get("classify"), 2);
  assert.equal(totals.get("cacheMaintenance"), 2);
  assert.equal(totals.get("reconstruct"), 2);
});
