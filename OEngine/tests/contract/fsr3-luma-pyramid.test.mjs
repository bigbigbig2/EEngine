import assert from "node:assert/strict";
import test from "node:test";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { Fsr3LumaPyramidPass } from "../../.test-dist/render/passes/fsr3/Fsr3LumaPyramidPass.js";
globalThis.GPUShaderStage = { COMPUTE: 4 };
globalThis.GPUTextureUsage = { STORAGE_BINDING: 8, TEXTURE_BINDING: 4 };

test("1080p luma retains depth and the fp16 boundary with six executable stages", () => {
  const device = {
    createBindGroupLayout: () => ({}),
    createShaderModule: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
  };
  const owner = new Fsr3LumaPyramidPass(device);
  const graph = new FrameGraph("luma products");
  const imported = (name) => graph.import_resource(name, { kind: "imported" }, {});
  const products = owner.addToGraph(graph, {
    currentLuma: imported("luma"),
    farthestDepth: imported("depth"),
    constants: imported("constants"),
    previousFrameInfo: imported("previous"),
    currentFrameInfo: imported("current"),
    width: 1920,
    height: 1080,
  });
  const consumer = graph.add("consume", {}, () => {});
  consumer.read(products.frameInfo);
  consumer.read(products.farthestDepthMip1);
  consumer.make_side_effect();
  const dump = graph.compile().dump();
  const stages = dump.executablePassOrder.map((id) => dump.passes[id].name);
  assert.equal(stages.filter((name) => name.startsWith("FSR3/Luma")).length, 6);
  assert.ok(stages.indexOf("FSR3/Luma SPD mip5 fp16") < stages.indexOf("FSR3/Luma SPD mip9"));
  const depth = graph.getDescriptor(products.farthestDepthMip1);
  assert.equal(depth.width, 960);
  assert.equal(depth.height, 540);
});
