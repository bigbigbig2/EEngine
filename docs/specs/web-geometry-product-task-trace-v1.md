---
id: web-geometry-product-task-trace-v1
kind: contract
status: candidate
owners:
  - virtual-assets
version: 1
consumers:
  - OEngine/src/assets/web-cook
  - validation/workloads/web-authored-large-cook-k0-v1.yaml
  - validation/workloads/web-authored-large-perf-v1.yaml
invariants:
  - a long-running cook identifies its current Product and phase
  - phase timing is monotonic and attributable to one Product task
  - cancellation and failure leave an explicit terminal task record
  - units never substitute for Product or shard progress
validation:
  - task-trace contract and oracle tests
  - authored-large K0 trace artifact
---
Status: candidate
Owners: virtual-assets

# Web Geometry Product Task Trace V1

## Version/Compatibility

Version 1 is an additive CookSession telemetry event. It does not alter Product
or Page binary identity.

## Contract

`units` is catalog-primitive coverage. It is not Product progress and must not
be the only cook telemetry.

Each Product/shard task exposes this minimum identity:

```text
taskId
productOrdinal
primitive identity (mesh, primitive, scene asset index)
spatial flag
shard ordinal and shard count when known
triangle count
vertex count
domain count
canonical bytes
```

Catalog readiness remains the session-level `SceneCatalogReady` event. Product
V1 phases are:

```text
canonicalize
wasm-plan
spill
publish
cancelled
failed
completed
```

Every phase transition records `startedAt`, `endedAt`, `elapsedMs`, and
task-local counters. The task receipt also records:

```text
canonicalizeMs
wasmPlanMs
spillMs
publishMs
pageCount
spillBytes
```

The current-task snapshot supports watchdog diagnosis and the final artifact;
it does not claim that synchronous WASM is preemptible. A watchdog detecting a
blocked WASM call records the Product, last phase, and elapsed time instead of
reporting ordinary progress.

K0 acceptance requires a start and terminal event for every Product task plus
final settled and disposed events. A stall such as
`product=17, phase=wasm-plan, triangles=128K` must be observable without parsing
browser console prose.

## Validation

Oracle tests require attributable phase start/completion pairs and exactly one
terminal state per Product. Authored K0 additionally checks full catalog
coverage, settled state, session spill evidence, and harness disposal.
