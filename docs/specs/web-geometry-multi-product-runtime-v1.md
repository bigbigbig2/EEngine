---
id: specs/web-geometry-multi-product-runtime-v1
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/render/pipeline/RendererCore.ts
---
# Web Geometry Multi-Product Runtime V1

Status: frozen

Owners: `GeometryProductMultiRuntimeV1`, `VirtualGeometryResidency`, `GpuScene`, renderer

## Version/Compatibility

Cooked Product schema remains 1; runtime GPU ABI is version 3. Product Table records are 64-byte little-endian records;
instance ABI V8 remains 176 bytes. Unknown flags, reserved values, stale
generations, invalid ranges, and unsupported record sizes fail closed.

## Contract

The Product-per-Shard route incrementally admits independent revisions, appends
their immutable tables into one scene metadata heap, publishes appended scene
state incrementally, and renders through the normal hierarchy, MeshletWork, hardware visibility,
and shading consumers. The first admitted shard can render before total cook
completion. No frame builds a CPU final-visible list.

The combined heap contains one header followed by Product Table, asset references,
asset records, roots, hierarchy nodes, groups, page locations, and vertex formats.
This is the sole authoritative GPU directory. Product owners retain CPU
descriptors and source/page lifetimes, without allocating duplicate local GPU
metadata or a standalone Product Table buffer. A small CPU free-range list
reuses section ranges only after the last-consumer fence; published ranges do
not move. A second Product relocates asset/root/hierarchy/group/page/
vertex-format ranges; root node IDs and hierarchy child/group IDs are rewritten to
the combined namespace. Page IDs remain Product-local: Product `pageBegin` selects
the global page-location range and the local PageID indexes within it.

The authored workload derives Product Table slots and combined metadata capacity
from its catalog and negotiated limits. Each buffer is independently limited by
`maxBufferSize` and `maxStorageBufferBindingSize`. The scene directory (default
64 MiB) is budgeted separately from shared page banks. Section proportions remain
fixed; a live/candidate/retiring set that cannot fit is explicitly rejected.
Releasing a bounded live set repeatedly must not exhaust cumulative capacity.

## Product Table ABI

Each record contains 16 `u32` words:

```text
0   productGeneration       4   flags (bit 0 = ACTIVE)
8   assetBegin             12   assetCount
16  rootBegin              20   rootCount
24  hierarchyBegin         28   hierarchyCount
32  groupBegin             36   groupCount
40  pageBegin              44   pageCount
48  vertexFormatBegin      52   vertexFormatCount
56  reserved0              60   reserved1
```

The CPU mirror and record embedded in the combined heap use the same relocated
ranges. There is no second GPU Table. Empty/dormant slots are zero.
ACTIVE is published only after activation pages and metadata are ready.

## Identity and routing

An instance references `(ProductTableSlot, ProductGeneration,
AssetReferenceIndex)`. `GpuScene` writes slot and generation per instance; the
asset reference resolves the Product-local asset record. Page demand, completion,
eviction, and cache identity remain `(ProductTableSlot, ProductGeneration,
ProductLocalPageID)`.

The GPU demand mask uses `product.pageBegin + localPageId`, so different Products
cannot alias the same mask bit. Readback records preserve local identity and one
`GeometryPageStreamingRuntimeV1` routes completions to the matching residency.
Upload and location sinks carry exact slot, generation and local PageID, rather
than resolving the first matching ProductID/revision.
All residencies share the same negotiated four bank objects; page locations from
every Product therefore resolve through the one renderer binding set.

## Lifecycle and failure

```text
load -> active -> dormant/active -> retiring -> released
                 replace -> new active; old generation retires separately
```

Late demand/completion, invalid Product/Page identity, hash mismatch, and slot
reuse reject without mutating the current generation. A later shard failure does
not retract already published shards. Release withdraws the scene publication,
unregisters streaming generations, retires GPU work, and then frees source,
metadata, and shared slots. Replacement constructs a candidate without revoking
the old current publication; failure preserves it. Release/retire/evict without
an explicit completion token capture `queue.onSubmittedWorkDone()`; a rejected
fence never authorizes reuse. Loading/candidate entries remain cancellable, and
late completion cannot revive a released slot.

Residency publication events synchronously withdraw streaming registrations:
dormant/retiring abort reads and drop verified pages, reactivation registers the
same source again, destruction removes the subscription. This cancellation
precedes source release and does not authorize early GPU slot retirement.

On device loss the Renderer checkpoints every active/dormant owned source,
slot, generation and asset-reference range, then replays all sources into the
replacement device. Old GPU objects, maps and IO registrations are discarded.
Generation is preserved as scene identity under a new device epoch; it does
not authorize old-device completions. Source ownership transfers only after
the whole replay succeeds; failed replay retains readable sources for retry.

## Validation

Contract/oracle coverage includes 64 simultaneous shards, relocated second-Product
ranges, shared page-location publication, per-instance slot/generation lanes,
global demand-mask indexing, multi-Product streaming routing, scene merge of
transform/material/bounds, replacement/dormancy/eviction/release, stale identity,
and slot ABA. G2.1 adds 1/8/64/66-source recovery, repeated range reuse beyond
old cumulative capacity, rejected-fence safety, bounded verified IO, fair
multi-Product pressure, and a real two-Product Renderer recovery oracle.
These small fixtures do not prove large-scene performance. Current production browser performance promotion requires clean
`web-authored-large-perf` evidence after authored K0/K1. Implementation alone is
not RuntimeValidated or PerformanceEvaluated.
