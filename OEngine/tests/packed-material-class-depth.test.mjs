import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { materialClassDepthValue, PACKED_MATERIAL_CLASS_DEPTH_WGSL } = await import(
  "../.test-dist/shaders/packed_material_class_depth.js"
);

test("MaterialClassDepth maps seven classes to distinct depth32 values", () => {
  const values = Array.from({ length: 7 }, (_, i) => materialClassDepthValue(i));
  assert.deepEqual(values, [1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8]);
  assert.equal(new Set(values).size, 7);
  assert.throws(() => materialClassDepthValue(7), /\[0, 6\]/);
});

test("ClassDepth shader discards EMPTY/invalid keys and is a separate fullscreen producer", () => {
  assert.match(PACKED_MATERIAL_CLASS_DEPTH_WGSL, /textureLoad\(visibility_keys/);
  assert.match(PACKED_MATERIAL_CLASS_DEPTH_WGSL, /oengine_visibility_key_is_valid/);
  assert.match(PACKED_MATERIAL_CLASS_DEPTH_WGSL, /@builtin\(frag_depth\)/);
  assert.match(PACKED_MATERIAL_CLASS_DEPTH_WGSL, /packed_material_class_depth_vs/);
});

test("Surface backend keeps class-depth and class-discard as explicit depth policies", () => {
  const source = readFileSync(new URL("../src/render/passes/PackedMaterialResolvePass.ts", import.meta.url), "utf8");
  assert.match(source, /depthCompare: \(backend === "class-depth" \? "equal" : "always"\)/);
  assert.match(source, /OENGINE_CLASS_DISCARD/);
  assert.match(source, /pass\.draw\(3, 1, 0, 0\)/);
  assert.match(source, /activeKernelMask/);
  const shader = readFileSync(new URL("../src/shaders/packed_material_resolve.ts", import.meta.url), "utf8");
  assert.match(shader, /let class_depth = \(f32\(OENGINE_ACTIVE_KERNEL_CLASS\) \+ 1\.0\) \/ 8\.0/);
  assert.match(shader, /@builtin\(frag_depth\)/);
  assert.match(shader, /output\.depth = \(f32\(OENGINE_ACTIVE_KERNEL_CLASS\) \+ 1\.0\) \/ 8\.0/);
});
