import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import {
  compileAppearanceGraph,
  selectAppearanceProductProgram,
} from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { bindAppearanceProducts } from "../../.test-dist/material/AppearanceProductBinding.js";
import {
  cookAppearanceMipProduct,
  sampleAppearanceCookedField,
} from "../../.test-dist/material/AppearanceMipCooker.js";
import { cookAppearanceNormalProduct } from "../../.test-dist/material/AppearanceNormalCooker.js";
import { evaluateCompiledAppearance } from "../../.test-dist/material/AppearanceGraphEvaluation.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage,
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

const options = (extra = {}) => ({
  width: 4,
  height: 4,
  mipCount: 3,
  byteBudget: 8192,
  validationProbeBudget: 8192,
  domainMin: [0, 0],
  domainMax: [1, 1],
  error: { absolute: 0.001, relative: 0 },
  storagePrecision: "float16",
  sample: () => [0.5, 0, 0.8, 1],
  ...extra,
});
const packageProduct = async (product) =>
  openAppearanceAssetPackage(
    await writeAppearanceAssetPackage(product, {
      uri: "test/product-binding",
      contentHash: "a".repeat(64),
      dependencies: [],
    }),
  );

function source(gain = 2) {
  const g = new AppearanceGraphBuilder(),
    uv = g.input("uv", 2, "surface", undefined, "uv0");
  const sample = g.swizzle(g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv), [0]);
  const value = g.operation("pow", g.operation("multiply", sample, g.parameter("gain", gain)), g.constant(2));
  g.output("staticRoot", value);
  g.output("animated", g.operation("multiply", value, g.input("time", 1, "dynamic")));
  return compileAppearanceGraph(g.build());
}

test("binding an internal baked root removes its source sampling/parameters/math while retaining dynamic target evaluation", async () => {
  const p = source(),
    product = cookAppearanceMipProduct(p, { baked: p.outputs.staticRoot }, options());
  const asset = await packageProduct(product);
  const bound = bindAppearanceProducts(p, [{ source: p, asset, roots: { baked: p.outputs.staticRoot } }]);
  assert.equal(bound.samples.length, 0);
  assert.equal(bound.productReads.length, 1);
  assert.ok(!bound.instructions.some((i) => i.kind === "parameter" || i.op === "pow"));
  assert.equal(bound.productReads[0].source, p);
  assert.deepEqual(bound.productReads[0].sourceRoots, p.outputs.staticRoot);
  let reads = 0;
  const actual = evaluateCompiledAppearance(bound, {
    inputs: { uv: [0.25, 0.75], time: [3] },
    sample: () => {
      throw new Error("dead source sample must not execute");
    },
    sampleProduct(index, uv) {
      reads++;
      assert.equal(index, 0);
      return sampleAppearanceCookedField(product.fields.baked, ...uv, 0);
    },
  });
  assert.deepEqual(actual, { staticRoot: [1], animated: [3] });
  assert.equal(reads, 1);
  const lowered = lowerNativeMaterial(bound);
  assert.ok(!lowered.source.includes("native_material_sample_"));
  assert.ok(!lowered.source.includes("pow("));
  assert.equal(lowered.source.match(/native_material_product_0\(/g).length, 1);
});

test("coordinate anchors survive when the baked expression is itself a coordinate component", async () => {
  const g = new AppearanceGraphBuilder(),
    uv = g.input("uv", 2, "surface", undefined, "uv0");
  g.output("u", g.swizzle(uv, [0]));
  g.output("target", g.operation("multiply", g.swizzle(uv, [0]), g.input("gain", 1, "dynamic")));
  const p = compileAppearanceGraph(g.build());
  const product = cookAppearanceMipProduct(
    p,
    { u: p.outputs.u },
    options({ mipCount: 1, error: { absolute: 0.13, relative: 0 } }),
  );
  const bound = bindAppearanceProducts(p, [
    { source: p, asset: await packageProduct(product), roots: { u: p.outputs.u } },
  ]);
  const values = evaluateCompiledAppearance(bound, {
    inputs: { uv: [0.375, 0.625], gain: [2] },
    sample: () => [],
    sampleProduct: (_index, coordinates) => sampleAppearanceCookedField(product.fields.u, ...coordinates, 0),
  });
  assert.deepEqual(values, { u: [0.375], target: [0.75] });
  assert.ok(bound.instructions.every((instruction, index) => instruction.args.every((arg) => arg < index)));
});

test("exact f32 constant products need no product texture, coordinate inputs, or sample callbacks", async () => {
  const g = new AppearanceGraphBuilder();
  g.output("value", g.parameter("hdr", [16, 0.25]));
  const p = compileAppearanceGraph(g.build()),
    product = cookAppearanceMipProduct(p, { constant: p.outputs.value }, options());
  const bound = bindAppearanceProducts(p, [
    { source: p, asset: await packageProduct(product), roots: { constant: p.outputs.value } },
  ]);
  const values = evaluateCompiledAppearance(bound, {
    inputs: {},
    sample: () => {
      throw new Error("no sample");
    },
  });
  assert.deepEqual(values.value, [16, 0.25]);
  assert.deepEqual(bound.inputs, []);
  assert.ok(!lowerNativeMaterial(bound).source.includes("native_material_product_"));
  assert.deepEqual(lowerNativeMaterial(bound).constants, [16, 0.25]);
});

test("independent normal/coat products break source roughness CSE at lobe outputs and preserve validity", async () => {
  const g = new AppearanceGraphBuilder(),
    uv = g.input("uv", 2, "surface", undefined, "uv0");
  const t = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv),
    r = g.constant(0.5);
  g.output("normalTS", g.swizzle(t, [0, 1, 2]));
  g.output("roughness", r);
  g.output("coatNormalTS", g.combine(g.swizzle(t, [0]), g.constant(0), g.constant(1)));
  g.output("coatRoughness", r);
  const p = compileAppearanceGraph(g.build());
  assert.deepEqual(p.outputs.roughness, p.outputs.coatRoughness);
  const pairs = [
    ["baseMoment", "normalTS", "roughness"],
    ["coatMoment", "coatNormalTS", "coatRoughness"],
  ].map(([momentField, normalOutput, roughnessOutput]) => ({
    momentField,
    normalOutput,
    roughnessOutput,
    normal: p.outputs[normalOutput],
    roughness: p.outputs[roughnessOutput],
    maxAngleRadians: 0.01,
    maxRoughnessError: 0.025,
  }));
  const product = cookAppearanceNormalProduct(
    p,
    pairs,
    options({ sample: (_binding, uv) => (uv[0] < 0.5 ? [0.6, 0, 0.8, 1] : [-0.6, 0, 0.8, 1]) }),
  );
  const bound = bindAppearanceProducts(p, [{ source: p, asset: await packageProduct(product) }]);
  assert.equal(bound.samples.length, 0);
  assert.equal(bound.productReads.length, 2);
  const actual = evaluateCompiledAppearance(bound, {
    inputs: { uv: [0.5, 0.5] },
    sample: () => {
      throw new Error("dead sample");
    },
    sampleProduct: (index, coordinates) =>
      sampleAppearanceCookedField(product.fields[bound.productReads[index].field.name], ...coordinates, 2),
  });
  assert.ok(actual.roughness[0] > actual.coatRoughness[0]);
  assert.deepEqual(actual.normalTSValidity, [1]);
  assert.deepEqual(actual.coatNormalTSValidity, [1]);
  const selected = selectAppearanceProductProgram(bound, { coat: bound.outputs.coatRoughness });
  assert.equal(selected.productReads.length, 1);
  assert.equal(selected.productReads[0].field.name, "coatMoment");
  assert.ok(lowerNativeMaterial(bound).source.includes("appearance_decode_normal_moment"));
});

test("source snapshots, output widths, roots, and dependency domains are validated once before GPU publication", async () => {
  const p = source(),
    asset = await packageProduct(cookAppearanceMipProduct(p, { baked: p.outputs.staticRoot }, options()));
  const binding = { source: p, asset, roots: { baked: p.outputs.staticRoot } };
  assert.throws(() => bindAppearanceProducts(source(3), [binding]), /source snapshot/);
  assert.throws(
    () => bindAppearanceProducts(p, [{ ...binding, roots: { baked: p.outputs.animated } }]),
    /dynamic/,
  );
  assert.throws(() => bindAppearanceProducts(p, [binding, binding]), /overlap/);
  assert.throws(() => bindAppearanceProducts(p, [{ ...binding, roots: { baked: [999999] } }]), /invalid/);
  const bound = bindAppearanceProducts(p, [binding]);
  assert.throws(() => bindAppearanceProducts(bound, [{ ...binding, source: bound }]), /bind once/);
  assert.throws(() => cookAppearanceMipProduct(bound, bound.outputs, options()), /original source/);
});
