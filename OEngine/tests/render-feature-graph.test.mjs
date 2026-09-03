import assert from "node:assert/strict";
import test from "node:test";

const { RenderFeatureGraph } = await import(
  "../.test-dist/render/RenderFeatureGraph.js"
);

test("RenderFeatureGraph orders enabled contributors by logical products and executes them", () => {
  const calls = [];
  const graph = new RenderFeatureGraph([
    {
      id: "temporal",
      enabled: (context) => context.temporal,
      inputs: ["opaque-hdr"],
      outputs: ["temporal-hdr"],
      contribute: (_context, products) => {
        calls.push("temporal");
        products.publish("temporal-hdr", `${products.read("opaque-hdr")}/taa`);
      }
    },
    {
      id: "surface",
      enabled: () => true,
      inputs: ["visibility-key"],
      outputs: ["surface"],
      contribute: (_context, products) => {
        calls.push("surface");
        products.publish("surface", `${products.read("visibility-key")}/surface`);
      }
    },
    {
      id: "lighting",
      enabled: () => true,
      inputs: ["surface"],
      outputs: ["opaque-hdr"],
      contribute: (_context, products) => {
        calls.push("lighting");
        products.publish("opaque-hdr", `${products.read("surface")}/lighting`);
      }
    }
  ]);

  const compiled = graph.compile({ temporal: true }, ["visibility-key"]);
  assert.deepEqual(compiled.order, ["surface", "lighting", "temporal"]);

  const execution = compiled.contribute(
    { temporal: true },
    new Map([["visibility-key", "visibility"]])
  );
  assert.deepEqual(calls, ["surface", "lighting", "temporal"]);
  assert.equal(execution.products.get("temporal-hdr"), "visibility/surface/lighting/taa");
  assert.deepEqual(
    execution.contributions.map(({ featureId, inputs, outputs }) => ({ featureId, inputs, outputs })),
    [
      { featureId: "surface", inputs: ["visibility-key"], outputs: ["surface"] },
      { featureId: "lighting", inputs: ["surface"], outputs: ["opaque-hdr"] },
      { featureId: "temporal", inputs: ["opaque-hdr"], outputs: ["temporal-hdr"] }
    ]
  );
});

test("RenderFeatureGraph gives disabled features zero contribution and permits mutually exclusive producers", () => {
  let disabledCalls = 0;
  const graph = new RenderFeatureGraph([
    {
      id: "packed-surface",
      enabled: (context) => context.packed,
      outputs: ["surface"],
      contribute: (_context, products) => products.publish("surface", "packed")
    },
    {
      id: "legacy-surface",
      enabled: (context) => !context.packed,
      outputs: ["surface"],
      persistentOwner: "legacy-owner",
      history: "legacy-history",
      contribute: (_context, products) => {
        disabledCalls++;
        products.publish("surface", "legacy");
      }
    }
  ]);

  const compiled = graph.compile({ packed: true });
  const execution = compiled.contribute({ packed: true });
  assert.deepEqual(compiled.order, ["packed-surface"]);
  assert.deepEqual(compiled.persistentOwners, []);
  assert.deepEqual(compiled.histories, []);
  assert.equal(execution.products.get("surface"), "packed");
  assert.equal(disabledCalls, 0);
});

test("RenderFeatureGraph rejects duplicate enabled producers and missing required products", () => {
  assert.throws(
    () => new RenderFeatureGraph([
      { id: "a", enabled: () => true, outputs: ["surface"] },
      { id: "b", enabled: () => true, outputs: ["surface"] }
    ]).compile({}),
    /product 'surface'.*both 'a' and 'b'/
  );

  assert.throws(
    () => new RenderFeatureGraph([
      { id: "lighting", enabled: () => true, inputs: ["surface"] }
    ]).compile({}),
    /requires missing product 'surface'/
  );
});

test("RenderFeatureGraph rejects dependency cycles, including product-derived cycles", () => {
  assert.throws(
    () => new RenderFeatureGraph([
      { id: "a", enabled: () => true, inputs: ["b-output"], outputs: ["a-output"] },
      { id: "b", enabled: () => true, inputs: ["a-output"], outputs: ["b-output"] }
    ]).compile({}),
    /dependency cycle.*a.*b|dependency cycle.*b.*a/
  );
});

test("RenderFeatureGraph enforces declared inputs and outputs during contribution", () => {
  const missingOutput = new RenderFeatureGraph([
    {
      id: "surface",
      enabled: () => true,
      outputs: ["surface"],
      contribute: () => {}
    }
  ]).compile({});
  assert.throws(
    () => missingOutput.contribute({}),
    /did not publish declared output 'surface'/
  );

  const undeclaredOutput = new RenderFeatureGraph([
    {
      id: "surface",
      enabled: () => true,
      contribute: (_context, products) => products.publish("hidden", 1)
    }
  ]).compile({});
  assert.throws(
    () => undeclaredOutput.contribute({}),
    /cannot publish undeclared output 'hidden'/
  );
});
