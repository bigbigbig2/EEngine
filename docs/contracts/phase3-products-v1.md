---
id: phase3-products-v1
kind: contract
status: proposed
owners:
  - frame-runtime
  - shading
version: 1
consumers:
  - OEngine/src/render/pipeline/Phase3Products.ts
  - OEngine/src/render/pipeline/RendererCore.ts
invariants:
  - a named product is not production until its producer, consumer, resource lifetime, and focused validation are present
  - environment products consumed by one frame carry one immutable environment generation
  - temporal products carry frame revision and history validity before reuse
validation:
  - focused module-close tests; final GPU acceptance is deferred
---
# Phase 3 Product Semantics

This contract records only products that actually appeared in the Phase 3
implementation. It is an inventory and ownership boundary; it does not promote
an entry to production merely because a type or pass has the same name.

| Product | Owner | Intended consumer | Generation | Current state |
| --- | --- | --- | --- | --- |
| `PhysicalSun` | `PhysicalEnvironmentRuntime` | Surface direct lighting | environment | production |
| `SkyRadiance` | `PhysicalEnvironmentRuntime` | Sky background and aerial transport | environment | production: shared 3D scattering and higher-order LUT |
| `SkyIrradiance` | `PhysicalEnvironmentRuntime` | Surface indirect environment lighting | environment | production |
| `AerialScattering` | `AerialPerspectivePass` | FSR3 Upscaler, Present | environment | production: camera-to-point LUT transport |
| `Motion` | Surface material path | FSR3 Upscaler, Temporal Fabric | frame | production: rg16float product, spatial frequency resolved before FSR3 |
| `TemporalDepth` | Visibility depth | FSR3 Upscaler, Temporal Fabric | frame | production: current visibility depth and GPU reconstructed previous depth |
| `PreExposure` | `RadiometryRuntime` | Surface, FSR3, Temporal Fabric | pre-exposure | production: frame contract and history scaling |
| `TemporalReconstructedColor` | FSR3 Upscaler | Present | frame | production integration: output-full radiance; GPU quality acceptance deferred |

All environment entries carry one immutable `EnvironmentPublication` generation.
All temporal entries carry the frame revision and history validity that selected
them. The machine-readable names and states are in
[`Phase3Products.ts`](../../OEngine/src/render/pipeline/Phase3Products.ts).

This contract intentionally contains no future GI, VSM, VT, FSR3 internal, or
generic effect products.
