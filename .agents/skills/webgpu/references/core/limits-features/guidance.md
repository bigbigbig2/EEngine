# WebGPU Limits and Features

Negotiate WebGPU device limits and optional features correctly so `requestDevice`
never fails on a feature or limit the adapter does not support.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

`GPUAdapter.limits` reports what the hardware can do. `GPUDevice.limits` reports
what the device was negotiated for. `GPUAdapter.features` is a set-like
`GPUSupportedFeatures` object listing the optional features this adapter supports.

Spec-mandated default limits (a real adapter reports values at least this good):

| Limit | Default | Class |
|-------|---------|-------|
| maxTextureDimension2D | 8192 | maximum |
| maxTextureDimension3D | 2048 | maximum |
| maxTextureArrayLayers | 256 | maximum |
| maxBindGroups | 4 | maximum |
| maxBindingsPerBindGroup | 1000 | maximum |
| maxUniformBuffersPerShaderStage | 12 | maximum |
| maxStorageBuffersPerShaderStage | 8 | maximum |
| maxSampledTexturesPerShaderStage | 16 | maximum |
| maxUniformBufferBindingSize | 65536 (64 KiB) | maximum |
| maxStorageBufferBindingSize | 134217728 (128 MiB) | maximum |
| maxBufferSize | 268435456 (256 MiB) | maximum |
| minUniformBufferOffsetAlignment | 256 | alignment |
| minStorageBufferOffsetAlignment | 256 | alignment |
| maxComputeInvocationsPerWorkgroup | 256 | maximum |
| maxComputeWorkgroupSizeX / Y | 256 | maximum |
| maxComputeWorkgroupSizeZ | 64 | maximum |
| maxComputeWorkgroupsPerDimension | 65535 | maximum |

The complete table is in `methods.md`.

Key optional features (full `GPUFeatureName` enum in `methods.md`):

| Feature | Purpose | Version gate |
|---------|---------|--------------|
| timestamp-query | GPU-side profiling via GPUQuerySet | WebGPU 1.0 baseline |
| texture-compression-bc | BC compressed texture formats | WebGPU 1.0 baseline |
| depth32float-stencil8 | depth32float-stencil8 format | WebGPU 1.0 baseline |
| float32-filterable | filter float32 textures | WebGPU 1.0 baseline |
| shader-f16 | WGSL `enable f16;` | Chrome 120+ |
| dual-source-blending | dual-source blend factors | Chrome 130+ |
| subgroups | WGSL subgroup builtins | Chrome 134+ |

## Decision Tree

```
Need a non-default API capability?
├── It is a LIMIT (a bigger buffer, more bind groups, larger workgroup)?
│   ├── Default value is enough for your code?
│   │   └── Request NOTHING. Omit requiredLimits entirely.
│   └── Default is too small?
│       ├── Read adapter.limits.<name> FIRST
│       ├── adapter value >= what you need?
│       │   └── Put { <name>: neededValue } in requiredLimits
│       └── adapter value < what you need?
│           └── adapter cannot run this workload. Reduce the workload
│               or surface a clear error. NEVER request beyond adapter.
│
└── It is a FEATURE (timestamp-query, shader-f16, a compression set)?
    ├── adapter.features.has("<name>") === true?
    │   └── Include "<name>" in requiredFeatures
    └── adapter.features.has("<name>") === false?
        └── OMIT it. Run a code path that does not need the feature.
            Use: requiredFeatures: adapter.features.has("x") ? ["x"] : []
```

## Core Patterns

### Pattern 1: ALWAYS feature-detect before adding to requiredFeatures

`requestDevice` rejects (the returned device is already lost) when
`requiredFeatures` names a feature the adapter does not list. ALWAYS gate every
optional feature on `adapter.features.has`.

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter");

const wanted = ["timestamp-query", "shader-f16"];
const requiredFeatures = wanted.filter((f) => adapter.features.has(f));

const device = await adapter.requestDevice({ requiredFeatures });
```

### Pattern 2: NEVER request a limit better than the adapter reports

`requestDevice` validates `requiredLimits` against the adapter's reported limits.
Requesting a `maximum`-class limit higher than `adapter.limits` (or an
`alignment`-class limit lower than `adapter.limits`) makes `requestDevice` fail.
There is NO silent clamping. ALWAYS read `adapter.limits` first.

```js
const needed = 512 * 1024 * 1024; // 512 MiB buffer
if (adapter.limits.maxBufferSize < needed) {
  throw new Error("Adapter cannot allocate a 512 MiB buffer");
}
const device = await adapter.requestDevice({
  requiredLimits: { maxBufferSize: needed },
});
```

### Pattern 3: ALWAYS request only the limits the code actually needs

The device validates every API call against the NEGOTIATED limits, not the
adapter's full limits. `requiredLimits` starts from the spec defaults; each entry
raises (or tightens) one limit. Requesting only what is needed keeps the app
portable: it runs on weaker adapters and catches accidental over-use early.

```js
// GOOD: request exactly what this app needs, nothing more.
const device = await adapter.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 },
});
// device.limits.maxComputeWorkgroupSizeX is still the default 256,
// even if the adapter would have allowed 1024.
```

### Pattern 4: ALWAYS read negotiated limits from device.limits

After `requestDevice`, `device.limits` holds the negotiated values. ALWAYS size
buffers, workgroups, and bind groups against `device.limits`, NEVER against
`adapter.limits`, because the device rejects calls that exceed the negotiated set.

```js
const maxUbo = device.limits.maxUniformBufferBindingSize;
const uniformBuffer = device.createBuffer({
  label: "frame-uniforms",
  size: Math.min(myUniformSize, maxUbo),
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
```

### Pattern 5: Request the compatibility tier with featureLevel

`navigator.gpu.requestAdapter({ featureLevel: "compatibility" })` selects an
adapter mapped to OpenGL ES 3.1 / D3D11-class hardware. The compatibility tier
has reduced limits and a smaller feature set than the default `"core"` tier. Use
it ONLY when targeting that older-hardware tier deliberately; the default
`featureLevel` is `"core"`.

```js
const adapter = await navigator.gpu.requestAdapter({
  featureLevel: "compatibility",
});
// adapter.limits here reflect the reduced compatibility tier.
```

### Pattern 6: ALWAYS null-check the adapter before reading features

`requestAdapter` resolves to `null` when no compatible GPU exists. Reading
`.features` or `.limits` on `null` throws a `TypeError`. ALWAYS branch on
`adapter !== null` first.

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  // No WebGPU adapter. Show a fallback UI; do not touch adapter.features.
  return;
}
```

## Common Anti-Patterns

1. Putting an optional feature in `requiredFeatures` without checking
   `adapter.features`. `requestDevice` rejects on every browser that lacks the
   feature, so the app works in Chrome and breaks in Safari and Firefox.

2. Assuming a feature exists because Chrome ships it. Chrome leads feature
   rollout (`shader-f16` Chrome 120, `subgroups` Chrome 134). Safari and Firefox
   expose different, smaller optional-feature sets. ALWAYS detect per adapter.

3. Requesting an unnecessarily high limit. Naming a `maximum`-class limit higher
   than the adapter reports makes `requestDevice` fail outright. Requesting a
   high limit the code never uses also blocks adapters that could have run the
   real workload.

## Critical Warnings

- NEVER add a `GPUFeatureName` to `requiredFeatures` without
  `adapter.features.has(name)` returning `true` first.
- NEVER request a `maximum`-class limit above `adapter.limits.<name>` or an
  `alignment`-class limit below it. `requestDevice` fails with no silent clamp.
- NEVER size resources against `adapter.limits` after the device is created.
  The device validates against `device.limits` (the negotiated set).
- NEVER assume default limits are uniform across browsers and adapters. Query
  `adapter.limits` and request only what the code needs.
- NEVER read `.features` or `.limits` on a `null` adapter; it throws.
- NEVER invent feature names. The valid `GPUFeatureName` enum is fixed; see
  `methods.md`.

## Reference Files

- `methods.md` : complete GPUSupportedLimits table with defaults and
  classes, the full GPUFeatureName enum with version gates, and the
  `requestAdapter` / `requestDevice` negotiation signatures.
- `examples.md` : verified feature-detection and limit-negotiation
  code, including the compatibility-tier path.
- `anti-patterns.md` : negotiation mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-core-architecture` : the adapter / device / queue initialization chain.
- `webgpu-core-cross-browser` : per-browser feature and limit divergence.
- `webgpu-core-memory-model` : how `minUniformBufferOffsetAlignment` and other
  alignment limits drive buffer layout.
