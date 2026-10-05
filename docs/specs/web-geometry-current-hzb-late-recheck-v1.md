---
id: specs/web-geometry-current-hzb-late-recheck-v1
state: current
verifies:
  - OEngine/src
---
# Web Geometry Current-HZB Late Recheck V1

Status: candidate

Owners: visibility (`CurrentHzbLateRecheckGpu`), renderer HZB owner

## Version/Compatibility

The production path does not introduce a second visibility identity. Input and
output use the standard 32-byte MeshletWork queue header and 24-byte
`MeshletRasterWork` record, preserving the VisibilityKey work-slot namespace.
The older 32-byte diagnostic candidate and 65,536-record CPU oracle remain only
for policy tests; they are not the production queue ceiling.

## Contract

```text
previous-HZB hierarchy traversal
  -> source Product MeshletWork
  -> coarse hardware raster/depth
  -> current reverse-Z HZB build
  -> current-HZB compute filter
  -> filtered MeshletWork + GPU-written drawIndirect
  -> final hardware raster consuming that exact output
```

The compute pass resolves the Product asset from per-instance generation, reads
meshlet bounds from the combined Product metadata/banks, projects eight bound
corners, samples the current HZB at the selected mip, and rejects only a
conservatively occluded record. Invalid projection, asset, hierarchy, page,
generation, NaN/overflow, stale source generation, source overflow, and source
invalid state all retain the source record.

Reverse-Z rejection is `candidateNearest + epsilon < occluderFarthest`, with the
farthest occluder depth equal to the minimum of four footprint-corner samples.
The final raster clears VisibilityKey/shading-bin outputs, loads coarse depth,
uses `greater-equal`, and consumes the filtered queue and indirect record without
CPU readback.

## Capacity and lifecycle

Production capacity is the prepared source MeshletWork capacity, bounded by the
24-bit VisibilityKey slot space and the negotiated minimum of `maxBufferSize` and
`maxStorageBufferBindingSize`. The filter writes every indirect field. Because
output capacity equals source capacity, fail-open copying cannot partially
publish; an unexpected output overflow is observable.

The feature is Product-only and currently mutually exclusive with TriangleSetup.
When disabled or inapplicable, no owner, queue, indirect buffer, bind group,
FrameGraph pass, readback, or extra submit is created. Resource retirement is
ordered after GPU completion.

## Validation

The CPU oracle covers conservative rejection, invalid metadata, and overflow
fallback. Production source checks prove the FrameGraph order, standard queue
input/output, GPU indirect consumer, fail-open publication, and feature-off
pruning. Dense-occlusion screenshot parity and GPU timing remain Phase K browser
evidence and are not inferred from Node tests.
