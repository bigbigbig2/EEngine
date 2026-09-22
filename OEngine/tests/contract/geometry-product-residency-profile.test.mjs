import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const {
  selectGeometryProductResidencyProfileV1
} = await import("../../.test-dist/gpu/GeometryProductResidencyProfile.js");
const { VirtualGeometryResidency } = await import("../../.test-dist/gpu/VirtualGeometryResidency.js");

function limits(maxBufferSize, maxStorageBufferBindingSize = maxBufferSize) {
  return { maxBufferSize, maxStorageBufferBindingSize, maxStorageBuffersPerShaderStage: 16 };
}

function fixture() {
  const page = new Uint8Array(262144);
  const hash = createHash("sha256").update(page).digest();
  const assetRecords = new Uint8Array(128);
  const assetView = new DataView(assetRecords.buffer);
  assetRecords.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) assetView.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) assetView.setFloat32(at, value, true);
  const hierarchyNodes = new Uint8Array(48);
  new DataView(hierarchyNodes.buffer).setUint32(44, 1, true);
  const groupDirectory = new Uint8Array(16);
  const groupView = new DataView(groupDirectory.buffer);
  groupView.setUint32(0, 0, true);
  groupView.setUint32(8, 64, true);
  groupView.setUint32(12, 1, true);
  const pageRecords = new Uint8Array(32);
  pageRecords.set(hash.subarray(0, 16));
  new DataView(pageRecords.buffer).setUint32(20, 1, true);
  const vertexFormats = new Uint8Array(16);
  const formatView = new DataView(vertexFormats.buffer);
  formatView.setUint16(0, 16, true);
  formatView.setUint16(2, 3, true);
  formatView.setUint8(5, 6);
  const descriptor = {
    schemaVersion: 1,
    productId: new Uint8Array(32).fill(2),
    revision: 0,
    producerKind: "offline-native",
    producerId: "phase-h-profile",
    producerVersion: "1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(3),
    recipeHash: new Uint8Array(32).fill(4),
    runtimeProfile: "oengine-vg-v1-v3-decoded",
    decodedPageBytes: 262144,
    assetRecords,
    rootNodeIds: new Uint32Array([0]),
    hierarchyNodes,
    groupDirectory,
    pageRecords,
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats,
    activationPageIds: new Uint32Array([0])
  };
  return {
    descriptor,
    source: {
      descriptor,
      async readPage(pageId) {
        return {
          productId: descriptor.productId.slice(),
          revision: 0,
          pageId,
          decodedHash128: descriptor.pageRecords.slice(0, 16),
          decodedPageHash128: hash.subarray(0, 16),
          bytes: page.slice().buffer
        };
      },
      release() {}
    }
  };
}

function fakeDevice(limitBytes) {
  let creates = 0;
  return {
    get creates() { return creates; },
    limits: limits(limitBytes),
    createBuffer(descriptor) {
      creates++;
      return { ...descriptor, destroy() {} };
    },
    queue: { writeBuffer() {} }
  };
}

test("Phase H chooses the three physical profiles from negotiated limits", () => {
  const portable = selectGeometryProductResidencyProfileV1(limits(128 * 1024 * 1024), { requestedProfile: "auto" });
  assert.equal(portable.profile, "Portable");
  assert.equal(portable.capacityBytes, 512 * 1024 * 1024);

  const balanced = selectGeometryProductResidencyProfileV1(limits(192 * 1024 * 1024), { requestedProfile: "Balanced" });
  assert.equal(balanced.profile, "Balanced");
  assert.equal(balanced.capacityBytes, 768 * 1024 * 1024);

  const highEnd = selectGeometryProductResidencyProfileV1(limits(256 * 1024 * 1024), { requestedProfile: "HighEnd" });
  assert.equal(highEnd.profile, "HighEnd");
  assert.equal(highEnd.capacityBytes, 1024 * 1024 * 1024);
});

test("Phase H falls back without recook and does not guess physical VRAM", () => {
  const plan = selectGeometryProductResidencyProfileV1(limits(192 * 1024 * 1024), {
    requestedProfile: "HighEnd",
    configuredCapacityBytes: 768 * 1024 * 1024
  });
  assert.equal(plan.profile, "Balanced");
  assert.equal(plan.fallbackFrom, "HighEnd");
  assert.equal(plan.reason, "selected");
  const pressured = selectGeometryProductResidencyProfileV1(limits(256 * 1024 * 1024), {
    requestedProfile: "auto",
    runtimeEvidence: { residentBytes: 600 * 1024 * 1024, retiringBytes: 64 * 1024 * 1024 }
  });
  assert.equal(pressured.profile, "HighEnd");
});

test("Phase H feature-off and low-limit paths allocate no profile banks", async () => {
  const { source } = fixture();
  const low = fakeDevice(64 * 1024 * 1024);
  await assert.rejects(
    VirtualGeometryResidency.create(low, source, 1, 0, undefined, { requestedProfile: "Portable" }),
    /unsupported-limits|unavailable/
  );
  assert.equal(low.creates, 0);

  const off = fakeDevice(256 * 1024 * 1024);
  await assert.rejects(
    VirtualGeometryResidency.create(off, source, 2, 0, undefined, { featureEnabled: false }),
    /feature-off/
  );
  assert.equal(off.creates, 0);
});

test("Phase H creates the same Product ABI with an adapter-sized Balanced heap", async () => {
  const { source } = fixture();
  const device = fakeDevice(192 * 1024 * 1024);
  const residency = await VirtualGeometryResidency.create(device, source, 3, 0, undefined, {
    requestedProfile: "Balanced"
  });
  assert.equal(residency.residencyProfile.profile, "Balanced");
  assert.equal(residency.residencyProfile.bankBytes, 192 * 1024 * 1024);
  assert.equal(residency.evidence().sharedBankCapacityBytes, 768 * 1024 * 1024);
  assert.equal(residency.bindings().banks.length, 4);
  residency.destroy();
});
