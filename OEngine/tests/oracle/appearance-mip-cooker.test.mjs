import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  cookAppearanceMipProduct,
  sampleAppearanceCookedField,
} from "../../.test-dist/material/AppearanceMipCooker.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

function graph(power = 1, textureBinding = snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb")) {
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv", 2, "surface", undefined, "uv0");
  const s = g.swizzle(g.texture(textureBinding, uv), [0]);
  g.output("field", power === 1 ? s : g.operation("pow", s, g.constant(power)));
  return compileAppearanceGraph(g.build());
}
const options = (extra = {}) => ({
  width: 4,
  height: 4,
  mipCount: 3,
  byteBudget: 4096,
  validationProbeBudget: 4096,
  domainMin: [0, 0],
  domainMax: [1, 1],
  error: { absolute: 1e-5, relative: 0 },
  sample: (_binding, _uv, footprint) => [0.2 + footprint.chartLod * 0.1, 0.4, 0.6, 1],
  ...extra,
});

test("every mip reevaluates source filtering instead of downsampling nonlinear level-zero results", () => {
  const p = graph(2);
  const product = cookAppearanceMipProduct(
    p,
    { nonlinear: p.outputs.field },
    options({ error: { absolute: 0.003, relative: 0 } }),
  );
  const values = product.fields.nonlinear.mips.map((mip) => mip.data[0]);
  [0.04, 0.09, 0.16].forEach((wanted, index) => assert.ok(Math.abs(values[index] - wanted) < 1e-6));
  assert.ok(product.validation.maxAbsoluteError > 0.0024, "fractional LOD discrepancy must be measured");
  assert.ok(product.validation.maxBudgetRatio <= 1);
  assert.equal(product.allocatedBytes, (16 + 4 + 1) * 4);
  assert.equal(product.validation.probeCount, 221);
  assert.equal(product.coordinateDomain, "uv0");
});

test("nonlinear trilinear mismatch exceeding the declared budget rejects the product", () => {
  const p = graph(2);
  assert.throws(
    () => cookAppearanceMipProduct(p, { nonlinear: p.outputs.field }, options()),
    /quality budget/,
  );
});

test("half-float product quality probes include quantization error and reject finite-storage overflow", () => {
  const p = graph();
  assert.throws(
    () =>
      cookAppearanceMipProduct(
        p,
        { field: p.outputs.field },
        options({
          storagePrecision: "float16",
          sample: () => [0.2001, 0, 0, 1],
          error: { absolute: 1e-7, relative: 0 },
        }),
      ),
    /quality budget/,
  );
  const result = cookAppearanceMipProduct(
    p,
    { field: p.outputs.field },
    options({
      storagePrecision: "float16",
      error: { absolute: 0.0002, relative: 0 },
    }),
  );
  assert.equal(result.storagePrecision, "float16");
  assert.ok(result.validation.maxAbsoluteError > 1e-5);
  assert.ok(result.validation.maxBudgetRatio <= 1);
  assert.throws(
    () =>
      cookAppearanceMipProduct(
        p,
        { field: p.outputs.field },
        options({
          storagePrecision: "float16",
          sample: () => [100000, 0, 0, 1],
          error: { absolute: 100000, relative: 0 },
        }),
      ),
    /finite storage precision/,
  );
});

test("affine mip interpolation passes and all slow/mismatching probes contribute", () => {
  const p = graph();
  const product = cookAppearanceMipProduct(p, { color: p.outputs.field }, options());
  const sampled = sampleAppearanceCookedField(product.fields.color, 0.3, 0.7, 0.5);
  assert.ok(Math.abs(sampled[0] - 0.25) < 1e-6);
  assert.ok(product.validation.maxBudgetRatio < 0.01);
});

test("compiled constant fields consume neither texture mip storage nor probing budget", () => {
  const g = new AppearanceGraphBuilder();
  g.output("field", g.constant([0, 0.5, 8]));
  const p = compileAppearanceGraph(g.build());
  const product = cookAppearanceMipProduct(
    p,
    { hdr: p.outputs.field },
    options({
      byteBudget: 0,
      validationProbeBudget: 0,
      sample: () => {
        throw new Error("constants must not sample");
      },
    }),
  );
  assert.equal(product.coordinateDomain, null);
  assert.equal(product.allocatedBytes, 0);
  assert.equal(product.validation.probeCount, 0);
  assert.deepEqual(product.fields.hdr.constant, [0, 0.5, 8]);
  assert.deepEqual(sampleAppearanceCookedField(product.fields.hdr, 0.9, 0.4, 2), [0, 0.5, 8]);
});

test("material-only products evaluate their own subgraph without unrelated texture or target inputs", () => {
  const g = new AppearanceGraphBuilder();
  const parameter = g.parameter("factor", [0.25, 0.5]);
  g.output("uniform", g.operation("multiply", parameter, g.constant(2)));
  const uv = g.input("uv", 2, "surface", undefined, "uv0");
  g.output("texture", g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv));
  const p = compileAppearanceGraph(g.build());
  const product = cookAppearanceMipProduct(
    p,
    { factor: p.outputs.uniform },
    options({
      byteBudget: 0,
      validationProbeBudget: 0,
      sample: () => {
        throw new Error("unrelated texture must not execute");
      },
    }),
  );
  assert.deepEqual(product.fields.factor.constant, [0.5, 1]);
  assert.equal(product.allocatedBytes, 0);
});

test("byte and probe reservation reject before any source work", () => {
  const p = graph();
  let reads = 0;
  const sample = () => {
    reads++;
    return [0.2, 0.4, 0.6, 1];
  };
  assert.throws(
    () => cookAppearanceMipProduct(p, { field: p.outputs.field }, options({ sample, byteBudget: 1 })),
    /bytes/,
  );
  assert.throws(
    () =>
      cookAppearanceMipProduct(p, { field: p.outputs.field }, options({ sample, validationProbeBudget: 1 })),
    /probes/,
  );
  assert.equal(reads, 0);
});

test("NPOT mip dimensions and source-specific affine footprints remain explicit", () => {
  const binding = snapshotAppearanceTexture(
    new ShadeTexture(),
    "linear-rgb",
    [0.1, 0.2],
    [2, 3],
    Math.PI / 2,
  );
  const p = graph(1, binding);
  let first;
  const product = cookAppearanceMipProduct(
    p,
    { field: p.outputs.field },
    options({
      width: 5,
      height: 3,
      domainMin: [2, 4],
      domainMax: [6, 6],
      sample: (_binding, uv, footprint) => {
        first ??= { uv, footprint };
        return [0.2, 0.4, 0.6, 1];
      },
    }),
  );
  assert.deepEqual(
    product.fields.field.mips.map((mip) => [mip.width, mip.height]),
    [
      [5, 3],
      [2, 1],
      [1, 1],
    ],
  );
  assert.ok(Math.abs(first.footprint.ddx[0]) < 1e-6);
  assert.ok(Math.abs(first.footprint.ddx[1] - 1.6) < 1e-6);
  assert.ok(Math.abs(first.footprint.ddy[0] + 2) < 1e-6);
  assert.ok(Math.abs(first.uv[0] - (0.1 - (4 + 1 / 3) * 3)) < 1e-5);
});

test("static cook rejects dynamic, multi-domain and texture-driven UVs without masking them as static", () => {
  const g = new AppearanceGraphBuilder();
  g.output("field", g.input("time", 1, "dynamic"));
  const dynamic = compileAppearanceGraph(g.build());
  assert.throws(() => cookAppearanceMipProduct(dynamic, dynamic.outputs, options()), /dynamic/);
  const m = new AppearanceGraphBuilder();
  const uv0 = m.input("uv0", 2, "surface", undefined, "uv0"),
    uv1 = m.input("uv1", 2, "surface", undefined, "uv1");
  m.output("field", m.operation("add", uv0, uv1));
  const multi = compileAppearanceGraph(m.build());
  assert.throws(() => cookAppearanceMipProduct(multi, multi.outputs, options()), /single/);
  const w = new AppearanceGraphBuilder();
  const uv = w.input("uv", 2, "surface", undefined, "uv0");
  const warped = w.operation("sin", uv);
  w.output("field", w.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), warped));
  const warpedProgram = compileAppearanceGraph(w.build());
  assert.throws(
    () => cookAppearanceMipProduct(warpedProgram, warpedProgram.outputs, options()),
    /direct chart UV/,
  );
});
