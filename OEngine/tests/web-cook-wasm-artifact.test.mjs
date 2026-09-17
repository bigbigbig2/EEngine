import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { encodeWebCanonicalGeometryV1, encodeWebGeometryCookRecipeV1, cookWebGeometryWasmV1 } = await import("../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");
const Module = (await import("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs")).default;

test("checked-in Web geometry artifact executes the Product ABI", async () => {
  const wasm = await readFile(new URL("../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url));
  const module = await Module({
    instantiateWasm(info, receive) {
      WebAssembly.instantiate(wasm, info).then(result => receive(result.instance));
      return {};
    }
  });
  assert.equal(module._oengine_web_geometry_cook_abi_version(), 1);
  const canonical = encodeWebCanonicalGeometryV1([{
    materialId: 0,
    meshletFlags: 1,
    attributeMask: 1,
    generateNormals: true,
    vertices: Float32Array.from([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]),
    indices: Uint32Array.from([0, 1, 2])
  }]);
  const result = cookWebGeometryWasmV1(module, canonical, encodeWebGeometryCookRecipeV1(), 8 * 262144);
  try {
    assert.ok(result.pageCount >= 1);
    assert.equal(result.copyPage(0).byteLength, 262144);
    assert.equal(result.descriptorSections().pageRecords.byteLength, result.pageCount * 32);
  } finally {
    result.release();
  }
});

