import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { XeGtaoDenoisePass } from "../../.test-dist/render/ao/XeGtaoDenoisePass.js";

globalThis.GPUBufferUsage ??= { STORAGE: 128 };

function build(consumer) {
  const device = {
    features: new Set(["texture-formats-tier1"]),
    limits: {
      maxSampledTexturesPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 4,
      maxStorageBuffersPerShaderStage: 8,
      maxStorageBufferBindingSize: 1e8,
      maxBufferSize: 1e8,
      maxComputeWorkgroupsPerDimension: 65535
    },
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createComputePipeline: (descriptor) => descriptor,
    createShaderModule: (descriptor) => descriptor
  };
  const graph = new FrameGraph("XeGTAO scalar consumer contract");
  const imported = (name) => graph.import_resource(name, { kind: "imported" }, {});
  const owner = new XeGtaoDenoisePass(device, 1);
  const result = owner.addToGraph(graph, {
    prepared: { width: 3, height: 5, constants: imported("constants") },
    main: { rawAo: imported("raw AO"), edges: imported("edges") }
  });
  const consume = graph.add("actual scalar consumer", {}, () => {});
  consume.read(result[consumer]);
  consume.make_side_effect();
  return { graph, result };
}

test("XeGTAO exposes its existing final scalar texture while the packed ABI remains unchanged", () => {
  const { graph, result } = build("packed");
  assert.equal(result.width, 3);
  assert.equal(result.height, 5);
  assert.equal(result.words, 4);
  assert.deepEqual(graph.getDescriptor(result.packed), {
    kind: "transient_buffer",
    size: 16,
    usage: GPUBufferUsage.STORAGE,
    domain: "internal-full"
  });
  const descriptor = graph.getDescriptor(result.scalarTexture);
  assert.equal(descriptor.kind, "transient_texture");
  assert.equal(descriptor.format, "r8unorm");
  assert.equal(descriptor.width, 3);
  assert.equal(descriptor.height, 5);
  graph.compile();
  assert.equal(
    graph.listExecutablePasses().find((pass) => pass.name === "XeGTAO/pack indirect visibility").culled,
    false
  );
});

test("texture-only native consumer retains denoise and culls the unused packed pass", () => {
  const { graph } = build("scalarTexture");
  graph.compile();
  const passes = graph.listExecutablePasses();
  assert.equal(passes.find((pass) => pass.name === "XeGTAO/denoise 1 final").culled, false);
  assert.equal(passes.find((pass) => pass.name === "XeGTAO/pack indirect visibility").culled, true);
});
