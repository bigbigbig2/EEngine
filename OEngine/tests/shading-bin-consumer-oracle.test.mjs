import assert from "node:assert/strict";
import test from "node:test";

import {
  GPU_SHADING_PROGRAM,
  deriveGpuShadingIdentity
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";
import {
  evaluateGpuShadingProgramReference,
  fresnelSchlickReference,
  gpuShadingProgramSpecialization,
  perspectiveBarycentricReference,
  reconstructAttributeReference
} from "../.test-dist/gpu/GpuShadingProgramOracle.js";
import {
  GPU_SHADING_OUTPUT_DEPENDENCY
} from "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";

const BASE_MATERIAL = Object.freeze({
  baseColorFactor: [0.8, 0.5, 0.25],
  metallicFactor: 0.4,
  roughnessFactor: 0.6,
  normalScale: 1,
  occlusionStrength: 0.75,
  emissiveFactor: [0.1, 0.2, 0.3],
  vertexColor: [0.5, 0.8, 1],
  baseSample: [0.25, 0.5, 0.75, 1],
  ormSample: [0.2, 0.7, 0.9, 1],
  normalSample: [0.5, 0.5, 1, 1],
  emissiveSample: [0.5, 0.25, 1, 1],
  shadingNormal: [0, 0, 1],
  geometricNormal: [0, 0, 1],
  tangent: [1, 0, 0, 1]
});

function input(programId, overrides = {}) {
  return {
    programId,
    outputDependencyMask: 0,
    material: BASE_MATERIAL,
    viewDirection: [0, 0, 1],
    directLights: [{ direction: [0, 0, 1], radiance: [2, 1, 0.5], visibility: 1 }],
    preExposure: 2,
    gradientValid: true,
    ...overrides
  };
}

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function closeVector(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}

test("all sixteen slots expose a compile-time specialization and exact output mask", () => {
  for (let programId = 0; programId < 16; programId++) {
    for (let outputMask = 0; outputMask < 8; outputMask++) {
      const specialization = gpuShadingProgramSpecialization(programId, outputMask);
      assert.equal(specialization.programId, programId);
      assert.equal(specialization.outputDependencyMask, outputMask);
      assert.equal(
        specialization.publishesShadingSurface,
        (outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0
      );
      assert.equal(
        specialization.publishesDiffuseSurface,
        (outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0
      );
      assert.equal(
        specialization.publishesVelocity,
        (outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0
      );
      assert.equal(specialization.lit, programId >= GPU_SHADING_PROGRAM.PbrFactor);
    }
  }
  assert.equal(gpuShadingProgramSpecialization(GPU_SHADING_PROGRAM.UnlitFactor, 0).reconstructTriangle, false);
  assert.equal(gpuShadingProgramSpecialization(
    GPU_SHADING_PROGRAM.UnlitFactor,
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity
  ).reconstructTriangle, true);
});

test("specialization dependencies cover every published material and geometry identity", () => {
  for (const shadingModel of ["unlit", "standard-pbr"]) {
    for (let textureBits = 0; textureBits < 16; textureBits++) {
      if (shadingModel === "unlit" && (textureBits & 14) !== 0) continue;
      for (const hasAuthoredVertexColor of [false, true]) {
        const identity = deriveGpuShadingIdentity({
          shadingModel,
          hasBaseTexture: (textureBits & 1) !== 0,
          hasOrmTexture: (textureBits & 2) !== 0,
          hasNormalTexture: (textureBits & 4) !== 0,
          hasEmissiveTexture: (textureBits & 8) !== 0,
          textureBindingSetId: 2
        }, {
          hasAuthoredVertexColor,
          hasUv0: true,
          hasNormal: true,
          hasTangent: true
        });
        const specialization = gpuShadingProgramSpecialization(identity.programId, 0);
        assert.equal(specialization.baseTexture !== "never", (textureBits & 1) !== 0 || identity.programId === 15);
        assert.equal(specialization.ormTexture !== "never", (textureBits & 2) !== 0 || identity.programId === 15);
        assert.equal(specialization.normalTexture !== "never", (textureBits & 4) !== 0 || identity.programId === 15);
        assert.equal(specialization.emissiveTexture !== "never", (textureBits & 8) !== 0 || identity.programId === 15);
        if (shadingModel === "unlit") {
          assert.equal(specialization.authoredVertexColor === "required", hasAuthoredVertexColor);
        } else {
          assert.equal(specialization.authoredVertexColor, "geometry-conditional");
        }
      }
    }
  }
});

test("perspective barycentric and UV gradients preserve partition and scaling", () => {
  const affine = perspectiveBarycentricReference(
    [0.25, 0.25],
    [0, 0, 0, 1],
    [1, 0, 0, 1],
    [0, 1, 0, 1]
  );
  assert.equal(affine.valid, true);
  closeVector(affine.weights, [0.5, 0.25, 0.25]);
  closeVector(affine.ddx, [-1, 1, 0]);
  closeVector(affine.ddy, [-1, 0, 1]);
  close(affine.weights.reduce((sum, value) => sum + value, 0), 1);
  close(affine.ddx.reduce((sum, value) => sum + value, 0), 0);
  close(affine.ddy.reduce((sum, value) => sum + value, 0), 0);

  const uv = reconstructAttributeReference(
    [[0, 0], [1, 0], [0, 1]],
    affine,
    [0.5, 0.25],
    [0.1, 0.2],
    [2, 3],
    [0, 1]
  );
  closeVector(uv.uv, [-0.65, 0.7]);
  closeVector(uv.ddx, [0, 4]);
  closeVector(uv.ddy, [-12, 0]);

  const degenerate = perspectiveBarycentricReference(
    [0, 0], [0, 0, 0, 1], [1, 1, 0, 1], [2, 2, 0, 1]
  );
  assert.deepEqual(degenerate, {
    weights: [1, 0, 0], ddx: [0, 0, 0], ddy: [0, 0, 0], valid: false
  });
});

test("unlit specializations ignore direct light and AO while preserving factor/color/texture", () => {
  const factor = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.UnlitFactor));
  closeVector(factor.radiance, [1.6, 1, 0.5]);
  const colored = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.UnlitFactorColor));
  closeVector(colored.radiance, [0.8, 0.8, 0.5]);
  const textured = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.UnlitTexture));
  closeVector(textured.radiance, [0.4, 0.5, 0.375]);
  const complete = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.UnlitTextureColor, {
    directLights: [{ direction: [0, 0, 1], radiance: [1e6, 1e6, 1e6], visibility: 1 }]
  }));
  closeVector(complete.radiance, [0.2, 0.4, 0.375]);
  assert.equal(complete.ambientOcclusion, 1);
  assert.equal(complete.metallic, 0.4);
});

test("PBR reference retains Filament-style Fresnel/GGX, shadow visibility and PreExposure", () => {
  closeVector(fresnelSchlickReference([0.04, 0.04, 0.04], 1, 1), [0.04, 0.04, 0.04]);
  closeVector(fresnelSchlickReference([0.04, 0.04, 0.04], 1, 0), [1, 1, 1]);
  const visible = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.PbrBaseOrmNormalEmissive));
  const hidden = evaluateGpuShadingProgramReference(input(
    GPU_SHADING_PROGRAM.PbrBaseOrmNormalEmissive,
    { directLights: [{ direction: [0, 0, 1], radiance: [2, 1, 0.5], visibility: 0 }] }
  ));
  closeVector(hidden.radiance, [0.1, 0.1, 0.6]);
  assert.ok(visible.radiance.every((value, index) => value >= hidden.radiance[index]));
  const halfExposure = evaluateGpuShadingProgramReference(input(
    GPU_SHADING_PROGRAM.PbrBaseOrmNormalEmissive,
    { preExposure: 1 }
  ));
  closeVector(visible.radiance, halfExposure.radiance.map((value) => value * 2), 1e-8);
  close(visible.ambientOcclusion, 0.4);
  close(visible.metallic, 0.36);
  close(visible.roughness, 0.42);
  closeVector(visible.shadingNormal, [0, 0, 1]);
});

test("texture gradient fallback and output products are explicit and consumer-driven", () => {
  const mask = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
    GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite |
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  const textured = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.PbrGeneric, {
    outputDependencyMask: mask,
    gradientValid: false
  }));
  assert.equal(textured.gradientFallback, true);
  assert.equal(textured.publishesShadingSurface, true);
  assert.equal(textured.publishesDiffuseSurface, true);
  assert.equal(textured.publishesVelocity, true);
  const factor = evaluateGpuShadingProgramReference(input(GPU_SHADING_PROGRAM.PbrFactor, {
    gradientValid: false
  }));
  assert.equal(factor.gradientFallback, false);
  assert.equal(factor.publishesShadingSurface, false);
  assert.equal(factor.publishesDiffuseSurface, false);
  assert.equal(factor.publishesVelocity, false);
});
