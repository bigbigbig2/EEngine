import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeGpuShadingBinId,
  deriveGpuShadingIdentity,
  encodeGpuShadingBinId,
  GPU_SHADING_BIN_PROGRAM_MASK,
  GPU_SHADING_BIN_RESERVED_MASK,
  GPU_SHADING_BIN_TEXTURE_SET_MASK,
  GPU_SHADING_BIN_TEXTURE_SET_SHIFT,
  GPU_SHADING_DEPENDENCY,
  GPU_SHADING_DEPENDENCY_LUT_VERSION,
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_ABI_VERSION,
  GPU_SHADING_PROGRAM_COUNT,
  GPU_SHADING_PROGRAM_INVALID,
  GPU_SHADING_PROGRAM_LUT,
  GPU_SHADING_PROGRAM_NAMES,
  GPU_SHADING_PROGRAM_WGSL,
  shadingProgramIdForDependencyMask,
  ShadingIdentityPublicationError
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";
import {
  createGpuShadingBinLayouts,
  GPU_SHADING_BIN_ABI_VERSION,
  GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS,
  GPU_SHADING_BIN_CONTROL_OFFSET,
  GPU_SHADING_BIN_CONTROL_OFFSETS,
  GPU_SHADING_BIN_CONTROL_STRIDE,
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_COUNTER_OFFSETS,
  GPU_SHADING_BIN_COUNTER_STRIDE,
  GPU_SHADING_BIN_COUNTERS_OFFSET,
  GPU_SHADING_BIN_HEAP_USAGE,
  GPU_SHADING_BIN_INDIRECT_BYTES,
  GPU_SHADING_BIN_INDIRECT_OFFSETS,
  GPU_SHADING_BIN_INDIRECT_STRIDE,
  GPU_SHADING_BIN_INDIRECT_USAGE,
  GPU_SHADING_BIN_INVALID_ID,
  GPU_SHADING_BIN_LAYOUT_FLAG,
  GPU_SHADING_BIN_LAYOUT_OFFSETS,
  GPU_SHADING_BIN_LAYOUT_STRIDE,
  GPU_SHADING_BIN_LAYOUTS_OFFSET,
  GPU_SHADING_BIN_MACRO_HEIGHT,
  GPU_SHADING_BIN_MACRO_WIDTH,
  GPU_SHADING_BIN_MUTABLE_BYTES,
  GPU_SHADING_BIN_MICROTILE_HEIGHT,
  GPU_SHADING_BIN_MICROTILE_WIDTH,
  GPU_SHADING_BIN_PIXELS_PER_INVOCATION,
  GPU_SHADING_BIN_QUEUE_CLASS,
  GPU_SHADING_BIN_RECORDS_OFFSET,
  GPU_SHADING_BIN_RECORD_STRIDE,
  GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
  GPU_SHADING_BIN_SETTINGS_OFFSETS,
  GPU_SHADING_BIN_SETTINGS_STRIDE,
  GPU_SHADING_BIN_WGSL,
  packGpuShadingBinControl,
  packGpuShadingBinCounter,
  packGpuShadingBinIndirectArgs,
  packGpuShadingBinLayout,
  packGpuShadingBinSettings,
  preflightGpuShadingBinSizing,
  shadingBinActiveMask,
  shadingBinCounterByteOffset,
  shadingBinDispatchDimensions,
  shadingBinHeapByteLength,
  shadingBinIndirectByteOffset,
  shadingBinLayoutByteOffset,
  shadingBinMicrotileGrid,
  shadingBinRecordByteOffset,
  unpackGpuShadingBinControl,
  unpackGpuShadingBinCounter,
  unpackGpuShadingBinIndirectArgs,
  unpackGpuShadingBinLayout,
  unpackGpuShadingBinSettings
} from "../.test-dist/gpu/GpuShadingBinAbi.js";

const generousLimits = Object.freeze({
  maxTextureDimension2D: 32768,
  maxBufferSize: 8 * 1024 * 1024 * 1024,
  maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
});

const fullGeometry = Object.freeze({
  hasAuthoredVertexColor: false,
  hasUv0: true,
  hasNormal: true,
  hasTangent: true
});

function material(shadingModel, textureBits, textureBindingSetId = 3) {
  return {
    shadingModel,
    hasBaseTexture: (textureBits & 1) !== 0,
    hasOrmTexture: (textureBits & 2) !== 0,
    hasNormalTexture: (textureBits & 4) !== 0,
    hasEmissiveTexture: (textureBits & 8) !== 0,
    textureBindingSetId
  };
}

test("ADR-0013 freezes all sixteen program ids and a shared versioned LUT", () => {
  assert.equal(GPU_SHADING_PROGRAM_ABI_VERSION, 1);
  assert.equal(GPU_SHADING_DEPENDENCY_LUT_VERSION, 1);
  assert.equal(GPU_SHADING_PROGRAM_COUNT, 16);
  assert.equal(GPU_SHADING_PROGRAM_NAMES.length, 16);
  assert.deepEqual(Object.values(GPU_SHADING_PROGRAM), Array.from({ length: 16 }, (_, i) => i));
  assert.equal(GPU_SHADING_PROGRAM_LUT.length, 64);
  assert.match(GPU_SHADING_PROGRAM_WGSL, /array<u32, 64>/u);
  assert.equal(GPU_SHADING_BIN_PROGRAM_MASK, 0xf);
  assert.equal(GPU_SHADING_BIN_TEXTURE_SET_SHIFT, 4);
  assert.equal(GPU_SHADING_BIN_TEXTURE_SET_MASK, 0x30);
  assert.equal(GPU_SHADING_BIN_RESERVED_MASK, 0xc0);
  assert.match(GPU_SHADING_PROGRAM_WGSL, /fn oengine_shading_bin_id/u);
  assert.match(GPU_SHADING_PROGRAM_WGSL, /OENGINE_SHADING_PROGRAM_PBR_GENERIC: u32 = 15u/u);
  for (const value of GPU_SHADING_PROGRAM_LUT) {
    assert.ok(value === GPU_SHADING_PROGRAM_INVALID || (value >= 0 && value < 16));
    assert.match(GPU_SHADING_PROGRAM_WGSL, new RegExp(`\\b${value}u\\b`, "u"));
  }
});

test("all sixteen programs and four texture sets round-trip through the six-bit bin", () => {
  for (let textureBindingSetId = 0; textureBindingSetId < 4; textureBindingSetId++) {
    for (let programId = 0; programId < 16; programId++) {
      const binId = encodeGpuShadingBinId(programId, textureBindingSetId);
      assert.equal(binId, textureBindingSetId * 16 + programId);
      assert.deepEqual(decodeGpuShadingBinId(binId), { programId, textureBindingSetId });
    }
  }
  assert.throws(() => decodeGpuShadingBinId(GPU_SHADING_BIN_INVALID_ID), RangeError);
  assert.throws(() => decodeGpuShadingBinId(64), RangeError);
  assert.throws(() => encodeGpuShadingBinId(16, 0), RangeError);
  assert.throws(() => encodeGpuShadingBinId(0, 4), ShadingIdentityPublicationError);
});

test("unlit identity canonicalizes textureless sets and preserves color and texture dependencies", () => {
  const noAttributes = { hasAuthoredVertexColor: false, hasUv0: false, hasNormal: false, hasTangent: false };
  assert.deepEqual(deriveGpuShadingIdentity(material("unlit", 0, 3), noAttributes), {
    dependencyMask: 0,
    programId: GPU_SHADING_PROGRAM.UnlitFactor,
    textureBindingSetId: 0,
    binId: 0
  });
  const color = deriveGpuShadingIdentity(material("unlit", 0, 2), {
    ...noAttributes,
    hasAuthoredVertexColor: true
  });
  assert.equal(color.programId, GPU_SHADING_PROGRAM.UnlitFactorColor);
  assert.equal(color.textureBindingSetId, 0);
  assert.equal(color.dependencyMask, GPU_SHADING_DEPENDENCY.AuthoredVertexColor);

  const texture = deriveGpuShadingIdentity(material("unlit", 1, 2), {
    ...noAttributes,
    hasUv0: true
  });
  assert.equal(texture.programId, GPU_SHADING_PROGRAM.UnlitTexture);
  assert.equal(texture.binId, 34);
  const textureColor = deriveGpuShadingIdentity(material("unlit", 1, 1), {
    ...noAttributes,
    hasUv0: true,
    hasAuthoredVertexColor: true
  });
  assert.equal(textureColor.programId, GPU_SHADING_PROGRAM.UnlitTextureColor);
});

test("every legal Standard PBR texture combination selects exactly one fixed or generic program", () => {
  const expected = [4, 5, 6, 7, 8, 9, 10, 11, 15, 13, 15, 15, 15, 15, 14, 12];
  for (let textureBits = 0; textureBits < 16; textureBits++) {
    const identity = deriveGpuShadingIdentity(material("standard-pbr", textureBits), fullGeometry);
    assert.equal(identity.programId, expected[textureBits], `texture bits ${textureBits}`);
    assert.equal(identity.textureBindingSetId, textureBits === 0 ? 0 : 3);
    assert.equal(shadingProgramIdForDependencyMask(identity.dependencyMask), expected[textureBits]);
    const withColor = deriveGpuShadingIdentity(material("standard-pbr", textureBits), {
      ...fullGeometry,
      hasAuthoredVertexColor: true
    });
    assert.equal(withColor.programId, expected[textureBits]);
  }
});

test("publication rejects unsupported models and missing geometry dependencies structurally", () => {
  const expectCode = (callback, code) => assert.throws(callback, (error) => {
    assert.ok(error instanceof ShadingIdentityPublicationError);
    assert.equal(error.code, code);
    return true;
  });
  expectCode(
    () => deriveGpuShadingIdentity(material("clear-coat", 0), fullGeometry),
    "UNSUPPORTED_SHADING_MODEL"
  );
  expectCode(
    () => deriveGpuShadingIdentity(material("standard-pbr", 1), { ...fullGeometry, hasUv0: false }),
    "MISSING_UV0"
  );
  expectCode(
    () => deriveGpuShadingIdentity(material("standard-pbr", 0), { ...fullGeometry, hasNormal: false }),
    "MISSING_NORMAL"
  );
  expectCode(
    () => deriveGpuShadingIdentity(material("standard-pbr", 4), { ...fullGeometry, hasTangent: false }),
    "MISSING_TANGENT"
  );
  expectCode(
    () => deriveGpuShadingIdentity(material("unlit", 2), fullGeometry),
    "UNSUPPORTED_SHADING_MODEL"
  );
  expectCode(
    () => shadingProgramIdForDependencyMask(GPU_SHADING_DEPENDENCY.BaseTexture),
    "INVALID_DEPENDENCY_MASK"
  );
  expectCode(
    () => shadingProgramIdForDependencyMask(1 << 9),
    "INVALID_DEPENDENCY_MASK"
  );
});

test("Shading Bin constants, offsets, usages and WGSL structs match ADR-0013", () => {
  assert.equal(GPU_SHADING_BIN_ABI_VERSION, 1);
  assert.equal(GPU_SHADING_BIN_COUNT, 64);
  assert.equal(GPU_SHADING_BIN_INVALID_ID, 0xff);
  assert.equal(GPU_SHADING_BIN_MACRO_WIDTH, 64);
  assert.equal(GPU_SHADING_BIN_MACRO_HEIGHT, 64);
  assert.equal(GPU_SHADING_BIN_MICROTILE_WIDTH, 8);
  assert.equal(GPU_SHADING_BIN_MICROTILE_HEIGHT, 8);
  assert.equal(GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS, 256);
  assert.equal(GPU_SHADING_BIN_PIXELS_PER_INVOCATION, 16);
  assert.equal(GPU_SHADING_BIN_SETTINGS_STRIDE, 32);
  assert.equal(GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE, 256);
  assert.equal(GPU_SHADING_BIN_CONTROL_STRIDE, 32);
  assert.equal(GPU_SHADING_BIN_COUNTER_STRIDE, 16);
  assert.equal(GPU_SHADING_BIN_LAYOUT_STRIDE, 16);
  assert.equal(GPU_SHADING_BIN_RECORD_STRIDE, 4);
  assert.equal(GPU_SHADING_BIN_INDIRECT_STRIDE, 12);
  assert.equal(GPU_SHADING_BIN_INDIRECT_BYTES, 768);
  assert.equal(GPU_SHADING_BIN_CONTROL_OFFSET, 0);
  assert.equal(GPU_SHADING_BIN_COUNTERS_OFFSET, 32);
  assert.equal(GPU_SHADING_BIN_MUTABLE_BYTES, 1056);
  assert.equal(GPU_SHADING_BIN_LAYOUTS_OFFSET, 1056);
  assert.equal(GPU_SHADING_BIN_RECORDS_OFFSET, 2304);
  assert.equal(GPU_SHADING_BIN_QUEUE_CLASS, "CorrectnessCritical");
  assert.deepEqual(GPU_SHADING_BIN_HEAP_USAGE, ["storage", "copy-dst"]);
  assert.deepEqual(GPU_SHADING_BIN_INDIRECT_USAGE, ["storage", "indirect", "copy-dst"]);
  assert.deepEqual(Object.values(GPU_SHADING_BIN_SETTINGS_OFFSETS), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.deepEqual(Object.values(GPU_SHADING_BIN_CONTROL_OFFSETS), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.deepEqual(Object.values(GPU_SHADING_BIN_COUNTER_OFFSETS), [0, 4, 8, 12]);
  assert.deepEqual(Object.values(GPU_SHADING_BIN_LAYOUT_OFFSETS), [0, 4, 8, 12]);
  assert.deepEqual(Object.values(GPU_SHADING_BIN_INDIRECT_OFFSETS), [0, 4, 8]);
  for (const declaration of [
    "OEngineShadingBinSettings",
    "OEngineShadingBinControl",
    "OEngineShadingBinCounter",
    "OEngineShadingBinLayout",
    "OEngineShadingBinIndirectArgs"
  ]) assert.match(GPU_SHADING_BIN_WGSL, new RegExp(`struct ${declaration}\\b`, "u"));
  assert.match(GPU_SHADING_BIN_WGSL, /struct OEngineShadingBinHeap/u);
  assert.match(GPU_SHADING_BIN_WGSL, /records_alignment_padding: array<u32, 56>/u);
  assert.doesNotMatch(GPU_SHADING_BIN_WGSL, /consumed_count/u);
});

test("all fixed-size CPU records round-trip at their exact byte offsets", () => {
  const settings = {
    width: 1920,
    height: 1080,
    microtilesX: 240,
    generation: 7,
    allowedMaskLo: 0x80000001,
    allowedMaskHi: 0x80000001,
    maxDispatchDimension: 65535,
    layoutRevision: 9
  };
  assert.deepEqual(unpackGpuShadingBinSettings(packGpuShadingBinSettings(settings)), settings);
  const control = {
    frameFlags: 3,
    errorCount: 2,
    generatedMaskLo: 1,
    generatedMaskHi: 0x80000000,
    finalizedGeneration: 7,
    layoutRevision: 9
  };
  assert.deepEqual(unpackGpuShadingBinControl(packGpuShadingBinControl(control)), control);
  assert.deepEqual(unpackGpuShadingBinControl(packGpuShadingBinControl({
    ...control,
    finalizedGeneration: 0,
    layoutRevision: 0
  })), { ...control, finalizedGeneration: 0, layoutRevision: 0 });
  const counter = { attemptedCount: 11, writtenCount: 7, overflowCount: 4, flags: 8 };
  assert.deepEqual(unpackGpuShadingBinCounter(packGpuShadingBinCounter(counter)), counter);
  const layout = { recordBase: 123, capacity: 456, revision: 9, flags: GPU_SHADING_BIN_LAYOUT_FLAG.Active };
  assert.deepEqual(unpackGpuShadingBinLayout(packGpuShadingBinLayout(layout)), layout);
  const args = { workgroupCountX: 65535, workgroupCountY: 2, workgroupCountZ: 1 };
  assert.deepEqual(unpackGpuShadingBinIndirectArgs(packGpuShadingBinIndirectArgs(args)), args);
  assert.throws(
    () => packGpuShadingBinCounter({ ...counter, overflowCount: 3 }),
    /attempted = written \+ overflow/u
  );
});

test("zero, edge, 1080p and 4K extents compute exact microtile and heap sizing", () => {
  assert.deepEqual(shadingBinMicrotileGrid(0, 0), { microtilesX: 0, microtilesY: 0, microtileCount: 0 });
  assert.deepEqual(shadingBinMicrotileGrid(1, 1), { microtilesX: 1, microtilesY: 1, microtileCount: 1 });
  assert.deepEqual(shadingBinMicrotileGrid(9, 65), { microtilesX: 2, microtilesY: 9, microtileCount: 18 });
  assert.deepEqual(shadingBinMicrotileGrid(1920, 1080), { microtilesX: 240, microtilesY: 135, microtileCount: 32400 });
  assert.deepEqual(shadingBinMicrotileGrid(3840, 2160), { microtilesX: 480, microtilesY: 270, microtileCount: 129600 });
  assert.equal(shadingBinHeapByteLength(0, 32400), 2304);
  assert.equal(shadingBinHeapByteLength(1, 32400), 131904);
  assert.equal(shadingBinHeapByteLength(64, 32400), 8296704);
  assert.equal(shadingBinHeapByteLength(64, 129600), 33179904);
});

test("active layouts are dense, immutable-shaped and address records exactly", () => {
  const layouts = createGpuShadingBinLayouts(16, 8, [63, 0, 17], 5);
  assert.equal(layouts.length, 64);
  assert.deepEqual(layouts[0], { recordBase: 0, capacity: 2, revision: 5, flags: 1 });
  assert.deepEqual(layouts[17], { recordBase: 2, capacity: 2, revision: 5, flags: 1 });
  assert.deepEqual(layouts[63], { recordBase: 4, capacity: 2, revision: 5, flags: 1 });
  assert.deepEqual(layouts[1], { recordBase: 0, capacity: 0, revision: 5, flags: 0 });
  assert.equal(shadingBinCounterByteOffset(63), 32 + 63 * 16);
  assert.equal(shadingBinLayoutByteOffset(63), 1056 + 63 * 16);
  assert.equal(shadingBinIndirectByteOffset(63), 63 * 12);
  assert.equal(shadingBinRecordByteOffset(layouts[17], 1), 2304 + 3 * 4);
  assert.throws(() => createGpuShadingBinLayouts(1, 1, [0, 0], 1), /Duplicate/u);
  assert.throws(() => shadingBinRecordByteOffset(layouts[17], 2), /exceeds capacity/u);
});

test("preflight rejects extent, element-address, binding and dispatch limit failures before resources", () => {
  const sizing = preflightGpuShadingBinSizing(1920, 1080, [0, 15, 63], 4, generousLimits);
  assert.equal(sizing.heapBytes, 391104);
  assert.deepEqual(sizing.activeBinIds, [0, 15, 63]);
  assert.deepEqual(shadingBinActiveMask([0, 31, 32, 63]), { lo: 0x80000001, hi: 0x80000001 });
  assert.throws(
    () => preflightGpuShadingBinSizing(32769, 1, [0], 1, generousLimits),
    /maxTextureDimension2D/u
  );
  assert.throws(
    () => preflightGpuShadingBinSizing(1920, 1080, [0], 1, { ...generousLimits, maxBufferSize: 1000 }),
    /maxBufferSize/u
  );
  assert.throws(
    () => preflightGpuShadingBinSizing(1920, 1080, [0], 1, { ...generousLimits, maxStorageBufferBindingSize: 1000 }),
    /maxStorageBufferBindingSize/u
  );
  assert.throws(
    () => preflightGpuShadingBinSizing(65535, 65535, Array.from({ length: 64 }, (_, i) => i), 1, {
      ...generousLimits,
      maxTextureDimension2D: 65535,
      maxBufferSize: Number.MAX_SAFE_INTEGER,
      maxStorageBufferBindingSize: Number.MAX_SAFE_INTEGER
    }),
    /record elements/u
  );
  assert.throws(
    () => preflightGpuShadingBinSizing(4096, 4096, [0], 1, {
      ...generousLimits,
      maxComputeWorkgroupsPerDimension: 2
    }),
    /squared workgroups/u
  );
});

test("indirect dimensions overwrite complete zero, one, boundary and 2D-tail records", () => {
  assert.deepEqual(shadingBinDispatchDimensions(0, 65535), {
    workgroupCountX: 0, workgroupCountY: 1, workgroupCountZ: 1
  });
  assert.deepEqual(shadingBinDispatchDimensions(1, 65535), {
    workgroupCountX: 1, workgroupCountY: 1, workgroupCountZ: 1
  });
  assert.deepEqual(shadingBinDispatchDimensions(65535, 65535), {
    workgroupCountX: 65535, workgroupCountY: 1, workgroupCountZ: 1
  });
  assert.deepEqual(shadingBinDispatchDimensions(65536, 65535), {
    workgroupCountX: 65535, workgroupCountY: 2, workgroupCountZ: 1
  });
  assert.throws(() => shadingBinDispatchDimensions(5, 2), /squared workgroups/u);
});
