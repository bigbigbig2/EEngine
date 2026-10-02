import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { FrameGraph, FrameGraphBindingLayout, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { SurfaceReconstructionPass } from "../../.test-dist/render/surface/SurfaceReconstructionPass.js";

globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 };

test("Surface history swaps actual resources on a reused graph and preserves roles on abort", () => {
  const groups = [], settings = [];
  let serial = 0;
  const device = {
    createBuffer: descriptor => ({ ...descriptor, destroy() {} }),
    createTexture: descriptor => {
      const texture = { ...descriptor, serial: ++serial, destroy() {}, createView() { return { texture }; } };
      return texture;
    },
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createComputePipeline: () => ({}),
    createBindGroup: descriptor => { groups.push(descriptor); return descriptor; }
  };
  const command = { gpu_encoder: {}, device,
    writeBuffer(buffer, _offset, data) { if (buffer.label === "Surface reconstruct settings") settings.push(new Uint32Array(data.slice(0))); },
    beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }) };
  const owner = new SurfaceReconstructionPass(device);
  owner.prepareFrame(4, 2);
  const graph = new FrameGraph("Surface history regression");
  const layout = new FrameGraphBindingLayout();
  const initial = {};
  const resource = graph.import_resource("fixture", { kind: "imported" }, {});
  owner.addToGraph(graph, { diffuse: resource, specular: resource, coat: resource, ibl: resource,
    reactive: resource, identity: resource, motion: resource, preExposure: resource, sampleMap: resource,
    revisions: { environment: 1, light: 1, shadow: 1 }, width: 4, height: 2, recordCount: 8,
    diagnosticsEnabled: false, historyBinding: (name, resolve) => layout.slot(name, initial, resolve) });
  const compiled = graph.compile();
  const execute = () => compiled.execute(new FrameGraphContext({ device, encoder: command }), initial);
  const textureAt = (frame, binding) => groups[frame].entries.find(entry => entry.binding === binding).resource.texture;
  execute(); owner.commit(Promise.resolve());
  owner.prepareFrame(4, 2); execute(); owner.abort();
  owner.prepareFrame(4, 2); execute(); owner.commit(Promise.resolve());
  owner.invalidate(); owner.prepareFrame(4, 2); execute(); owner.commit(Promise.resolve());
  for (const [read, write] of [[11,12], [13,14], [15,16], [17,18], [20,21], [22,23]]) {
    assert.notEqual(textureAt(0, read), textureAt(0, write));
    assert.equal(textureAt(1, read), textureAt(0, write));
    assert.equal(textureAt(1, write), textureAt(0, read));
    assert.equal(textureAt(2, read), textureAt(1, read), "abort must not swap history");
    assert.equal(textureAt(3, read), textureAt(2, write));
  }
  assert.deepEqual(settings.map(words => words[3]), [0, 1, 1, 0]);
  owner.destroy();
});
