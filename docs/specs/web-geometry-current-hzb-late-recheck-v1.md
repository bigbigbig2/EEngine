# Web Geometry Current-HZB Late Recheck V1

Status: candidate

Owners: visibility (`CurrentHzbLateRecheck`), renderer HZB owner

## Version/Compatibility

Phase I adds an optional recheck hint queue. It does not change VisibilityKey
V2, MeshletRasterWork, Product/Page, or HZB texture formats. A consumer may
enable it only when the current HZB and conservative projection metadata are
available in the same frame.

## Candidate ABI

Each 32-byte record contains:

| word | field |
| ---: | --- |
| 0 | frame-local `workSlot` |
| 1 | `flags` (`Uncertain`, `Expensive`, `Conservative`) |
| 2-3 | normalized screen minimum |
| 4-5 | normalized screen maximum |
| 6 | reverse-Z nearest depth |
| 7 | raster vertex estimate |

The queue header is the existing 32-byte atomic header shape:
`attempted`, `written`, `consumed`, `capacity`, `overflow`, `generation`,
`invalid`, and `reserved`.

## Producer/consumer

The previous-HZB hierarchy and normal MeshletWork producer remain the source
of candidates. A bounded GPU late-recheck producer samples the current HZB at
the candidate footprint and publishes a compact retained queue. The final
visibility consumer may use that queue only when `overflow == 0`; otherwise it
must use the source queue unchanged. The CPU oracle is diagnostic and never a
frame-local visible-list producer.

Only candidates marked `Uncertain` or `Expensive` and `Conservative` are
eligible for rejection. Invalid projection/depth metadata fails open. Reverse-Z
occlusion uses the HZB farthest sample (`min` of the four footprint corners):
`candidateNearest + epsilon < occluderFarthest`.

## Contract

The source queue is authoritative for correctness. A late-recheck queue is an
optional optimization snapshot: it may replace the source only after its
generation, capacity, and overflow fields pass validation. A missing current
HZB, invalid record, stale generation, or non-zero overflow selects the source
queue without a CPU visible-list traversal.

## Capacity and lifecycle

The default maximum capacity is 65,536 records. The prepared output capacity
must be at least the source candidate count for an optimization-enabled frame.
An all-or-nothing reservation records overflow and publishes no partial queue.
Feature-off or unavailable current-HZB metadata creates no queue, bind group,
dispatch, readback, or submit. Queue generation and Product identity remain
frame-local; stale generations fail open to the source queue.

## Validation

`OEngine/tests/oracle/current-hzb-late-recheck.test.mjs` covers:

- conservative uncertain rejection against a reverse-Z HZB;
- expensive-but-not-conservative fail-open behavior;
- invalid projection metadata and parity-unknown evidence;
- bounded overflow falling back to the complete source queue;
- WGSL producer/consumer, atomic reservation, and fail-open guards.

This is implementation/oracle evidence. Dense-occlusion browser evidence that
proves selected meshlets, raster vertices, GPU visibility time, and screenshot
parity still requires the independent `validation/` host; it is not claimed by
this spec.
