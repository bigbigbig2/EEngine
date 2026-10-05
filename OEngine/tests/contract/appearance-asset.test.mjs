import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { cookAppearanceMipProduct } from "../../.test-dist/material/AppearanceMipCooker.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import {
  writeAppearanceAssetPackage,
  openAppearanceAssetPackage,
} from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { writeRuntimeAssetPackageV2 } from "../../.test-dist/assets/RuntimeAssetManifestV2.js";
import { stageAppearanceAssetUpload } from "../../.test-dist/gpu/AppearanceAssetUpload.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";

globalThis.GPUBufferUsage = { COPY_SRC: 4 };
globalThis.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };
const source = {
  uri: "test/appearance-graph",
  contentHash: "a".repeat(64),
  dependencies: [{ assetId: "b".repeat(64), required: true }],
};
function product(precision = "float16") {
  const g = new AppearanceGraphBuilder(),
    uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const sample = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
  for (const [name, channels] of [
    ["r", [0]],
    ["rg", [0, 1]],
    ["rgb", [0, 1, 2]],
    ["rgba", [0, 1, 2, 3]],
  ])
    g.output(name, g.swizzle(sample, channels));
  g.output("constant", g.constant([16, -0, 0.25]));
  const p = compileAppearanceGraph(g.build());
  return cookAppearanceMipProduct(p, p.outputs, {
    width: 5,
    height: 3,
    mipCount: 3,
    byteBudget: 4096,
    validationProbeBudget: 4096,
    domainMin: [2, 4],
    domainMax: [6, 8],
    error: { absolute: 1e-6, relative: 0 },
    storagePrecision: precision,
    sample: (_binding, _uv, footprint) => [0.125 + footprint.chartLod * 0.125, 0.375, 0.75, 1],
  });
}
async function asset() {
  return openAppearanceAssetPackage(await writeAppearanceAssetPackage(product(), source));
}

test("portable half-field asset round-trips NPOT mips, narrow formats, HDR/signed-zero constants and provenance", async () => {
  const p = product(),
    bytes = await writeAppearanceAssetPackage(p, source);
  const a = await openAppearanceAssetPackage(bytes);
  assert.deepEqual(
    a.fields.map((field) => field.format),
    [null, "r16float", "rg16float", "rgba16float", "rgba16float"],
  );
  assert.deepEqual(a.domainMin, [2, 4]);
  assert.deepEqual(a.domainMax, [6, 8]);
  assert.equal(a.coordinateDomain, "uv0");
  assert.equal(a.residentBytes, 396);
  assert.ok(Object.is(a.fields[0].constant[1], -0));
  assert.equal(a.fields[0].constant[0], 16);
  assert.deepEqual(a.runtime.manifest.dependencies, source.dependencies);
  for (const field of a.fields.slice(1)) {
    assert.deepEqual(
      field.mips.map((mip) => [mip.width, mip.height]),
      [
        [5, 3],
        [2, 1],
        [1, 1],
      ],
    );
    const view = new DataView(
      field.mips[1].payload.buffer,
      field.mips[1].payload.byteOffset,
      field.mips[1].payload.byteLength,
    );
    assert.equal(decodeFloat16(view.getUint16(0, true)), 0.25);
  }
  assert.deepEqual(new Uint8Array(await writeAppearanceAssetPackage(p, source)), new Uint8Array(bytes));
  assert.deepEqual(
    new Uint8Array(
      await writeAppearanceAssetPackage(p, { ...source, contentHash: source.contentHash.toUpperCase() }),
    ),
    new Uint8Array(bytes),
  );
});

test("asset packing rejects pre-quantization products and forged unquantized texels", async () => {
  await assert.rejects(writeAppearanceAssetPackage(product("float32"), source), /validated half-field/);
  const p = product();
  p.fields.r.mips[0].data[0] = 0.2001;
  await assert.rejects(writeAppearanceAssetPackage(p, source), /unvalidated texels/);
});

test("tampered payload checksum and authentic but inconsistent typed metadata are rejected", async () => {
  const a = await asset();
  const bytes = await writeAppearanceAssetPackage(product(), source),
    corrupted = bytes.slice(0);
  const offset = a.runtime.manifest.chunks.find((chunk) => chunk.id !== "appearance-metadata").byteOffset;
  new Uint8Array(corrupted)[offset] ^= 1;
  await assert.rejects(openAppearanceAssetPackage(corrupted), /checksum|hash/i);
  const metadata = JSON.parse(new TextDecoder().decode(a.runtime.chunks.get("appearance-metadata")));
  metadata.fields.find((field) => field.name === "r").format = "rgba16float";
  const revised = new TextEncoder().encode(JSON.stringify(metadata));
  const chunks = a.runtime.manifest.chunks.map((chunk) => ({
    ...chunk,
    data: chunk.id === "appearance-metadata" ? revised : a.runtime.chunks.get(chunk.id),
    decodedBytes: chunk.id === "appearance-metadata" ? revised.byteLength : chunk.decodedBytes,
  }));
  const { chunks: _chunks, schemaVersion: _schemaVersion, ...manifest } = a.runtime.manifest;
  const authentic = await writeRuntimeAssetPackageV2({ manifest, chunks });
  await assert.rejects(openAppearanceAssetPackage(authentic), /format\/mip count/);
});

function uploadFixture(a) {
  const device = { limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxBufferSize: 1e8 } };
  const copies = [],
    staging = [],
    destinations = new Map();
  for (const field of a.fields)
    if (field.format !== null)
      destinations.set(field.name, {
        layer: 2,
        texture: {
          dimension: "2d",
          format: field.format,
          usage: 6,
          depthOrArrayLayers: 4,
          width: 5,
          height: 3,
          mipLevelCount: 3,
        },
      });
  const event = () => ({
    callbacks: [],
    addOne(fn) {
      this.callbacks.push(fn);
    },
    send() {
      for (const fn of this.callbacks.splice(0)) fn();
    },
  });
  const command = {
    device,
    closed: false,
    onFinished: event(),
    onAborted: event(),
    allocateTextureUploadBuffer(data) {
      const buffer = { data, size: data.byteLength, usage: 4 };
      staging.push(buffer);
      return buffer;
    },
    copyBufferToTexture(source, destination, size) {
      copies.push({ source, destination, size });
    },
    finish() {
      this.closed = true;
      this.onFinished.send();
    },
    abort() {
      this.closed = true;
      this.onAborted.send();
    },
  };
  return { device, command, destinations, copies, staging };
}
const budget = { maxUploadBytes: 4096, maxStagingBytes: 4096, maxResidentBytes: 4096 };

test("an authentic manifest cannot alias a different Appearance assetId to the same physical contents", async () => {
  const a = await asset(),
    { chunks: _chunks, schemaVersion: _schema, ...manifest } = a.runtime.manifest;
  const chunks = a.runtime.manifest.chunks.map((chunk) => ({
    ...chunk,
    data: a.runtime.chunks.get(chunk.id),
  }));
  const bytes = await writeRuntimeAssetPackageV2({
    manifest: { ...manifest, assetId: "f".repeat(64) },
    chunks,
  });
  await assert.rejects(openAppearanceAssetPackage(bytes), /assetId.*validated content/);
});

test("transactional asset upload pads rows, copies all mips/layers and commits only at submission", async () => {
  const a = await asset(),
    f = uploadFixture(a);
  const staged = stageAppearanceAssetUpload(f.device, a, f.destinations, f.command, budget);
  assert.equal(staged.evidence.copyCount, 12);
  assert.equal(staged.evidence.privateSubmitCount, 0);
  assert.equal(staged.evidence.payloadBytes, 396);
  assert.ok(staged.evidence.stagingBytes > 396);
  assert.equal(staged.evidence.pooledBufferBytes, staged.evidence.stagingBytes);
  assert.equal(staged.residency.evidence().residentChunkCount, 0);
  for (const copy of f.copies) {
    assert.equal(copy.source.bytesPerRow % 256, 0);
    assert.equal(copy.destination.origin[2], 2);
    assert.equal(copy.source.buffer.usage, 4);
    const bytes = new Uint8Array(copy.source.buffer.data);
    if (copy.size[1] > 1) {
      assert.equal(
        new DataView(bytes.buffer).getUint16(0, true),
        new DataView(bytes.buffer).getUint16(256, true),
      );
      assert.ok(
        bytes
          .slice(
            copy.size[0] *
              2 *
              (copy.destination.texture.format === "r16float"
                ? 1
                : copy.destination.texture.format === "rg16float"
                  ? 2
                  : 4),
            256,
          )
          .every((n) => n === 0),
      );
    }
  }
  f.command.finish();
  assert.equal(staged.residency.evidence().residentChunkCount, 12);
  assert.equal(staged.residency.evidence().residentBytes, 396);
  const aborted = uploadFixture(a),
    other = stageAppearanceAssetUpload(aborted.device, a, aborted.destinations, aborted.command, budget);
  aborted.command.abort();
  assert.equal(other.residency.evidence().residentChunkCount, 0);
  assert.equal(other.residency.evidence().abortedRequestCount, 1);
});

test("upload budget/format/layer failures occur before any staging allocation or copy", async () => {
  const a = await asset();
  for (const configure of [
    (f) => {
      f.destinations.get("r").layer = 4;
    },
    (f) => {
      f.destinations.get("r").texture.format = "rgba16float";
    },
    (f) => {
      f.device.limits.maxBufferSize = 1;
    },
  ]) {
    const f = uploadFixture(a);
    configure(f);
    assert.throws(
      () => stageAppearanceAssetUpload(f.device, a, f.destinations, f.command, budget),
      /profile|limit/,
    );
    assert.equal(f.staging.length, 0);
    assert.equal(f.copies.length, 0);
  }
  const f = uploadFixture(a);
  assert.throws(
    () =>
      stageAppearanceAssetUpload(f.device, a, f.destinations, f.command, { ...budget, maxStagingBytes: 396 }),
    /padded/,
  );
  assert.equal(f.staging.length, 0);
});

test("constant-only assets retain f32 values while requiring zero texture/upload/staging budget", async () => {
  const g = new AppearanceGraphBuilder();
  g.output("hdr", g.parameter("color", [100000, -0, 0.25]));
  const p = compileAppearanceGraph(g.build());
  const cooked = cookAppearanceMipProduct(p, p.outputs, {
    width: 1,
    height: 1,
    mipCount: 1,
    byteBudget: 0,
    validationProbeBudget: 0,
    domainMin: [0, 0],
    domainMax: [1, 1],
    error: { absolute: 0, relative: 0 },
    storagePrecision: "float16",
    sample: () => {
      throw new Error("no sample allowed");
    },
  });
  const a = await openAppearanceAssetPackage(await writeAppearanceAssetPackage(cooked, source));
  assert.equal(a.fields[0].constant[0], 100000);
  assert.ok(Object.is(a.fields[0].constant[1], -0));
  const f = uploadFixture(a);
  const upload = stageAppearanceAssetUpload(f.device, a, f.destinations, f.command, {
    maxUploadBytes: 0,
    maxStagingBytes: 0,
    maxResidentBytes: 0,
  });
  f.command.finish();
  assert.equal(upload.evidence.copyCount, 0);
  assert.equal(f.staging.length, 0);
});

test("a failure after an encoded texture copy aborts the entire caller transaction", async () => {
  const a = await asset(),
    f = uploadFixture(a);
  let copies = 0;
  f.command.copyBufferToTexture = () => {
    if (++copies === 2) throw new Error("injected copy failure");
  };
  assert.throws(
    () => stageAppearanceAssetUpload(f.device, a, f.destinations, f.command, budget),
    /injected copy failure/,
  );
  assert.equal(f.command.closed, true);
  assert.equal(copies, 2);
});
