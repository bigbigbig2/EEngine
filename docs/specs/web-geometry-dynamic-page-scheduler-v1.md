---
id: specs/web-geometry-dynamic-page-scheduler-v1
state: current
verifies:
  - OEngine/src
---
# Web Geometry Dynamic Page Scheduler V1

Status: candidate

Owners: `GeometryPageSchedulerV1`, `GeometryPageStreamingRuntimeV1`,
`VirtualGeometryResidency`

## Version/Compatibility

Phase J changes scheduling policy only. ProductID, generation, PageID, decoded
page bytes, demand ABI, delayed readback ring, and residency ownership remain
unchanged. Existing `maxConcurrentReads`, `maxInFlightBytes`, and
`maxUploadBytesPerFrame` are hard caps for every adaptive profile.

## Contract

`setPressure()` consumes delayed, caller-owned observations:

- camera state: `stable`, `moving`, or `cut`;
- IO throughput in bytes/second;
- normalized GPU pressure;
- frame time and target frame time.

The scheduler maps these values to a bounded budget. `cut` selects the declared
caps for a temporary burst. Stable views use a lower baseline and high GPU,
frame, or IO pressure further throttles the budget. The selected budget is
never below the configured minimums or the decoded page size.

The scheduler still consumes delayed GPU demand only on the CPU scheduling
side; it never rebuilds a visible list or waits for the current GPU submission.
Priority, generation checks, retries, cancellation, hash verification, and
upload sink ownership are unchanged.

## Capacity and overflow

Read concurrency, source bytes in flight, and upload bytes per frame are each
bounded independently. Existing demand/readback overflow, malformed readback,
retry, cancellation, and upload-budget counters remain authoritative. Adaptive
evidence additionally records pressure samples, budget changes, camera-cut
bursts, throttled frames, last pressure, and the active budget.

## Lifecycle and failure

`GeometryPageStreamingRuntimeV1.updatePressure()` fails when the runtime is
destroyed. Invalid pressure values fail before changing the budget. Product
unregister aborts non-resident operations and recomputes the page-size floor;
late results cannot publish against a removed generation. Device-loss/recovery
continues to use the existing Product generation and residency owner.

## Validation

`OEngine/tests/unit/geometry-page-scheduler-adaptive.test.mjs` covers bounded
throttling, camera-cut bursts, and invalid pressure. Existing scheduler tests
continue to cover identity/hash failure, retry, read concurrency, upload budget,
delayed readback, generation cancellation, and demand overflow.

This is implementation/unit evidence. Camera-cut recovery and IO/GPU pressure
curves still require independent browser evidence on the frozen workload; no
formal PERF claim is made here.
