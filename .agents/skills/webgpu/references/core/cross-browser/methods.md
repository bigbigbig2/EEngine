# Cross-Browser Capability Detection: Methods Reference

Snapshot: 2026-09-10. This file intentionally contains no browser-version
matrix. Query current MDN and browser-engine sources when shipping status matters.

## Entry Point and Canvas

```ts
if (!("gpu" in navigator)) {
  throw new Error("WebGPU requires a supporting browser and secure context");
}

const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
```

`getPreferredCanvasFormat()` is the portable default for
`GPUCanvasContext.configure()`. Do not choose between BGRA and RGBA using a
browser sniff.

## Adapter and Device

```ts
const adapter = await navigator.gpu.requestAdapter({
  featureLevel: "core", // or deliberately request "compatibility"
  powerPreference: "high-performance",
});
if (!adapter) throw new Error("No compatible adapter");

const optional: GPUFeatureName[] = [
  "timestamp-query",
  "shader-f16",
  "primitive-index",
  "subgroups",
];
const requiredFeatures = optional.filter(name => adapter.features.has(name));
const device = await adapter.requestDevice({ requiredFeatures });
```

`adapter.features` is grantable capability. `device.features` is enabled
capability. Runtime decisions after device creation use the latter.

For the current complete `GPUFeatureName` enum and dependencies, read
`../limits-features/methods.md` rather than duplicating it here.

## WGSL Language Features

```ts
const languageFeatures = navigator.gpu.wgslLanguageFeatures;
const supports = (name: string) => languageFeatures.has(name);
```

The language-feature namespace evolves independently of `GPUFeatureName`.
Current work may encounter `buffer_view`, `linear_indexing`,
`immediate_address_space`, `fragment_depth`, and `swizzle_assignment`, alongside
older entries. Verify the exact directive and feature spelling in the current
WGSL specification before generating a variant.

Some pairs cross both surfaces:

| Device feature | WGSL declaration/use |
|---|---|
| `shader-f16` | `enable f16;` |
| `subgroups` | `enable subgroups;` and subgroup built-ins |
| `primitive-index` | `enable primitive_index;` and `@builtin(primitive_index)` |
| `subgroup-size-control` | `enable subgroup_size_control;` and `@subgroup_size(...)` |

## Structural Probes for Merged Core APIs

Structural probes are rollout guards, not normative feature negotiation:

```ts
const hasImmediateHostAPI = (pass: GPURenderPassEncoder) =>
  typeof (pass as { setImmediates?: unknown }).setImmediates === "function";

const hasTransientUsage =
  typeof GPUTextureUsage !== "undefined" &&
  "TRANSIENT_ATTACHMENT" in GPUTextureUsage;
```

Then validate the complete path under an error scope. For example, Immediate
Data also needs an adequate `device.limits.maxImmediateSize`, pipeline-layout
support, and WGSL `immediate_address_space`. Transient attachments still must
satisfy their texture and render-pass restrictions.

## Error-Scope Probe

```ts
device.pushErrorScope("validation");
let resource: GPUTexture | undefined;
try {
  resource = device.createTexture(descriptor);
} finally {
  const validationError = await device.popErrorScope();
  if (validationError) {
    resource?.destroy();
    throw new Error(validationError.message);
  }
}
```

Prefer a real pipeline/resource validation over a browser UA string. Do not use
error scopes in hot loops; probe once during capability initialization.

## Toolchain Drift

If runtime/spec support is newer than local TypeScript declarations:

1. confirm the symbol in the current GPUWeb/WGSL spec;
2. confirm implementation exposure for the target browsers;
3. upgrade `@webgpu/types` when practical;
4. otherwise add the smallest local ambient declaration and label it with the
   spec snapshot and removal condition;
5. never hide broad API mismatches with `any`.

## Current Sources

- <https://gpuweb.github.io/gpuweb/>
- <https://gpuweb.github.io/gpuweb/wgsl/>
- <https://gpuweb.github.io/cts/>
- <https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API>
- <https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures>
