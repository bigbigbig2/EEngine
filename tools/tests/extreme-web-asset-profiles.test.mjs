import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeAvifArguments, qualityAnchors } from "../../OEngine/tools/extreme-web-asset/native-profiles.mjs";

test("native AVIF profiles retain selected tuning, depth, range and channel semantics", () => {
  assert.deepEqual(qualityAnchors, { high: 80, extreme: 50 });
  const value = (args, key) => args[args.indexOf(key) + 1];
  for (const semantic of ["color-rgb", "color-rgba", "normal-xy", "data-rgb", "moment-xyz", "scalar-r"]) {
    for (const quality of Object.values(qualityAnchors)) {
      const args = nativeAvifArguments(semantic, quality);
      assert.equal(value(args, "-q"), String(quality));
      assert.equal(value(args, "-s"), "4");
      assert.equal(value(args, "-c"), "aom");
      assert.equal(value(args, "-d"), "10");
      assert.equal(value(args, "--range"), "full");
      assert.equal(value(args, "-a"), semantic.startsWith("color-") ? "tune=iq" : "tune=ssim");
      assert.equal(value(args, "--yuv"), semantic === "scalar-r" ? "400" : "444");
      assert.equal(value(args, "--cicp"), semantic.startsWith("color-") ? "1/13/6" : semantic === "scalar-r" ? "1/8/6" : "1/8/0");
      assert.equal(args.includes("--qalpha"), semantic === "color-rgba");
      assert.ok(args.includes("--ignore-icc") && args.includes("--ignore-exif") && args.includes("--ignore-xmp"));
    }
  }
});

test("native profiles reject unsupported semantics and silent effort/quality changes", () => {
  for (const quality of [-1, 101, NaN, 50.5]) assert.throws(() => nativeAvifArguments("normal-xy", quality));
  assert.throws(() => nativeAvifArguments("hdr", 80));
  assert.throws(() => nativeAvifArguments("color-rgb", 80, 6));
  assert.equal(nativeAvifArguments("data-rgb", 80, 2)[3], "2");
});

test("preparation pins exact source identities and separates shader authorization", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../OEngine/tools/extreme-web-asset/sources.json", import.meta.url), "utf8"));
  for (const source of Object.values(manifest.sources)) {
    assert.match(source.revision, /^[0-9a-f]{40}$/);
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.license);
  }
  assert.match(manifest.sources.spark.license, /production authorization not recorded/);
  assert.match(manifest.nasm.sha256, /^[0-9a-f]{64}$/);
});
