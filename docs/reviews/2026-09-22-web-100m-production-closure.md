# ADR-0018 Web 100M Production Closure Review (2026-09-22)

This review reconciles the implementation with
`ADR-0018_Web_100M_Virtual_Geometry_Architecture.md`. It closes the previously
missing production wiring, but deliberately leaves Phase K active until a clean
committed browser run produces accepted evidence.

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
| K | Clean frozen 100M evidence | **Active**; executable case is ready, but no clean committed evidence exists yet |
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

Run fresh OEngine and validation builds/tests, repository model/registry checks,
`verify --changed`, and protocol self-test. Commit those changes first. Only then
run `node tools/vibe.mjs case web-100m-formal-perf --run` from the clean revision.
Phase K becomes done only when that case passes with full verification receipts,
no GPU errors, complete disposal evidence, and accepted samples/summary artifacts.

If the formal run fails, the failure belongs to Phase K and must be fixed against
the frozen workload. Phase L begins only after the fixed 384-vertex baseline is
captured; it must compare 32/64/96/128 buckets without changing workload, camera,
quality, or evidence identity.
