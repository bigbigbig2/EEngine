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
import { createSourceGeometry } from "../.test-dist/assets/SourceGeometry.js";
import { buildBoxSourceGeometry } from "../.test-dist/geometry/BoxGeometry.js";

const GEOMETRY_DIRECTORY = 0x1000;
const OPTIONAL_DEBUG_NAMES = 0x9000;
const SOURCE_GEOMETRY_FIXTURE = 0x7f000001;
const GEOMETRY_SUPPORT = {
  supportedSectionTypes: new Set([GEOMETRY_DIRECTORY])
};
const SOURCE_FIXTURE_SUPPORT = {
  supportedSectionTypes: new Set([SOURCE_GEOMETRY_FIXTURE])
};
const SOURCE_GOLDEN_HASHES = {
  tiny: {
    contentHash: "24c786dc851c88404d0be879144c1f720e452ead276777d40c00b01c0e065ba3",
    fileHash: "dfcb9fc1967e80f04db98af023ff5578f621acd1c72a2e3c39c36b33890b77a9"
  },
  cube: {
    contentHash: "8bdbea6e5d6ea8e6108653aec744d6d5a9750d2c6209e08df50de040cae4b6f9",
    fileHash: "bdeb6c033e155df4886b2ab0cc47423aec98be7fb5b56cd7751a975f2ea3cd8c"
  },
  multiMaterial: {
    contentHash: "8f49763aa8fbeeec072e476e8ecb6bb132ccdc5addfb2177533405e249812ae0",
    fileHash: "f8b9c97466c99fba884297e20509b23a5fdc512c8d7128e725542c2bdf2700d5"
  },
  alphaTested: {
    contentHash: "04e92b481bd3d9b36aa9818843ff4f31fafa51d690ec521526f2bc12dcccc360",
    fileHash: "85db0b427674663904faa17a4edde68060399cd3a800044c9609e13f091d1ed6"
  },
  degenerate: {
    contentHash: "b80714901e31ed28e05b0b3661377b7be2082495e557c4596b96e81994110f03",
    fileHash: "6d728102f686a3bafc0e816bfb34c0abc5b4cab8afb89442bac3721fa51e4741"
  }
};

test("Package Kernel reopens deterministic SourceGeometry golden fixtures", async () => {
  const fixtures = sourceGoldenFixtures();
  const actualGoldens = {};
  for (const [name, source] of Object.entries(fixtures)) {
    const payload = encodeSourceFixture(source);
    const first = await writeRuntimeAssetPackage({
      sections: [{
        type: SOURCE_GEOMETRY_FIXTURE,
        required: true,
        data: payload,
        elementStride: 1,
        elementCount: payload.byteLength,
        alignment: 16
      }]
    });
    const second = await writeRuntimeAssetPackage({
      sections: [{
        type: SOURCE_GEOMETRY_FIXTURE,
        required: true,
        data: payload,
        elementStride: 1,
        elementCount: payload.byteLength,
        alignment: 16
      }]
    });
    assert.deepEqual(new Uint8Array(first), new Uint8Array(second), name);
    const reopened = await openRuntimeAssetPackage(first, SOURCE_FIXTURE_SUPPORT);
    assert.deepEqual(
      [...reopened.section(SOURCE_GEOMETRY_FIXTURE).bytes],
      [...payload],
      name
    );
    actualGoldens[name] = {
      contentHash: reopened.manifest.contentHash,
      fileHash: createHash("sha256").update(new Uint8Array(first)).digest("hex")
    };
  }
  assert.deepEqual(actualGoldens, SOURCE_GOLDEN_HASHES);
});

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

  const pkg = await openRuntimeAssetPackage(first, GEOMETRY_SUPPORT);
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
    () => openRuntimeAssetPackage(required, GEOMETRY_SUPPORT),
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
  const pkg = await openRuntimeAssetPackage(optional, GEOMETRY_SUPPORT);
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
  const opened = await openRuntimeAssetPackage(valid, GEOMETRY_SUPPORT);

  const truncated = valid.slice(0, valid.byteLength - 1);
  assert.equal((await validateRuntimeAssetPackage(truncated, GEOMETRY_SUPPORT)).valid, false);
  await assert.rejects(
    () => openRuntimeAssetPackage(truncated, GEOMETRY_SUPPORT),
    (error) => hasIssue(error, "total-length-mismatch")
  );

  const corruptPayload = valid.slice(0);
  new Uint8Array(corruptPayload)[opened.section(GEOMETRY_DIRECTORY).byteOffset] ^= 0xff;
  await assert.rejects(
    () => openRuntimeAssetPackage(corruptPayload, GEOMETRY_SUPPORT),
    (error) => hasIssue(error, "section-checksum-mismatch")
  );

  const badOffset = valid.slice(0);
  const directory = new DataView(badOffset);
  directory.setBigUint64(96 + 8, 97n, true);
  await assert.rejects(
    () => openRuntimeAssetPackage(badOffset, GEOMETRY_SUPPORT),
    (error) => hasIssue(error, "section-offset-noncanonical")
  );

  const unsafeRange = valid.slice(0);
  new DataView(unsafeRange).setBigUint64(96 + 8, 0xffffffffffffffffn, true);
  const unsafeReport = await validateRuntimeAssetPackage(unsafeRange, GEOMETRY_SUPPORT);
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
    ["nonzero-header-reserved", (view, bytes) => { bytes[80] = 1; }],
    ["nonzero-directory-reserved", (view) => view.setUint32(96 + 44, 1, true)],
    ["invalid-section-alignment", (view) => view.setUint32(96 + 32, 3, true)],
    ["section-checksum-mismatch", (view) => view.setUint32(96 + 40, 0, true)],
    ["content-hash-mismatch", (view, bytes) => { bytes[48] ^= 0xff; }]
  ];

  for (const [expectedCode, mutate] of cases) {
    const corrupted = valid.slice(0);
    mutate(new DataView(corrupted), new Uint8Array(corrupted));
    const report = await validateRuntimeAssetPackage(corrupted, GEOMETRY_SUPPORT);
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

function sourceGoldenFixtures() {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    1, 1, 0
  ]);
  const source = (sourceId, indices, materialRanges) => createSourceGeometry({
    sourceId,
    indices: new Uint32Array(indices),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: positions
    }],
    materialRanges
  });
  return {
    tiny: source("golden:tiny", [0, 1, 2]),
    cube: buildBoxSourceGeometry(2, 2, 2),
    multiMaterial: source("golden:multi", [0, 1, 2, 2, 1, 3], [
      {
        firstTriangle: 0,
        triangleCount: 1,
        materialId: 10,
        alphaMode: "opaque",
        doubleSided: false
      },
      {
        firstTriangle: 1,
        triangleCount: 1,
        materialId: 11,
        alphaMode: "opaque",
        doubleSided: true
      }
    ]),
    alphaTested: source("golden:alpha", [0, 1, 2], [{
      firstTriangle: 0,
      triangleCount: 1,
      materialId: 12,
      alphaMode: "mask",
      doubleSided: true
    }]),
    degenerate: source("golden:degenerate", [0, 0, 0])
  };
}

function encodeSourceFixture(source) {
  return new TextEncoder().encode(JSON.stringify({
    topology: source.topology,
    sourceId: source.sourceId,
    indices: [...source.indices],
    attributes: [...source.attributes.values()].map((attribute) => ({
      semantic: attribute.semantic,
      componentCount: attribute.componentCount,
      normalized: attribute.normalized,
      dataType: attribute.dataType,
      data: [...attribute.data]
    })),
    materialRanges: source.materialRanges,
    bounds: {
      box: [...source.bounds.box],
      sphere: [...source.bounds.sphere]
    }
  }));
}
