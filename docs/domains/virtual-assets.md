---
id: virtual-assets
kind: domain
owner: virtual-assets
contracts: 
  - geometry-product-v1
  - virtual-geometry-runtime-v1
  - web-geometry-cooker-abi-v1
  - web-cook-session-protocol-v1
claims: 
  - virtual-assets.product-consumer
  - virtual-assets.web-cook
  - virtual-assets.lifecycle
---
# Virtual Assets

The asset domain owns device independent runtime packages, Web/Offline Product admission, page residency, and the mapping into the shared GPU scene. Loaders and cookers produce a validated Product; they do not own long lived GPU resources.

The production route is:

```text
GLB/glTF or OEGPACK -> Product descriptor/pages -> admission -> residency
 -> GpuScene/GpuRenderWorld -> hierarchy/work -> hardware visibility
```

The stable contracts are in `docs/specs/geometry-product-v1.md`, `docs/specs/virtual-geometry-runtime-v1.md`, and the OEGPACK specs. The source and algorithm trace is in `docs/porting/geometry.md` and the Nyx ledger. Durable claims are `virtual-assets.product-consumer`, `virtual-assets.web-cook`, and `virtual-assets.lifecycle`; their case links are in `project/claims/virtual-assets.yaml`.

Required evidence covers producer neutral admission, GPU consumption, bounded cook budgets, replacement generation, page demand, cancellation, and device recovery. A successful cook without a live GPU consumer is not an asset-domain completion.
