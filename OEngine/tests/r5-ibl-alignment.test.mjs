import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  estimateConstantDiffuseIrradiance,
  hammersley2d,
  iblMaterialTerms,
  iblRoughnessToLod,
  octDecode,
  octEncode,
  perceptualRoughnessToLinear
} from "../.test-dist/render/IblAlignment.js";
import { estimateSunDirection } from "../.test-dist/loaders/load_environment_avif.js";
import { GPU_COUNTER_FIELDS, GPU_COUNTER_SCHEMA_VERSION } from "../.test-dist/debug/GpuFrameCounters.js";
import { ENVIRONMENT_PREFILTER_WGSL } from "../.test-dist/shaders/environment_prefilter.js";
import { IBL_DIFFUSE_WGSL } from "../.test-dist/shaders/environment_ibl.js";
import { IBL_SPECULAR_WGSL } from "../.test-dist/shaders/ibl_specular.js";
import { OPAQUE_LIGHTING_RESOLVE_WGSL } from "../.test-dist/shaders/opaque_lighting_resolve.js";
import { RenderDebugView } from "../.test-dist/debug/RenderDebugView.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { GPU_SURFACE_ABI_WGSL } from "../.test-dist/gpu/GpuSurfaceAbi.js";

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1 };
const { id: TextureDescriptor } = await import("../.test-dist/gpu/GPUTextureDescriptors.js");

test("FX-03 perceptual roughness maps dynamically across any mip chain", () => {
  assert.equal(iblRoughnessToLod(0, 1), 0);
  assert.equal(iblRoughnessToLod(0.5, 9), 4);
  assert.equal(iblRoughnessToLod(1, 7), 6);
  assert.equal(perceptualRoughnessToLinear(0.5), 0.25);
  assert.equal(perceptualRoughnessToLinear(0), 0.0004);
});

test("FX-03 metallic endpoints freeze dielectric and conductor energy inputs", () => {
  assert.deepEqual(iblMaterialTerms([0.8, 0.4, 0.2], 0), {
    diffuseColor: [0.8, 0.4, 0.2],
    specularF0: [0.04, 0.04, 0.04]
  });
  assert.deepEqual(iblMaterialTerms([0.8, 0.4, 0.2], 1), {
    diffuseColor: [0, 0, 0],
    specularF0: [0.8, 0.4, 0.2]
  });
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /mix\(vec3f\(MIN_DIELECTRICS_F0\), albedo, metalness\)/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /diffuse = albedo \* \(1\.0 - metalness\)/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /textureSampleLevel\([\s\S]*vec2f\(no_v, roughness\)/);
});

test("FX-03 octahedral orientation round-trips canonical and oblique directions", () => {
  for (const direction of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0.3, -0.4, 0.5]]) {
    const length = Math.hypot(...direction);
    const expected = direction.map((value) => value / length);
    const actual = octDecode(octEncode(direction));
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-6);
  }
});

test("FX-03 Hammersley and constant-environment diffuse oracle are bounded", () => {
  assert.deepEqual(hammersley2d(0, 8), [0, 0]);
  for (let index = 0; index < 8; index++) {
    const sample = hammersley2d(index, 8);
    assert.ok(sample[0] >= 0 && sample[0] < 1 && sample[1] >= 0 && sample[1] < 1);
  }
  const irradiance = estimateConstantDiffuseIrradiance([0.25, 0.5, 2]);
  assert.deepEqual(irradiance, [Math.PI * 0.25, Math.PI * 0.5, Math.PI * 2]);
});

test("FX-03 sun estimator reads every texel and returns the bright octahedral direction", () => {
  const data = new Float32Array(4 * 4 * 3);
  data[(1 * 4 + 3) * 3] = 20;
  data[(1 * 4 + 3) * 3 + 1] = 20;
  data[(1 * 4 + 3) * 3 + 2] = 20;
  const actual = estimateSunDirection({ width: 4, height: 4, itemSize: 3, data });
  assert.ok(Number.isFinite(actual[0]) && Number.isFinite(actual[1]) && Number.isFinite(actual[2]));
  assert.ok(Math.abs(Math.hypot(...actual) - 1) < 1e-6);
});

test("FX-03 production WGSL owns independent diffuse/GGX convolution and dynamic mip count", () => {
  assert.match(ENVIRONMENT_PREFILTER_WGSL, /importance_sample_ggx/);
  assert.match(ENVIRONMENT_PREFILTER_WGSL, /cosine_sample_hemisphere/);
  assert.match(ENVIRONMENT_PREFILTER_WGSL, /convolve_diffuse/);
  assert.match(IBL_SPECULAR_WGSL, /textureNumLevels\(sec_radix_passes\)/);
  assert.match(IBL_DIFFUSE_WGSL, /textureNumLevels\(source\)/);
  assert.doesNotMatch(`${IBL_SPECULAR_WGSL}\n${IBL_DIFFUSE_WGSL}`, /f32\(5\s*-\s*1\)/);
});

test("FX-03 sampled-mip evidence remains present in the additive counter ABI", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 12);
  const names = new Set(GPU_COUNTER_FIELDS.map((field) => field.name));
  assert.ok(names.has("iblSampledPixels"));
  for (let mip = 0; mip <= 8; mip++) assert.ok(names.has(`iblMip${mip}`));
});

test("FX-03 environment loading has no implicit browser download side effect", async () => {
  const source = await readFile(new URL("../src/loaders/load_environment_map.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /downloadBinary|anchor\.click|createObjectURL/);
});

test("FX-03 texture owner evidence sums every mip in bytes", () => {
  const descriptor = new TextureDescriptor();
  descriptor.size = [64, 64, 1];
  descriptor.format = "rgba16float";
  descriptor.mipLevelCount = 7;
  assert.equal(descriptor.memory_footprint, 43_688);
  descriptor.size = [4, 4, 8];
  descriptor.mipLevelCount = 3;
  assert.equal(descriptor.memory_footprint, (4 * 4 + 2 * 2 + 1) * 8 * 8);
});

test("FX-03 debug views own distinct FrameGraph topology keys", () => {
  const base = {
    shadows: false, ssr: false, ssao: false, temporal: false, bloom: false,
    automaticExposure: false, motionBlur: false, sharpening: false,
    fusedIndirect: false, upscaleType: 0, indirectLightingMode: 0
  };
  const codes = [RenderDebugView.None, RenderDebugView.IndirectDiffuse,
    RenderDebugView.IndirectSpecular, RenderDebugView.LinearHdr]
    .map((debugView) => resolveMainFrameFeatureTopology({ ...base, debugView }).enabledFeatureBits);
  assert.equal(new Set(codes).size, codes.length);
});

test("FX-03 Packed indirect composite suppresses IBL for Unlit Surface metadata", async () => {
  const [pass, renderer] = await Promise.all([
    readFile(new URL("../src/render/passes/OpaqueLightingResolvePass.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render/Renderer.ts", import.meta.url), "utf8")
  ]);
  assert.ok(OPAQUE_LIGHTING_RESOLVE_WGSL.includes(GPU_SURFACE_ABI_WGSL));
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /OENGINE_SURFACE_FLAG_UNLIT/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /return vec4f\(0\.0\)/);
  assert.match(OPAQUE_LIGHTING_RESOLVE_WGSL, /fn fs_main_legacy/);
  assert.match(pass, /metadata\?: ResourceId/);
  assert.match(renderer, /metadata: packedResolveOut\?\.surfaceFlags/);
});
