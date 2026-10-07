import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { compileAppearanceExecutionPlan } from "../../.test-dist/material/ExactAppearanceDag.js";
import {
  AppearanceClosureInterner,
  APPEARANCE_CLOSURE_READ as READ,
  compileAppearanceClosurePlans
} from "../../.test-dist/material/AppearanceClosurePlan.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { GpuAppearancePublication } from "../../.test-dist/gpu/GpuAppearancePublication.js";
import {
  packAppearanceDagPublication,
  APPEARANCE_DAG_CLOSURES_OFFSET,
  APPEARANCE_DAG_CLOSURES_COUNT,
  APPEARANCE_CLOSURE_PLAN_WORDS
} from "../../.test-dist/gpu/GpuAppearanceDagAbi.js";

const interner = new AppearanceClosureInterner();
const texture = new ShadeTexture();
function fixture({ name = "uv0", source = texture, nested = false, unrelated = false, gain = 2 } = {}) {
  const graph = new AppearanceGraphBuilder();
  if (unrelated) {
    graph.output("emissive", graph.parameter("emissive", [3, 4, 5]));
  }
  const uv = graph.input(name, 2, "surface", undefined, name);
  let coordinates = graph.operation("sin", graph.operation("sin", uv));
  if (nested) {
    coordinates = graph.swizzle(
      graph.texture(snapshotAppearanceTexture(texture, "linear-rgb"), coordinates),
      [0, 1]
    );
  }
  const sampled = graph.texture(snapshotAppearanceTexture(source, "linear-rgb"), coordinates);
  graph.output(
    "roughness",
    graph.operation("multiply", graph.swizzle(sampled, [1]), graph.parameter("gain", gain))
  );
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const execution = compileAppearanceExecutionPlan(program, lowered);
  return {
    program,
    lowered,
    execution,
    plans: compileAppearanceClosurePlans(program, lowered, execution, interner)
  };
}
function reads(plan) {
  const records = [];
  for (let index = 0; index < plan.reads.length; index += 5) {
    records.push([...plan.reads.subarray(index, index + 5)]);
  }
  return records;
}

test("closure descriptors survive unrelated outputs while dynamic parameters remain actual value reads", () => {
  const first = fixture();
  const reordered = fixture({ unrelated: true, gain: 7 });
  assert.equal(first.plans.length, 1);
  assert.equal(reordered.plans.length, 1, "uniform emissive keeps its existing update producer");
  assert.equal(first.plans[0].handle, reordered.plans[0].handle);
  const dynamic = reads(first.plans[0]).filter(([kind]) => kind === READ.uniform);
  assert.ok(dynamic.length > 0, "the changing gain is read from the current GPU uniform boundary");
  assert.equal(first.plans[0].field, 3);
  assert.equal(first.plans[0].valueWords, 1);
  assert.equal(first.plans[0].geometryMask, 1 << 1);
  assert.equal(first.plans[0].neighborMask, 1 << 1);
});

test("UV0/1/2 identities retain every exact coordinate point and never acquire an unrelated camera epoch", () => {
  const handles = new Set();
  for (let semantic = 1; semantic <= 3; semantic++) {
    const plan = fixture({ name: `uv${semantic - 1}` }).plans[0];
    handles.add(plan.handle);
    const geometry = reads(plan).filter(([kind]) => kind === READ.input);
    assert.deepEqual(
      geometry.map(([, , kind, channel, point]) => [kind, channel, point]),
      [
        [semantic, 0, 0],
        [semantic, 0, 1],
        [semantic, 0, 2],
        [semantic, 1, 0],
        [semantic, 1, 1],
        [semantic, 1, 2]
      ]
    );
    assert.equal(plan.geometryMask, 1 << semantic);
  }
  assert.equal(handles.size, 3);
});

test("nested queries retain both complete resource routes and the original coordinate closure", () => {
  const { plans } = fixture({ nested: true, source: new ShadeTexture() });
  const route = reads(plans[0]).filter(([kind]) => kind === READ.route);
  assert.equal(route.length, 32, "two complete 16-word resident routes, including revision and sampler");
  assert.equal(new Set(route.map(([, query]) => query)).size, 2);
  for (const query of new Set(route.map(([, query]) => query))) {
    assert.deepEqual(
      route.filter(([, index]) => index === query).map(([, , , word]) => word),
      Array.from({ length: 16 }, (_, word) => word)
    );
  }
  assert.notEqual(plans[0].handle, fixture().plans[0].handle);
  assert.notEqual(fixture({ source: new ShadeTexture() }).plans[0].handle, fixture().plans[0].handle);
});

test("cheap and uniform closures keep direct/update work, and view-dependent closures name their real inputs", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  graph.output(
    "baseColor",
    graph.swizzle(graph.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv), [0, 1, 2])
  );
  graph.output("metallic", graph.parameter("metallic", 0.2));
  const view = graph.input("viewDirection", 3, "view");
  graph.output("emissive", graph.operation("sin", graph.operation("sin", view)));
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const plan = compileAppearanceClosurePlans(
    program,
    lowered,
    compileAppearanceExecutionPlan(program, lowered),
    interner
  );
  assert.deepEqual(
    plan.map(({ field }) => field),
    [5]
  );
  assert.equal(plan[0].geometryMask, 1 << 8);
  assert.equal(plan[0].neighborMask, 0);
  assert.deepEqual(
    reads(plan[0]).map(([, , kind, channel, point]) => [kind, channel, point]),
    [
      [8, 0, 0],
      [8, 1, 0],
      [8, 2, 0]
    ]
  );
});

test("the existing Appearance publication packs full descriptors and local read addresses in the same code buffer", () => {
  const fixtures = [fixture(), fixture({ unrelated: true }), fixture({ name: "uv1" })];
  const sources = fixtures.map(({ program, lowered }) => ({
    program,
    lowered,
    constantBase: 0,
    routeBase: 0,
    inputBase: 0,
    textureBindingSetId: 0
  }));
  const packed = packAppearanceDagPublication(sources, 1024 * 1024, 1024 * 1024, 500);
  assert.equal(packed.closureCount, 2);
  for (let entry = 0; entry < sources.length; entry++) {
    const exportPlan = packed.code[entry * 16 + 2];
    const base = packed.code[exportPlan + APPEARANCE_DAG_CLOSURES_OFFSET];
    assert.equal(packed.code[exportPlan + APPEARANCE_DAG_CLOSURES_COUNT], 1);
    const plan = packed.closurePlans[entry][0];
    const header = packed.code.subarray(base, base + APPEARANCE_CLOSURE_PLAN_WORDS);
    assert.deepEqual(
      [...header.subarray(0, 6)],
      [plan.handle, 1 << 3, plan.keyWords, 1, plan.geometryMask, plan.neighborMask]
    );
    assert.equal(plan.keyWords, 2 + header[7]);
    assert.deepEqual(packed.code.subarray(header[6], header[6] + header[7] * 5), plan.reads);
  }
  assert.throws(
    () => packAppearanceDagPublication(sources, packed.code.byteLength - 4),
    /exceeds negotiated/
  );
});

test("multiple varying fields retain independent closure products while admission selects one exact candidate", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const expensive = (source) => {
    let value = graph.texture(snapshotAppearanceTexture(source, "linear-rgb"), uv);
    for (let index = 0; index < 12; index++) value = graph.operation("sin", value);
    return graph.swizzle(value, [0, 1, 2]);
  };
  graph.output("baseColor", expensive(texture));
  graph.output("emissive", expensive(new ShadeTexture()));
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const packed = packAppearanceDagPublication(
    [{ program, lowered, constantBase: 0, routeBase: 0, inputBase: 0, textureBindingSetId: 0 }],
    1024 * 1024,
    1024 * 1024
  );
  assert.equal(packed.closurePlans[0].length, 2);
  assert.equal(packed.cacheCandidateCount, 1);
  const exportPlan = packed.code[2];
  const directory = packed.code[exportPlan + APPEARANCE_DAG_CLOSURES_OFFSET];
  const candidate = packed.code[exportPlan + 10];
  assert.notEqual(candidate, 0, "one exact closure is admitted");
  assert.ok(candidate >= directory);
  assert.ok(candidate < directory + 2 * APPEARANCE_CLOSURE_PLAN_WORDS);
  assert.equal(packed.code[12] & ((1 << 0) | (1 << 5)), (1 << 0) | (1 << 5));
});

test("published route identities compare all sixteen words, share equal routes and bound descriptor memory", () => {
  const owner = { routeValues: new Uint32Array(32), routeIdentities: new Uint32Array(2),
    routeIdentityNext: 0, routeIdentitySnapshots: new Map() };
  const publish = () => GpuAppearancePublication.prototype.refreshRouteIdentities.call(owner);
  publish();
  assert.equal(owner.routeIdentities[0], owner.routeIdentities[1]);
  for (let word = 0; word < 16; word++) {
    owner.routeValues[16 + word] = word + 1;
    publish();
    assert.notEqual(owner.routeIdentities[0], owner.routeIdentities[1], "route word " + word + " invalidates identity");
    const changed = owner.routeIdentities[1];
    publish();
    assert.equal(owner.routeIdentities[1], changed, "unchanged route has stable identity");
    owner.routeValues[16 + word] = 0;
    publish();
    assert.equal(owner.routeIdentities[0], owner.routeIdentities[1]);
    assert.ok(owner.routeIdentitySnapshots.size <= 2);
  }
});

test("shared heavy ancestors cannot admit a cache that only removes output arithmetic", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  let shared = graph.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
  for (let index = 0; index < 6; index++) shared = graph.operation("sin", shared);
  graph.output("baseColor", graph.swizzle(shared, [0, 1, 2]));
  graph.output("emissive", graph.swizzle(shared, [0, 1, 2]));
  const program = compileAppearanceGraph(graph.build());
  const packed = packAppearanceDagPublication([
    { program, lowered: lowerAppearanceWgsl(program), constantBase: 0, routeBase: 0, inputBase: 0, textureBindingSetId: 0 }
  ], 1024 * 1024, 1024 * 1024);
  assert.equal(packed.cacheCandidateCount, 0);
  assert.ok(packed.closurePlans[0].length > 0, "complete expensive descriptors are retained");
  assert.ok(packed.closurePlans[0].every((plan) => plan.exclusiveTextureQueries === 0 && plan.exclusiveOperationCost <= 12));
});

test("admission selects removable heavy work rather than the first legal output", () => {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  let a = graph.swizzle(uv, [0]), b = graph.swizzle(uv, [1]);
  for (let index = 0; index < 3; index++) a = graph.operation("sin", a);
  for (let index = 0; index < 12; index++) b = graph.operation("sin", b);
  graph.output("roughness", a);
  graph.output("emissive", graph.combine(b, b, b));
  const program = compileAppearanceGraph(graph.build());
  const packed = packAppearanceDagPublication([
    { program, lowered: lowerAppearanceWgsl(program), constantBase: 0, routeBase: 0, inputBase: 0, textureBindingSetId: 0 }
  ], 1024 * 1024, 1024 * 1024);
  const candidate = packed.code[packed.code[2] + 10];
  assert.equal(packed.code[candidate + 1], 1 << 5);
});
