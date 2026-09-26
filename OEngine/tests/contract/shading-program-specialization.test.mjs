import assert from "node:assert/strict";
import test from "node:test";
import {
  GPU_SHADING_MATERIAL_ABI_VERSION,
  GPU_SHADING_MATERIAL_RECORD_STRIDE,
  GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord,
  packGpuShadingTextureRoute,
  unpackGpuShadingMaterialHeader,
  unpackGpuShadingTextureRoute
} from "../../.test-dist/gpu/GpuShadingMaterialAbi.js";
import {
  GPU_MATERIAL_VISIBILITY_ABI_VERSION
} from "../../.test-dist/gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_SHADING_PROGRAM
} from "../../.test-dist/gpu/GpuShadingProgramAbi.js";
import {
  evaluateEnvironmentBrdfReference
} from "../../.test-dist/shaders/environment_brdf.js";

test("shared environment BRDF oracle preserves split-sum multiple scattering and energy clamp", () => {
  const result = evaluateEnvironmentBrdfReference([0.62, 0.21], [0.04, 0.5, 0.9], 1);
  const ratio = (1 - 0.83) / 0.83;
  const expected = [0.04, 0.5, 0.9].map((f0) => {
    const single = f0 * 0.62 + 0.21;
    return single + single * f0 * ratio;
  });
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(result.directionalAlbedo[index] - expected[index]) < 1e-12);
    assert.equal(
      result.diffuseEnergy[index],
      Math.min(1, Math.max(0, 1 - expected[index]))
    );
  }
  assert.throws(
    () => evaluateEnvironmentBrdfReference([Number.NaN, 0], [0.04, 0.04, 0.04], 1),
    /must be finite/
  );
});

test("material and texture-route publication ABI validates generations and exact strides", () => {
  assert.equal(GPU_MATERIAL_VISIBILITY_ABI_VERSION, 8);
  assert.equal(GPU_SHADING_MATERIAL_ABI_VERSION, 4);
  const header = {
    programId: GPU_SHADING_PROGRAM.PbrGeneric,
    textureBindingSetId: 2,
    materialGeneration: 11,
    textureGeneration: 12,
    publicationRevision: 13,
    flags: 0
  };
  const bytes = packGpuShadingMaterialRecord(header, materialPayload());
  assert.equal(bytes.byteLength, GPU_SHADING_MATERIAL_RECORD_STRIDE);
  assert.equal(bytes.byteLength, 304);
  assert.equal(new DataView(bytes.buffer).getUint32(32, true), 0);
  assert.deepEqual(unpackGpuShadingMaterialHeader(bytes), header);
  assert.throws(
    () => packGpuShadingMaterialRecord(header, { ...materialPayload(), reserved0: 1 }),
    /reserved0 must be zero/u
  );
  const route = { textureRef: 0x20000001, textureGeneration: 12, publicationRevision: 13, textureBindingSetId: 2 };
  const routeBytes = packGpuShadingTextureRoute(route);
  assert.equal(routeBytes.byteLength, GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  assert.deepEqual(unpackGpuShadingTextureRoute(routeBytes), route);
  assert.throws(() => packGpuShadingTextureRoute({ ...route, textureGeneration: 0 }), /non-zero/u);
});

function materialPayload() {
  return {
    reserved0: 0, alphaMode: 0, flags: 1, textureRef: 0xffffffff,
    baseColorFactorAlpha: 1, alphaCutoff: 0.5, textureUvSets: 0, samplerClass: 0,
    uvOffset: [0, 0], uvScale: [1, 1], rotationCos: 1, rotationSin: 0,
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, perceptualRoughness: 1,
    normalScale: 1, occlusionStrength: 1, emissiveFactor: [0, 0, 0, 1],
    normalTextureRef: 0xffffffff, ormTextureRef: 0xffffffff, emissiveTextureRef: 0xffffffff,
    textureSamplerClasses: 0,
    normalUvOffset: [0, 0], normalUvScale: [1, 1], normalRotationCos: 1, normalRotationSin: 0,
    ormUvOffset: [0, 0], ormUvScale: [1, 1], ormRotationCos: 1, ormRotationSin: 0,
    emissiveUvOffset: [0, 0], emissiveUvScale: [1, 1], emissiveRotationCos: 1, emissiveRotationSin: 0,
    textureBindingSetId: 2,
    occlusionTextureRef: 0xffffffff, occlusionUvSet: 1,
    occlusionUvOffset: [0, 0], occlusionUvScale: [1, 1],
    occlusionRotationCos: 1, occlusionRotationSin: 0
  };
}
