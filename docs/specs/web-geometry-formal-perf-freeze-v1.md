# Web Geometry Formal PERF Freeze V1

Status: candidate

Owners: `validation/` independent browser host and `FormalPerfFreezeV1`

Decision: `ADR-0018`, Phase K

## Version/Compatibility

Version 1 targets the Geometry Product V1/WebGPU production route and Chrome
stable. Changes to sample fields, identity fields, or aggregation rules require
a new version; readers must reject unknown versions.

## Contract

## Purpose

This contract defines the identity and sample shape for the first formal 100M
virtual-geometry run. A benchmark number is not promotion evidence unless every
sample can be traced to one clean revision, browser executable, adapter and
capability snapshot, fixed 1920x1080/DPR 1 condition, camera path, feature set,
and workload hash.

The contract is renderer-neutral. `OEngine/src/debug/FormalPerfFreeze.ts`
validates and aggregates the values; the independent `validation/` host owns
browser lifecycle, WebGPU diagnostics, screenshots, disposal, and raw artifacts.

## Frozen Identity

The freeze records:

- `commit`, `tree`, and `dirty`;
- Chrome stable version, executable SHA-256, and user agent;
- adapter vendor/architecture/device/description;
- negotiated feature set, numeric limits, and timestamp-query availability;
- internal resolution, DPR, and render scale;
- camera path id and SHA-256;
- workload id/SHA-256, source SHA-256, and source triangle count.

The feature list is sorted and unique. The workload hash is the canonical hash
from `validation/registry.generated.json`, not a path or a local archive name.
Accepted L4 evidence requires `dirty: false`, matching independent-run freeze
identities, and all required verification receipts with `scope: full`.

### Samples and Aggregation

Each independent run records TTFMF and measured samples after the declared warmup
window. A sample contains:

- CPU frame, build, and submit milliseconds;
- GPU frame milliseconds, or `null` only when timestamp-query is unavailable;
- current/peak owner bytes for source, WASM, JS, and GPU geometry;
- page demand, page churn, and overflow counters;
- camera-cut triggered state plus recovery milliseconds and frames when a cut was
  exercised.

The helper reports CPU/GPU/TTFMF and page/cut P50/P95, while owner values are
maxima over every measured sample. GPU P50/P95 is `null` when the capability is
unavailable; CPU time is never substituted for GPU time.

## Validation

The formal manifest is `web-100m-formal-perf` with workload
`web-100m-formal-perf-v1` and profile `formal-1080p`. The independent host mounts
the frozen 2,800,457,176-byte/100,000,000-triangle source through a Range-capable
local route, rejects a byte-length mismatch, and records the frozen source hash.
The case is included in validation typecheck and production Vite build.

`web-authored-large-perf` reuses the same production path as a diagnostic
control with the local 477,591,060-byte authored GLB: 4,871,612 source
triangles, 1,041 nodes, 1,920 primitives, and a 1,364,306-triangle maximum
primitive. Its source hash and workload identity are frozen independently. It
is suitable for routine production-path and machine-capacity diagnosis, but it
is not promotion evidence for the 100M claim. Its canonical input and decoded
Product windows are capped at 64 MiB and 128 MiB respectively so the portable
WASM producer retains room for its bounded construction intermediates.

One execution performs 120 warmup and 480 measured frames for each of three
measurement windows, with timestamp-query required. It records the first complete
meaningful Product frame before total shard cook completion, then waits for every
shard before sampling. A camera cut explicitly invalidates view history; recovery
is the first successful fallback frame and uses the maximum CPU/GPU frame time.
`gpuGeometryBytes` is currently a conservative renderer allocation peak rather
than a geometry-only subtraction and must be labelled as such in reports.
The host grants this L4 PERF case a bounded 30-minute deadline and records the
latest cook heartbeat; ordinary validation cases retain the five-minute ceiling.

The repository contains an executable formal gate but no accepted clean-run
evidence until `node tools/vibe.mjs case web-100m-formal-perf --run` succeeds on
the committed revision. Until then it makes no `RuntimeValidated`,
`PerformanceEvaluated`, or cross-adapter performance claim.

This contract does not permit old benchmark JSON, a dirty worktree, an authored
control scene, the 1.6B-triangle Zorah archive, or a Node-only sample to stand in
for the formal 100M browser run.
