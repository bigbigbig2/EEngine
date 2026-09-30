import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph, APPEARANCE_DEPENDENCY as D } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { evaluateCompiledAppearance } from "../../.test-dist/material/AppearanceGraphEvaluation.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../.test-dist/texture/ShadeImage.js";
import { Sampler2D } from "../../.test-dist/texture/Sampler2D.js";

const texture = () => ShadeTexture.from(ShadeImage.fromSampler2D(new Sampler2D(new Uint8Array([128, 64, 220, 170]), 4, 1, 1)));
const sampleValue = [0.2, 0.4, 0.7, 0.6];
const context = (sample = () => sampleValue) => ({ inputs: { uv0: [0.2, 0.7], uv1: [0.3, 0.1], uv2: [0.9, 0.8], vertexColor: [0.3, 0.7, 0.9] }, sample });
const close = (actual, expected, epsilon = 2e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon * Math.max(1, Math.abs(expected[i])), `${value} != ${expected[i]}`));
};

// Independent unoptimized vector interpreter: it never calls compiler evaluation helpers.
function reference(graph, inputs, sample) {
  const values = [];
  for (const node of graph.nodes) {
    if (node.kind === "constant") values.push(node.value.map(Math.fround));
    else if (node.kind === "input") values.push(inputs[node.name].map(Math.fround));
    else if (node.kind === "texture") values.push(sample(node.binding, values[node.uv]).map(Math.fround));
    else if (node.kind === "swizzle") values.push(node.channels.map(c => values[node.source][c]));
    else if (node.kind === "combine") values.push(node.sources.flatMap(s => values[s]));
    else {
      values.push(Array.from({ length: node.width }, (_, channel) => {
        const f = Math.fround;
        const [a, b, c] = node.args.map(ref => values[ref][graph.nodes[ref].width === 1 ? 0 : channel]);
        switch (node.op) {
          case "add": return f(a + b);
          case "subtract": return f(a - b);
          case "multiply": return f(a * b);
          case "divide": return f(a / b);
          case "min": return Math.min(a, b);
          case "max": return Math.max(a, b);
          case "clamp": return Math.min(Math.max(a, b), c);
          case "mix": return f(f(a * f(1 - c)) + f(b * c));
          case "pow": return f(a ** b);
          case "sin": return f(Math.sin(a));
          case "cos": return f(Math.cos(a));
          case "sqrt": return f(Math.sqrt(a));
          case "abs": return Math.abs(a);
          default: throw new Error(node.op);
        }
      }));
    }
  }
  return Object.fromEntries(Object.entries(graph.outputs).map(([name, ref]) => [name, values[ref]]));
}

test("scalar compiler matches independent vector evaluation for every operation and broadcast", () => {
  const g = new AppearanceGraphBuilder();
  const x = g.input("x", 4, "dynamic", { low: 0.05, high: 1.5 });
  const y = g.input("y", 1, "view", { low: 0.1, high: 0.9 });
  for (const op of ["add", "subtract", "multiply", "divide", "min", "max", "pow"]) g.output(op, g.operation(op, x, y));
  for (const op of ["sin", "cos", "abs", "sqrt"]) g.output(op, g.operation(op, x));
  g.output("clamp", g.operation("clamp", x, g.constant(0.2), g.constant(1.2)));
  g.output("mix", g.operation("mix", x, g.constant([0.8, 0.3, 0.2, 0.1]), y));
  g.output("permuted", g.swizzle(x, [3, 1, 1, 0]));
  const graph = g.build(), program = compileAppearanceGraph(graph);
  let seed = 517;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32; };
  for (let i = 0; i < 512; i++) {
    const inputs = { x: Array.from({ length: 4 }, () => 0.05 + random() * 1.45), y: [0.1 + random() * 0.8] };
    const expected = reference(graph, inputs, () => []);
    const actual = evaluateCompiledAppearance(program, { inputs, sample: () => [] });
    for (const name of Object.keys(expected)) close(actual[name], expected[name], 0);
  }
});

test("per-channel demands remove dead sources and deduplicate identical samples", () => {
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0"), t = texture();
  const a = g.texture(snapshotAppearanceTexture(t, "linear-rgb"), uv);
  const b = g.texture(snapshotAppearanceTexture(t, "linear-rgb"), uv);
  g.output("orm", a); g.output("ao", g.swizzle(b, [0]));
  g.output("unused", g.input("unusedDynamic", 4, "dynamic"));
  const p = compileAppearanceGraph(g.build(), { orm: 6, ao: 1 });
  assert.equal(p.samples.length, 1); assert.equal(p.samples[0].readMask, 7);
  assert.ok(!p.inputs.some(i => i.name === "unusedDynamic"));
  let count = 0;
  const result = evaluateCompiledAppearance(p, context(() => { count++; return sampleValue; }));
  close(result.orm, [0.4, 0.7]); close(result.ao, [0.2]); assert.equal(count, 1);
  assert.deepEqual(p.outputMasks, { orm: 6, ao: 1 });
});

test("full source/sampler/UV/decode signature controls texture CSE", () => {
  const g = new AppearanceGraphBuilder(), t = texture();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const uv1 = g.input("uv1", 2, "surface", undefined, "uv1");
  const emit = (binding, coordinate = uv) => g.output(`o${Object.keys(g.build().outputs).length}`, g.texture(binding, coordinate));
  emit(snapshotAppearanceTexture(t, "linear-rgb"));
  const alias = ShadeTexture.from(t.image);
  emit(snapshotAppearanceTexture(alias, "linear-rgb"));
  emit(snapshotAppearanceTexture(t, "srgb-rgb"));
  emit(snapshotAppearanceTexture(t, "linear-alpha"));
  emit(snapshotAppearanceTexture(t, "linear-rgb", [0.2, 0]));
  emit(snapshotAppearanceTexture(t, "linear-rgb"), uv1);
  t.magFilter = 0; emit(snapshotAppearanceTexture(t, "linear-rgb"));
  const p = compileAppearanceGraph(g.build());
  assert.equal(p.samples.length, 6, "only identical source and complete sampling state may merge");
});

test("constant folding and identity elision preserve operation order and f32 rounding", () => {
  const g = new AppearanceGraphBuilder();
  const folded = g.operation("add", g.constant(16777216), g.constant(1));
  const x = g.input("x", 1, "dynamic");
  g.output("folded", folded);
  g.output("identity", g.operation("multiply", x, g.constant(1)));
  g.output("ordered", g.operation("add", g.operation("add", x, g.constant(-16777216)), g.constant(1)));
  const p = compileAppearanceGraph(g.build());
  const actual = evaluateCompiledAppearance(p, { inputs: { x: [16777216] }, sample: () => [] });
  close(actual.folded, [16777216], 0); close(actual.identity, [16777216], 0); close(actual.ordered, [1], 0);
  assert.ok(!p.instructions.some(i => i.op === "multiply"));
  assert.throws(() => compileAppearanceGraph(g.build(), { folded: 2 ** 32 }), /mask/);
});

test("static/dynamic/geometry/view/nonlocal and multi-UV dependencies partition correctly", () => {
  const g = new AppearanceGraphBuilder(), t = texture();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const uv1 = g.input("uv1", 2, "surface", undefined, "uv1");
  const a = g.swizzle(g.texture(snapshotAppearanceTexture(t, "linear-rgb"), uv), [0]);
  const b = g.swizzle(g.texture(snapshotAppearanceTexture(t, "linear-rgb"), uv1), [1]);
  const expensive = g.operation("sin", g.operation("pow", a, g.constant(2)));
  const dynamic = g.operation("add", expensive, g.input("time", 1, "dynamic"));
  g.output("static", expensive); g.output("dynamic", dynamic);
  g.output("geometry", g.operation("multiply", expensive, g.input("vertex", 1, "geometry")));
  g.output("view", g.operation("add", expensive, g.input("view", 1, "view")));
  g.output("nonlocal", g.operation("add", expensive, g.input("worldQuery", 1, "nonlocal")));
  g.output("multi", g.operation("add", expensive, b));
  const p = compileAppearanceGraph(g.build());
  const root = name => p.products.find(root => root.instruction === p.outputs[name][0]);
  assert.equal(root("static").kind, "static-bake-candidate");
  assert.equal(root("static").filter, "nonlinear");
  assert.equal(root("dynamic").kind, "dynamic-cache-program");
  assert.equal(root("dynamic").dependency, D.Surface | D.Texture | D.Dynamic);
  for (const name of ["geometry", "view", "nonlocal", "multi"]) assert.equal(root(name).kind, "per-target");
  assert.deepEqual(root("multi").coordinateDomains, ["uv0", "uv1"]);
});

test("nonlinear baking cannot silently commute source filtering", () => {
  const source = [0.1, 0.9];
  const filteredThenSquared = ((source[0] + source[1]) / 2) ** 2;
  const squaredThenFiltered = (source[0] ** 2 + source[1] ** 2) / 2;
  assert.ok(Math.abs(filteredThenSquared - squaredThenFiltered) > 0.15);
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const s = g.swizzle(g.texture(snapshotAppearanceTexture(texture(), "linear-rgb"), uv), [0]);
  g.output("nonlinear", g.operation("pow", s, g.constant(2)));
  g.output("affine", g.operation("multiply", s, g.constant(0.5)));
  const p = compileAppearanceGraph(g.build());
  assert.equal(p.instructions[p.outputs.nonlinear[0]].filter, "nonlinear");
  assert.equal(p.instructions[p.outputs.affine[0]].filter, "affine");
});

test("Standard and all coated fields match an independent authored-material oracle", () => {
  const m = new StandardShadeMaterial();
  const roles = ["texture_albedo", "texture_normal", "texture_orm", "texture_occlusion", "texture_emissive",
    "texture_specular", "texture_specular_color", "texture_clearcoat", "texture_clearcoat_roughness", "texture_clearcoat_normal"];
  for (const role of roles) m[role] = texture();
  m.diffuse_color.set(0.3, 0.6, 0.9, 0.8);
  m.metallic_factor = 0.7; m.roughness_factor = 0.4; m.normal_scale = 0.3;
  m.ambient_factors.a = 0.6; m.emissive_factor.set(2, 0.5, 0.1);
  m.ior_factor = 1.8; m.specular_factor = 0.75; m.specular_color_factor.set(0.4, 0.5, 0.6);
  m.clearcoat_factor = 0.9; m.clearcoat_roughness_factor = 0.5; m.clearcoat_normal_scale = 0.7;
  m.specular_uv_set = 1; m.clearcoat_normal_uv_set = 2;
  const p = compileCanonicalMaterial(m).appearance, result = evaluateCompiledAppearance(p, context());
  close(result.baseColor, [0.3 * 0.3 * 0.2, 0.6 * 0.7 * 0.4, 0.9 * 0.9 * 0.7]);
  close(result.alpha, [0.8 * 0.6]); close(result.metallic, [0.7 * 0.7]); close(result.roughness, [0.4 * 0.4]);
  close(result.occlusion, [1 * (1 - 0.6) + 0.2 * 0.6]); close(result.emissive, [2 * 0.2, 0.5 * 0.4, 0.1 * 0.7]);
  close(result.normalTS, [(0.2 * 2 - 1) * 0.3, (0.4 * 2 - 1) * 0.3, 0.7 * 2 - 1]);
  close(result.specularWeight, [0.75 * 0.6]); close(result.specularColor, [0.4 * 0.2, 0.5 * 0.4, 0.6 * 0.7]);
  close(result.ior, [1.8]); close(result.coatWeight, [0.9 * 0.2]); close(result.coatRoughness, [0.5 * 0.4]);
  close(result.coatNormalTS, [(0.2 * 2 - 1) * 0.7, (0.4 * 2 - 1) * 0.7, 0.7 * 2 - 1]);
  assert.equal(p.samples.length, 10);
});

test("Dungeon has constant metallic/base factor, live dielectric specular, one ORM/AO sample", () => {
  const m = new StandardShadeMaterial();
  m.texture_orm = m.texture_occlusion = texture();
  const p = compileCanonicalMaterial(m).appearance;
  assert.equal(p.samples.length, 1); assert.equal(p.samples[0].readMask, 3, "metallic B is dead, roughness G and AO R survive");
  const values = evaluateCompiledAppearance(p, context());
  close(values.metallic, [0]); close(values.specularWeight, [1]); close(values.specularColor, [1, 1, 1]);
  m.occlusion_uv_set = 1;
  assert.equal(compileCanonicalMaterial(m).appearance.samples.length, 2);
});

test("zero RGB preserves alpha, zero normal scale preserves signed Z, zero coat removes its sources", () => {
  const m = new StandardShadeMaterial();
  m.texture_albedo = texture(); m.diffuse_color.set(0, 0, 0, 0.7);
  m.texture_normal = texture(); m.normal_scale = 0;
  m.texture_clearcoat = texture(); m.texture_clearcoat_normal = texture();
  const p = compileCanonicalMaterial(m).appearance;
  assert.equal(p.samples.find(s => s.binding.texture === m.texture_albedo).readMask, 8);
  assert.equal(p.samples.find(s => s.binding.texture === m.texture_normal).readMask, 4);
  assert.ok(!p.samples.some(s => s.binding.texture === m.texture_clearcoat));
  const values = evaluateCompiledAppearance(p, context());
  close(values.baseColor, [0, 0, 0]); close(values.alpha, [0.42]); close(values.normalTS, [0, 0, 0.4]);
  m.is_unlit = true;
  assert.deepEqual(Object.keys(compileCanonicalMaterial(m).appearance.outputs).sort(), ["alpha", "baseColor"]);
});

test("compiled products own immutable numeric and sampling snapshots", () => {
  const m = new StandardShadeMaterial(); m.texture_albedo = texture();
  m.base_color_uv_offset = [0.2, 0.3]; m.specular_color_factor.set(0.1, 0.2, 0.3);
  const c = compileCanonicalMaterial(m);
  const before = evaluateCompiledAppearance(c.appearance, context());
  m.base_color_uv_offset[0] = 99; m.texture_albedo.magFilter = 0;
  m.diffuse_color.r = 0.9; m.specular_color_factor.r = 1;
  assert.equal(c.samples[0].offset[0], 0.2); assert.equal(c.specularColor[0], 0.1);
  assert.notEqual(c.appearance.samples[0].binding.sampler[2], m.texture_albedo.magFilter);
  assert.deepEqual(evaluateCompiledAppearance(c.appearance, context()), before);
  assert.throws(() => { c.appearance.samples[0].binding.offset[0] = 4; }, TypeError);
  assert.throws(() => { c.appearance.instructions[0].args.push(42); }, TypeError);
});

test("UV transform snapshot is evaluated in shader scale/rotation/offset order", () => {
  const m = new StandardShadeMaterial(); m.texture_albedo = texture();
  m.base_color_uv_scale = [2, 3]; m.base_color_uv_rotation = Math.PI / 2;
  m.base_color_uv_offset = [0.1, 0.2];
  let coordinate;
  evaluateCompiledAppearance(compileCanonicalMaterial(m).appearance, context((binding, uv) => { coordinate = uv; return sampleValue; }));
  close(coordinate, [0.1 - 0.7 * 3, 0.2 + 0.2 * 2]);
});

test("cycles, types, conflicting inputs and nonfinite constants fail at publication", () => {
  assert.throws(() => compileAppearanceGraph({ nodes: [{ kind: "operation", op: "sin", width: 1, args: [0] }], outputs: { o: 0 } }), /cycle/);
  const g = new AppearanceGraphBuilder(); const x = g.constant([1, 2]);
  g.output("bad", g.operation("add", x, g.constant([1, 2, 3])));
  assert.throws(() => compileAppearanceGraph(g.build()), /operation/);
  const a = new AppearanceGraphBuilder(); a.output("a", a.input("x", 1, "dynamic")); a.output("b", a.input("x", 1, "view"));
  assert.throws(() => compileAppearanceGraph(a.build()), /Conflicting/);
  const b = new AppearanceGraphBuilder(); b.output("b", b.operation("divide", b.constant(1), b.constant(0)));
  assert.throws(() => compileAppearanceGraph(b.build()), /nonfinite/);
  const c = new AppearanceGraphBuilder(); c.output("c", c.constant(1e39));
  assert.throws(() => compileAppearanceGraph(c.build()), /finite/);
});

test("topological compilation handles deep graphs without recursive stack use", () => {
  const g = new AppearanceGraphBuilder(); let x = g.input("x", 1, "dynamic", { low: 0, high: 1 });
  for (let i = 0; i < 12000; i++) x = g.operation("add", x, g.constant(0.01));
  g.output("o", x);
  const p = compileAppearanceGraph(g.build());
  assert.ok(p.instructions.length > 12000);
  const value = evaluateCompiledAppearance(p, { inputs: { x: [0.5] }, sample: () => [] }).o[0];
  assert.ok(value > 120 && value < 121);
});
