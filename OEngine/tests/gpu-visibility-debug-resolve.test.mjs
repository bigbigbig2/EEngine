import test from "node:test";
import assert from "node:assert/strict";

const {
  GPU_VISIBILITY_DEBUG_COLORS,
  GPU_VISIBILITY_DEBUG_SETTINGS_SIZE,
  GPU_VISIBILITY_DEBUG_STATUS,
  GPU_VISIBILITY_DEBUG_STATUS_WGSL,
  resolveVisibilityDebugReference
} = await import("../.test-dist/gpu/GpuVisibilityDebugResolve.js");
const {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS
} = await import("../.test-dist/gpu/GpuMaterialVisibilityAbi.js");
const { GPU_INSTANCE_FLAGS } = await import(
  "../.test-dist/gpu/GpuInstanceAbi.js"
);
const {
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  encodeVisibilityKey
} = await import("../.test-dist/gpu/GpuVisibilityKeyAbi.js");

test("R4-A-04 debug resolve freezes status/color ABI and max-key fail-visible", () => {
  assert.equal(GPU_VISIBILITY_DEBUG_SETTINGS_SIZE, 32);
  assert.equal(new Set(Object.values(GPU_VISIBILITY_DEBUG_STATUS)).size, 15);
  assert.equal(Object.keys(GPU_VISIBILITY_DEBUG_COLORS).length, 14);
  assert.match(GPU_VISIBILITY_DEBUG_STATUS_WGSL, /OENGINE_VIS_DEBUG_MATERIAL_INVALID/);
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
      encodeVisibilityKey(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT, 127),
      validTables()
    ).status,
    GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange
  );
});

test("R4-A-04 CPU oracle identifies every GPU lookup failure layer", () => {
  const cases = [
    ["rasterWork", [], GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange],
    ["visibleClusters", [], GPU_VISIBILITY_DEBUG_STATUS.VisibleClusterOutOfRange],
    ["clusterRecordCount", 0, GPU_VISIBILITY_DEBUG_STATUS.ClusterRecordOutOfRange],
    ["meshlets", [], GPU_VISIBILITY_DEBUG_STATUS.MeshletOutOfRange],
    ["meshlets", [{ triangleCount: 0 }], GPU_VISIBILITY_DEBUG_STATUS.TriangleOutOfRange],
    ["instances", [], GPU_VISIBILITY_DEBUG_STATUS.InstanceOutOfRange],
    ["geometryRecordCount", 0, GPU_VISIBILITY_DEBUG_STATUS.GeometryOutOfRange],
    ["materials", [], GPU_VISIBILITY_DEBUG_STATUS.MaterialOutOfRange]
  ];
  for (const [field, value, expected] of cases) {
    const tables = { ...validTables(), [field]: value };
    assert.equal(
      resolveVisibilityDebugReference(encodeVisibilityKey(0, 0), tables).status,
      expected,
      field
    );
  }

  const inactive = validTables();
  inactive.instances[0].flags = 0;
  assert.equal(
    resolveVisibilityDebugReference(0, inactive).status,
    GPU_VISIBILITY_DEBUG_STATUS.InactiveInstance
  );

  const mismatch = validTables();
  mismatch.instances[0].geometryRecordIndex = 1;
  assert.equal(
    resolveVisibilityDebugReference(0, mismatch).status,
    GPU_VISIBILITY_DEBUG_STATUS.IdentityMismatch
  );

  const invalidMaterial = validTables();
  invalidMaterial.materials[0].flags = 0;
  assert.equal(
    resolveVisibilityDebugReference(0, invalidMaterial).status,
    GPU_VISIBILITY_DEBUG_STATUS.MaterialRecordInvalid
  );

  const blend = validTables();
  blend.materials[0].alphaMode = GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend;
  assert.equal(
    resolveVisibilityDebugReference(0, blend).status,
    GPU_VISIBILITY_DEBUG_STATUS.BlendMaterial
  );
});

test("R4-A-04 valid resolve returns the complete identity and alpha class", () => {
  const resolved = resolveVisibilityDebugReference(encodeVisibilityKey(0, 0), validTables());
  assert.deepEqual(resolved, {
    kind: "valid",
    status: GPU_VISIBILITY_DEBUG_STATUS.Valid,
    reason: "valid",
    rasterWorkSlot: 0,
    visibleClusterSlot: 0,
    meshletRecordIndex: 0,
    localTriangle: 0,
    instanceRecordIndex: 0,
    instanceDebugId: 77,
    geometryRecordIndex: 0,
    clusterRecordIndex: 0,
    materialHandle: 0,
    alphaMode: GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask,
    materialFlags:
      GPU_MATERIAL_VISIBILITY_FLAGS.Valid |
      GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided
  });
});

function validTables() {
  return {
    rasterWork: [{ visibleClusterSlot: 0, meshletRecordIndex: 0 }],
    visibleClusters: [{
      instanceRecordIndex: 0,
      geometryRecordIndex: 0,
      clusterRecordIndex: 0,
      materialHandle: 0
    }],
    meshlets: [{ triangleCount: 1 }],
    instances: [{
      geometryRecordIndex: 0,
      materialHandle: 0,
      flags: GPU_INSTANCE_FLAGS.Active,
      debugId: 77
    }],
    geometryRecordCount: 1,
    clusterRecordCount: 1,
    materials: [{
      materialId: 0,
      alphaMode: GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask,
      flags:
        GPU_MATERIAL_VISIBILITY_FLAGS.Valid |
        GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided
    }]
  };
}
