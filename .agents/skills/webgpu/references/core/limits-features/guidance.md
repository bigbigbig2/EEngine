# WebGPU Limits and Features

Negotiate against the adapter actually selected. The WebGPU specification is a
living standard: do not use browser release numbers or a historical “WebGPU 1.0”
label as a capability check.

## Capability Layers

| Layer | Detection | Examples |
|---|---|---|
| API entry point | `"gpu" in navigator` | WebGPU availability in a secure context |
| Adapter feature | `adapter.features.has(name)` | `subgroups`, `primitive-index`, texture tiers |
| Negotiated feature | `device.features.has(name)` | the feature is usable by this device |
| Limit | `adapter.limits` then `device.limits` | binding counts, buffer sizes, `maxImmediateSize` |
| WGSL language feature | `navigator.gpu.wgslLanguageFeatures.has(name)` | grammar/type-system extensions |
| Structural API exposure | `typeof pass.setImmediates === "function"` | newly merged core APIs during rollout |

Read `../webgpu-2026/guidance.md` before using post-1.0 capability names.

## Negotiation Rules

1. Null-check the adapter.
2. Request only features that are both required by the chosen path and present
   in `adapter.features`.
3. Check every requested limit against `adapter.limits`. A value better than the
   adapter can grant fails; a maximum below the feature-level default or an
   alignment above it is clamped to that default.
4. After device creation, branch and size resources against `device.features`
   and `device.limits`, not the adapter's maximum capability.
5. Do not request every exposed feature or copy all adapter limits. That reduces
   portability and weakens accidental-overuse checks.

```ts
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No compatible WebGPU adapter");

const wanted: GPUFeatureName[] = ["timestamp-query", "primitive-index"];
const requiredFeatures = wanted.filter(name => adapter.features.has(name));

const requiredLimits: Record<string, number> = {};
const neededStorageBytes = 256 * 1024 * 1024;
if (adapter.limits.maxStorageBufferBindingSize >= neededStorageBytes) {
  requiredLimits.maxStorageBufferBindingSize = neededStorageBytes;
}

const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
```

An unsupported name or a value better than the adapter can grant makes device
negotiation fail. Runtime device loss is a separate condition and must be
handled through `device.lost`.

## Current Feature Families (2026-09 Snapshot)

The current Editor's Draft has 24 `GPUFeatureName` values. Use `methods.md` for
the exact list and dependency graph. Important additions beyond older reference
sets include:

- `core-features-and-limits`;
- sliced-3D BC and ASTC compression;
- `texture-formats-tier1` and `texture-formats-tier2`;
- `primitive-index` and `texture-component-swizzle`;
- `subgroup-size-control`;
- `texture-compression-unaligned`.

Immediate Data and Transient Attachments are merged core API surfaces, not
`GPUFeatureName` strings. Never put `"immediate-data"` or
`"transient-attachments"` in `requiredFeatures`.

## Limit Rules That Commonly Break Engines

- `maximum` limits are better when larger; never request above the adapter.
- `alignment` limits are better when smaller; never request a value better than
  the adapter supports.
- `maxImmediateSize` bounds both pipeline-layout `immediateSize` and immediate
  writes. The current default is 64 bytes; query the negotiated value.
- Current declarations add per-stage storage limits:
  `maxStorageBuffersInVertexStage`, `maxStorageBuffersInFragmentStage`,
  `maxStorageTexturesInVertexStage`, and
  `maxStorageTexturesInFragmentStage`. Older TypeScript packages may omit or
  mark them optional.
- Feature level and `core-features-and-limits` affect guaranteed limits. Avoid a
  copied universal numeric table; use the current spec plus runtime values.

## Feature Dependencies

Requesting an advanced feature implicitly enables its required dependency on the
created device, but code should understand the relation:

| Feature | Requires |
|---|---|
| `texture-formats-tier2` | `texture-formats-tier1` |
| `texture-formats-tier1` | `rg11b10ufloat-renderable` |
| `texture-compression-bc-sliced-3d` | `texture-compression-bc` |
| `texture-compression-astc-sliced-3d` | `texture-compression-astc` |
| `subgroup-size-control` | `subgroups` |

## Critical Warnings

- Without `indirect-first-instance`, an indirect draw whose encoded
  `firstInstance` is non-zero is a no-op; it is not rewritten to zero.
- A device feature and its WGSL extension may both be required. For example,
  `shader-f16` pairs with `enable f16;`, and `primitive-index` pairs with
  `enable primitive_index;`.
- Type declarations are not the authority. If the current browser implements a
  spec API that local `@webgpu/types` lacks, upgrade the package or use a narrow,
  documented compatibility declaration.

## References

- `methods.md`: current feature enum, dependencies, limit surface, and API signatures.
- `examples.md`: negotiation examples.
- `anti-patterns.md`: failure patterns.
- `../webgpu-2026/guidance.md`: 2026 capability classification and source policy.
