import assert from "node:assert/strict";
import test from "node:test";
import { parseGltfMaterial } from "../../.test-dist/loaders/gltf/gltfMaterials.js";
import { compileCanonicalMaterial, MATERIAL_CLOSURE_FAMILY } from
  "../../.test-dist/material/CanonicalMaterial.js";
import { packGpuClosureMaterial, GPU_CLOSURE_MATERIAL_STRIDE } from
  "../../.test-dist/gpu/GpuClosureMaterialAbi.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../.test-dist/texture/ShadeImage.js";
import { Sampler2D } from "../../.test-dist/texture/Sampler2D.js";

function texture() {
  return ShadeTexture.from(ShadeImage.fromSampler2D(
    new Sampler2D(new Uint8Array([127, 127, 255, 255]), 4, 1, 1)
  ));
}

test("glTF specular, IOR and clearcoat retain factors, channels and independent UVs", () => {
  const textures = Array.from({ length: 5 }, texture);
  const source = {
    name: "coated-glTF",
    pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.5, 1],
      metallicFactor: 0.2, roughnessFactor: 0.6 },
    extensions: {
      KHR_materials_ior: { ior: 1.7 },
      KHR_materials_specular: { specularFactor: 0.8,
        specularColorFactor: [0.5, 0.6, 0.7],
        specularTexture: { index: 0, texCoord: 1 },
        specularColorTexture: { index: 1, texCoord: 0 } },
      KHR_materials_clearcoat: { clearcoatFactor: 0.9,
        clearcoatRoughnessFactor: 0.4,
        clearcoatTexture: { index: 2 },
        clearcoatRoughnessTexture: { index: 3, texCoord: 1 },
        clearcoatNormalTexture: { index: 4, texCoord: 2, scale: 0.7 } }
    }
  };
  const material = parseGltfMaterial(source, textures);
  const canonical = compileCanonicalMaterial(material);
  assert.equal(canonical.family, MATERIAL_CLOSURE_FAMILY.Coated);
  assert.equal(canonical.ior, 1.7);
  assert.equal(canonical.specularFactor, 0.8);
  assert.deepEqual(canonical.specularColor, [0.5, 0.6, 0.7]);
  assert.equal(canonical.coatFactor, 0.9);
  assert.equal(canonical.coatRoughness, 0.4);
  assert.equal(canonical.coatNormalScale, 0.7);
  assert.equal(canonical.samples.find(sample => sample.role === "specular").uvSet, 1);
  assert.equal(canonical.samples.find(sample => sample.role === "coatRoughness").uvSet, 1);
  assert.equal(canonical.samples.find(sample => sample.role === "coatNormal").uvSet, 2);
  assert.equal(canonical.samples.find(sample => sample.role === "specularColor").colorDecode,
    "srgb-rgb");
  assert.equal(canonical.samples.find(sample => sample.role === "coatNormal").colorDecode,
    "linear-rgb");

  const refs = new Map(textures.map((value, index) => [value, index + 10]));
  const bytes = packGpuClosureMaterial(material, canonical, refs);
  assert.equal(bytes.byteLength, GPU_CLOSURE_MATERIAL_STRIDE);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(32, true), 10);
  assert.equal(view.getUint32(32 + 48 * 4, true), 14);
  assert.equal(view.getUint32(32 + 48 * 4 + 4, true), 2);
  assert.ok(Math.abs(view.getFloat32(16 + 12, true) - 0.7) < 1e-6);
});

test("zero coat is Standard and nonzero transmission requires its own provider", () => {
  const material = parseGltfMaterial({ extensions: {
    KHR_materials_clearcoat: { clearcoatFactor: 0,
      clearcoatTexture: { index: 0 } }
  } }, [texture()]);
  const canonical = compileCanonicalMaterial(material);
  assert.equal(canonical.family, MATERIAL_CLOSURE_FAMILY.Standard);
  assert.ok(!canonical.samples.some(sample => sample.role.startsWith("coat")));
  material.transmission_factor = 0.5;
  assert.throws(() => compileCanonicalMaterial(material), /transmission provider/);
  assert.throws(() => parseGltfMaterial({ extensions: {
    KHR_materials_transmission: { transmissionFactor: 0.5 }
  } }, []), /transmission provider/);
});
