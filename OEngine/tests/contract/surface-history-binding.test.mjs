import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { planSurfaceReconstructionBatches, SurfaceReconstructionPass } from "../../.test-dist/render/surface/SurfaceReconstructionPass.js";

globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 };

test("Surface reconstruct plans bounded tile batches", () => {
  assert.deepEqual(planSurfaceReconstructionBatches(17, 9, 2), {
    tilesX: 3, tilesY: 2, tileCount: 6, batchTiles: 2, batchCount: 3
  });
  assert.throws(() => planSurfaceReconstructionBatches(0, 9), /positive integers/);
  assert.throws(() => planSurfaceReconstructionBatches(17, 9, 0), /batchTiles is invalid/);
});

test("Surface reconstruct consumes packet and TemporalFacts resources", () => {
  const device = {
    createBuffer: descriptor => ({ ...descriptor, destroy() {} }),
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createComputePipeline: () => ({}),
    createBindGroup: descriptor => descriptor
  };
  const command = { gpu_encoder: {}, device,
    writeBuffer() {},
    beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {},
      dispatchWorkgroupsIndirect() {}, end() {} }) };
  const owner = new SurfaceReconstructionPass(device);
  owner.prepareFrame(4, 2, 1);
  const graph = new FrameGraph("Surface packet reconstruct");
  const texture = { createView: () => ({}) };
  const resource = graph.import_resource("fixture", { kind: "imported" }, texture);
  const packets = graph.import_resource("packets", { kind: "imported" }, {});
  const fullPackets = graph.import_resource("full packets", { kind: "imported" }, {});
  const preExposure = graph.import_resource("pre exposure", { kind: "imported" }, {});
  const sampleMap = graph.import_resource("sample map", { kind: "imported" }, texture);
  const products = owner.addToGraph(graph, { packets, fullPackets, reactive: resource, preExposure, sampleMap,
    width: 4, height: 2, recordCount: 8, diagnosticsEnabled: true });
  assert.ok(products.radiance);
  assert.ok(products.reactiveMask);
  assert.ok(products.counters);
  const consume = graph.add("consume reconstruct outputs", {}, () => {});
  consume.read(products.radiance); consume.read(products.reactiveMask); consume.read(products.counters);
  consume.make_side_effect();
  const compiled = graph.compile();
  const dump = compiled.dump();
  assert.ok(dump.executablePassOrder.some(id => dump.passes[id].name === "Surface/cheap batched reconstruct"));
  assert.ok(dump.resources.some(entry => entry.name === "packets"));
  assert.ok(dump.resources.some(entry => entry.name === "full packets"));
  assert.ok(dump.resources.some(entry => entry.name === "sample map"));
  owner.commit();
  assert.throws(() => owner.commit(), /without prepare/);
  owner.prepareFrame(4, 2, 1);
  owner.abort();
  assert.throws(() => owner.addToGraph(new FrameGraph("aborted"), {
    packets, fullPackets, reactive: resource, preExposure, sampleMap,
    width: 4, height: 2, recordCount: 8, diagnosticsEnabled: false
  }), /not prepared/);
  owner.destroy();
});
