---
id: web-geometry-product-work-budget-v1
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
  - Product admission is bounded by work and memory together
  - every accepted Product satisfies every declared limit
  - an oversized primitive is spatially sharded before WASM cook
  - ordinary windows use the same limits as spatial shards
validation:
  - planner contract and oracle tests
  - authored-large K0 receipt
---
Status: candidate
Owners: virtual-assets

# Web Geometry Product Work Budget V1

## Version/Compatibility

Version 1 adds work bounds to the existing Web Geometry Product planner without
changing the Geometry Product binary ABI.

## Contract

The authored-large target is bounded by cook work as well as memory. A Product
must not become a large synchronous WASM task merely because indexed vertices
fit inside a canonical byte window.

The planner evaluates these dimensions together:

```text
canonical bytes
triangle count
unique vertex count
domain count
```

The first authored target freezes this policy:

```text
maxCanonicalBytes      = 32 MiB
maxTrianglesPerProduct = 128 Ki
maxVerticesPerProduct  = 512 Ki
maxDomainsPerProduct   = 64
```

These values are workload policy, not Geometry Product ABI.

## Planning rules

1. A primitive that exceeds any work limit is spatially sharded before Product
   admission, even when its canonical byte estimate is below the byte limit.
2. Ordinary primitive batching flushes before adding a domain that would exceed
   any limit. It must not fill a byte window while ignoring triangle or domain
   work.
3. A shard owns triangles. Boundary vertices may duplicate; mutable vertex
   ownership may not cross shard boundaries.
4. The planner emits deterministic Product/shard identity, source primitive
   identity, bounds, and estimates before cook starts.
5. An unavailable estimate causes a conservative split or planning failure. It
   never permits an unbounded task.

## Validation

Every Product task receipt records all four dimensions, configured limits,
spatial-shard status, and shard ordinal/total. Authored K0 proves catalog
coverage separately from Product count:

```text
union(Product.sceneAssetIndices) == all catalog primitive indices
```

Product count is an observation. It is not required to equal the 1,920 authored
primitive count.
