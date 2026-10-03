# EEngine performance guidance

Read this reference when implementing or reviewing a renderer hot path, a new
GPU product, a cache, a queue, a dispatch, a shader work generator, or a data
layout. It is a set of stable defaults, not a requirement to run a performance
audit for ordinary coding. Only perform the review checklist at the end when
the user explicitly asks for a performance review or the change itself is a
performance optimization.

## Optimize the work that exists

The fastest GPU work is work that is never generated. Prefer the flow:

```text
visibility or demand
  -> classify
  -> compact actual work
  -> execute the compact queue
```

Bind dispatch and allocation to `visibleCount`, `activeCount`, `missCount`,
`dirtyCount`, `requestedCount`, `residentCount`, or `signalCount` when those
facts exist. Prefer GPU-generated indirect arguments over CPU scheduling based
on worst-case capacity. An early return in a full-capacity dispatch still pays
for lanes, scheduling, and part of the dispatch.

Use a finite set of program or work families when divergence or skipped work is
materially reduced. Do not create a dispatch for every material, field, or
feature: command encoding, bind groups, pipeline switches, and dispatches also
cost time. Limit shader specialization to useful program families instead of
the Cartesian product of every feature. Local binning or bounded compaction can
be better than a global sort. When sorting, balance shader coherence with
texture and spatial locality; perfect material order is not automatically the
best memory access pattern.

## Spend bandwidth deliberately

For every new GPU record or intermediate, be able to derive its stride,
capacity, active bytes, reserved bytes, and lifetime. Ask whether a field can be
reconstructed, shared, published once, or kept on a cold path. Keep hot data
compact and separate optional or rarely used data into cold products. Choose
AoS, SoA, or a hybrid from the consumer access pattern and coalescing needs,
not from a TypeScript API preference.

Compare recomputation with materialization. Cheap ALU over a small value can be
better than a large irregular write and reload; an expensive compact fact used
by several consumers can justify a shared product. Do not add a full-resolution
intermediate merely to save a small amount of arithmetic. Check whether the
signal really needs output, material, lighting, and history at the same rate.
Retain higher rates for high-frequency features such as specular, thin edges,
normal detail, coat, and hard shadow boundaries; coarse rates are more suitable
for slowly varying diffuse, AO, or environment signals.

Temporal data follows the signal domain. A stable or absent signal does not
need a full-resolution history buffer; use no history, a compact history, a
shared history, or a coarse history when its quality contract permits it.

## Own memory and lifetime explicitly

Keep persistent resources (for example FieldStore, SignalStore, and residency)
separate from frame scratch, batch-local queues, transient products, and
temporal history. Prefer bounded batch working sets over giving every stage a
buffer sized for the largest possible frame. Persistent caches may have their
own capacity, but transient geometry, material, lighting, and scratch products
should track the bounded work budget.

Avoid rebuilding the same facts in multiple consumers. A shared GeometryRecord
or frame-local setup is useful when it removes repeated visibility, triangle,
barycentric, position, normal, or material-identity reconstruction, provided
the memory traffic is smaller than the saved work. Do not materialize a giant
full-screen product for a handful of consumers.

Cache identity must include every dependency that changes the result, such as
geometry lineage, program or material version, texture/content version, LOD,
view dependence, lighting dependence, and footprint validity. A stable field
must not be invalidated merely because the camera moved. Prefer precise
component invalidation over clearing an entire cache. Correct identity is more
important than a higher apparent hit rate.

## Keep the frame GPU-driven

The normal render path must not use a current-frame GPU readback to decide the
next GPU workload. Use counters and indirect arguments inside the frame graph;
reserve readback for diagnostics, profiling, offline tools, or future-frame
decisions. Passes must not call `device.queue.submit` privately. Keep one frame
owner, one command lifecycle, and explicit FrameGraph ordering.

Avoid per-frame GC pressure in hot paths. Reuse scratch storage, typed arrays,
descriptors, and stable arrays when this is a real steady-state path. Do not
create shader modules, pipelines, layouts, samplers, or other GPU objects in
the frame loop. Precreate or cache pipelines and stable bindings; dynamic bind
groups are appropriate when their views or resources truly change.

Treat binding limits, storage-buffer limits, bind-group count, and command
encoding cost as architecture constraints. Keep the baseline portable. Optional
subgroups, shader-f16, primitive-index, immediates, buffer views, or future
atomic capabilities may specialize a bounded fast path with the same semantics;
they must not be required for correctness.

## Keep parallel work healthy

Avoid giant kernels in which a wave handles many unrelated material or work
types. Classify, bin, and compact toward homogeneous work when divergence or
idle lanes are significant, while avoiding an explosion of tiny dispatches.
Aggregate queue allocation and counters in a workgroup or subgroup before
using a global atomic when contention can be high. Do not assume subgroup size
or lane mapping without an explicit capability guarantee.

Keep barriers and synchronization visible. WebGPU has no arbitrary global
barrier inside one dispatch; express a real producer-to-consumer boundary as
separate FrameGraph passes. A lane-0 loop over substantial data is a reference
or correctness implementation unless the data is genuinely tiny; consider
cooperative reduction, prefix, shared-memory, or subgroup work when optimizing
that path.

Keep diagnostics and overflow handling cold and switchable. When diagnostics
are disabled, avoid writing counters or debug records merely for a later CPU
decision. A fast path should skip heavy resources, queues, lookups, and
dispatches as early as its contract allows.

## Quality and worst-case behavior

Performance work preserves the same visual result unless a variable-rate or
approximation contract is explicit. Do not claim a speedup by disabling shadows,
specular, coat, temporal behavior, or texture quality. Check legal worst cases:
all misses, fine geometry, many materials or lights, full caches, queue
overflow, camera cuts, LOD changes, and texture updates. They may be slower, but
must remain bounded, correct, and deadlock-free.

Controlled benchmark profiles may exist, but must remain clearly separate from
the production profile. Disabling real features, fixing the camera, or replacing
materials to obtain a number does not establish production performance.

## Focused performance review questions

When the user explicitly requests performance review, ask:

- Does this generate work that visibility or demand could remove?
- Is work sized by actual or bounded demand rather than maximum capacity?
- Does it add a full-resolution intermediate, memory traffic, random access, or
  repeated reconstruction that costs more than the ALU it saves?
- Does it add excessive dispatches, bind-group changes, pipeline switches, or
  per-frame CPU/GPU object creation?
- Does it introduce current-frame readback, a private submit, broad invalidation,
  shader divergence, atomic contention, or hidden copying?
- Can the result be compacted, indirect, batched, cached safely, hot/cold split,
  or kept batch-local without changing the quality contract?
