import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext,
  FrameGraphResourceManager,
} from "../../.test-dist/framegraph/FrameGraph.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import "../webgpu-test-globals.mjs";
globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64 };

test("execute touches only compiled references/events when cold resources or commands scale", () => {
  for (const [commands, cold] of [
    [8, 0],
    [8, 4096],
    [256, 0],
    [256, 4096],
  ]) {
    const graph = new FrameGraph("scaling"),
      hot = graph.import_resource("hot", { kind: "imported" }, {});
    const coldIds = [];
    for (let i = 0; i < cold; i++) coldIds.push(graph.import_resource("cold" + i, { kind: "imported" }, {}));
    let consumed = 0;
    for (let i = 0; i < commands; i++) {
      const p = graph.add("command" + i, {}, (_, r) => {
        assert.ok(r.get(hot));
        consumed++;
      });
      p.read(hot);
      p.make_side_effect();
    }
    const compiled = graph.compile();
    let lastReads = 0;
    for (const id of [hot, ...coldIds]) {
      const entry = graph.getResourceEntry(id),
        last = entry.last;
      Object.defineProperty(entry, "last", {
        get() {
          lastReads++;
          return last;
        },
      });
    }
    graph.getResourceEntry = () => {
      throw new Error("execution re-resolved the complete graph registry");
    };
    compiled.execute(new FrameGraphContext(), undefined);
    assert.equal(consumed, commands);
    assert.equal(lastReads, 0, "old per-node registry scan reads last");
    const live = compiled.dump().passes.filter((p) => !p.culled);
    assert.equal(
      live.reduce((sum, p) => sum + p.resourceSlots.length, 0),
      commands,
    );
  }
});
test("physical imports preserve versions, RAW and old-version reader-before-overwrite ordering", () => {
  const graph = new FrameGraph("physical aliases"),
    physical = { value: 0 },
    original = graph.import_resource("first", { kind: "imported" }, physical),
    seen = [];
  const writer = graph.add("write", {}, (_, r) => {
    r.get(next).value = 7;
    seen.push("write");
  });
  const next = writer.write(original);
  const alias = graph.import_resource("second", { kind: "imported" }, physical);
  assert.equal(graph.getResourceNode(alias).version, 1);
  const lateOld = graph.add("late old reader", {}, (_, r) => {
    assert.equal(r.get(original).value, 0);
    seen.push("old");
  });
  lateOld.read(original);
  lateOld.make_side_effect();
  const consumer = graph.add("new reader", {}, (_, r) => {
    assert.equal(r.get(alias).value, 7);
    seen.push("new");
  });
  consumer.read(alias);
  consumer.make_side_effect();
  const compiled = graph.compile();
  assert.equal(compiled.dump().resources.length, 1);
  compiled.execute(new FrameGraphContext(), undefined);
  assert.deepEqual(seen, ["old", "write", "new"]);
});
test("overlapping aliases that force an overwrite before the old reader fail as a dependency cycle", () => {
  const graph = new FrameGraph("bad alias"),
    r = graph.import_resource("buffer", { kind: "imported" }, {});
  const writer = graph.add("write", {}, () => {});
  writer.write(r);
  const reader = graph.add("read old", {}, () => {});
  reader.read(r);
  reader.dependsOn(writer);
  reader.make_side_effect();
  assert.throws(() => graph.compile(), /cycle/);
});
test("explicit dependency retains a producer with no consumed resource and dead chains stay culled", () => {
  const graph = new FrameGraph("dependencies"),
    seen = [];
  const dead = graph.add("dead", {}, () => {
    throw new Error("culled");
  });
  dead.create("unused", { kind: "opaque" });
  const required = graph.add("required", {}, () => seen.push("required"));
  const consumer = graph.add("consumer", {}, () => seen.push("consumer"));
  consumer.dependsOn(required);
  consumer.make_side_effect();
  const compiled = graph.compile();
  compiled.execute(new FrameGraphContext(), undefined);
  assert.deepEqual(seen, ["required", "consumer"]);
  assert.equal(compiled.dump().passes[0].culled, true);
});
test("compiled lifetime events alias nonoverlap, retain overlap, and finish behind the fence", async () => {
  const made = [],
    ledger = new ResourceAccounting(),
    device = {
      limits: { maxBufferSize: 4096 },
      createBuffer(d) {
        const b = {
          ...d,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        made.push(b);
        return b;
      },
    };
  const allocator = new GPUBufferAllocator(device, ledger),
    graphics = { device, buffer_allocator_main: allocator, allocator_textures: { release() {} } };
  const graph = new FrameGraph("lifetimes"),
    seen = [];
  let a, b, c;
  const pa = graph.add("a", {}, (_, r) => seen.push(r.get(a)));
  a = pa.create("a", { kind: "transient_buffer", size: 64, usage: GPUBufferUsage.STORAGE });
  const overlap = graph.add("b", {}, (_, r) => {
    seen.push(r.get(b));
    assert.notEqual(r.get(a), r.get(b));
  });
  overlap.read(a);
  b = overlap.create("b", { kind: "transient_buffer", size: 64, usage: GPUBufferUsage.STORAGE });
  const end = graph.add("use b", {}, (_, r) => seen.push(r.get(b)));
  end.read(b);
  end.make_side_effect();
  const pc = graph.add("c", {}, (_, r) => seen.push(r.get(c)));
  c = pc.create("c", { kind: "transient_buffer", size: 64, usage: GPUBufferUsage.STORAGE });
  pc.make_side_effect();
  let done;
  const fence = new Promise((resolve) => (done = resolve));
  const manager = new FrameGraphResourceManager(device, fence);
  const ctx = new FrameGraphContext({
    device,
    graphics,
    resource_manager: manager,
    encoder: { clearBuffer() {} },
  });
  graph.compile().execute(ctx, undefined);
  assert.equal(made.length, 2);
  assert.equal(seen[3], seen[0]);
  assert.equal(allocator.evidence().pendingBytes, 128);
  assert.equal(ledger.snapshot().retiredBytes, 128);
  allocator.destroy();
  assert(
    made.every((b) => !b.destroyed),
    "pending buffers survive owner destruction",
  );
  done();
  await Promise.resolve();
  assert(made.every((b) => b.destroyed));
  assert.equal(ledger.snapshot().totalBytes, 0);
});
test("throw and cleanup failure preserve original cause and do not poison the next execution", () => {
  const graph = new FrameGraph("failure");
  let id,
    fail = true;
  const p = graph.add("producer", {}, (_, r) => {
    r.get(id);
    if (fail) throw new Error("original producer error");
  });
  id = p.create("work", { kind: "opaque" });
  p.make_side_effect();
  let gets = 0,
    releases = 0,
    finishes = 0;
  const manager = {
    attachEncoder() {},
    get() {
      gets++;
      return {};
    },
    release() {
      releases++;
      if (fail) throw new Error("cleanup error");
    },
    finish() {
      finishes++;
    },
  };
  const compiled = graph.compile(),
    ctx = new FrameGraphContext({ resource_manager: manager });
  assert.throws(
    () => compiled.execute(ctx, undefined),
    (error) => error instanceof AggregateError && error.errors[0].message.includes("original producer error"),
  );
  fail = false;
  compiled.execute(ctx, undefined);
  assert.equal(gets, 2);
  assert.equal(releases, 2);
  assert.equal(finishes, 2);
});
test("cached bindings refresh history roles; dead bindings never resolve; destroy/device replacement reject execution", () => {
  const initial = { buffer: {} },
    layout = new FrameGraphBindingLayout(),
    graph = new FrameGraph("cached"),
    seen = [];
  let deadResolves = 0;
  graph.import_resource(
    "dead",
    { kind: "imported" },
    layout.slot("dead", initial, () => {
      deadResolves++;
      return {};
    }),
  );
  const handle = graph.import_resource(
    "history",
    { kind: "imported" },
    layout.slot("history", initial, (b) => b.buffer),
  );
  const p = graph.add("read", {}, (_, r) => seen.push(r.get(handle)));
  p.read(handle);
  p.make_side_effect();
  const compiled = graph.compile();
  const first = {},
    second = {},
    device = {};
  compiled.execute(new FrameGraphContext({ device }), { buffer: first });
  compiled.execute(new FrameGraphContext({ device }), { buffer: second });
  assert.deepEqual(seen, [first, second]);
  assert.equal(graph.getResourceEntry(handle).resource, null);
  assert.equal(
    deadResolves,
    1,
    "binding layout evaluates the initial shape once; execute never resolves a dead import",
  );
  assert.throws(
    () => compiled.execute(new FrameGraphContext({ device: {} }), { buffer: first }),
    /device changed/,
  );
  compiled.destroy();
  assert.throws(() => compiled.execute(new FrameGraphContext(), {}), /destroyed/);
});

test("equal binding names in different layouts retain separate owners and resources", () => {
  const graph = new FrameGraph("binding namespaces"),
    a = new FrameGraphBindingLayout(),
    b = new FrameGraphBindingLayout(),
    initial = { left: {}, right: {} };
  const first = graph.import_resource(
    "left",
    { kind: "imported" },
    a.slot("buffer", initial, (x) => x.left),
  );
  const second = graph.import_resource(
    "right",
    { kind: "imported" },
    b.slot("buffer", initial, (x) => x.right),
  );
  const p = graph.add("consume both", {}, (_, r) => assert.notEqual(r.get(first), r.get(second)));
  p.read(first);
  p.read(second);
  p.make_side_effect();
  graph.compile().execute(new FrameGraphContext(), initial);
});
