import test from "node:test";
import assert from "node:assert/strict";
import { preserveAssetUrl } from "../../OEngine/tools/preserve-asset-url.mjs";

test("actual asset expression survives formatting and rejects comment/string lookalikes", () => {
  const path = "./vendor/lib.wasm";
  for (const source of [
    'const url = new URL("./vendor/lib.wasm", import.meta.url);',
    "const url = new URL(\n './vendor/lib.wasm',\n import.meta.url\n);"
  ]) {
    assert.equal(preserveAssetUrl(source, path, "PLACEHOLDER"), "const url = PLACEHOLDER;");
  }
  assert.throws(
    () => preserveAssetUrl('// new URL("./vendor/lib.wasm", import.meta.url)', path, "P"),
    /found 0/
  );
  assert.throws(
    () => preserveAssetUrl("const text = 'new URL(\"./vendor/lib.wasm\", import.meta.url)';", path, "P"),
    /found 0/
  );
  assert.throws(
    () =>
      preserveAssetUrl(
        'new URL("./vendor/lib.wasm", import.meta.url); new URL("./vendor/lib.wasm", import.meta.url);',
        path,
        "P"
      ),
    /found 2/
  );
});
