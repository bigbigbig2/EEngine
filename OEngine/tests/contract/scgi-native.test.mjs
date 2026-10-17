import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { planFinalPixelLightingDirectory } from "../../.test-dist/gpu/FinalPixelAbi.js";
import { planNativeExecutionBins } from "../../.test-dist/render/surface/NativeExecutionBins.js";
import { scgiFieldCopies } from "../../.test-dist/render/gi/ScgiLightingWindow.js";
import { surfaceCacheGiSettings } from "../../.test-dist/render/gi/SurfaceCacheGiSettings.js";
const limits = {
  minStorageBufferOffsetAlignment: 256,
  maxBufferSize: 256 * 1024 ** 2,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  maxComputeWorkgroupsPerDimension: 65535,
  maxComputeWorkgroupSizeX: 256,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupStorageSize: 32768,
  maxStorageBuffersPerShaderStage: 16,
  maxTextureDimension2D: 16384
};

test("GI directory admits full, 4K stripe and near-full producer remapping without dropping domains", () => {
  const full = planFinalPixelLightingDirectory(limits, 1, 1, 0, [1920, 1080]);
  assert.equal(full.windowRows, 1080);
  assert.equal(full.giBytes, 960 * 540 * 112);
  const stripe = planFinalPixelLightingDirectory(limits, 1, 1, 0, [3840, 2160]);
  assert.ok(stripe.windowRows < 2160 && stripe.windowRows % 8 === 0);
  assert.ok(stripe.bytes <= limits.maxStorageBufferBindingSize);
  const descriptors = Math.floor((128 * 1024 ** 2 - 256 * 1024) / 16);
  const remap = planFinalPixelLightingDirectory(limits, 1, descriptors, 0, [3840, 2160]);
  assert.equal(remap.remapped, true);
  assert.equal(remap.descriptorCount, descriptors);
  assert.ok(remap.nativeBytes <= limits.maxStorageBufferBindingSize);
  assert.throws(() => planFinalPixelLightingDirectory(limits, 1, 1, 0, [0xffffffff, 2]), /u32/);
});

test("window partition allocates one classification with complete stripe/bin ranges", () => {
  const plan = planNativeExecutionBins(limits, {
    width: 65,
    height: 49,
    window: [32, 16],
    bins: [
      { programIndex: 0, bindingSet: 0 },
      { programIndex: 1, bindingSet: 0 }
    ]
  });
  assert.equal(plan.windows, 12);
  assert.equal(plan.bankCapacity, 8);
  assert.equal(plan.queueBytes, 12 * 2 * (32 + 8 * 12));
  assert.equal(plan.dispatches, 2);
});

test("segmented window copy preserves every 112-byte record across odd row boundaries", () => {
  const buffers = [{ size: 112 * 5 }, { size: 112 * 7 }];
  const publication = {
    status: "encoded",
    fieldComplete: true,
    generation: 3,
    halfExtent: [4, 3],
    radianceDomain: "linear-rec709-unexposed",
    coefficientScale: 1,
    candidateWorldField: {
      segments: buffers.map((buffer, i) => ({
        buffer,
        plan: {
          ranges: {
            worldField: { offset: 0, count: i === 0 ? 5 : 7, stride: 112, bytes: buffer.size }
          }
        }
      }))
    }
  };
  const copies = scgiFieldCopies(publication, 3, 7, 256);
  assert.deepEqual(
    copies.map((copy) => [copy.sourceOffset, copy.destinationOffset, copy.bytes]),
    [
      [336, 256, 224],
      [0, 480, 560]
    ]
  );
  assert.throws(() => scgiFieldCopies(publication, 11, 2, 0), /interval/);
});

test("GI settings reject invalid capacities without guessing physical VRAM", () => {
  assert.equal(surfaceCacheGiSettings({ enabled: true }).enabled, true);
  assert.throws(() => surfaceCacheGiSettings({ updates: 20, patches: 10 }), /quality/);
  assert.throws(() => surfaceCacheGiSettings({ voxelSize: Infinity }), /quality/);
});
