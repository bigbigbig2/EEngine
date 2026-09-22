# Web Geometry Adaptive GPU Residency Profile V1

Status: candidate

Owners: `GeometryProductResidencyProfileV1`, `GeometryProductSlotPool`, `VirtualGeometryResidency`

## Version/Compatibility

V1 consumes the existing `oengine-vg-v1-v3-decoded` Product contract. It does
not change ProductID, revision, PageID, decoded page bytes, or GPU-visible
record strides. A profile is a device/runtime allocation choice, not a cook
format or cache identity.

## Scope

Phase H changes only the physical page-bank capacity. The Product descriptor,
decoded page size (256 KiB), PageID identity, hierarchy layout, page-location
record, Product Table record, shader bindings, and cooked bytes remain V1. A
Product can therefore be admitted without recook on all supported profiles.

## Profiles

Each profile uses four storage-buffer bindings. The profile values are bounded
targets, not claims about physical VRAM:

| Profile | Bank size | Total page capacity | Selection requirement |
| --- | ---: | ---: | --- |
| `Portable` | 128 MiB | 512 MiB | `maxBufferSize` and `maxStorageBufferBindingSize` >= 128 MiB |
| `Balanced` | 192 MiB | 768 MiB | both negotiated buffer limits >= 192 MiB |
| `HighEnd` | 256 MiB | 1 GiB | both negotiated buffer limits >= 256 MiB |

All profiles also require the Product consumer's negotiated
`maxStorageBuffersPerShaderStage >= 16`. The selector reads the post-device
limits; it never reads or infers physical adapter VRAM.

## Contract

### Selection

`selectGeometryProductResidencyProfileV1(limits, options)` is pure and creates
no GPU object. `requestedProfile` may be explicit or `auto`. `auto` starts at
Portable and may select HighEnd when supplied runtime evidence reports pressure,
demand overflow, or fallback work. An explicit profile falls back to the
largest profile that fits both negotiated limits and `configuredCapacityBytes`.
If no profile fits, or `featureEnabled` is false, the plan is `Disabled` and
`VirtualGeometryResidency.create` fails before metadata, page banks, demand
queues, or readback resources are allocated.

The selected plan is device-wide for a shared page-bank pool. All Product
revisions on one device must use the same profile while the pool is alive;
changing it requires a device/resource lifecycle boundary. A replacement
revision reuses the same Product/Page ABI and profile and does not recook.

## Budget and evidence

The GPU budget ledger records the selected capacity, current/peak bytes, and
metadata overhead. Profile evidence records negotiated limits, bank count,
bank bytes, slot capacity, runtime evidence, and the selected/fallback reason.
The ledger remains bounded during replacement: old and candidate revisions
share the same physical pool rather than allocating a second profile heap.

## Feature-off and low-limit behavior

Feature-off and unsupported-limit paths are fail-closed before
`GPUDevice.createBuffer`. They allocate no profile page banks. A caller may
still construct unrelated renderer state, but it must not create the Product
residency, demand queue, or readback ring when the plan is disabled.

## Validation

Contract coverage is in
`OEngine/tests/contract/geometry-product-residency-profile.test.mjs`:

- Portable/Balanced/HighEnd selection from negotiated limits;
- explicit fallback and runtime-pressure selection without recook;
- low-limit and feature-off zero-bank allocation;
- Balanced residency using four 192 MiB banks with the unchanged Product ABI.

This is implementation/contract evidence only. Independent browser evidence
across real adapters and formal 100M PERF evidence remain open.
