# WebGPU 2026 Capability Snapshot

Use this reference before relying on WebGPU/WGSL capabilities added after the
original WebGPU 1.0 surface. Snapshot date: 2026-09-10. Normative snapshot:
GPUWeb and WGSL editor drafts dated 2026-09-01, commit
`e0aff163a37eb3633ffd612e2a943ceb6196d6af`.

This is a routing and decision guide, not a browser support promise. Recheck the
living specifications and target runtime whenever exact current support matters.

## Source order

1. <https://gpuweb.github.io/gpuweb/> for host API, validation, limits and
   `GPUFeatureName`.
2. <https://gpuweb.github.io/gpuweb/wgsl/> for directives, language features,
   address spaces, builtins and shader validation.
3. <https://gpuweb.github.io/cts/> for conformance and validation coverage.
4. Browser implementation notes and release status.
5. MDN for API discoverability and compatibility summaries.

The GPUWeb proposal index is useful for finding an explainer. Its `Merged` label
does not make the explainer normative; use the merged specification text.

## Classify before gating

Do not call every new capability a feature flag. Determine its exposure surface:

| Surface | Probe | Enable/use |
| --- | --- | --- |
| Device feature | `adapter.features.has(name)` | add to `requiredFeatures`, then branch on `device.features.has(name)` |
| Device limit | `adapter.limits[name]` | request only the needed supported value; use `device.limits[name]` afterward |
| WGSL enable-extension | matching device feature | emit `enable ...;` only in that device-feature variant |
| WGSL language feature | `navigator.gpu.wgslLanguageFeatures.has(name)` | document with `requires ...;`; no `requiredFeatures` entry |
| Core API added after older browsers | structural API probe plus required limit/WGSL probe | use only when the complete surface is present |
| Draft proposal | no production probe | do not ship as standard WebGPU; isolate experiments |

Unknown future feature strings are safe to query with
`adapter.features.has("name")`; they are not safe to pass to `requiredFeatures`
unless the adapter reports them.

## Current 2026 capability groups

Read `../limits-features/methods.md` for the complete enum and dependency table.
The most consequential additions are:

- `core-features-and-limits` and `GPURequestAdapterOptions.featureLevel` separate
  core from compatibility-mode capability guarantees.
- `subgroups`, `primitive-index`, `subgroup-size-control`, `shader-f16`,
  `texture-formats-tier1`, `texture-formats-tier2`, and
  `texture-component-swizzle` are device features.
- `texture-compression-bc-sliced-3d` and
  `texture-compression-astc-sliced-3d` extend their parent compression families.
- `texture-compression-unaligned` is in the 2026-09-01 GPUWeb editor draft. A
  browser or type package can lag this enum; query the runtime string and update
  typings before using it in typed production code.
- Immediate Data and Transient Attachments are core API additions, not
  `GPUFeatureName` values.

Do not treat multi-draw-indirect, mesh/task shaders, buffer device address,
general bindless resource tables, 64-bit general atomics, sized binding arrays,
subgroup matrices, or view instancing as standard production WebGPU unless a
newer normative specification has actually merged them and the target runtime
passes validation/CTS coverage.

## Immediate Data

Immediate Data replaces tiny, frequently changed constant buffers where its
small fixed range is appropriate. Before using it, require all of:

- `GPUPipelineLayoutDescriptor.immediateSize`;
- `setImmediates()` on the relevant render/compute/bundle encoder;
- `device.limits.maxImmediateSize` large enough for the declared range (core
  default in this snapshot: 64 bytes);
- `navigator.gpu.wgslLanguageFeatures.has("immediate_address_space")`;
- WGSL `requires immediate_address_space;` and one statically accessed
  `var<immediate>` per entry point.

`setImmediates` writes 4-byte slots. Validate range offset and byte size against
`maxImmediateSize`, initialize every statically accessed slot before draw or
dispatch, and keep an ordinary uniform/ring-buffer path when older runtimes lack
the complete surface.

## Transient Attachments

`GPUTextureUsage.TRANSIENT_ATTACHMENT` is a core usage bit, not a device feature.
It is a memory/bandwidth optimization hint for a render-pass-local attachment.
In this snapshot a transient texture:

- has usage exactly `RENDER_ATTACHMENT | TRANSIENT_ATTACHMENT`;
- is 2D, one mip, one array layer, with empty `viewFormats`;
- uses clear/discard on each writable aspect;
- cannot be a resolve target, canvas texture, sampled/storage/copy resource, or
  later pass product.

Probe the constant/API surface. Fall back to an ordinary render attachment with
the same render result and lifecycle; do not interpret transient usage as general
heap aliasing permission.

## WGSL 2026 routing

Enable-extensions mapped to device features include `f16`, `clip_distances`,
`dual_source_blending`, `subgroups`, `primitive_index`, and
`subgroup_size_control`. The last one implicitly enables subgroups at the device
feature level, but shader variants still need the applicable directive.

Relevant language features now include `immediate_address_space`, `buffer_view`,
`linear_indexing`, `fragment_depth`, `texture_formats_tier1`,
`texture_and_sampler_let`, `subgroup_id`, `subgroup_uniformity`, and
`swizzle_assignment`, alongside earlier layout/pointer/storage-texture features.
Always query `wgslLanguageFeatures` before emitting a `requires` directive.

`primitive_index` is a fragment-stage input and does not identify the draw,
instance, meshlet, or material by itself. Subgroup code must support every size in
`device.adapterInfo.subgroupMinSize..subgroupMaxSize` unless
`subgroup-size-control` is enabled and a valid `@subgroup_size` is selected.

## Toolchain drift

Compare the project WebGPU typings with the current spec before coding. If the
runtime/spec contains a member the types do not, do not scatter casts or duplicate
ambient declarations. Prefer upgrading the type package, then add one narrow
compatibility declaration only when the project intentionally supports an older
toolchain. Record the spec revision and browser probe used to justify it.

## Completion check

- Exact capability classified by surface, not guessed from its name.
- Adapter support checked before device request; device support checked before use.
- Feature dependencies and final enabled closure recorded.
- WGSL `enable` versus `requires` chosen correctly.
- New core API structurally probed when older browsers may lack it.
- Correct fallback or explicit initialization failure exists before resource creation.
- Cache keys and performance provenance include capability-dependent shader/layout/format choices.
