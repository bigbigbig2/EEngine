import assert from "node:assert/strict";
import test from "node:test";

import "./webgpu-test-globals.mjs";

import { parseGltfMaterial } from "../.test-dist/loaders/gltf/gltfMaterials.js";
import {
  GPU_MATERIAL_VISIBILITY_FLAGS,
  materialVisibilitySource
} from "../.test-dist/gpu/GpuMaterialVisibilityAbi.js";
import { PACKED_TRANSPARENT_FORWARD_WGSL } from "../.test-dist/shaders/packed_transparent_oit.js";

const textures = Object.freeze([
  { image: { width: 4, height: 4, depth: 1 }, wrapS: 1, wrapT: 1, magFilter: 1, minFilter: 1 },
  { image: { width: 4, height: 4, depth: 1 }, wrapS: 1, wrapT: 1, magFilter: 1, minFilter: 1 }
]);

test("glTF AO-only material retains its independent texture, UV set, transform and strength", () => {
  const material = parseGltfMaterial({
    name: "ao-only",
    occlusionTexture: {
      index: 1,
      texCoord: 1,
      strength: 0.35,
      extensions: {
        KHR_texture_transform: { offset: [0.25, 0.5], scale: [2, 3], rotation: 0.4 }
      }
    }
  }, textures);

  assert.equal(material.texture_orm, undefined);
  assert.equal(material.texture_occlusion, textures[1]);
  assert.equal(material.occlusion_uv_set, 1);
  assert.deepEqual(material.occlusion_uv_offset, [0.25, 0.5]);
  assert.deepEqual(material.occlusion_uv_scale, [2, 3]);
  assert.equal(material.occlusion_uv_rotation, 0.4);
  assert.equal(material.ambient_factors.a, 0.35);
  const source = materialVisibilitySource(material, { occlusion: 17 }, 0, 2);
  assert.ok((source.packed.flags & GPU_MATERIAL_VISIBILITY_FLAGS.HasOcclusionTexture) !== 0);
  assert.equal(source.packed.occlusionTextureRef, 17);
  assert.equal(source.packed.occlusionUvSet, 1);
  assert.deepEqual(source.packed.occlusionUvOffset, [0.25, 0.5]);
});

test("glTF separate MR and AO textures preserve independent textureInfo contracts", () => {
  const material = parseGltfMaterial({
    name: "separate-mr-ao",
    pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0, texCoord: 0 } },
    occlusionTexture: { index: 1, texCoord: 1 }
  }, textures);

  assert.equal(material.texture_orm, textures[0]);
  assert.equal(material.orm_uv_set, 0);
  assert.equal(material.texture_occlusion, textures[1]);
  assert.equal(material.occlusion_uv_set, 1);
});

test("glTF shared ORM sample stays on the compact path only when texture and UV mapping match", () => {
  const shared = parseGltfMaterial({
    name: "shared-orm",
    pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0, texCoord: 1 } },
    occlusionTexture: { index: 0, texCoord: 1 }
  }, textures);
  assert.equal(shared.texture_orm, textures[0]);
  assert.equal(shared.texture_occlusion, undefined);

  const differentUv = parseGltfMaterial({
    name: "shared-image-different-uv",
    pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0, texCoord: 0 } },
    occlusionTexture: { index: 0, texCoord: 1 }
  }, textures);
  assert.equal(differentUv.texture_orm, textures[0]);
  assert.equal(differentUv.texture_occlusion, textures[0]);
  assert.equal(differentUv.orm_uv_set, 0);
  assert.equal(differentUv.occlusion_uv_set, 1);
});

test("packed transparency consumes independent AO UV and applies AO only to indirect light", () => {
  assert.match(PACKED_TRANSPARENT_FORWARD_WGSL, /material_uv\(input, material, 4u\)/u);
  assert.match(PACKED_TRANSPARENT_FORWARD_WGSL, /material\.occlusion_texture_ref/u);
  assert.match(PACKED_TRANSPARENT_FORWARD_WGSL, /radiance \* \(f0 \* dfg\.x \+ dfg\.y\) \* material_ao/u);
  assert.match(PACKED_TRANSPARENT_FORWARD_WGSL, /irradiance[\s\S]*\* material_ao/u);
  assert.doesNotMatch(
    PACKED_TRANSPARENT_FORWARD_WGSL,
    /shade_standard_material_direct\([\s\S]{0,160}material_ao/u
  );
});
