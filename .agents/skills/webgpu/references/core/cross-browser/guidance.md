# WebGPU Cross-Browser Compatibility

Build around capability negotiation, not browser-name or version gates. WebGPU,
WGSL, browser implementations, operating-system backends, drivers, adapters,
and TypeScript declarations advance on different schedules.

## Source Policy

- Use the current GPUWeb and WGSL Editor's Drafts for semantics and validation.
- Use WebGPU CTS for executable conformance expectations.
- Use browser-engine release notes/status pages for implementation status.
- Use MDN for API exposure and compatibility summaries.
- Treat proposal documents as design background, even after a proposal is
  marked merged; the integrated specification is normative.

When the answer depends on what ships today, browse these sources during the
task. Do not preserve a release-number matrix in this skill.

## Detection Surfaces

| Question | Check |
|---|---|
| Is the WebGPU entry point exposed? | `"gpu" in navigator` in a secure context |
| Can the adapter grant a device feature? | `adapter.features.has(name)` |
| Was the feature enabled on this device? | `device.features.has(name)` |
| Can this adapter/device satisfy a resource budget? | `adapter.limits`, then `device.limits` |
| Does the WGSL front end expose a language extension? | `navigator.gpu.wgslLanguageFeatures.has(name)` |
| Is a newly merged host method/constant exposed? | narrow structural probe plus real creation test |
| Which canvas format should be used? | `navigator.gpu.getPreferredCanvasFormat()` |

## Initialization Pattern

```ts
if (!("gpu" in navigator)) throw new Error("WebGPU unavailable");

const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core" });
if (!adapter) throw new Error("No compatible adapter");

const wanted: GPUFeatureName[] = ["timestamp-query", "subgroups"];
const requiredFeatures = wanted.filter(name => adapter.features.has(name));
const device = await adapter.requestDevice({ requiredFeatures });

device.lost.then(info => {
  console.error("WebGPU device lost", info.reason, info.message);
});
```

If a capability is required for correctness, reject the workload with a precise
error when absent. If it only improves quality or performance, select a tested
fallback before creating dependent pipelines/resources.

## Device Features Versus WGSL Features

Do not conflate the two namespaces:

- Device features are requested through `requiredFeatures`, then checked on
  `device.features`.
- WGSL language features are reported on `navigator.gpu.wgslLanguageFeatures`.
- Some shader capabilities require a device feature and a matching WGSL
  `enable`/`requires` directive.
- Immediate Data and Transient Attachments are core API surfaces, not device
  feature strings.

See `../webgpu-2026/guidance.md` for the 2026 capability classification.

## Newly Merged API Rollout

For Immediate Data, require all of the path you use: negotiated
`maxImmediateSize`, pipeline-layout `immediateSize`, encoder `setImmediates`, and
WGSL `immediate_address_space`. A single property check is insufficient.

For Transient Attachments, check `GPUTextureUsage.TRANSIENT_ATTACHMENT`, then
perform creation/validation in an error scope. The texture's usage and render
pass contract remain strict; structural exposure does not prove every requested
format/sample-count combination works.

```ts
const hasTransientUsage =
  typeof GPUTextureUsage !== "undefined" &&
  "TRANSIENT_ATTACHMENT" in GPUTextureUsage;
```

## Portability Rules

- Never branch on `adapter.info` vendor strings for correctness.
- Never hard-code the canvas format.
- Never request all adapter features or all adapter limits.
- Never infer completion from submission timing; use explicit WebGPU completion
  mechanisms only where CPU/GPU synchronization is actually required.
- Compile and test every selected shader/pipeline variant on the actual device.
- Record the adapter, browser/engine, OS/backend, enabled features, negotiated
  limits, workload, and validation-error output with benchmark evidence.

## References

- `methods.md`: exact detection surfaces and structural-probe rules.
- `examples.md`: fallback examples.
- `../limits-features/methods.md`: current feature and limit names.
- `../webgpu-2026/guidance.md`: 2026 snapshot and authority rules.
