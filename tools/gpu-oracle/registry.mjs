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
    name: "environment-probe",
    file: "tools/gpu-oracle/self-test/environment-probe.mjs",
    url: "/__gpu-oracle/self-test/environment-probe.mjs",
    entry: "runEnvironmentProbe",
    description:
      "Minimal real-GPU smoke test: one compute dispatch, storage-buffer readback, asserted on the CPU.",
    timeoutMs: 60_000,
    note: "Run this first on a new machine or CI runner; it separates harness/driver availability from oracle logic.",
  }),
  Object.freeze({
    name: "hzb-conservative",
    file: "OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    url: "/OEngine/tests/oracle/hzb-conservative-gpu.mjs",
    entry: "runConservativeHzbGpuOracle",
    description:
      "Exhaustive rg16float half-boundary reduction plus all 1296 HZB footprint rectangles against buildHzbReference.",
    timeoutMs: 180_000,
    note: "Independent CPU reference; strongest numeric oracle in the repository.",
  }),
  Object.freeze({
    name: "virtual-geometry-handoff",
    file: "OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-handoff-gpu.mjs",
    entry: "runVirtualGeometryHandoffGpuOracle",
    description:
      "VirtualGeometryMeshletWorkCandidate queue/draw-indirect handoff with exact compacted cluster IDs.",
    timeoutMs: 180_000,
    note: "Drives the production owner VirtualGeometryMeshletWorkCandidate from OEngine/.test-dist.",
  }),
  Object.freeze({
    name: "virtual-geometry-instance-culling",
    file: "OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    url: "/OEngine/tests/oracle/virtual-geometry-instance-culling-gpu.mjs",
    entry: "runVirtualGeometryInstanceCullingGpuOracle",
    description:
      "HierarchicalWorkGenerator root/hierarchy kernels over 20 camera frames, with the old double-transform false rejection as negative control.",
    timeoutMs: 180_000,
    note: "Drives the production owner HierarchicalWorkGenerator from OEngine/.test-dist.",
  }),
  Object.freeze({
    name: "self-test-wrong-kernel",
    file: "tools/gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    url: "/__gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs",
    entry: "runWrongKernelHzbOracle",
    description:
      "Negative control: the HZB reduction oracle with a deliberately non-conservative GPU kernel.",
    timeoutMs: 180_000,
    negativeControl: true,
    note: "Must FAIL. Proves the harness propagates failures produced by real GPU output. Never a production oracle.",
  }),
]);

export function findOracle(name) {
  return oracles.find((oracle) => oracle.name === name) ?? null;
}
