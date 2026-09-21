import assert from "node:assert/strict";
import test from "node:test";

import {
  GPU_SHADING_BIN_VISIBILITY_CLEAR,
  GPU_SHADING_BIN_VISIBILITY_FORMAT,
  GPU_SHADING_BIN_VISIBILITY_SAMPLE_COUNT,
  GPU_SHADING_BIN_VISIBILITY_TARGETS,
  GPU_SHADING_BIN_VISIBILITY_USAGE,
  gpuShadingBinVisibilityAttachmentContract,
  gpuShadingBinVisibilityNativeDescriptor,
  gpuShadingBinVisibilityRenderPassAttachments,
  gpuVisibilityKeyRenderPassAttachments,
  resolveGpuShadingBinRasterOwnership
} from "../.test-dist/gpu/GpuShadingBinVisibilityContract.js";
import { GPU_VISIBILITY_KEY_EMPTY } from "../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import {
  MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL,
  MESHLET_BUCKET_VISIBILITY_WGSL,
  MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL,
  MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL
} from "../.test-dist/shaders/meshlet_bucket_visibility.js";

test("ShadingBinId attachment and dual-MRT render pass freeze the physical contract", () => {
  const contract = gpuShadingBinVisibilityAttachmentContract(1920, 1080);
  assert.equal(contract.format, GPU_SHADING_BIN_VISIBILITY_FORMAT);
  assert.equal(contract.format, "r8uint");
  assert.equal(contract.sampleCount, GPU_SHADING_BIN_VISIBILITY_SAMPLE_COUNT);
  assert.equal(contract.sampleCount, 1);
  assert.deepEqual(contract.usage, GPU_SHADING_BIN_VISIBILITY_USAGE);
  assert.deepEqual(contract.usage, ["render-attachment", "texture-binding"]);
  assert.equal(contract.clearValue.r, GPU_SHADING_BIN_VISIBILITY_CLEAR);
  assert.equal(contract.clearValue.r, 0xff);
  assert.deepEqual(GPU_SHADING_BIN_VISIBILITY_TARGETS, [
    { location: 0, semantic: "visibility-key", format: "r32uint" },
    { location: 1, semantic: "shading-bin-id", format: "r8uint" }
  ]);

  const descriptor = gpuShadingBinVisibilityNativeDescriptor(contract, {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04
  });
  assert.deepEqual(descriptor.size, { width: 1920, height: 1080, depthOrArrayLayers: 1 });
  assert.equal(descriptor.usage, 0x14);
  assert.equal(descriptor.mipLevelCount, 1);

  const keyView = { label: "key" };
  const binView = { label: "bin" };
  const attachments = gpuShadingBinVisibilityRenderPassAttachments(keyView, binView);
  assert.equal(attachments.length, 2);
  assert.strictEqual(attachments[0].view, keyView);
  assert.strictEqual(attachments[1].view, binView);
  assert.equal(attachments[0].clearValue.r, GPU_VISIBILITY_KEY_EMPTY);
  assert.equal(attachments[1].clearValue.r, 0xff);
  assert.ok(attachments.every(({ loadOp, storeOp }) => loadOp === "clear" && storeOp === "store"));
});

test("CPU raster ownership keeps key and bin in the same winning depth sample domain", () => {
  const result = resolveGpuShadingBinRasterOwnership(3, 2, [
    { x: 0, y: 0, reverseDepth: 0.4, visibilityKey: 10, shadingBinId: 3, discarded: false },
    { x: 0, y: 0, reverseDepth: 0.2, visibilityKey: 11, shadingBinId: 4, discarded: false },
    { x: 1, y: 0, reverseDepth: 0.9, visibilityKey: 12, shadingBinId: 5, discarded: true },
    { x: 0, y: 0, reverseDepth: 0.8, visibilityKey: 13, shadingBinId: 63, discarded: false },
    { x: 2, y: 1, reverseDepth: 0, visibilityKey: 14, shadingBinId: 6, discarded: false }
  ]);
  assert.deepEqual([...result.visibilityKeys], [
    13, GPU_VISIBILITY_KEY_EMPTY, GPU_VISIBILITY_KEY_EMPTY,
    GPU_VISIBILITY_KEY_EMPTY, GPU_VISIBILITY_KEY_EMPTY, GPU_VISIBILITY_KEY_EMPTY
  ]);
  assert.deepEqual([...result.shadingBinIds], [63, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.ok(result.shadingBinIds.every((bin, pixel) =>
    (bin === 0xff) === (result.visibilityKeys[pixel] === GPU_VISIBILITY_KEY_EMPTY)
  ));
});

test("direct single-bin visibility uses one r32uint MRT and omits bin identity", () => {
  const keyView = { label: "key" };
  const attachments = gpuVisibilityKeyRenderPassAttachments(keyView);
  assert.equal(attachments.length, 1);
  assert.strictEqual(attachments[0].view, keyView);
  assert.equal(attachments[0].clearValue.r, GPU_VISIBILITY_KEY_EMPTY);
  for (const source of [MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL,
    MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL]) {
    assert.doesNotMatch(source, /@location\(9\).*shading_bin_id/su);
    assert.doesNotMatch(source, /@location\(1\)\s+shading_bin_id/u);
    assert.match(source, /@location\(0\) visibility_key:\s*u32/u);
  }
});

test("raster ownership rejects invalid fragments before either target can change", () => {
  const cases = [
    { x: -1, y: 0, reverseDepth: 0.5, visibilityKey: 1, shadingBinId: 0, discarded: false },
    { x: 0, y: 2, reverseDepth: 0.5, visibilityKey: 1, shadingBinId: 0, discarded: false },
    { x: 0, y: 0, reverseDepth: Number.NaN, visibilityKey: 1, shadingBinId: 0, discarded: false },
    { x: 0, y: 0, reverseDepth: 0.5, visibilityKey: 1, shadingBinId: 64, discarded: false },
    { x: 0, y: 0, reverseDepth: 0.5, visibilityKey: -1, shadingBinId: 0, discarded: false }
  ];
  for (const fragment of cases) {
    assert.throws(() => resolveGpuShadingBinRasterOwnership(2, 2, [fragment]), RangeError);
  }
});

test("production Visibility shaders use one flat six-bit varying and one dual-output return", () => {
  for (const source of [
    MESHLET_BUCKET_VISIBILITY_WGSL,
    MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL
  ]) {
    assert.match(source, /@location\(9\)\s+@interpolate\(flat\)\s+shading_bin_id:\s*u32/u);
    assert.match(source, /oengine_instance_shading_bin_id\(work\.packed_raster_flags\)/u);
    assert.match(source, /@location\(0\)\s+visibility_key:\s*u32/u);
    assert.match(source, /@location\(1\)\s+shading_bin_id:\s*u32/u);
    assert.equal((source.match(/OEngineMeshletVisibilityOutput\(key, shading_bin_id\)/gu) ?? []).length, 2);
    assert.match(source, /if alpha < record\.alpha_cutoff \{ discard; \}\s+let key/su);
  }
});
