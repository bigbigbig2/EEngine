---
id: web-geometry-authored-large-gate-v1
kind: contract
status: candidate
owners:
  - virtual-assets
version: 1
consumers:
  - validation/workloads/web-authored-large-cook-k0-v1.yaml
  - validation/workloads/web-authored-large-runtime-smoke-v1.yaml
  - validation/workloads/web-authored-large-perf-v1.yaml
  - project/claims/virtual-assets.yaml
invariants:
  - the authored large source identity is frozen
  - full catalog primitive coverage is required
  - Product count is recorded but not equated to primitive count
  - every Product partition has a stable non-colliding Product scope identity
  - partial catalog coverage is terminal failure, never cook-complete
  - authored evidence cannot be relabelled as 100M evidence
validation:
  - web-authored-large-cook-k0
  - web-authored-large-perf
---
Status: candidate
Owners: virtual-assets

# Authored Large Gate V1

## Version/Compatibility

Version 1 replaces the immediate ADR-0018 acceptance workload with the frozen
authored `large.glb`; it does not relabel authored evidence as deferred 100M
scale evidence.

## Contract

The current ADR-0018 acceptance target is the fixed authored scene:

```text
source: large.glb
sha256: 54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f
bytes: 477,591,060 (about 455 MiB)
triangles: 4,871,612
nodes: 1,041
primitives: 1,920
maximum primitive: 1,364,306 triangles
```

### K0 cook gate

The `web-authored-large-cook-k0` case proves producer lifecycle without
formal timestamp sampling:

```text
catalog
  -> bounded source/canonical windows
  -> work-bounded Product/shard cook
  -> activation/publication
  -> full page spill and reread
  -> catalog coverage
  -> settled and disposal
```

K0 starts with a 32 MiB canonical budget, 128 Ki triangle budget, 512 Ki vertex
budget, 64-domain budget, 128 MiB per-Product decoded budget, and 1 GiB session
spill budget. Actual Product count and spill peak are observations; neither is a
hard-coded 1,920 Product requirement.

K0 uses its own producer-only page, without Renderer or GPU allocation. Required
receipt fields are source identity, catalog count and covered primitive set,
Product/shard count, exact per-primitive triangle totals and complete shard ordinal
sets, first activation and total cook time, task phase pairs and unique terminals,
owner current/peak/limit bytes, checksum-verified rereads of every declared page,
settled state, and acknowledged worker artifact disposal with zero live owners.
GPU errors and camera-cut recovery belong to K1.

Every ordinary window and spatial shard derives ProductID from a stable Product
scope (planner/partition version, ordered catalog mapping, and canonical window
digests). Runtime task ordinal is evidence only and cannot participate in the
identity. If any required Product fails before the union reaches all 1,920
catalog primitives, the session must reject `waitForCookCompletion()`, emit no
`cook-complete`, and retain the exact failed task/phase in evidence. Optional
refinement is recoverable only after full coverage already exists.

The K0 case is executable because the validation page asserts coverage, task
trace, session spill accounting, settled state, and disposal. A placeholder
case that can pass without those assertions remains forbidden.

Product scope includes the stable planner partition key (spatial shardId or
ordinary ordered catalog mapping) and canonical digests; runtime task ordinals
remain evidence only. `cook-complete` ends revision enumeration but leaves page
requests available. Graceful `disposeAsync()` waits for `session-disposed`
acknowledgement after artifact cleanup, then terminates; timeout/failure rejects
instead of claiming cleanup. Immediate `dispose()` remains forced termination.

The independent K0 page uses catalog coverage and work-budget assertions. Formal
`web-authored-large-perf` remains a future promotion identity until K0 and K1
browser evidence pass.

### K1 runtime and performance

After K0 passes, planned workload `web-authored-large-runtime-smoke-v1` exercises
camera movement, page demand, ancestor fallback, camera-cut recovery, settled,
and disposal on the same source. Its executable case is registered only after
those actions and assertions exist. Formal authored PERF runs only after K0 and
the producer debt items pass.

### Deferred scale target

Scale receipts distinguish `unique-source-multi-primitive`, `single-giant`, and
`instanced-logical`. Record unique source triangles, maximum primitive triangles,
instance count, and logical triangles separately. No category proves another.
Before single-giant acceptance, partition ownership must use bounded external
storage; a full-primitive triangle-index scratch allocation is not scale proof.

Product thresholds are workload policy. Changing them requires measured cook
tail/activation time, Product/root/metadata counts, duplicated boundary vertices,
and residency cost, plus cross-shard seam, conservative bounds, LOD error and
fallback continuity verification. Smaller Products alone are not an improvement.

GPU capacities must fit negotiated device limits. OPFS admission records actual
storage quota/usage estimates separately from the configured session spill cap;
estimates do not reserve space, so quota failures must fail required production
without successful settlement and release owned artifacts. Concurrent work shares
source/canonical/WASM/inflight budgets rather than multiplying per-task limits.

The synthetic single-giant 100M workload remains a later scale gate. Its result
belongs to `virtual-assets.scale-performance`; authored evidence and 100M scale
evidence cannot promote each other's claims.

## Validation

`web-authored-large-cook-k0` is executable only with catalog coverage, Product
task trace, independent session spill accounting, settled, and disposal
assertions. Formal promotion remains owned by `web-authored-large-perf`.
