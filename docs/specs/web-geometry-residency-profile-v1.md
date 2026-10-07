---
id: specs/web-geometry-residency-profile-v1
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryProductResidencyProfile.ts
    - OEngine/src/gpu/GeometryProductSlotPool.ts
    - OEngine/src/gpu/GeometryProductGpuBudget.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
---
# Web Geometry Adaptive GPU Residency Profile V1

Status: candidate

Owners: `GeometryProductResidencyProfileV1`, `GeometryProductSlotPool`, `VirtualGeometryResidency`

## Version/Compatibility

V1 consumes the existing `oengine-vg-v1-v3-decoded` Product contract. It does
not change ProductID, revision, PageID, decoded page bytes, or GPU-visible
record strides. A profile is a device/runtime allocation choice, not a cook
format or cache identity.

## Scope

The profile selects physical bank capacity. Product descriptors, 256 KiB decoded
pages, PageID identity, hierarchy and cooked bytes remain unchanged; no recook is
required for a capacity change. Runtime GPU ABI version 3 publishes actual
`slotsPerBank` in metadata header word 12. Its resident-address namespace uses
1024 slots per bank; this ceiling is distinct from allocated physical capacity.

## Profiles

Each profile uses four equal, page-aligned storage-buffer bindings. These values
are ceilings, not minimum allocations or claims about physical VRAM:

| Profile | Bank size | Total page capacity | Selection requirement |
| --- | ---: | ---: | --- |
| `Portable` | up to 128 MiB | up to 512 MiB | full ceiling requires both buffer limits >= 128 MiB |
| `Balanced` | up to 192 MiB | up to 768 MiB | full ceiling requires both buffer limits >= 192 MiB |
| `HighEnd` | up to 256 MiB | up to 1 GiB | full ceiling requires both buffer limits >= 256 MiB |

`auto` without an explicit budget reserves **4 × 32 MiB = 128 MiB**. An explicit
profile without a budget may allocate its full ceiling. Actual bank bytes are
`floor(min(profile ceiling, both buffer limits, configured budget / 4) / 256 KiB)
* 256 KiB`. Budgets below four pages fail closed; small banks are valid. This
default is an allocation policy, not a measured optimum for large scenes.

All profiles also require the Product consumer's negotiated
`maxStorageBuffersPerShaderStage >= 16`. The selector reads the post-device
limits; it never reads or infers physical adapter VRAM.

## Contract

### Selection

`selectGeometryProductResidencyProfileV1(limits, options)` is pure and creates
no GPU object. `requestedProfile` may be explicit or `auto`. Delayed runtime
evidence can select a higher ceiling, but cannot exceed the configured budget
or negotiated limits; it does not resize a live pool. The plan records actual
bank bytes and slots. If even four pages cannot fit, required storage bindings
are unsupported, or `featureEnabled` is false, the plan is `Disabled`.
`VirtualGeometryResidency.create` and the multi-runtime constructor reject
before creating their metadata or page banks. Composition must not then create
Product demand/readback resources.

The selected plan is device-wide for a shared page-bank pool. All Product
revisions on one device must use the same bank size and capacity while the pool is alive;
changing it requires a device/resource lifecycle boundary. A replacement
revision reuses the same Product/Page ABI and profile and does not recook.

## Budget and evidence

The GPU budget ledger records the selected capacity, current/peak bytes, and
metadata overhead, including retiring ownership. The ledger uses the actual
configured budget rather than imposing a 512 MiB floor. Profile evidence records negotiated limits, bank count,
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
- small budgets, explicit fallback and runtime-pressure ceilings without recook;
- low-limit and feature-off zero-bank allocation;
- actual slots versus packed address namespace, including 511/512/767/1023;
- Balanced residency using four 192 MiB banks with unchanged cooked pages.

Budgeted lifecycle contracts and the `geometry-budgeted-residency` GPU oracle
also cover capacity negotiation, physical bank-boundary reads, pinned coarse
coverage and delayed pressure eviction. Results and limitations live in the V4
execution plan G2.1 record.

This is implementation/contract evidence only. Current-revision `large.glb`
browser evidence is required for runtime and performance claims.
