import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  appearanceFieldIdentity,
  updateAppearanceFieldVersions,
} from "../../.test-dist/material/AppearanceFieldIdentity.js";
import {
  AppearanceMaterialDefinition,
  resolveAppearanceMaterialProducts,
} from "../../.test-dist/material/AppearanceMaterialDefinition.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { cookAppearanceMipProduct } from "../../.test-dist/material/AppearanceMipCooker.js";
import { cookAppearanceNormalProduct } from "../../.test-dist/material/AppearanceNormalCooker.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage,
} from "../../.test-dist/assets/AppearanceAssetPackage.js";

const opts = {
  width: 2,
  height: 2,
  mipCount: 2,
  byteBudget: 8192,
  validationProbeBudget: 8192,
  domainMin: [0, 0],
  domainMax: [1, 1],
  error: { absolute: 0.001, relative: 0 },
  storagePrecision: "float16",
  sample: () => [0.25, 0.5, 0.75, 1],
};
const pack = async (product) =>
  openAppearanceAssetPackage(
    await writeAppearanceAssetPackage(product, {
      uri: "test/field-identity",
      contentHash: "a".repeat(64),
      dependencies: [],
    }),
  );

function graph(gain = 2, color = 0.5, version = "source-v1", reorder = false) {
  const g = new AppearanceGraphBuilder(),
    texture = new ShadeTexture();
  texture.appearance_content_version = version;
  if (reorder) g.output("unrelated", g.operation("cos", g.input("view", 1, "view")));
  const uv = g.input("uv", 2, "surface", undefined, "uv0"),
    sample = g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
  const field = g.operation("multiply", g.swizzle(sample, [0]), g.parameter("gain", gain));
  g.output("field", field);
  g.output("target", g.operation("multiply", field, g.input("time", 1, "dynamic")));
  g.output("color", g.parameter("color", color));
  return compileAppearanceGraph(g.build());
}

test("exact field identity survives recompilation/unrelated ordering and separates parameter, source, UV and dynamic dependencies", () => {
  const original = graph(),
    reordered = graph(2, 0.75, "source-v1", true);
  assert.equal(
    appearanceFieldIdentity(original, original.outputs.field).key,
    appearanceFieldIdentity(reordered, reordered.outputs.field).key,
  );
  assert.equal(appearanceFieldIdentity(original, original.outputs.field).portable, true);
  assert.notEqual(
    appearanceFieldIdentity(original, original.outputs.field).key,
    appearanceFieldIdentity(graph(3), graph(3).outputs.field).key,
  );
  const newSource = graph(2, 0.5, "source-v2");
  assert.notEqual(
    appearanceFieldIdentity(original, original.outputs.field).key,
    appearanceFieldIdentity(newSource, newSource.outputs.field).key,
  );
  const versions = updateAppearanceFieldVersions(reordered, updateAppearanceFieldVersions(original));
  assert.equal(versions.get("field").version, 1);
  assert.equal(versions.get("target").version, 1);
  assert.equal(versions.get("color").version, 2);
  assert.equal(versions.get("unrelated").version, 1);
  const gainChanged = updateAppearanceFieldVersions(graph(3), versions);
  assert.equal(gainChanged.get("field").version, 2);
  assert.equal(gainChanged.get("target").version, 2);
});

test("source snapshot content versions are immutable; unversioned sources are explicit session-local identities", () => {
  const texture = new ShadeTexture();
  texture.appearance_content_version = "old";
  const old = snapshotAppearanceTexture(texture, "linear-rgb");
  assert.throws(() => {
    texture.appearance_content_version = "new";
  }, /immutable raw image/);
  const replacement = new ShadeTexture();
  replacement.appearance_content_version = "new";
  assert.equal(old.contentVersion, "raw:old");
  assert.equal(snapshotAppearanceTexture(replacement, "linear-rgb").contentVersion, "raw:new");
  const make = (texture) => {
    const g = new AppearanceGraphBuilder();
    g.output(
      "value",
      g.swizzle(
        g.texture(
          snapshotAppearanceTexture(texture, "linear-rgb"),
          g.input("uv", 2, "surface", undefined, "uv0"),
        ),
        [0],
      ),
    );
    return compileAppearanceGraph(g.build());
  };
  const shared = new ShadeTexture(),
    a = make(shared),
    b = make(shared),
    c = make(new ShadeTexture());
  const ai = appearanceFieldIdentity(a, a.outputs.value);
  assert.equal(ai.portable, false);
  assert.equal(ai.key, appearanceFieldIdentity(b, b.outputs.value).key);
  assert.notEqual(ai.key, appearanceFieldIdentity(c, c.outputs.value).key);
});

test("packed field roots reconnect across source snapshots; unrelated edits preserve data and stale fields restore the actual source", async () => {
  const original = graph(),
    product = cookAppearanceMipProduct(
      original,
      { baked: original.outputs.field, uniform: original.outputs.color },
      opts,
    );
  const asset = await pack(product),
    current = graph(2, 0.75, "source-v1", true);
  const resolved = resolveAppearanceMaterialProducts(current, [asset]);
  assert.equal(resolved.reused.length, 1);
  assert.equal(resolved.stale.length, 1);
  assert.equal(resolved.program.samples.length, 0);
  assert.equal(resolved.program.productReads[0].field.name, "baked");
  assert.ok(resolved.program.instructions.some((i) => i.parameter === "color" && i.value === 0.75));
  const changed = resolveAppearanceMaterialProducts(graph(3, 0.75), [asset]);
  assert.equal(changed.reused.length, 0);
  assert.equal(changed.stale.length, 2);
  assert.equal(changed.program.samples.length, 1);
  const revised = await pack(
    cookAppearanceMipProduct(
      graph(2, 0.75),
      { baked: graph(2, 0.75).outputs.field, uniform: graph(2, 0.75).outputs.color },
      opts,
    ),
  );
  assert.notEqual(asset.runtime.manifest.assetId, revised.runtime.manifest.assetId);
  assert.equal(
    asset.fields.find((f) => f.name === "baked").contentKey,
    revised.fields.find((f) => f.name === "baked").contentKey,
    "a different field in the same package must not invalidate this physical field's identity",
  );
});

test("normal and roughness invalidate as one lobe, while unchanged coat retains its actual moment product", async () => {
  const make = (base) => {
    const g = new AppearanceGraphBuilder();
    g.output("normalTS", g.constant([0, 0, 1]));
    g.output("roughness", g.parameter("baseRoughness", base));
    g.output("coatNormalTS", g.constant([0, 1, 0]));
    g.output("coatRoughness", g.parameter("coatRoughness", 0.75));
    return compileAppearanceGraph(g.build());
  };
  const p = make(0.5),
    pairs = [
      ["base", "normalTS", "roughness"],
      ["coat", "coatNormalTS", "coatRoughness"],
    ].map(([momentField, normalOutput, roughnessOutput]) => ({
      momentField,
      normalOutput,
      roughnessOutput,
      normal: p.outputs[normalOutput],
      roughness: p.outputs[roughnessOutput],
      maxAngleRadians: 0.001,
      maxRoughnessError: 0.01,
    }));
  const asset = await pack(cookAppearanceNormalProduct(p, pairs, opts));
  const before = resolveAppearanceMaterialProducts(p, [asset]),
    after = resolveAppearanceMaterialProducts(make(0.6), [asset]);
  assert.equal(after.reused.length, 1);
  assert.equal(after.stale.length, 1);
  assert.equal(after.program.productReads[0].field.name, "coat");
  const v = updateAppearanceFieldVersions(after.program, updateAppearanceFieldVersions(before.program));
  assert.equal(v.get("normalTS").version, 2);
  assert.equal(v.get("roughness").version, 2);
  assert.equal(v.get("coatNormalTS").version, 1);
  assert.equal(v.get("coatRoughness").version, 1);
});

test("canonical scene materials consume author definitions/products and retain only contracted outputs and live source textures", async () => {
  const g = new AppearanceGraphBuilder(),
    texture = new ShadeTexture();
  texture.appearance_content_version = "author-v1";
  const uv = g.input("uv0", 2, "surface", undefined, "uv0"),
    t = g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
  const baked = g.operation("multiply", g.swizzle(t, [0, 1, 2]), g.parameter("colorGain", 2));
  g.output("baked", baked);
  g.output("baseColor", g.operation("multiply", baked, g.input("vertexColor", 3, "geometry")));
  g.output("alpha", g.constant(1));
  g.output("dead", g.input("view", 1, "view"));
  const source = compileAppearanceGraph(g.build()),
    asset = await pack(cookAppearanceMipProduct(source, { rgb: source.outputs.baked }, opts));
  const material = new StandardShadeMaterial();
  material.is_unlit = true;
  material.appearance_definition = new AppearanceMaterialDefinition(g.build(), [asset]);
  const published = compileCanonicalMaterial(material);
  assert.equal(published.appearanceResolution.reused.length, 1);
  assert.equal(published.appearance.samples.length, 0);
  assert.deepEqual(Object.keys(published.appearance.outputs), ["baseColor", "alpha"]);
  assert.deepEqual(
    published.appearance.inputs.map((i) => i.name),
    ["uv0", "vertexColor"],
  );
  assert.deepEqual(material.textures, [texture]);
  const other = new StandardShadeMaterial();
  other.is_unlit = true;
  assert.equal(material.equals(other), false);
  other.appearance_definition = material.appearance_definition;
  assert.equal(material.equals(other), true);
  const broken = new AppearanceGraphBuilder();
  broken.output("baseColor", broken.constant(1));
  material.appearance_definition = new AppearanceMaterialDefinition(broken.build());
  assert.throws(() => compileCanonicalMaterial(material), /requires baseColor width 3/);
});

test("f32 signed zero, sampling route changes and nonzero version exhaustion have explicit identities", () => {
  const make = (value) => {
    const g = new AppearanceGraphBuilder();
    g.output("value", g.parameter("value", value));
    return compileAppearanceGraph(g.build());
  };
  const p = make(0),
    n = make(-0);
  assert.notEqual(
    appearanceFieldIdentity(p, p.outputs.value).key,
    appearanceFieldIdentity(n, n.outputs.value).key,
  );
  const versions = updateAppearanceFieldVersions(p),
    old = new Map([["value", { ...versions.get("value"), version: 0xffffffff }]]);
  assert.equal(updateAppearanceFieldVersions(p, old).get("value").version, 0xffffffff);
  assert.throws(() => updateAppearanceFieldVersions(n, old), /new identity epoch/);
  const route = (offset, wrap) => {
    const g = new AppearanceGraphBuilder(),
      texture = new ShadeTexture();
    texture.appearance_content_version = "same";
    texture.wrapS = wrap;
    g.output(
      "field",
      g.swizzle(
        g.texture(
          snapshotAppearanceTexture(texture, "linear-rgb", offset),
          g.input("uv", 2, "surface", undefined, "uv0"),
        ),
        [0],
      ),
    );
    const p = compileAppearanceGraph(g.build());
    return appearanceFieldIdentity(p, p.outputs.field).key;
  };
  assert.notEqual(route([0, 0], 1), route([0.1, 0], 1));
  assert.notEqual(route([0, 0], 1), route([0, 0], 2));
});
