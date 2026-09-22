# ADR-0018 Production Closure Review (2026-09-22, superseded target)

> Target update: this implementation inventory remains historical evidence, but
> its acceptance order is superseded by
> `2026-09-22-web-100m-authored-first-validation-plan.md`. ADR-0018 now targets
> `large.glb` (477,591,060 bytes, 4,871,612 triangles, 1,920 primitives) first.
> The 100M formal run is a deferred scale gate.

This review reconciles the implementation with
`ADR-0018_Web_100M_Virtual_Geometry_Architecture.md`. It closes the previously
missing production wiring, but it does not reduce the remaining work to a
single browser run. The authored target has no accepted evidence yet, and its
CPU/WASM producer still lacks a four-dimensional Product work bound and Product
task trace.

## Outcome

The Web route now performs bounded cook-and-spill, publishes independent Product
shards, relocates them into one GPU metadata heap, writes Product identity per
instance, routes Product-local demand to multiple residencies, and consumes the
result in the normal hierarchy/visibility/shading pipeline. Current-HZB is a real
same-frame producer/consumer chain rather than a diagnostic candidate oracle.

The formal 100M case mounts the frozen 2,800,457,176-byte source, requires its
100,000,000-triangle/hash identity, freezes clean revision/browser/adapter/display/
camera/workload data, and collects TTFMF, 3 x (120 warmup + 480 samples), CPU/GPU
timings, owner peaks, demand/churn/overflow, and camera-cut recovery.

This is implementation and local verification evidence. It is not yet accepted
`RuntimeValidated` or `PerformanceEvaluated` evidence because the formal case must
run after the implementation commit, with a clean worktree.

## Corrected interpretation of the review

The earlier assessment is correct that A-J now have substantially connected
implementation/contract evidence. It is too strong to say that the only
remaining work is accepted 100M evidence. The following gaps are still real:

- `SpatialShardPlanner` computes a bounded scan, but its planning/materialization
  scratch and ordered source access are not yet proven against repeated
  giant-primitive rescans, cancellation, or cleanup at authored scale.
- `uploadWebCookedMultiProductScene()` merges all previously admitted parts and
  replaces the full Scene publication for every new shard. This is correct but
  accumulates O(N^2) CPU/publication work as Product count grows.
- The caller still selects `uploadWebCookedMultiProductScene()` and supplies
  `multiProductSlotCapacity`; the public `load_gltf()`-style route does not yet
  infer Product mode and next-power-of-two capacity from the plan/catalog.
- No accepted authored-large browser evidence exists in the current revision;
  the stopped run is a debugging trace, not a pass.

These are K1 production-performance debts. They do not invalidate the A-J
correctness wiring, but they do prevent the formal 100M result from being the
only remaining acceptance question.

## Original phase reconciliation

| Phase | Original design gate | Repository state after this closure |
| --- | --- | --- |
| A | Reproducible 100M source and exact failure owner | Done; frozen source/hash/triangle/byte identity and Phase A report retained |
| B | Bounded source/canonical windows | Done; canonical window contracts and oracles remain authoritative |
| C | Giant primitive spatial shards | Done; one 100M primitive plans ~100 deterministic shards |
| D | Cook-and-spill; release WASM payload | Done; every shard spills before publication, rereads exact bytes, and releases WASM page ownership |
| E | Multi-Product Table and independent identity | Production-wired; combined heap relocation, 128 formal slots, per-instance slot/generation, shared banks, scene merge, and stale rejection are tested |
| F | Visible-first publication | Production-wired; first admitted shard can render before `settled()` completes |
| G | GPU demand dedup/compaction | Production-wired; demand mask uses global page range while records retain Product-local identity |
| H | Adapter-selected residency | Done at implementation/contract level; formal adapter evidence remains K |
| I | Previous HZB -> current depth/HZB -> late recheck | Production-wired; standard MeshletWork filter writes indirect args and final raster consumes it; invalid/stale/overflow fails open |
| J | Dynamic page budgets | Production-wired; delayed GPU/frame/camera/IO feedback remains bounded by hard caps |
| K0 | Authored-large cook gate | **Active design**; work-budget/coverage/trace/spill contracts are frozen, implementation and executable case remain todo |
| K1 | Authored runtime smoke and producer debt | Todo; activation-first publication, capacity, and telemetry follow K0 |
| K2 | Authored formal PERF | Todo; `web-authored-large-perf` is the current L4 promotion case after K0/K1 |
| S1 | Clean frozen 100M scale evidence | Deferred; covers the separate scale-performance claim |
| L | 32/64/96/128 raster buckets | Todo; must not start before K baseline is accepted |
| M | 250M/500M/1B scaling | Todo |

## Correctness and ownership decisions

- One scene metadata heap owns immutable relocated tables; Product residencies own
  source/page lifecycle and share four physical bank buffers.
- The standalone Product Table, CPU mirror, and heap Product Table publish identical
  global ranges. Page IDs remain Product-local.
- GPU instances carry Product slot and generation; the CPU never reconstructs a
  per-frame visible list.
- A single streaming runtime maps delayed demand/completion to the exact shard
  residency and generation.
- Formal 100M uses 128 Product slots. The combined metadata binding is 128 MiB;
  combined plus local descriptor metadata has a 256 MiB total ledger. Each binding
  still obeys negotiated adapter limits.
- Current-HZB feature-off allocates no owner/pass/queue/indirect resource. Its
  production capacity follows VisibilityKey and adapter buffer limits, not the
  65,536-record diagnostic oracle ceiling.

## Nyx mapping

Nyx `GeometryStreaming::{PinRootPages,Update,SyncMemoryAndAddressTable,
OnPageIOComplete,ImmediateEvict}` maps to shared bank residency, multi-Product
metadata publication, delayed readback routing, and revoke-before-reuse.
`DAGCull::{ProcessNodeBatch,ProcessMeshletBatch,computeMain}` remains the previous
HZB traversal authority; the WebGPU adaptation adds a conservative current-depth
late compute pass and standard indirect raster. Missing/stale state retains source
work. `VBufferMesh::{BuildVertexOutput,meshMain,pixelMain}` continues through Product
bank vertex pulling and VisibilityKey output. Exact files, differences, fallbacks,
and oracles are recorded in `docs/porting/nyx-function-map.json`.

## Verification required before promotion

Implement and pass authored K0 first, then authored runtime smoke, then run
`web-authored-large-perf` from a clean revision. The 100M case is not the next
command and must not be used to bypass an authored producer stall.

If the formal run fails, the failure belongs to Phase K and must be fixed against
the frozen workload. Phase L begins only after the fixed 384-vertex baseline is
captured; it must compare 32/64/96/128 buckets without changing workload, camera,
quality, or evidence identity.

The practical order is K0 authored cook, K1 authored runtime/debt closure, K2
authored formal PERF, then S1 formal 100M scale evidence.
