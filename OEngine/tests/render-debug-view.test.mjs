import test from "node:test";
import assert from "node:assert/strict";

import {
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  getRenderDebugViewStatus,
  isRenderableRenderDebugView
} from "../.test-dist/debug/RenderDebugView.js";
import {
  DEPTH_DEBUG_WGSL,
  RENDER_DEBUG_VIEW_FORMAT,
  VELOCITY_DEBUG_WGSL,
  VISIBILITY_KEY_DEBUG_WGSL
} from "../.test-dist/shaders/render_debug_view.js";
globalThis.GPUShaderStage ??= { COMPUTE: 1, FRAGMENT: 2, VERTEX: 4 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2 };
const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");
const { RenderDebugViewPass } = await import(
  "../.test-dist/render/passes/RenderDebugViewPass.js"
);

test("unified render debug catalog reports supported and unsupported views", () => {
  assert.equal(RENDER_DEBUG_VIEW_OPTIONS.length, 12);
  assert.equal(new Set(RENDER_DEBUG_VIEW_OPTIONS.map((entry) => entry.view)).size, 12);
  assert.deepEqual(
    RENDER_DEBUG_VIEW_OPTIONS
      .filter((entry) => entry.status === "supported")
      .map((entry) => entry.view),
    [RenderDebugView.VisibilityKey, RenderDebugView.Depth, RenderDebugView.Velocity]
  );
  assert.equal(getRenderDebugViewStatus(RenderDebugView.None).status, "disabled");
  assert.equal(getRenderDebugViewStatus(RenderDebugView.HzbMip).status, "unsupported");
  assert.match(
    getRenderDebugViewStatus(RenderDebugView.RasterClassification).reason,
    /硬件光栅/
  );
  assert.equal(isRenderableRenderDebugView(RenderDebugView.VisibilityKey), true);
  assert.equal(isRenderableRenderDebugView(RenderDebugView.HistoryValidity), false);
  assert.throws(() => getRenderDebugViewStatus("not-a-view"), /Unknown/);
});

test("supported debug shaders share HDR output and explicit source scaling", () => {
  assert.equal(RENDER_DEBUG_VIEW_FORMAT, "rgba16float");
  for (const source of [
    VISIBILITY_KEY_DEBUG_WGSL,
    DEPTH_DEBUG_WGSL,
    VELOCITY_DEBUG_WGSL
  ]) {
    assert.match(source, /source_coordinate/);
    assert.match(source, /output_size/);
    assert.match(source, /@fragment/);
  }
  assert.match(VISIBILITY_KEY_DEBUG_WGSL, /16777216u/);
  assert.match(VISIBILITY_KEY_DEBUG_WGSL, /triangle_ids/);
  assert.match(DEPTH_DEBUG_WGSL, /texture_depth_2d/);
  assert.match(DEPTH_DEBUG_WGSL, /pow\(clamp\(depth/);
  assert.match(VELOCITY_DEBUG_WGSL, /atan2/);
  assert.match(VELOCITY_DEBUG_WGSL, /length\(velocity\)/);
});

test("debug graph work exists only for a supported non-disabled selection", () => {
  const pass = new RenderDebugViewPass({ device: {} });
  const resources = {
    meshId: 0,
    triangleId: 1,
    depth: 2,
    velocity: 3
  };
  const graph = new FrameGraph("debug-enabled");
  for (const name of ["mesh", "triangle", "depth", "velocity"]) {
    graph.import_resource(name, { kind: "imported", label: name }, {});
  }
  const output = pass.addToGraph(
    graph,
    RenderDebugView.VisibilityKey,
    resources,
    960,
    540
  );
  const sink = graph.add("debug sink", {}, () => {});
  sink.read(output);
  sink.make_side_effect();
  graph.compile();
  assert.equal(graph.passCount, 2);
  assert.equal(graph.listExecutablePasses()[0].culled, false);

  const disabledGraph = new FrameGraph("debug-disabled");
  if (isRenderableRenderDebugView(RenderDebugView.None)) {
    pass.addToGraph(disabledGraph, RenderDebugView.None, resources, 960, 540);
  }
  assert.equal(disabledGraph.passCount, 0);

  const unsupportedGraph = new FrameGraph("debug-unsupported");
  if (isRenderableRenderDebugView(RenderDebugView.HzbMip)) {
    pass.addToGraph(unsupportedGraph, RenderDebugView.HzbMip, resources, 960, 540);
  }
  assert.equal(unsupportedGraph.passCount, 0);
});
