import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_MATERIAL_KERNEL_CLASS,
  GPU_MATERIAL_KERNEL_CLASS_COUNT,
  GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE,
  computeGpuShadeWorkCapacity,
  exclusivePrefixSumReference,
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

test("exclusive prefix oracle covers empty, block edges and recursive inputs", () => {
  for (const length of [0, 1, 255, 256, 257, 65_537]) {
    const values = Uint32Array.from({ length }, (_, index) => (index * 17 + 3) % 11);
    const prefixes = exclusivePrefixSumReference(values);
    assert.equal(prefixes.length, values.length);
    let expected = 0;
    for (let index = 0; index < values.length; index++) {
      assert.equal(prefixes[index], expected);
      expected += values[index];
    }
  }
  assert.throws(() => exclusivePrefixSumReference([0xffffffff, 1]), /exceeds u32/);
  assert.throws(() => exclusivePrefixSumReference([1, -1]), /must be a u32/);
});

test("ShadeWork capacity is one pixel queue plus recursive multi-workgroup scan levels", () => {
  const result = computeGpuShadeWorkCapacity(1921, 913, {
    maxBufferSize: 1 << 30,
    maxStorageBufferBindingSize: 1 << 30
  });
  assert.equal(result.pixelCapacity, 1_753_873);
  assert.equal(
    result.workgroupCount,
    Math.ceil(result.pixelCapacity / GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE)
  );
  assert.equal(result.dispatchWorkgroupsX, result.workgroupCount);
  assert.equal(result.dispatchWorkgroupsY, 1);
  assert.equal(result.queueBytes, result.pixelCapacity * 4);
  assert.ok(result.scanLevelElementCounts.length >= 2);
  assert.equal(result.scanLevelElementCounts.at(-1), 1);
  assert.equal(
    result.scanScratchBytes,
    result.scanLevelElementCounts.reduce(
      (bytes, elements, level) => bytes + elements * 7 * 4 *
        (level < result.scanLevelElementCounts.length - 1 ? 2 : 1),
      0
    )
  );
  assert.throws(() => computeGpuShadeWorkCapacity(1921, 913, {
    maxBufferSize: 1024,
    maxStorageBufferBindingSize: 1024
  }), /queue requires/);
  const large = computeGpuShadeWorkCapacity(8192, 8192, {
    maxBufferSize: 1 << 30,
    maxStorageBufferBindingSize: 1 << 30,
    maxComputeWorkgroupsPerDimension: 65_535
  });
  assert.ok(large.workgroupCount > 65_535);
  assert.ok(large.dispatchWorkgroupsX <= 65_535);
  assert.ok(large.dispatchWorkgroupsY <= 65_535);
  assert.ok(
    large.dispatchWorkgroupsX * large.dispatchWorkgroupsY >= large.workgroupCount
  );
});

function texture() {
  const image = ShadeImage.fromArrayBuffer(new Uint8Array(4), 4, "uint8", 1, 1, 1);
  return ShadeTexture.from(image);
}
