import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_VISIBILITY_DEBUG_COLORS,
  GPU_VISIBILITY_DEBUG_RESOLVE_ABI_VERSION,
  GPU_VISIBILITY_DEBUG_SETTINGS_SIZE,
  GPU_VISIBILITY_DEBUG_STATUS,
  GPU_VISIBILITY_DEBUG_STATUS_WGSL,
  resolveVisibilityDebugReference
} = await import("../.test-dist/gpu/GpuVisibilityDebugResolve.js");
const {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS
} = await import("../.test-dist/gpu/GpuMaterialVisibilityAbi.js");
const { GPU_INSTANCE_FLAGS } = await import("../.test-dist/gpu/GpuInstanceAbi.js");
const {
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  encodeVisibilityKey
} = await import("../.test-dist/gpu/GpuVisibilityKeyAbi.js");

test("debug resolve freezes the direct RasterWork status/color ABI", () => {
  assert.equal(GPU_VISIBILITY_DEBUG_RESOLVE_ABI_VERSION, 2);
  assert.equal(GPU_VISIBILITY_DEBUG_SETTINGS_SIZE, 32);
  assert.equal(new Set(Object.values(GPU_VISIBILITY_DEBUG_STATUS)).size, 13);
  assert.equal(Object.keys(GPU_VISIBILITY_DEBUG_COLORS).length, 12);
  assert.match(GPU_VISIBILITY_DEBUG_STATUS_WGSL, /OENGINE_VIS_DEBUG_MATERIAL_INVALID/);
  assert.doesNotMatch(GPU_VISIBILITY_DEBUG_STATUS_WGSL, /VISIBLE_CLUSTER|CLUSTER_RECORD/);
  assert.equal(
    resolveVisibilityDebugReference(GPU_VISIBILITY_KEY_EMPTY, validTables()).status,
    GPU_VISIBILITY_DEBUG_STATUS.Empty
  );
  assert.equal(
    resolveVisibilityDebugReference(GPU_VISIBILITY_KEY_INVALID, validTables()).status,
    GPU_VISIBILITY_DEBUG_STATUS.InvalidKey
  );
  assert.equal(
    resolveVisibilityDebugReference(
      encodeVisibilityKey(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT),
      validTables()
    ).status,
    GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange
  );
});

test("CPU oracle identifies every direct lookup failure layer", () => {
  const cases = [
    ["rasterWork", [], GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange],
    ["meshlets", [], GPU_VISIBILITY_DEBUG_STATUS.MeshletOutOfRange],
    ["meshlets", [{ triangleCount: 0 }], GPU_VISIBILITY_DEBUG_STATUS.TriangleOutOfRange],
    ["instances", [], GPU_VISIBILITY_DEBUG_STATUS.InstanceOutOfRange],
    ["geometryRecordCount", 0, GPU_VISIBILITY_DEBUG_STATUS.GeometryOutOfRange],
    ["materials", [], GPU_VISIBILITY_DEBUG_STATUS.MaterialOutOfRange]
  ];
  for (const [field, value, expected] of cases) {
    const tables = { ...validTables(), [field]: value };
    assert.equal(resolveVisibilityDebugReference(0, tables).status, expected, field);
  }

  const inactive = validTables();
  inactive.instances[0].flags = 0;
  assert.equal(resolveVisibilityDebugReference(0, inactive).status,
    GPU_VISIBILITY_DEBUG_STATUS.InactiveInstance);

  const mismatch = validTables();
  mismatch.instances[0].geometryRecordIndex = 1;
  assert.equal(resolveVisibilityDebugReference(0, mismatch).status,
    GPU_VISIBILITY_DEBUG_STATUS.IdentityMismatch);

  const invalidMaterial = validTables();
  invalidMaterial.materials[0].flags = 0;
  assert.equal(resolveVisibilityDebugReference(0, invalidMaterial).status,
    GPU_VISIBILITY_DEBUG_STATUS.MaterialRecordInvalid);

  const blend = validTables();
  blend.materials[0].alphaMode = GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend;
  assert.equal(resolveVisibilityDebugReference(0, blend).status,
    GPU_VISIBILITY_DEBUG_STATUS.BlendMaterial);
});

test("valid resolve returns direct exact-triangle identity", () => {
  assert.deepEqual(resolveVisibilityDebugReference(0, validTables()), {
    kind: "valid",
    status: GPU_VISIBILITY_DEBUG_STATUS.Valid,
    reason: "valid",
    rasterWorkSlot: 0,
    meshletRecordIndex: 0,
    localTriangle: 0,
    instanceRecordIndex: 0,
    instanceDebugId: 77,
    geometryRecordIndex: 0,
    materialHandle: 0,
    alphaMode: GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask,
    materialFlags: GPU_MATERIAL_VISIBILITY_FLAGS.Valid |
      GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided
  });
});

function validTables() {
  return {
    rasterWork: [{
      instanceRecordIndex: 0,
      geometryRecordIndex: 0,
      meshletRecordIndex: 0,
      localTriangleIndex: 0,
      materialHandle: 0,
      rasterFlags: 0
    }],
    meshlets: [{ triangleCount: 1 }],
    instances: [{
      geometryRecordIndex: 0,
      materialHandle: 0,
      flags: GPU_INSTANCE_FLAGS.Active,
      debugId: 77
    }],
    geometryRecordCount: 1,
    materials: [{
      materialId: 0,
      alphaMode: GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask,
      flags: GPU_MATERIAL_VISIBILITY_FLAGS.Valid |
        GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided
    }]
  };
}
