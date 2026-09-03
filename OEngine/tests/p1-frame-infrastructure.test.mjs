import assert from "node:assert/strict";
import test from "node:test";

const { RenderFeatureRegistry } = await import(
  "../.test-dist/render/RenderFeatureRegistry.js"
);
const { summarizeFrameGraphResources } = await import(
  "../.test-dist/framegraph/FrameResourceSummary.js"
);
const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");

test("P1 Render Feature 注册表在关闭时不产生 owner/history", () => {
  const registry = new RenderFeatureRegistry([
    { id: "lighting", enabled: (ctx) => ctx.lighting, persistentOwner: "lighting" },
    {
      id: "temporal",
      enabled: (ctx) => ctx.temporal,
      dependencies: ["lighting"],
      persistentOwner: "taa",
      history: "temporal-color-history"
    }
  ]);

  assert.deepEqual(registry.resolve({ lighting: false, temporal: false }), {
    enabled: [],
    persistentOwners: [],
    histories: []
  });
  assert.deepEqual(registry.resolve({ lighting: true, temporal: true }), {
    enabled: ["lighting", "temporal"],
    persistentOwners: ["lighting", "taa"],
    histories: ["temporal-color-history"]
  });
  assert.throws(
    () => registry.resolve({ lighting: false, temporal: true }),
    /dependency 'lighting' is disabled/
  );
});

test("P1 Render Feature 注册表拒绝重复或未知依赖", () => {
  assert.throws(
    () => new RenderFeatureRegistry([
      { id: "same", enabled: () => true },
      { id: "same", enabled: () => true }
    ]),
    /is duplicated/
  );
  assert.throws(
    () => new RenderFeatureRegistry([
      { id: "feature", enabled: () => true, dependencies: ["missing"] }
    ]),
    /missing dependency 'missing'/
  );
});

test("P1 FrameGraph 资源摘要区分 imported/transient 与未使用资源", () => {
  const graph = new FrameGraph("p1-resource-summary");
  const output = graph.import_resource(
    "output",
    { kind: "imported", label: "output" },
    {}
  );
  graph.create_resource("unused", { kind: "transient_buffer", size: 4 });
  const produce = graph.add("produce-scratch", {}, () => {});
  const producedTexture = produce.create("scratch-texture", {
    kind: "transient_texture",
    width: 4,
    height: 4,
    format: "rgba8unorm",
    usage: 1
  });
  const producedBuffer = produce.create("scratch-buffer", {
    kind: "transient_buffer",
    size: 16
  });
  const consume = graph.add("consume-scratch", {}, () => {});
  consume.read(producedTexture);
  consume.read(producedBuffer);
  consume.write(output);

  const summary = summarizeFrameGraphResources(graph.compile());
  assert.deepEqual(summary, {
    imported: 1,
    transient: 3,
    transientTextures: 1,
    transientBuffers: 2,
    culledResources: 1
  });
});
