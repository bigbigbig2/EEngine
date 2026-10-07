// Registry of real-GPU oracles.
//
// Adding oracle #4 is one entry here plus its module; the CLI, the host page and
// the static server need no new code. Fields:
//   name         CLI selector
//   file         repository-relative path on disk (existence preflight + reports)
//   url          origin-relative URL the browser imports
//   entry        exported function called as entry(device)
//   allowPrefixes extra static-server prefixes this oracle additionally needs
//   note         provenance, or the exact observed blocker, shown in reports

export const oracles = Object.freeze([
  Object.freeze({
    name: "native-surface-product-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceProductProductionGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/", "OEngine/src/assets/web-cook/wasm/vendor/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description: "S2 actual ordinary Scene WASM Product admission, native Visibility/VSM/Surface/Temporal/recovery closure.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-production",
    file: "OEngine/tests/oracle/native-surface-production-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-production-gpu.mjs",
    entry: "runNativeSurfaceProductionGpuOracle",
    allowPrefixes: ["OEngine/src/render/assets/"],
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description: "S2 actual Renderer ownership, native instance publication, winner/HDR/Temporal/FSR, update/abort/retry/resize.",
    note: "Renderer negotiates its own device; oracle captures errors on that real production device. This is a correctness closure, not S3 performance acceptance.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-resource-profile",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceResourceProfileGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "S1 complete Product-geometry resource profile, native sunlight and resident winner input; not VG scene acceptance.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-surface-device-epoch",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceDeviceEpochGpuOracle",
    description:
      "S1 controlled device destruction and native subsystem reconstruction on two independent device epochs.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-surface-cost",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceCostGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1", "timestamp-query"],
    description: "S1 isolated 1080p native multi-route/Temporal/FSR cost; not production acceptance.",
    timeoutMs: 180000
  }),
  Object.freeze({
    name: "native-surface-perspective",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfacePerspectiveGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description: "S1 perspective reconstruction, physical sun math and real GPU exposure update.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-execution-bins",
    file: "OEngine/tests/oracle/native-execution-bins-gpu.mjs",
    url: "/OEngine/tests/oracle/native-execution-bins-gpu.mjs",
    entry: "runNativeExecutionBinsGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "S1 native pixel execution bins, complete tails, capacity and unique-writer coverage.",
    timeoutMs: 60000
  }),
  Object.freeze({
    name: "native-surface-integration",
    file: "OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-integration-gpu.mjs",
    entry: "runNativeSurfaceIntegrationGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description: "S1 isolated native winner/material/HDR/Temporal/FSR chain; no production cutover.",
    timeoutMs: 120000
  }),
  Object.freeze({
    name: "native-material",
    file: "OEngine/tests/oracle/native-material-gpu.mjs",
    url: "/OEngine/tests/oracle/native-material-gpu.mjs",
    entry: "runNativeMaterialGpuOracle",
    description:
      "S1 native Standard/Coat/Unlit/custom graph, explicit gradients and immutable publication transactions.",
    timeoutMs: 60000,
    note: "Component only: fixture geometry inputs and linear textures; no production cutover or S1 closure claim."
  }),
  Object.freeze({
    name: "native-surface-numeric",
    file: "OEngine/tests/oracle/native-surface-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-gpu.mjs",
    entry: "runNativeSurfaceGpuNumericProbe",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query"],
    description: "S0 targeted numeric validation without the timing/calibration matrix.",
    timeoutMs: 60000
  }),
  Object.freeze({
    name: "native-surface-viability",
    file: "OEngine/tests/oracle/native-surface-gpu.mjs",
    url: "/OEngine/tests/oracle/native-surface-gpu.mjs",
    entry: "runNativeSurfaceGpuProbe",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query"],
    description: "S0 isolated native Geometry/PBR/cluster/VSM/IBL costs and compact44 comparison.",
    timeoutMs: 180000,
    note: "Not production performance or an alternate renderer. Reports fixture simplifications; the execution authority decides viability from reviewed evidence, not the harness pass flag."
  }),
  Object.freeze({
    name: "framegraph-lifecycle",
    file: "OEngine/tests/oracle/framegraph-lifecycle-gpu.mjs",
    url: "/OEngine/tests/oracle/framegraph-lifecycle-gpu.mjs",
    entry: "runFrameGraphLifecycleGpuOracle",
    requiredFeatures: ["timestamp-query"],
    description:
      "A0/A1 production compiled executor, pooled/native lifetime, resize binding and diagnostics WGSL.",
    timeoutMs: 60000,
    note: "Real GPU component chain with independent buffer/diagnostic assertions."
  }),
  Object.freeze({
    name: "frame-timing",
    file: "OEngine/tests/oracle/frame-timing-gpu.mjs",
    url: "/OEngine/tests/oracle/frame-timing-gpu.mjs",
    entry: "runFrameTimingGpuOracle",
    requiredFeatures: ["timestamp-query"],
    description: "A0 persistent timer modes, query/marker tax and real GPU span/result assertions.",
    timeoutMs: 60000,
    note: "Production timer components, not a full-frame benchmark."
  }),
  Object.freeze({
    name: "environment-probe",
    file: "tools/gpu-oracle/self-test/environment-probe.mjs",
    url: "/__gpu-oracle/self-test/environment-probe.mjs",
    entry: "runEnvironmentProbe",
    description:
      "Minimal real-GPU smoke test: one compute dispatch, storage-buffer readback, asserted on the CPU.",
    timeoutMs: 60_000,
    note: "Run this first on a new machine or CI runner; it separates harness/driver availability from oracle logic."
  }),
  Object.freeze({
    name: "hzb-conservative",
    file: "OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    url: "/OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    entry: "runConservativeHzbGpuOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Exhaustive rg16float half-boundary reduction plus all 1296 HZB footprint rectangles against buildHzbReference.",
    timeoutMs: 180_000,
    note: "Independent CPU reference; strongest numeric oracle in the repository."
  }),
  Object.freeze({
    name: "virtual-geometry-handoff",
    file: "OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    entry: "runVirtualGeometryHandoffGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "VirtualGeometryMeshletWorkCandidate queue/draw-indirect handoff with exact compacted cluster IDs.",
    timeoutMs: 180_000,
    note: "Drives the production owner VirtualGeometryMeshletWorkCandidate from OEngine/.test-dist."
  }),
  Object.freeze({
    name: "virtual-geometry-instance-culling",
    file: "OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    entry: "runVirtualGeometryInstanceCullingGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description:
      "HierarchicalWorkGenerator root/hierarchy kernels over 20 camera frames, with the old double-transform false rejection as negative control.",
    timeoutMs: 180_000,
    note: "Drives the production owner HierarchicalWorkGenerator from OEngine/.test-dist."
  }),
  Object.freeze({
    name: "self-test-wrong-kernel",
    file: "tools/gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    url: "/__gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    entry: "runWrongKernelHzbOracle",
    requiredFeatures: ["texture-formats-tier1"],
    description:
      "Negative control: the HZB reduction oracle with a deliberately non-conservative GPU kernel.",
    timeoutMs: 180_000,
    negativeControl: true,
    note: "Must FAIL. Proves the harness propagates failures produced by real GPU output. Never a production oracle."
  })
]);

export function findOracle(name) {
  return oracles.find((oracle) => oracle.name === name) ?? null;
}
