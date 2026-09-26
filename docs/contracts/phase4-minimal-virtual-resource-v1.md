---
id: phase4-minimal-virtual-resource-v1
kind: contract
status: proposed
owners:
  - virtual-assets
  - frame-runtime
version: 1
consumers:
  - Phase 4 virtual resource consumers
invariants:
  - logical identity is stable across frames and independent of queue indices
  - one frame accepts one publication generation and rejects mixed generations
  - replaced resources retire only after their final FrameGraph use completes
  - telemetry is diagnostic feedback and never a CPU-visible render-list producer
validation:
  - module-close targeted checks; final acceptance after the planned providers
---
# Phase 4 Minimal Virtual Resource Contract

Phase 3 defines the public seam that later virtual consumers must share. It is
not a runtime manager and does not allocate pages, VSM tiles, or VT storage.

Every virtual resource publication carries:

- **Logical identity**: a producer-neutral stable key for the scene/product and
  logical subresource. Frame-local queue indices are not identity.
- **Generation**: a monotonically increasing publication generation. A consumer
  accepts one generation for a frame and rejects mixed generations.
- **Budget**: declared byte/work limits with an explicit exhausted result;
  budget ownership stays with the concrete consumer.
- **Residency and validity**: `unavailable`, `resident`, `stale`, or `invalid`.
  Residency is a fact about a physical consumer allocation, not proof that a
  page was freed.
- **Safe retirement**: a replaced generation remains retired-but-live until its
  last submitted FrameGraph use completes. Device loss may destroy it
  immediately and invalidates its generation.
- **Telemetry seam**: counters for requested, resident, evicted, invalidated,
  budget-exhausted, and retired resources. Telemetry is diagnostic feedback and
  never a CPU-visible render-list producer.

Concrete geometry residency already has its own ABI and lifecycle in
`virtual-geometry-runtime-v1.md`. This Phase 4 contract does not merge that
ABI with a future VT or VSM cache, and it does not introduce
`UniversalVirtualResourceManager`.
