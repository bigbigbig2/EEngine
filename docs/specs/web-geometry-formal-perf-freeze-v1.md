---
id: specs/web-geometry-formal-perf-freeze-v1
state: current
verifies:
  - OEngine/src
---
# Web Geometry Formal PERF Freeze V1

Status: candidate

Owners: `validation/` independent browser host and `FormalPerfFreezeV1`

Decision: `ADR-0018`

## Version/Compatibility

Version 1 freezes the formal receipt schema for the ADR-0018 authored-large
workload.

## Contract

This contract freezes identity and samples for the current formal authored-large
performance gate. A performance result is not promotion evidence unless every
sample belongs to one clean revision, browser executable, adapter/capability
snapshot, fixed display condition, camera path, feature set, and workload hash.

The current source is:

```text
large.glb
477,591,060 bytes
4,871,612 triangles
1,041 nodes
1,920 primitives
maximum primitive = 1,364,306 triangles
```

## Frozen identity

The freeze records commit/tree/dirty state, Chrome executable/version/hash,
adapter identity, negotiated features/limits, timestamp-query availability,
resolution/DPR/render scale, camera path id/hash, workload id/hash, and source
id/hash/bytes/triangle/primitive counts.

Accepted L4 evidence requires `dirty: false`, identical freeze identity across
independent runs, and full matching verification receipts.

## Producer prerequisites

Formal sampling is forbidden until the authored K0 and K1 gates pass. The
workload freezes:

```text
max canonical input       32 MiB
max triangles/Product     128 Ki
max vertices/Product      512 Ki
max domains/Product       64
max decoded Product       128 MiB
max session spill         1 GiB initial limit
```

The formal receipt must prove all 1,920 catalog primitives are covered by the
union of `Product.sceneAssetIndices`. Product count is recorded, not compared
with primitive count.

Every Product has the identity and phase timings required by
`web-geometry-product-task-trace-v1`. Owner accounting includes source,
canonical, WASM, JS, spill, decoded page, GPU geometry, and texture current,
peak, and limit bytes.

## Samples and aggregation

Each independent run records TTFMF and samples after the declared warmup. A
sample includes CPU frame/build/submit milliseconds; GPU frame milliseconds or
`null` when timestamp query is unavailable; owner bytes; page demand/churn/
overflow; and camera-cut recovery.

The helper reports CPU/GPU/TTFMF and page/cut P50/P95. Owner values are maxima
over measured samples. CPU time is never substituted for missing GPU timing.

## Validation

1. **K0 Authored Cook** uses the planned
   `web-authored-large-cook-k0-v1` workload. It requires full cook, full catalog
   coverage, task trace, bounded owner/spill peaks, settled, and disposal. It has
   no formal warmup or timestamp requirement. Its executable case is registered
   only because those assertions now exist in the shared page.
2. **K1 Authored Runtime Smoke** uses planned workload
   `web-authored-large-runtime-smoke-v1` to exercise production Multi-Product
   rendering, movement, page demand, fallback, camera-cut recovery, and disposal,
   and closes the declared producer/publication/capacity/telemetry debts.
3. **K2 Authored Formal PERF** runs `web-authored-large-perf` with workload
   `web-authored-large-perf-v1` and profile `formal-1080p`: 120 warmup frames,
   480 measured frames, and 3 independent runs.
The host records the first meaningful Product frame before total cook completion,
then waits for all tasks to settle before formal samples. A camera cut explicitly
invalidates view history and records fallback/recovery.

No accepted evidence exists merely because this contract or case manifest is
present. Old benchmark JSON, a dirty worktree, a stopped authored run, `units=3`,
the Zorah archive, or Node-only samples cannot promote the performance claim.
