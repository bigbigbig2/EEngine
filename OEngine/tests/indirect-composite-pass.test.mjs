import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage ??= { FRAGMENT: 2, VERTEX: 4 };

const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");
const { IndirectCompositePass } = await import(
  "../.test-dist/render/passes/IndirectCompositePass.js"
);

function imported(graph, name) {
  return graph.import_resource(name, { kind: "imported", label: name }, {});
}

test("legacy indirect composite omits the optional Surface metadata read", () => {
  const graphics = {
    render_pipelines: { obtain: () => ({}) }
  };
  const pass = new IndirectCompositePass(graphics);
  const graph = new FrameGraph("legacy-indirect-composite");
  const output = pass.addToGraph(graph, {
    hdr: imported(graph, "hdr"),
    depth: imported(graph, "depth"),
    normal: imported(graph, "normal"),
    bentNormal: imported(graph, "bent-normal"),
    albedoAo: imported(graph, "albedo-ao"),
    pbr: imported(graph, "pbr"),
    splitSum: imported(graph, "split-sum"),
    indirectDiffuse: imported(graph, "indirect-diffuse"),
    indirectSpecular: imported(graph, "indirect-specular"),
    camera: imported(graph, "camera"),
    metadata: undefined
  });
  const sink = graph.add("present", {}, () => {});
  sink.read(output.hdr);
  sink.make_side_effect();

  assert.doesNotThrow(() => graph.compile());
});

test("FrameGraph compile identifies the pass and usage for an invalid resource", () => {
  const graph = new FrameGraph("invalid-resource-diagnostic");
  const pass = graph.add("broken-pass", {}, () => {});
  pass.read(undefined);
  pass.make_side_effect();

  assert.throws(
    () => graph.compile(),
    /FrameGraph 'invalid-resource-diagnostic' pass 'broken-pass' declares invalid read resource undefined/
  );
});
