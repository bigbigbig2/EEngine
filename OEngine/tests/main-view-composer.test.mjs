import assert from "node:assert/strict";
import test from "node:test";

const { MainViewComposer } = await import(
  "../.test-dist/render/MainViewComposer.js"
);

test("MainViewComposer builds one FrameGraph from ordered Feature contributions and reuses it", () => {
  const calls = [];
  const cacheEvents = [];
  const composer = new MainViewComposer([
    {
      id: "present",
      enabled: () => true,
      inputs: ["scene-hdr", "swapchain"],
      outputs: ["presented"],
      contribute: (context, products) => {
        calls.push("present");
        const hdr = products.read("scene-hdr");
        const swapchain = products.read("swapchain");
        const pass = context.graph.add("present", {}, () => {});
        pass.read(hdr);
        products.publish("presented", pass.write(swapchain));
      }
    },
    {
      id: "surface",
      enabled: () => true,
      inputs: ["scene"],
      outputs: ["surface"],
      contribute: (context, products) => {
        calls.push("surface");
        const pass = context.graph.add("surface", {}, () => {});
        pass.read(products.read("scene"));
        products.publish("surface", pass.create("surface", {
          kind: "transient_texture",
          width: 4,
          height: 4,
          format: "rgba8unorm"
        }));
      }
    },
    {
      id: "lighting",
      enabled: () => true,
      inputs: ["surface"],
      outputs: ["scene-hdr"],
      contribute: (context, products) => {
        calls.push("lighting");
        const pass = context.graph.add("lighting", {}, () => {});
        pass.read(products.read("surface"));
        products.publish("scene-hdr", pass.create("scene-hdr", {
          kind: "transient_texture",
          width: 4,
          height: 4,
          format: "rgba16float"
        }));
      }
    },
    {
      id: "debug",
      enabled: (context) => context.state.debug,
      inputs: ["scene-hdr"],
      contribute: () => calls.push("debug")
    }
  ], {
    graphName: "main-view-test",
    cacheCapacity: 2,
    cacheObserver: {
      hit: () => cacheEvents.push("hit"),
      miss: () => cacheEvents.push("miss"),
      evict: () => cacheEvents.push("evict")
    }
  });

  const request = {
    cacheKey: "topology-0",
    bindings: { scene: {}, swapchain: {} },
    state: { debug: false },
    externalProducts: (context) => new Map([
      ["scene", context.graph.import_resource(
        "scene",
        { kind: "imported", label: "scene" },
        context.bind("scene", (bindings) => bindings.scene)
      )],
      ["swapchain", context.graph.import_resource(
        "swapchain",
        { kind: "imported", label: "swapchain" },
        context.bind("swapchain", (bindings) => bindings.swapchain)
      )]
    ])
  };

  const first = composer.compose(request);
  const second = composer.compose({
    ...request,
    bindings: { scene: { frame: 2 }, swapchain: { frame: 2 } }
  });

  assert.deepEqual(first.featureOrder, ["surface", "lighting", "present"]);
  assert.deepEqual(calls, ["surface", "lighting", "present"]);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.graph, second.graph);
  assert.deepEqual(cacheEvents, ["miss", "hit"]);
  assert.deepEqual(
    first.dump.passes.filter((pass) => !pass.culled).map((pass) => pass.name),
    ["surface", "lighting", "present"]
  );
});

test("MainViewComposer records into a supplied command without owning submit", () => {
  const composer = new MainViewComposer([
    {
      id: "present",
      enabled: () => true,
      inputs: ["swapchain"],
      outputs: ["presented"],
      contribute: (context, products) => {
        const pass = context.graph.add("present", {}, () => {});
        products.publish("presented", pass.write(products.read("swapchain")));
      }
    }
  ]);
  const composition = composer.compose({
    cacheKey: "present",
    bindings: { swapchain: {} },
    state: {},
    externalProducts: (context) => new Map([["swapchain", context.graph.import_resource(
      "swapchain",
      { kind: "imported", label: "swapchain" },
      context.bind("swapchain", (bindings) => bindings.swapchain)
    )]])
  });
  const command = {
    encoded: [],
    finishCount: 0,
    encodeCompiledGraph(graph, bindings) {
      this.encoded.push({ graph, bindings });
    },
    finish() {
      this.finishCount++;
    }
  };

  composer.encode(command, composition, { swapchain: { frame: 2 } });
  assert.equal(command.encoded.length, 1);
  assert.equal(command.encoded[0].graph, composition.graph);
  assert.equal(command.finishCount, 0);
});
