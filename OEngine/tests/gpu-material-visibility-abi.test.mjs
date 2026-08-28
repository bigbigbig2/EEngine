import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_OFFSETS,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  GPU_MATERIAL_VISIBILITY_RECORD_WGSL,
  materialVisibilitySource,
  packGpuMaterialVisibilityRecord
} = await import("../.test-dist/gpu/GpuMaterialVisibilityAbi.js");
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);
const { ShadeDrawSide, ShadeTransparencyMode } = await import(
  "../.test-dist/material/enums.js"
);
const { ShadeImage, ShadeTexture } = await import(
  "../.test-dist/texture/ShadeTexture.js"
);
const { parseGltfMaterial } = await import(
  "../.test-dist/loaders/gltf/gltfMaterials.js"
);

test("R4-A-03 MaterialVisibilityRecord freezes a 64-byte TS/WGSL layout", () => {
  assert.equal(GPU_MATERIAL_VISIBILITY_RECORD_STRIDE, 64);
  assert.deepEqual(GPU_MATERIAL_VISIBILITY_OFFSETS, {
    material_id: 0,
    alpha_mode: 4,
    flags: 8,
    texture_ref: 12,
    base_color_factor_alpha: 16,
    alpha_cutoff: 20,
    uv_set: 24,
    sampler_class: 28,
    uv_offset_scale: 32,
    uv_rotation: 48
  });
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /texture_ref: u32/);
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /uv_offset_scale: vec4f/);

  const material = new StandardShadeMaterial();
  material.transparency_mode = ShadeTransparencyMode.AlphaTested;
  material.draw_side = ShadeDrawSide.Double;
  material.diffuse_color.a = 0.75;
  material.alpha_cutoff = 0.375;
  material.base_color_uv_set = 1;
  material.base_color_uv_offset = [0.25, -0.5];
  material.base_color_uv_scale = [2, 3];
  material.base_color_uv_rotation = Math.PI / 2;
  material.texture_albedo = validTexture();

  const source = materialVisibilitySource(material, 7);
  const packed = packGpuMaterialVisibilityRecord(source.packed);
  const view = new DataView(packed);
  assert.equal(packed.byteLength, 64);
  assert.equal(view.getUint32(4, true), GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask);
  assert.equal(
    view.getUint32(8, true) & GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided,
    GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided
  );
  assert.equal(
    view.getUint32(8, true) & GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture,
    GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture
  );
  assert.equal(view.getUint32(12, true), 7);
  assert.equal(view.getFloat32(16, true), 0.75);
  assert.equal(view.getFloat32(20, true), 0.375);
  assert.equal(view.getUint32(24, true), 1);
  assert.equal(view.getFloat32(32, true), 0.25);
  assert.equal(view.getFloat32(36, true), -0.5);
  assert.equal(view.getFloat32(40, true), 2);
  assert.equal(view.getFloat32(44, true), 3);
  assert.ok(Math.abs(view.getFloat32(48, true)) < 1e-6);
  assert.ok(Math.abs(view.getFloat32(52, true) - 1) < 1e-6);
});

test("R4-A-03 invalid texture and sampler fallbacks remain independent", () => {
  const invalidTextureMaterial = new StandardShadeMaterial();
  invalidTextureMaterial.transparency_mode = ShadeTransparencyMode.AlphaTested;
  invalidTextureMaterial.diffuse_color.a = 0.4;
  invalidTextureMaterial.texture_albedo = new ShadeTexture();

  const invalidTextureSource = materialVisibilitySource(
    invalidTextureMaterial,
    GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
  );
  assert.equal(invalidTextureSource.texture, null);
  assert.equal(invalidTextureSource.textureFallback, true);
  assert.equal(invalidTextureSource.samplerFallback, false);
  assert.equal(
    invalidTextureSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture,
    0
  );
  assert.notEqual(
    invalidTextureSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.TextureFallback,
    0
  );

  const samplerFallbackMaterial = new StandardShadeMaterial();
  samplerFallbackMaterial.transparency_mode = ShadeTransparencyMode.AlphaTested;
  samplerFallbackMaterial.texture_albedo = validTexture();
  samplerFallbackMaterial.texture_albedo.wrapS = 99;
  const samplerFallbackSource = materialVisibilitySource(samplerFallbackMaterial, 3);
  assert.equal(samplerFallbackSource.texture, samplerFallbackMaterial.texture_albedo);
  assert.equal(samplerFallbackSource.textureFallback, false);
  assert.equal(samplerFallbackSource.samplerFallback, true);
  assert.notEqual(
    samplerFallbackSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture,
    0
  );
  assert.equal(
    samplerFallbackSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.TextureFallback,
    0
  );
  assert.notEqual(
    samplerFallbackSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.SamplerFallback,
    0
  );

  samplerFallbackMaterial.transparency_mode = ShadeTransparencyMode.Transparent;
  assert.equal(
    materialVisibilitySource(samplerFallbackMaterial).packed.alphaMode,
    GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend
  );
});

test("R4-A-03 glTF MASK parsing preserves cutoff, texCoord and KHR_texture_transform", () => {
  const texture = validTexture();
  const material = parseGltfMaterial({
    alphaMode: "MASK",
    alphaCutoff: 0.33,
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 0.8],
      baseColorTexture: {
        index: 0,
        texCoord: 0,
        extensions: {
          KHR_texture_transform: {
            offset: [0.1, 0.2],
            scale: [0.5, 0.75],
            rotation: 0.25,
            texCoord: 1
          }
        }
      }
    }
  }, [texture]);

  assert.equal(material.transparency_mode, ShadeTransparencyMode.AlphaTested);
  assert.equal(material.draw_side, ShadeDrawSide.Double);
  assert.equal(material.alpha_cutoff, 0.33);
  assert.equal(material.base_color_uv_set, 1);
  assert.deepEqual(material.base_color_uv_offset, [0.1, 0.2]);
  assert.deepEqual(material.base_color_uv_scale, [0.5, 0.75]);
  assert.equal(material.base_color_uv_rotation, 0.25);
});

function validTexture() {
  const image = ShadeImage.fromArrayBuffer(
    new Uint8Array([255, 255, 255, 255]),
    4,
    "uint8",
    1,
    1,
    1
  );
  image.color_space = 0;
  image.normalized = true;
  return ShadeTexture.from(image);
}
