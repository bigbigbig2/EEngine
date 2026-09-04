import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relative) => readFileSync(
  new URL(`../src/${relative}`, import.meta.url),
  "utf8"
);

test("P3 Renderer 使用统一 VisibilityFeature 与 SurfaceFeature 边界", () => {
  const renderer = source("render/Renderer.ts");
  assert.match(renderer, /new VisibilityFeature\(this\._graphics\)/);
  assert.match(renderer, /new SurfaceFeature\(this\._graphics\)/);
  assert.doesNotMatch(renderer, /new PackedVisibilityPass\(/);
  assert.doesNotMatch(renderer, /new PackedMaterialResolvePass\(/);
});

test("P3 Feature wrapper 保留 GPU producer→consumer 与 Surface ABI", () => {
  const visibility = source("render/features/VisibilityFeature.ts");
  const surface = source("render/features/SurfaceFeature.ts");
  const packedVisibility = source("render/passes/PackedVisibilityPass.ts");
  const packedResolve = source("render/passes/PackedMaterialResolvePass.ts");
  assert.match(visibility, /GPU work generation → VisibilityKey\/depth/);
  assert.match(surface, /唯一 Surface producer 边界/);
  assert.match(packedVisibility, /drawIndirect/);
  assert.match(packedResolve, /GPU_SURFACE_BYTES_PER_PIXEL/);
  assert.match(packedResolve, /pass\.drawIndirect\(/);
  assert.equal((packedResolve.match(/pass\.drawIndirect\(/g) ?? []).length, 1);
});

test("P3 关闭 Packed feature 时不创建 VisibilityKey 或 Surface owner", () => {
  const renderer = source("render/Renderer.ts");
  assert.match(renderer, /packedResolveOut \?\? this\.obtainLegacyMaterialExpand\(\)/);
  assert.match(renderer, /gpuPacked !== null/);
});

test("S1 legacy and Packed producers cross one immutable Surface seam", () => {
  const renderer = source("render/Renderer.ts");
  const legacy = source("render/passes/MaterialExpandPass.ts");
  assert.match(legacy, /surface: SurfaceFrame/);
  assert.match(renderer, /packedResolveOut\?\.surface \?\? matOut\.surface/);
  assert.doesNotMatch(renderer, /matOut\.gPbr|matOut\.gNormal|matOut\.gAlbedo|matOut\.gEmissive/);
});
