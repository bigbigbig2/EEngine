import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_MATERIAL_KERNEL_CLASS,
  GPU_MATERIAL_KERNEL_CLASS_COUNT,
  materialKernelClass
} = await import("../.test-dist/gpu/GpuMaterialKernelAbi.js");
const { StandardShadeMaterial } = await import("../.test-dist/material/StandardShadeMaterial.js");
const { ShadeImage, ShadeTexture } = await import("../.test-dist/texture/ShadeTexture.js");

test("MaterialKernelClass is bounded by features rather than material count", () => {
  assert.equal(GPU_MATERIAL_KERNEL_CLASS_COUNT, 7);
  const factor = new StandardShadeMaterial();
  assert.equal(materialKernelClass(factor), GPU_MATERIAL_KERNEL_CLASS.BaseFactor);
  const base = new StandardShadeMaterial();
  base.texture_albedo = texture();
  assert.equal(materialKernelClass(base), GPU_MATERIAL_KERNEL_CLASS.BaseTexture);
  const orm = new StandardShadeMaterial();
  orm.texture_orm = texture();
  assert.equal(materialKernelClass(orm), GPU_MATERIAL_KERNEL_CLASS.BaseOrm);
  const normal = new StandardShadeMaterial();
  normal.texture_normal = texture();
  assert.equal(materialKernelClass(normal), GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormal);
  const full = new StandardShadeMaterial();
  full.texture_normal = texture();
  full.texture_emissive = texture();
  assert.equal(materialKernelClass(full), GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormalEmissive);
  const unlit = new StandardShadeMaterial();
  unlit.is_unlit = true;
  assert.equal(materialKernelClass(unlit), GPU_MATERIAL_KERNEL_CLASS.Unlit);
  const fallback = new StandardShadeMaterial();
  fallback.texture_emissive = texture();
  assert.equal(materialKernelClass(fallback), GPU_MATERIAL_KERNEL_CLASS.GenericStandardPbrFallback);
});

function texture() {
  const image = ShadeImage.fromArrayBuffer(new Uint8Array(4), 4, "uint8", 1, 1, 1);
  return ShadeTexture.from(image);
}
