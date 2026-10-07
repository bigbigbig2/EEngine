import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import {
  nativeCoverageEvaluationWgsl,
  nativeVisibilityShader,
  nativeVisibilityView,
  NATIVE_VISIBILITY_VIEW_BYTES
} from "../../.test-dist/shaders/native_visibility.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function program() {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  graph.output("baseColor", graph.constant([0.2, 0.3, 0.4]));
  graph.output(
    "alpha",
    graph.operation(
      "multiply",
      graph.swizzle(uv, [0]),
      graph.input("time", 1, "dynamic", { low: 0, high: 2 })
    )
  );
  return lowerNativeMaterial(compileAppearanceGraph(graph.build()));
}

test("main and shadow share original full-program alpha offsets and raster suffix", () => {
  const p = program();
  const main = nativeVisibilityShader(p, []);
  const shadow = nativeVisibilityShader(p, [], { shadow: true });
  const coverage = nativeCoverageEvaluationWgsl(p);
  assert.match(
    coverage,
    new RegExp(`native_material_evaluate\\(material_base, inputs\\)\\[${p.outputs.alpha[0]}u\\]`)
  );
  assert.match(coverage, new RegExp(`material_base, ${p.constants.length}u`));
  assert.match(coverage, new RegExp(`material_base, ${p.constants.length + 1}u`));
  assert.ok(main.source.includes(coverage));
  assert.ok(shadow.source.includes(coverage));
  assert.match(shadow.source, /output.position = view.clip_from_world \* output.world_position/);
  assert.doesNotMatch(main.source, /output.position = view.clip_from_world/);
  assert.match(main.source, /return key.key/);
  // Hardware writes depth; do not replace it with a material-generated frag_depth.
  assert.doesNotMatch(main.source, /frag_depth/);
});

test("raster CXY precedes alpha discard, uniform inputs have no screen derivatives, and resources match stages", () => {
  const p = program();
  const materialLayout = [
    { binding: 0, visibility: 4, texture: { sampleType: "float", viewDimension: "2d-array" } }
  ];
  const shader = nativeVisibilityShader(p, materialLayout);
  const body = shader.source.slice(shader.source.indexOf("fn native_visibility_fragment"));
  assert.ok(body.lastIndexOf("dpdy(") < body.indexOf("let alpha = native_coverage_alpha"));
  assert.ok(body.indexOf("let alpha = native_coverage_alpha") < body.indexOf("discard;"));
  const dynamic = p.inputs.findIndex((input) => input.name === "time");
  assert.match(body, new RegExp(`inputs.x\\[${dynamic}u\\] = input_${dynamic};`));
  assert.equal(
    shader.groups[0].find((entry) => entry.binding === 3).buffer.minBindingSize,
    NATIVE_VISIBILITY_VIEW_BYTES
  );
  assert.equal(shader.groups[2].find((entry) => entry.binding === 0).visibility, 2);
  assert.equal(shader.groups[2].find((entry) => entry.binding === 1).visibility, 3);
  assert.equal(shader.groups[3][0].visibility, 2);
  assert.equal(materialLayout[0].visibility, 4);
  assert.match(shader.source, /material.execution_bin != route.x/);
  assert.match(shader.source, /instance.normal_x.w < 0.0 && input_corner != 0u/);
  assert.match(shader.source, /let cached = arena\[directory \+ 1u\] == generation/);
});

test("raster snapshots exact arena/source addressing and allows exact fallback for partial attributes", () => {
  const prepared = {
    budget: { vertexCapacity: 128, filteredWorkCapacity: 4 },
    layout: { attributeCapacity: 128, header: { offset: 1024 } }
  };
  const view = {
    clipFromWorld: identity,
    viewMatrix: identity,
    cameraPosition: [1, 2, 3],
    filtered: true,
    source: [0, 100, 200, 300],
    sourcePayload: [0, 0, 0, 256]
  };
  const bytes = nativeVisibilityView(prepared, 17, view);
  assert.equal(bytes.byteLength, 192);
  assert.deepEqual([...new Uint32Array(bytes.buffer).subarray(36, 40)], [256, 1, 17, 0]);
  assert.deepEqual([...new Float32Array(bytes.buffer).subarray(32, 35)], [1, 2, 3]);
  assert.equal(
    nativeVisibilityView({ ...prepared, layout: { ...prepared.layout, attributeCapacity: 127 } }, 17, view)
      .byteLength,
    192
  );
  const partitioned = nativeVisibilityShader(program(), [], { partitioned: true, productGeometry: true });
  assert.match(partitioned.source, /native_raster_indices\[partition_state.y/);
  assert.match(partitioned.source, /surface_source_load\(work\)/);
  assert.match(partitioned.source, /product_frame_vertex_load_source/);
  assert.throws(() => nativeVisibilityView(prepared, 0, view), /generation/);
  assert.throws(
    () => nativeVisibilityView(prepared, 17, { ...view, cameraPosition: [Infinity, 0, 0] }),
    /finite/
  );
});
