import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  RUNTIME_ASSET_FORMAT_VERSION,
  RUNTIME_ASSET_PACKAGE_SCHEMA_HASH,
  RuntimeAssetPackageError,
  openRuntimeAssetPackage,
  validateRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../.test-dist/assets/RuntimeAssetPackage.js";

const GEOMETRY_DIRECTORY = 0x1000;
const OPTIONAL_DEBUG_NAMES = 0x9000;

test("Package Kernel writes deterministic, aligned and independently hashable bytes", async () => {
  const input = {
    sections: [
      {
        type: OPTIONAL_DEBUG_NAMES,
        required: false,
        data: new TextEncoder().encode("cube\0"),
        elementStride: 1,
        elementCount: 5,
        alignment: 4
      },
      {
        type: GEOMETRY_DIRECTORY,
        required: true,
        data: new Uint32Array([1, 2, 3, 4]),
        elementStride: 4,
        elementCount: 4,
        alignment: 16
      }
    ]
  };

  const first = await writeRuntimeAssetPackage(input);
  const second = await writeRuntimeAssetPackage(input);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));

  const pkg = await openRuntimeAssetPackage(first, {
    supportedSectionTypes: new Set([GEOMETRY_DIRECTORY])
  });
  assert.equal(pkg.manifest.formatVersion, RUNTIME_ASSET_FORMAT_VERSION);
  assert.equal(pkg.manifest.schemaHash, RUNTIME_ASSET_PACKAGE_SCHEMA_HASH);
  assert.equal(pkg.manifest.totalByteLength, first.byteLength);
  assert.equal(first.byteLength, 213);
  assert.equal(
    pkg.manifest.contentHash,
    "ae04173236f7bc77b076f907020f144b0ae6ea595abe189ebcd8131a7e7b52e6"
  );
  assert.deepEqual([...pkg.section(GEOMETRY_DIRECTORY).bytes], [
    1, 0, 0, 0,
    2, 0, 0, 0,
    3, 0, 0, 0,
    4, 0, 0, 0
  ]);
  assert.equal(pkg.section(GEOMETRY_DIRECTORY).byteOffset % 16, 0);
  assert.equal(pkg.section(OPTIONAL_DEBUG_NAMES).required, false);
  assert.deepEqual(
    pkg.validate().issues.map((issue) => [issue.severity, issue.code]),
    [["warning", "unknown-optional-section"]]
  );

  // Independent whole-file digest freezes the byte-level golden package.
  assert.equal(
    createHash("sha256").update(new Uint8Array(first)).digest("hex"),
    "401d5082cf908324688b6f4929da1aba8bb48b768856523678bb4ce998aeb78b"
  );
});

test("Package Kernel rejects unknown required sections but preserves unknown optional sections", async () => {
  const required = await writeRuntimeAssetPackage({
    sections: [{
      type: 0x2000,
      required: true,
      data: new Uint32Array([7]),
      elementStride: 4,
      elementCount: 1,
      alignment: 4
    }]
  });
  await assert.rejects(
    () => openRuntimeAssetPackage(required, {
      supportedSectionTypes: new Set([GEOMETRY_DIRECTORY])
    }),
    (error) => hasIssue(error, "unknown-required-section")
  );

  const optional = await writeRuntimeAssetPackage({
    sections: [{
      type: 0x2000,
      required: false,
      data: new Uint8Array([1, 2, 3, 4]),
      elementStride: 1,
      elementCount: 4,
      alignment: 4
    }]
  });
  const pkg = await openRuntimeAssetPackage(optional, {
    supportedSectionTypes: new Set([GEOMETRY_DIRECTORY])
  });
  assert.equal(pkg.section(0x2000).bytes.byteLength, 4);
  assert.equal(pkg.validate().valid, true);
  assert.equal(pkg.validate().issues[0].code, "unknown-optional-section");
});

test("Package Kernel reports truncation, payload corruption and non-canonical section ranges", async () => {
  const valid = await writeRuntimeAssetPackage({
    sections: [{
      type: GEOMETRY_DIRECTORY,
      required: true,
      data: new Uint32Array([1, 2, 3, 4]),
      elementStride: 4,
      elementCount: 4,
      alignment: 16
    }]
  });
  const opened = await openRuntimeAssetPackage(valid, {
    supportedSectionTypes: new Set([GEOMETRY_DIRECTORY])
  });

  const truncated = valid.slice(0, valid.byteLength - 1);
  assert.equal((await validateRuntimeAssetPackage(truncated)).valid, false);
  await assert.rejects(
    () => openRuntimeAssetPackage(truncated),
    (error) => hasIssue(error, "total-length-mismatch")
  );

  const corruptPayload = valid.slice(0);
  new Uint8Array(corruptPayload)[opened.section(GEOMETRY_DIRECTORY).byteOffset] ^= 0xff;
  await assert.rejects(
    () => openRuntimeAssetPackage(corruptPayload),
    (error) => hasIssue(error, "section-checksum-mismatch")
  );

  const badOffset = valid.slice(0);
  const directory = new DataView(badOffset);
  directory.setBigUint64(96 + 8, 97n, true);
  await assert.rejects(
    () => openRuntimeAssetPackage(badOffset),
    (error) => hasIssue(error, "section-offset-noncanonical")
  );

  const unsafeRange = valid.slice(0);
  new DataView(unsafeRange).setBigUint64(96 + 8, 0xffffffffffffffffn, true);
  const unsafeReport = await validateRuntimeAssetPackage(unsafeRange);
  assert.equal(unsafeReport.valid, false);
  assert.ok(unsafeReport.issues.some((issue) => issue.code === "section-range-overflow"));
});

test("Package writer rejects duplicate types and inconsistent element ranges before producing bytes", async () => {
  await assert.rejects(
    () => writeRuntimeAssetPackage({
      sections: [0, 1].map(() => ({
        type: GEOMETRY_DIRECTORY,
        data: new Uint32Array([1]),
        elementStride: 4,
        elementCount: 1
      }))
    }),
    /Duplicate section type/
  );
  await assert.rejects(
    () => writeRuntimeAssetPackage({
      sections: [{
        type: GEOMETRY_DIRECTORY,
        data: new Uint32Array([1]),
        elementStride: 8,
        elementCount: 1
      }]
    }),
    /byte length.*elementStride.*elementCount/
  );
});

test("Package validator distinguishes header, directory, checksum and content identity failures", async () => {
  const valid = await writeRuntimeAssetPackage({
    sections: [{
      type: GEOMETRY_DIRECTORY,
      data: new Uint32Array([11]),
      elementStride: 4,
      elementCount: 1,
      alignment: 16
    }]
  });
  const cases = [
    ["invalid-magic", (view, bytes) => { bytes[0] ^= 0xff; }],
    ["unsupported-format-version", (view) => view.setUint32(8, 2, true)],
    ["schema-hash-mismatch", (view) => view.setUint32(12, 0, true)],
    ["endianness-mismatch", (view) => view.setUint32(16, 0, true)],
    ["nonzero-directory-reserved", (view) => view.setUint32(96 + 44, 1, true)],
    ["invalid-section-alignment", (view) => view.setUint32(96 + 32, 3, true)],
    ["section-checksum-mismatch", (view) => view.setUint32(96 + 40, 0, true)],
    ["content-hash-mismatch", (view, bytes) => { bytes[48] ^= 0xff; }]
  ];

  for (const [expectedCode, mutate] of cases) {
    const corrupted = valid.slice(0);
    mutate(new DataView(corrupted), new Uint8Array(corrupted));
    const report = await validateRuntimeAssetPackage(corrupted);
    assert.equal(report.valid, false, expectedCode);
    assert.ok(
      report.issues.some((issue) => issue.code === expectedCode),
      `${expectedCode}: ${report.issues.map((issue) => issue.code).join(", ")}`
    );
  }
});

function hasIssue(error, code) {
  return error instanceof RuntimeAssetPackageError &&
    error.report.issues.some((issue) => issue.code === code);
}
