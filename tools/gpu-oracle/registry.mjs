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
    name: "surface-closure-cache-cost",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceClosureCacheCostGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description: "Full 1080p removable expensive closure, real cache hits and direct HDR comparison.",
    timeoutMs: 120000,
    note: "All-cost diagnostic for the same exact production recipe; cold and warm reported separately."
  }),
  Object.freeze({
    name: "surface-closure-cache",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceClosureCacheGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Production exact closure keys, unique misses, persistent hits and original HDR consumer.",
    timeoutMs: 120000,
    note: "Real GPU scope covers lit cache values, multi-varying residual fields, local normal guides and bounded overflow through Lighting/Reconstruct; signal history validated separately."
  }),
  Object.freeze({
    name: "appearance-closure-key",
    file: "OEngine/tests/oracle/appearance-closure-key-gpu.mjs",
    url: "/OEngine/tests/oracle/appearance-closure-key-gpu.mjs",
    entry: "runAppearanceClosureKeyGpuOracle",
    description: "Actual uniform publication and complete exact closure key reader.",
    timeoutMs: 60000,
    note: "Component only: Geometry values are fixture inputs; no cache or Surface consumption claim."
  }),
  Object.freeze({
    name: "surface-work-channel-reference",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkChannelReferenceGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description:
      "Production scalar channel accessor versus the retired four-component gather, all other work identical.",
    timeoutMs: 120000,
    note: "Same banks/samplers/full Generic/consumers and every HDR word; retired accessor only in oracle."
  }),
  Object.freeze({
    name: "surface-work-resident-sampler-reference",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkResidentSamplerReferenceGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description: "All-bank sampler routing versus one proven immutable sampler class, same full Surface HDR.",
    timeoutMs: 120000,
    note: "All banks/mip clamps/transforms retained; no material-specific pipeline or production alternative."
  }),
  Object.freeze({
    name: "surface-work-fixed-scratch-reference",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkFixedScratchReferenceGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description:
      "Same production fixed formulas and samplers, storage versus named private sample intermediates.",
    timeoutMs: 120000,
    note: "Full 1080p HDR comparison and all consumers; reference only, no assumed register residence or production alternative."
  }),
  Object.freeze({
    name: "appearance-product-sampling-cost",
    file: "OEngine/tests/oracle/appearance-product-sampling-gpu.mjs",
    url: "/OEngine/tests/oracle/appearance-product-sampling-gpu.mjs",
    entry: "runAppearanceProductSamplingCostGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query"],
    description: "Paired Product software/hardware sampler timing with full output comparison.",
    timeoutMs: 60000,
    note: "256x128 cache-friendly texels, four queries per 1080p item; component attribution only, no production alternative."
  }),
  Object.freeze({
    name: "surface-work-native-reference",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkNativeReferenceGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description: "Isolated complete Generic straight-line cost reference, absent from production.",
    timeoutMs: 120000,
    note: "Same full C/X/Y sample demand and HDR output; not a production per-graph alternative."
  }),
  Object.freeze({
    name: "surface-work-cost",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkCostGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["timestamp-query", "texture-formats-tier1"],
    description: "Full 1080p fixed and complete Generic Surface cost, real consumers and complete coverage.",
    timeoutMs: 120000,
    note: "Diagnostic timing only; numerical field closure belongs to surface-work, no historical performance claim."
  }),
  Object.freeze({
    name: "appearance-product-sampling",
    file: "OEngine/tests/oracle/appearance-product-sampling-gpu.mjs",
    url: "/OEngine/tests/oracle/appearance-product-sampling-gpu.mjs",
    entry: "runAppearanceProductSamplingGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Original hardware textureSampleGrad versus production immutable half bank sampling.",
    timeoutMs: 60000,
    note: "Full original formats/mips/domain and cross-bank payload, component fidelity only."
  }),
  Object.freeze({
    name: "surface-work-compile",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkCompileGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Isolated current work kernels compilation diagnosis.",
    timeoutMs: 60000,
    note: "Compilation only, no correctness assertion."
  }),
  Object.freeze({
    name: "surface-work-lighting-compile",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkLightingCompileGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Isolated current closed lighting pipeline compilation diagnosis.",
    timeoutMs: 60000,
    note: "Compilation only, no correctness assertion."
  }),
  Object.freeze({
    name: "surface-coverage-values",
    file: "OEngine/tests/oracle/surface-coverage-value-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-coverage-value-gpu.mjs",
    entry: "runSurfaceCoverageValueGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    description: "Real cooked mip promotion and publication consumed by production alpha/discard fragment.",
    timeoutMs: 60000,
    note: "Independent coverage expectation; fixture plane excludes meshlet selection and VSM scheduling."
  }),
  Object.freeze({
    name: "surface-work",
    file: "OEngine/tests/oracle/surface-work-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-work-gpu.mjs",
    entry: "runSurfaceWorkGpuOracle",
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    requiredFeatures: ["texture-formats-tier1"],
    description: "B1/B2 current SurfaceWorkRuntime real producer consumer and mandatory overflow coverage.",
    timeoutMs: 120000,
    note: "Actual production chain, independent coverage and reuse OFF exact result assertions."
  }),

  Object.freeze({
    name: "surface-domain",
    file: "OEngine/tests/oracle/surface-domain-gpu.mjs",
    url: "/OEngine/tests/oracle/surface-domain-gpu.mjs",
    entry: "runSurfaceDomainGpuOracle",
    description:
      "B1 domain entity: interned domain identity, tile references and sample work counted separately.",
    timeoutMs: 60000,
    note: "Real GPU reads the publication-packed domain directory; separates domain/tile/sample counts (execution plan 6.1)."
  }),
  Object.freeze({
    name: "appearance-exact-dag",
    file: "OEngine/tests/oracle/appearance-exact-dag-gpu.mjs",
    url: "/OEngine/tests/oracle/appearance-exact-dag-gpu.mjs",
    entry: "runExactAppearanceDagGpuOracle",
    description: "B1 complete arithmetic and nested C/X/Y generic-component feasibility.",
    timeoutMs: 120000,
    note: "New production WGSL component versus independent CPU evaluation; not full Surface cutover."
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
