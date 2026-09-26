import assert from "node:assert/strict";
import test from "node:test";
import { buildFrameProgram } from "../../.test-dist/render/program/FrameProgram.js";
import { FrameGraph, FrameGraphBindingLayout, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";

const scene = {
  kind: "scene", outputWidth: 1280, outputHeight: 720, outputFormat: "bgra8unorm",
  capabilityProfile: "device-1", internalWidth: 640, internalHeight: 360,
  virtualGeometry: true, virtualBankCount: 2, previousHzb: true,
  currentHzbLateRecheck: false, meshletWorkCapacity: 1024,
  meshletWorkCompaction: "auto", primitiveIndex: "auto", coneCulling: true,
  activeClasses: [4, 0], textureBankMasks: [1, 0, 0, 0], physicalEnvironment: true
};

test("Frame Program closes the current scene product demand with a structural key", () => {
  const first = buildFrameProgram(scene);
  const reordered = buildFrameProgram({ ...scene, activeClasses: [0, 4] });
  assert.equal(first.key, reordered.key);
  for (const product of ["visibility", "depth", "hzb", "meshlet-work", "shading-work",
    "surface-radiance", "surface-motion", "sky-radiance", "aerial-radiance",
    "reconstructed-color", "swapchain"]) assert.ok(first.products.includes(product), product);
  assert.equal(first.directLighting, true);
  assert.notEqual(first.key, buildFrameProgram({ ...scene, internalWidth: 800 }).key);
  const noEnvironment = buildFrameProgram({ ...scene, physicalEnvironment: false });
  assert.ok(!noEnvironment.products.includes("sky-radiance"));
  assert.ok(!noEnvironment.products.includes("aerial-radiance"));
});

test("compiled graph resolves the environment role from each frame binding", () => {
  const initial = { environment: { lut: { generation: 1 } } };
  const layout = new FrameGraphBindingLayout();
  const graph = new FrameGraph("environment-generation-binding");
  const lut = graph.import_resource("environment-lut", { kind: "imported", label: "LUT" },
    layout.slot("environment-lut", initial, bindings => bindings.environment.lut));
  const seen = [];
  const consumer = graph.add("consume-current-lut", {}, (_data, resources) => {
    seen.push(resources.get(lut).generation);
  });
  consumer.read(lut);
  consumer.make_side_effect();
  const compiled = graph.compile();
  compiled.execute(new FrameGraphContext(), initial);
  compiled.execute(new FrameGraphContext(), { environment: { lut: { generation: 2 } } });
  assert.deepEqual(seen, [1, 2]);
});
