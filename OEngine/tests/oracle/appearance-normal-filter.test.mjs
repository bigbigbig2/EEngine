import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { cookAppearanceNormalProduct } from "../../.test-dist/material/AppearanceNormalCooker.js";
import { sampleAppearanceCookedField } from "../../.test-dist/material/AppearanceMipCooker.js";
import {
  encodeAppearanceNormalMoment,
  decodeAppearanceNormalMoment,
  referenceAppearanceNormalMoment,
} from "../../.test-dist/material/AppearanceNormalFilter.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage,
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { writeRuntimeAssetPackageV2 } from "../../.test-dist/assets/RuntimeAssetManifestV2.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

function graph() {
  const g = new AppearanceGraphBuilder(),
    uv = g.input("uv", 2, "surface", undefined, "uv0");
  const texel = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
  g.output("normalTS", g.swizzle(texel, [0, 1, 2]));
  g.output("roughness", g.swizzle(texel, [3]));
  return compileAppearanceGraph(g.build());
}
const pair = (p) => ({
  momentField: "baseMoment",
  normalOutput: "normalTS",
  roughnessOutput: "roughness",
  normal: p.outputs.normalTS,
  roughness: p.outputs.roughness,
  maxAngleRadians: 0.002,
  maxRoughnessError: 0.025,
});
const options = (extra = {}) => ({
  width: 5,
  height: 3,
  mipCount: 3,
  byteBudget: 8192,
  validationProbeBudget: 8192,
  domainMin: [0, 0],
  domainMax: [1, 1],
  error: { absolute: 0.001, relative: 0 },
  storagePrecision: "float16",
  sample: (_binding, uv) => (uv[0] < 0.5 ? [0.6, 0, 0.8, 0.5] : [-0.6, 0, 0.8, 0.8]),
  ...extra,
});
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test("perceptual roughness squares into alpha; independent inverse coth round-trips authored directions/roughness", () => {
  for (let i = 0; i <= 100; i++) {
    const p = i / 100,
      moment = encodeAppearanceNormalMoment([2, -3, 4], p);
    const exact = referenceAppearanceNormalMoment(moment);
    near(exact.roughness, p, 2e-5);
    near(Math.hypot(...exact.normal), 1, 1e-12);
    const decoded = decodeAppearanceNormalMoment(moment);
    near(decoded.roughness, p, p < 0.04 ? 0.04 : 0.025);
  }
  const m = encodeAppearanceNormalMoment([0, 0, -2], 0.5);
  near(m[2], -(1 - 0.5 * 0.5 ** 4), 1e-12);
  assert.throws(() => encodeAppearanceNormalMoment([0, 0, 0], 0.5), /finite direction/);
  assert.throws(() => encodeAppearanceNormalMoment([0, 0, 1], 1.1), /roughness/);
});

test("joint moments weight sharp directions more than rough directions, instead of independent normal averaging", () => {
  const sharp = encodeAppearanceNormalMoment([0.6, 0, 0.8], 0.05);
  const rough = encodeAppearanceNormalMoment([-0.6, 0, 0.8], 1);
  const result = decodeAppearanceNormalMoment(sharp.map((n, i) => (n + rough[i]) / 2));
  assert.ok(result.normal[0] > 0.17);
  assert.ok(result.roughness > 0.7);
  assert.equal(result.directionValid, true);
});

test("cancelled moments have explicit direction invalidity and maximum roughness; unit endpoints remain finite", () => {
  assert.deepEqual(decodeAppearanceNormalMoment([0, 0, 0]), {
    normal: [0, 0, 1],
    roughness: 1,
    directionValid: false,
  });
  assert.equal(decodeAppearanceNormalMoment([1e-6, 0, 0]).directionValid, false);
  assert.deepEqual(decodeAppearanceNormalMoment([0, 0, -1]), {
    normal: [0, 0, -1],
    roughness: 0,
    directionValid: true,
  });
  assert.equal(decodeAppearanceNormalMoment([0, 0, 1.0001]).roughness, 0);
});

test("NPOT and 1xN mips preserve every source texel and roughness coupling through area filtering", () => {
  const p = graph(),
    product = cookAppearanceNormalProduct(p, [pair(p)], options({ storagePrecision: "float32" }));
  assert.equal(product.kind, "coupled-vmf-moments");
  assert.equal(product.coordinateDomain, "uv0");
  assert.deepEqual(
    product.fields.baseMoment.mips.map((m) => [m.width, m.height]),
    [
      [5, 3],
      [2, 1],
      [1, 1],
    ],
  );
  const first = encodeAppearanceNormalMoment([0.6, 0, 0.8], 0.5),
    last = encodeAppearanceNormalMoment([-0.6, 0, 0.8], 0.8);
  // 2 of 5 columns are left; all 3 remaining columns, including the odd edge, contribute.
  for (let c = 0; c < 3; c++)
    near(product.fields.baseMoment.mips[2].data[c], (first[c] * 2 + last[c] * 3) / 5);
  const line = cookAppearanceNormalProduct(p, [pair(p)], options({ width: 1, height: 8, mipCount: 4 }));
  assert.deepEqual(
    line.fields.baseMoment.mips.map((m) => [m.width, m.height]),
    [
      [1, 8],
      [1, 4],
      [1, 2],
      [1, 1],
    ],
  );
  assert.ok(line.fields.baseMoment.mips.every((m) => [...m.data].every(Number.isFinite)));
});

test("fractional LOD/spatial probes decode filtered moments and retain variance that normalized mip storage would lose", () => {
  const p = graph(),
    product = cookAppearanceNormalProduct(p, [pair(p)], options());
  const moment = sampleAppearanceCookedField(product.fields.baseMoment, 0.5, 0.5, 0.5);
  assert.ok(Math.hypot(...moment) < 0.95);
  const decoded = decodeAppearanceNormalMoment(moment);
  assert.ok(decoded.roughness > 0.7);
  assert.ok(product.normalFilters[0].measuredAngleRadians < 0.002);
  assert.ok(product.normalFilters[0].measuredRoughnessError > 0);
  assert.ok(product.validation.maxBudgetRatio <= 1);
  assert.ok(product.peakWorkingBytes > product.allocatedBytes);
});

test("half precision glossy moment collapse and inverse-fit error reject explicit quality budgets", () => {
  const p = graph();
  assert.throws(
    () =>
      cookAppearanceNormalProduct(
        p,
        [{ ...pair(p), maxRoughnessError: 0.001 }],
        options({ sample: () => [0, 0, 1, 0.01] }),
      ),
    /quality budget/,
  );
  assert.throws(
    () =>
      cookAppearanceNormalProduct(
        p,
        [{ ...pair(p), maxRoughnessError: 0.0001 }],
        options({ storagePrecision: "float32", sample: () => [0, 0, 1, 0.8] }),
      ),
    /quality budget/,
  );
});

test("constant pairs allocate no mip/reference storage, with explicit fit-validation probes", () => {
  const g = new AppearanceGraphBuilder();
  g.output("normalTS", g.constant([0, 0, -1]));
  g.output("roughness", g.constant(0.5));
  const p = compileAppearanceGraph(g.build());
  const product = cookAppearanceNormalProduct(
    p,
    [pair(p)],
    options({
      byteBudget: 0,
      validationProbeBudget: 1,
      sample: () => {
        throw new Error("uniform pair must not sample");
      },
    }),
  );
  assert.equal(product.allocatedBytes, 0);
  assert.equal(product.peakWorkingBytes, 0);
  assert.equal(product.validation.probeCount, 1);
  assert.deepEqual(product.fields.baseMoment.mips, []);
  assert.equal(product.coordinateDomain, null);
  near(decodeAppearanceNormalMoment(product.fields.baseMoment.constant).roughness, 0.5, 0.002);
  assert.ok(product.normalFilters[0].measuredRoughnessError > 0.001);
});

test("base and coat retain independent pairs and nonuniform dependencies; byte/probe admission precedes sampling", () => {
  const p = graph(),
    coat = {
      ...pair(p),
      momentField: "coatMoment",
      normalOutput: "coatNormalTS",
      roughnessOutput: "coatRoughness",
    };
  const product = cookAppearanceNormalProduct(p, [pair(p), coat], options());
  assert.equal(product.normalFilters.length, 2);
  assert.equal(product.allocatedBytes, (15 + 2 + 1) * 3 * 4 * 2);
  assert.notEqual(product.fields.baseMoment, product.fields.coatMoment);
  let reads = 0;
  const sample = () => {
    reads++;
    return [0, 0, 1, 0.5];
  };
  assert.throws(
    () => cookAppearanceNormalProduct(p, [pair(p)], options({ byteBudget: 1, sample })),
    /peak bytes/,
  );
  assert.throws(
    () => cookAppearanceNormalProduct(p, [pair(p)], options({ validationProbeBudget: 1, sample })),
    /probes/,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => cookAppearanceNormalProduct(p, [pair(p), { ...coat, normalOutput: "normalTS" }], options()),
    /pair/,
  );
});

test("dynamic and zero-direction fields are rejected instead of cooked as a normal fixture", () => {
  const p = graph();
  assert.throws(
    () => cookAppearanceNormalProduct(p, [pair(p)], options({ sample: () => [0, 0, 0, 0.5] })),
    /finite direction/,
  );
  const g = new AppearanceGraphBuilder();
  g.output("normalTS", g.input("animatedNormal", 3, "dynamic"));
  g.output("roughness", g.constant(0.5));
  const dynamic = compileAppearanceGraph(g.build());
  assert.throws(() => cookAppearanceNormalProduct(dynamic, [pair(dynamic)], options()), /dynamic/);
});

test("normal asset records pair semantics/fit budgets; authentic-but-corrupt metadata is rejected", async () => {
  const p = graph(),
    product = cookAppearanceNormalProduct(p, [pair(p)], options());
  const a = await openAppearanceAssetPackage(
    await writeAppearanceAssetPackage(product, {
      uri: "test/joint-normal",
      contentHash: "a".repeat(64),
      dependencies: [],
    }),
  );
  assert.equal(a.kind, "coupled-vmf-moments");
  assert.equal(a.fields[0].format, "rgba16float");
  assert.deepEqual(a.normalFilters, product.normalFilters);
  const metadata = JSON.parse(new TextDecoder().decode(a.runtime.chunks.get("appearance-metadata")));
  metadata.normalFilters[0].roughnessOutput = "normalTS";
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const chunks = a.runtime.manifest.chunks.map((chunk) => ({
    ...chunk,
    data: chunk.id === "appearance-metadata" ? encoded : a.runtime.chunks.get(chunk.id),
    decodedBytes: chunk.id === "appearance-metadata" ? encoded.byteLength : chunk.decodedBytes,
  }));
  const { chunks: _chunks, schemaVersion: _schema, ...manifest } = a.runtime.manifest;
  await assert.rejects(
    openAppearanceAssetPackage(await writeRuntimeAssetPackageV2({ manifest, chunks })),
    /normal filter contract/,
  );
});
