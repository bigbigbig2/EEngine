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

test("R4-B-01 MaterialRecord freezes a 128-byte TS/WGSL Standard PBR layout", () => {
  assert.equal(GPU_MATERIAL_VISIBILITY_RECORD_STRIDE, 128);
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
    uv_rotation: 48,
    base_color_factor: 64,
    pbr_factors: 80,
    emissive_factor: 96,
    texture_refs: 112
  });
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /texture_ref: u32/);
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /uv_offset_scale: vec4f/);
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /base_color_factor: vec4f/);
  assert.match(GPU_MATERIAL_VISIBILITY_RECORD_WGSL, /texture_sampler_classes: u32/);

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
  material.texture_normal = validTexture();
  material.texture_orm = validTexture();
  material.texture_emissive = validTexture();
  material.diffuse_color.setRGB(0.2, 0.3, 0.4);
  material.diffuse_color.a = 0.75;
  material.metallic_factor = 0.8;
  material.roughness_factor = 0.25;
  material.ambient_factors.a = 0.6;
  material.emissive_factor.setRGB(2, 1, 0.5);

  const source = materialVisibilitySource(material, {
    baseColor: 7,
    normal: 8,
    orm: 9,
    emissive: 10
  }, 42);
  const packed = packGpuMaterialVisibilityRecord(source.packed);
  const view = new DataView(packed);
  assert.equal(packed.byteLength, 128);
  assert.equal(view.getUint32(0, true), 42);
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
  assert.ok(Math.abs(view.getFloat32(64, true) - 0.2) < 1e-6);
  assert.ok(Math.abs(view.getFloat32(68, true) - 0.3) < 1e-6);
  assert.ok(Math.abs(view.getFloat32(72, true) - 0.4) < 1e-6);
  assert.equal(view.getFloat32(76, true), 0.75);
  assert.ok(Math.abs(view.getFloat32(80, true) - 0.8) < 1e-6);
  assert.equal(view.getFloat32(84, true), 0.25);
  assert.ok(Math.abs(view.getFloat32(92, true) - 0.6) < 1e-6);
  assert.equal(view.getFloat32(96, true), 2);
  assert.equal(view.getFloat32(100, true), 1);
  assert.equal(view.getFloat32(104, true), 0.5);
  assert.equal(view.getUint32(112, true), 8);
  assert.equal(view.getUint32(116, true), 9);
  assert.equal(view.getUint32(120, true), 10);
});

test("R4-A-03 invalid texture and sampler fallbacks remain independent", () => {
  const invalidTextureMaterial = new StandardShadeMaterial();
  invalidTextureMaterial.transparency_mode = ShadeTransparencyMode.AlphaTested;
  invalidTextureMaterial.diffuse_color.a = 0.4;
  invalidTextureMaterial.texture_albedo = new ShadeTexture();

  const invalidTextureSource = materialVisibilitySource(
    invalidTextureMaterial,
    GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
    0
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
  const samplerFallbackSource = materialVisibilitySource(samplerFallbackMaterial, 3, 1);
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
    materialVisibilitySource(
      samplerFallbackMaterial,
      GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
      1
    ).packed.alphaMode,
    GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend
  );
});

test("R4-B MaterialRecord rejects UV sets outside the Geometry UV0/UV1 ABI", () => {
  const material = new StandardShadeMaterial();
  material.base_color_uv_set = 2;
  assert.throws(
    () => materialVisibilitySource(material, GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE, 0),
    /supports only TEXCOORD_0 and TEXCOORD_1/
  );
});

test("R4-B glTF shared UV contract accepts matching mappings on every texture", () => {
  const texture = validTexture();
  const mapping = {
    texCoord: 0,
    extensions: {
      KHR_texture_transform: {
        offset: [0.25, 0.5],
        scale: [2, 3],
        rotation: 0.125,
        texCoord: 1
      }
    }
  };
  const material = parseGltfMaterial({
    normalTexture: { index: 0, ...mapping },
    emissiveTexture: { index: 0, ...mapping },
    occlusionTexture: { index: 0, ...mapping },
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0, ...mapping },
      metallicRoughnessTexture: { index: 0, ...mapping }
    }
  }, [texture]);
  assert.equal(material.base_color_uv_set, 1);
  assert.deepEqual(material.base_color_uv_offset, [0.25, 0.5]);
  assert.deepEqual(material.base_color_uv_scale, [2, 3]);
  assert.equal(material.base_color_uv_rotation, 0.125);
});

test("R4-B glTF shared UV contract rejects per-texture texCoord or transform divergence", () => {
  const texture = validTexture();
  assert.throws(
    () => parseGltfMaterial({
      normalTexture: { index: 0, texCoord: 1 },
      pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 0 } }
    }, [texture]),
    /requires per-texture UV mappings/
  );
  assert.throws(
    () => parseGltfMaterial({
      emissiveTexture: {
        index: 0,
        extensions: { KHR_texture_transform: { offset: [0.5, 0] } }
      },
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } }
    }, [texture]),
    /requires per-texture UV mappings/
  );
});

test("R4-B glTF KHR_texture_transform texCoord override is authoritative", () => {
  const material = parseGltfMaterial({
    normalTexture: {
      index: 0,
      texCoord: 0,
      extensions: { KHR_texture_transform: { texCoord: 1 } }
    }
  }, [validTexture()]);
  assert.equal(material.base_color_uv_set, 1);
});

test("R4-B glTF rejects a separate occlusion texture before GPU residency", () => {
  const textures = [validTexture(), validTexture()];
  assert.throws(
    () => parseGltfMaterial({
      name: "separate-occlusion",
      occlusionTexture: { index: 1 },
      pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } }
    }, textures),
    /separate-occlusion.*occlusionTexture.*same texture index.*metallicRoughnessTexture/
  );
  assert.throws(
    () => parseGltfMaterial({
      name: "occlusion-only",
      occlusionTexture: { index: 0 }
    }, textures),
    /occlusion-only.*occlusionTexture.*requires metallicRoughnessTexture/
  );
});

test("R4-B glTF normalTexture.scale and unlit state reach MaterialRecord", () => {
  const texture = validTexture();
  const normal = parseGltfMaterial({
    normalTexture: { index: 0, scale: 0.375 }
  }, [texture]);
  const normalSource = materialVisibilitySource(normal, { normal: 7 }, 3);
  assert.equal(normal.normal_scale, 0.375);
  assert.equal(normalSource.packed.normalScale, 0.375);

  const unlit = parseGltfMaterial({
    pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    extensions: { KHR_materials_unlit: {} }
  }, [texture]);
  const unlitSource = materialVisibilitySource(unlit, { baseColor: 5 }, 4);
  assert.equal(unlit.is_unlit, true);
  assert.notEqual(unlitSource.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.Unlit, 0);

  unlit.texture_normal = validTexture();
  unlit.texture_orm = validTexture();
  unlit.texture_emissive = validTexture();
  const runtimeUnlitSource = materialVisibilitySource(unlit, { baseColor: 5 }, 4);
  assert.equal(runtimeUnlitSource.textureFallback, false);
  assert.equal(runtimeUnlitSource.samplerFallback, false);
  assert.equal(runtimeUnlitSource.textures.length, 1);
  assert.equal(
    runtimeUnlitSource.packed.flags & (
      GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture |
      GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture |
      GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture
    ),
    0
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
