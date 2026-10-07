---
id: specs/web-geometry-demand-compaction-v1
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryDemandReadbackRing.ts
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
---
# Web Geometry GPU Demand Dedup / Compaction V1

Status: candidate

Owners: `HierarchicalWorkGenerator`、`GeometryPageDemandAbiV1`、`GeometryPageStreamingRuntimeV1`、`GeometryPageSchedulerV1`

## Version/Compatibility

The demand record remains ABI V1: a 16-byte little-endian record and a 16-byte
queue header. The frame-local Product mask is scratch state and is not part of
the readback payload. A consumer must treat an unknown mask or queue ABI as a
hard incompatibility; it must not decode the queue by guessing offsets.

## Scope

Phase G removes repeated requests for the same Product-local page before the
GPU demand queue is copied to a readback ring. The existing delayed CPU path is
still the consumer: it validates Product identity/generation, performs any
cross-source deduplication, schedules bounded reads, and uploads through
`VirtualGeometryResidency`. This feature does not build a CPU visible list and
does not make a synchronous GPU readback.

## Contract

### Demand queue

The queue has a fixed 16-byte header followed by `capacity` records:

```text
header + 0  attempted       u32 atomic reservation count
header + 4  capacity        u32 immutable record capacity
header + 8  overflow        u32, 0 or 1
header + 12 frameRevisionLow u32 producer frame identity

record + 0  productTableSlot u32
record + 4  productGeneration u32
record + 8  pageId           u32, Product-local
record + 12 priorityFlags    u16 priority + three defined flags
```

The queue is bounded to 256 KiB (`16 + capacity * 16`). A reservation whose
index is at or above `capacity` is dropped and sets `overflow`; the producer
never writes past the queue. The readback ring copies only this bounded queue.

### Product-local request mask

Each prepared virtual-geometry work set owns one frame-local mask for its scene
Product directory. Its layout is:

```text
mask + 0  attempted  u32 atomic request attempts
mask + 4  unique     u32 first-seen page bits
mask + 8  duplicates u32 requests rejected by an already-set bit
mask + 12 overflow   u32 mask/page range overflow flag
mask + 16 words      array<atomic<u32>>, one bit per global page location
```

The bit index is `product.pageBegin + ProductLocalPageID`; distinct Products
cannot alias. `wordCount = ceil(scenePageLocationExtent / 32)`. The mask is cleared before every visibility
submission and the same mask is shared by hierarchy root/traversal producers in
that submission. `atomicOr` returns the previous word; only the first caller
whose bit was clear may reserve a queue record. A pageId outside the declared
Product range sets mask overflow and emits no record. Mask scratch is bounded to
1 MiB and is never mapped or read back as page payload.

The producer supplies one priority/flag tuple for the current view or shadow
pass, so duplicate records in one producer epoch have identical priority. The
CPU `deduplicateGeometryPageDemandsV1` step remains required when main-view and
shadow rings or multiple delayed frames are merged; it keeps the highest
priority tuple for an identity.

## Ownership and flow

```text
HierarchicalWorkGenerator (GPU root/traversal)
  -> Product-local atomic page mask
  -> bounded GeometryPageDemand queue
  -> GeometryDemandReadbackRingV1 (copy now, map after a later completion)
  -> GeometryPageStreamingRuntimeV1
  -> GeometryPageSchedulerV1 (identity/hash/retry/IO budgets)
  -> VirtualGeometryResidency (GPU upload and page location publication)
```

The generator owns the frame-local queue and mask. The readback ring owns its
staging slots. The scheduler owns source reads only when registered with the
default ownership mode; residency remains the owner of GPU page resources.

## Overflow and lifecycle

- Queue overflow drops only records that do not fit; `attempted`, `capacity`,
  and `overflow` remain observable in the copied header.
- Mask overflow is diagnostic and conservative: the invalid page emits no
  record. The mask and queue are reset on the next frame, so a full queue or a
  camera cut cannot grow retained state.
- Delayed readback slots are bounded (default three, each at most 256 KiB), and
  mapping is allowed only for frames strictly older than the caller's completed
  frame.
- Product generation and table slot are carried in every record. Stale or
  replaced Products are rejected before a page read; cancellation aborts reads
  and cannot publish a late page.
- Encoding reserves a slot; successful command submission commits it. Abort
  cancels the reservation and permits same-frame retry. Reset invalidates late
  maps. If one map fails, successful sibling maps are released and the failure
  is reported; no ready slots are silently abandoned.
- Feature-off paths allocate no demand queue, mask, readback ring, or scheduler
  resources.

Verified raw CPU pages and in-flight read reservations share one byte budget
(default 4 MiB in the production streaming composition). Upload/cancel releases
verified storage. Layout preflight retains no expanded attribute payload; that
decode is synchronous at upload. Provider caches, digest/copy temporaries and
decode scratch are separate from this retained queue budget.

Read/upload selection balances per-Product service counts, then local priority
and age. An indivisible expanded page may exceed the adaptive soft upload
target, never the hard cap; explicit remaining frame credit is respected.
Blocked physical allocation triggers the existing frame-between pump:
non-pinned age/hysteresis candidates → revoke → fence for all submitted
consumers → release → upload retry. The pump does not drive current-frame work
and introduces no submit. Working sets larger than budget can still thrash;
pending/blocked/verified/peak, IO P50/P95, reload and thrash bytes are observable.
Mapping/fence failures are reported through runtime/Renderer diagnostics.
Shadow feedback remains conditional on a real Geometry shadow-demand producer;
this interface alone does not establish that producer.

## Validation

Node contract/oracle evidence covers:

- 16-byte demand record/header packing and reserved-bit rejection;
- Product-local camera-cut duplicate reduction, mask statistics, clear/reset,
  and bounded page-id overflow;
- WGSL `atomicOr` mask producer and binding 14 wiring for root/traversal;
- delayed readback, queue overflow accounting, scheduler identity/hash checks,
  retries, upload budgets, cancellation, and generation retirement.

This candidate spec alone does not claim browser `RuntimeValidated` or formal
PERF. Those require accepted `large.glb` K1/K2 evidence for the current revision.
