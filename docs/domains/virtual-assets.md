---
id: virtual-assets
kind: domain
owner: virtual-assets
contracts: 
  - geometry-product-v1
  - virtual-geometry-runtime-v1
  - web-geometry-cooker-abi-v1
  - web-geometry-page-artifact-v1
  - web-geometry-multi-product-runtime-v1
  - web-geometry-residency-profile-v1
  - web-cook-session-protocol-v1
  - web-geometry-formal-perf-freeze-v1
claims: 
  - virtual-assets.product-consumer
  - virtual-assets.web-cook
  - virtual-assets.lifecycle
  - virtual-assets.performance
---
# Virtual Assets

The asset domain owns device independent runtime packages, Web/Offline Product admission, page residency, and the mapping into the shared GPU scene. Loaders and cookers produce a validated Product; they do not own long lived GPU resources.

The production route is:

```text
GLB/glTF or OEGPACK -> Product descriptor/pages -> admission -> residency
 -> GpuScene/GpuRenderWorld -> hierarchy/work -> hardware visibility
```

The stable contracts are in `docs/specs/geometry-product-v1.md`, `docs/specs/virtual-geometry-runtime-v1.md`, `docs/specs/web-geometry-residency-profile-v1.md`, and the OEGPACK specs. The source and algorithm trace is in `docs/porting/geometry.md` and the Nyx ledger. Durable claims are `virtual-assets.product-consumer`, `virtual-assets.web-cook`, and `virtual-assets.lifecycle`; their case links are in `project/claims/virtual-assets.yaml`.

Required evidence covers producer neutral admission, GPU consumption, bounded cook budgets, replacement generation, page demand, cancellation, and device recovery. A successful cook without a live GPU consumer is not an asset-domain completion. Formal performance additionally requires a clean frozen revision and matching browser/adapter/camera/workload identity. The official 100M source is now mounted by the independent host, but Phase K remains active until the committed clean-revision case produces accepted evidence.

## Current Production Path

Web GLB and Offline OEGPACK producers create the same versioned Product contract. Admission validates descriptors and activation cuts, residency maps verified pages into bounded physical storage, and the active product generation publishes atomically into `GpuScene`/`GpuRenderWorld` for hierarchy work and visibility consumption.

The Web 100M route publishes one Product per shard. `GeometryProductMultiRuntimeV1`
relocates immutable shard tables into one combined metadata heap, while `GpuScene`
writes Product slot/generation per instance and GPU demand uses global mask ranges
plus Product-local PageID records. One streaming runtime routes delayed completions
back to each shard residency. The renderer consumes this binding through the normal
hierarchy, current-HZB late recheck, indirect raster, and shading pipeline.

The Phase J scheduler keeps configured read concurrency, in-flight bytes, and
upload bytes as hard caps, then adapts within them from delayed camera, IO, GPU,
and frame pressure. Camera cuts may burst only to those caps; stable views and
pressure reduce the active budget. Adaptive evidence is scheduling feedback and
does not become a CPU visible-list producer.

## Owner Boundaries And Failure

Providers own source/cook/cache lifetime; admission owns validation and activation transactions; residency owns page state and physical slots; the renderer owns GPU publication and consumption. Late pages, old generations, cancellation, budget failure, replacement failure, and device loss cannot mutate the currently active generation.

## Main Entrypoints And Proof

Primary entrypoints are `OEngine/src/assets/`, `OEngine/src/loaders/`, `OEngine/src/geometry/`, `GeometryProductAdmission.ts`, and `VirtualGeometryResidency.ts`. Web, offline, and production-consumer cases promote producer neutrality; bootstrap/incremental/authored cases promote Web cook; replacement, incremental publication, and device loss promote lifecycle. Component and observer cases are diagnostic unless the claim policy says otherwise.
