import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { cookSurfacePlane, cookSurfaceGrid } from "../fixtures/surface-phase-one.mjs";
import { decodeGroupHeaderV3, decodeMeshletHeaderV3 } from "../../.test-dist/assets/GeometryAbiV3.js";
import { decodeSurfacePrimitive, SURFACE_METADATA_GROUP_FLAG, SURFACE_PRIMITIVE_BYTES } from "../../.test-dist/gpu/SurfacePrimitiveAbi.js";
import { decodedTextureVariation } from "../../.test-dist/gpu/TextureVariation.js";
import { ShadeTexture, ShadeImage } from "../../.test-dist/texture/ShadeTexture.js";
import { surfaceProbeCellReference, EXACT_SURFACE_PROBE_BUDGET, packSurfaceProbeBudget } from "../../.test-dist/render/surface/SurfaceProbe.js";
import { packGpuShadingTextureRoute, unpackGpuShadingTextureRoute } from "../../.test-dist/gpu/GpuShadingMaterialAbi.js";

function metadata(cooked) {
  const directory = new DataView(cooked.sections.groupDirectory.buffer);
  assert.ok(directory.getUint32(12, true) & SURFACE_METADATA_GROUP_FLAG);
  const offset = directory.getUint32(4, true);
  const view = new DataView(cooked.page.buffer, offset);
  const group = decodeGroupHeaderV3(view);
  const meshlet = decodeMeshletHeaderV3(view, group.meshletHeaderOffset);
  const begin = offset + ((meshlet.triangleByteOffset + meshlet.triangleCount * 3 + 3) & ~3);
  return Array.from({ length: meshlet.triangleCount }, (_, index) => decodeSurfacePrimitive(cooked.page, begin + index * SURFACE_PRIMITIVE_BYTES));
}

test("WASM cooker publishes a common source-corner domain across a continuous internal primitive edge", async () => {
  const facts = metadata(await cookSurfacePlane());
  assert.equal(facts.length, 2); assert.ok(facts[0].domain > 0);
  assert.equal(facts[0].domain, facts[1].domain);
  assert.equal(facts[0].risk, 0); assert.equal(facts[1].risk, 0);
  assert.deepEqual(facts[0].uv0Span, [1, 1]);
});
test("WASM cooker separates UV/mirror, normal, tangent and vertex-color seams", async () => {
  for (const options of [{ seam: true }, { mirroredUv: true }, { attributeSeam: "normal" }, { attributeSeam: "tangent" }, { attributeSeam: "color" }]) {
    const facts = metadata(await cookSurfacePlane(options));
    assert.notEqual(facts[0].domain, facts[1].domain);
  }
});
test("WASM recook bounds every metadata-bearing group to a page and preserves all source primitives", async () => {
  const cooked = await cookSurfaceGrid();
  const directory = new DataView(cooked.sections.groupDirectory.buffer);
  assert.ok(directory.byteLength / 16 >= 3);
  let primitiveCount = 0, domain = 0;
  for (let groupIndex = 0; groupIndex < directory.byteLength / 16; groupIndex++) {
    const record = groupIndex * 16;
    const page = cooked.pages[directory.getUint32(record, true)];
    const offset = directory.getUint32(record + 4, true);
    assert.ok(directory.getUint32(record + 8, true) <= 262144);
    const view = new DataView(page.buffer, offset);
    const group = decodeGroupHeaderV3(view);
    assert.ok(group.meshletCount <= 128);
    for (let meshletIndex = 0; meshletIndex < group.meshletCount; meshletIndex++) {
      const meshlet = decodeMeshletHeaderV3(view, group.meshletHeaderOffset + meshletIndex * 48);
      const begin = (meshlet.triangleByteOffset + meshlet.triangleCount * 3 + 3) & ~3;
      assert.ok(begin + meshlet.triangleCount * SURFACE_PRIMITIVE_BYTES <= group.vertexDataOffset);
      for (let primitive = 0; primitive < meshlet.triangleCount; primitive++) {
        const fact = decodeSurfacePrimitive(page, offset + begin + primitive * SURFACE_PRIMITIVE_BYTES);
        assert.ok(fact.domain > 0); assert.equal(fact.risk, 0);
        if (domain) assert.equal(fact.domain, domain);
        domain = fact.domain; primitiveCount++;
      }
    }
  }
  assert.equal(primitiveCount, cooked.primitiveCount);
});

test("decoded PBR texture ranges retain nonconstant color and reject unknown compression", () => {
  const texture = ShadeTexture.from(ShadeImage.fromArrayBuffer(new Uint8Array([128, 128, 128, 255, 129, 128, 128, 255]), 4, "uint8", 2, 1));
  texture.image.color_space = 2;
  const variation = decodedTextureVariation(texture);
  assert.equal(variation.known, true);
  assert.ok(variation.low[0] <= 128 / 255); assert.ok(variation.high[0] >= 129 / 255);
  assert.equal(decodedTextureVariation(texture, { format: "bc7-rgba-unorm", payloads: [] }).known, false);
  assert.equal(decodedTextureVariation(texture, { format: "rgba8unorm", payloads: [] }).known, false);
  texture.image.color_space = 1;
  const srgb = decodedTextureVariation(texture);
  const encoded = 128 / 255;
  const resized = Math.round(Math.pow((encoded + 0.055) / 1.055, 2.4) * 255) / 255;
  assert.ok(srgb.low[0] <= resized && srgb.high[0] >= resized);
});
test("64-byte route roundtrip preserves actual residency and sampling semantics", () => {
  const route = { textureRef: 0x10000001, textureGeneration: 2, publicationRevision: 3, textureBindingSetId: 1,
    residencySlot: 8, residencyRevision: 12, variationKnown: true, samplingSignature: 17,
    variationLow: [0, 0.25, 0.5, 1], variationHigh: [0.5, 0.5, 1, 1] };
  const bytes = packGpuShadingTextureRoute(route);
  assert.equal(bytes.byteLength, 64); assert.deepEqual(unpackGpuShadingTextureRoute(bytes), route);
});
test("CPU reference covers directional rates, cross-primitive sharing and full-rate rejection", () => {
  const fact = { valid: true, instance: 1, material: 2, geometry: 3, representation: 1, domain: 4, primitive: 0,
    depth: 0.5, normal: [0, 0, 1], color: [1, 1, 1], uv: [0.5, 0.5], risk: 0,
    variation: 0, parameterVariation: 0, residencyValid: true };
  assert.equal(surfaceProbeCellReference([fact, fact, { ...fact, primitive: 1 }, fact], EXACT_SURFACE_PROBE_BUDGET), 3);
  assert.equal(surfaceProbeCellReference([fact, fact, { ...fact, domain: 5 }, { ...fact, domain: 5 }], EXACT_SURFACE_PROBE_BUDGET), 1);
  assert.equal(surfaceProbeCellReference([fact, { ...fact, domain: 5 }, fact, { ...fact, domain: 5 }], EXACT_SURFACE_PROBE_BUDGET), 2);
  assert.equal(surfaceProbeCellReference([fact, { ...fact, uv: [1, 1] }, fact, fact], EXACT_SURFACE_PROBE_BUDGET), 3);
  for (const changed of [{ normalVariation: 1 }, { colorVariation: 1 }, { risk: 1 }, { residencyValid: false }, { variation: 1 }, { depth: NaN }, { representation: 2 }]) {
    assert.equal(surfaceProbeCellReference([fact, { ...fact, ...changed }, { ...fact, ...changed }, fact], EXACT_SURFACE_PROBE_BUDGET), 0);
  }
  assert.equal(surfaceProbeCellReference([fact], EXACT_SURFACE_PROBE_BUDGET), 0);
  assert.throws(() => packSurfaceProbeBudget({ ...EXACT_SURFACE_PROBE_BUDGET, color: NaN }), /budget/);
});
