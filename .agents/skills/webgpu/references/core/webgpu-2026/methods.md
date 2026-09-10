# WebGPU 2026 Capability Methods

Exact surface summary for the 2026-09-01 GPUWeb/WGSL editor drafts. Verify again
against the living specs when implementing after this snapshot.

## Capability discovery

```ts
const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core" });
if (!adapter) throw new Error("No core WebGPU adapter");

const wanted: GPUFeatureName[] = ["subgroups", "primitive-index", "shader-f16"];
const requiredFeatures = wanted.filter(name => adapter.features.has(name));
const device = await adapter.requestDevice({ requiredFeatures });

const enabled = device.features;
const language = navigator.gpu.wgslLanguageFeatures;
```

`featureLevel` accepts `"core"` and `"compatibility"`. Verify a core result with
`adapter.features.has("core-features-and-limits")`; older implementations may
ignore a newly added dictionary member.

## Immediate Data surface

```ts
interface GPUPipelineLayoutDescriptor {
  bindGroupLayouts: Iterable<GPUBindGroupLayout | null | undefined>;
  immediateSize?: number;
}

interface GPUSupportedLimits {
  readonly maxImmediateSize: number;
}

interface GPUBindingCommandsMixin {
  setImmediates(
    rangeOffset: number,
    data: GPUAllowSharedBufferSource,
    dataOffset?: number,
    dataSize?: number,
  ): undefined;
}
```

`rangeOffset` and copied byte size are multiples of 4, and the written range ends
at or before `device.limits.maxImmediateSize`. `dataOffset`/`dataSize` count
elements for typed arrays and bytes for `ArrayBuffer`/`DataView`.

```wgsl
requires immediate_address_space;

struct DrawImmediate {
  draw_id: u32,
  material_id: u32,
}

var<immediate> draw: DrawImmediate;
```

## Transient Attachment surface

```ts
const transientUsage =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TRANSIENT_ATTACHMENT;

const scratch = device.createTexture({
  size: [width, height, 1],
  dimension: "2d",
  mipLevelCount: 1,
  format,
  usage: transientUsage,
  viewFormats: [],
});
```

Color attachment: `loadOp: "clear"`, `storeOp: "discard"`. Depth/stencil uses
the corresponding clear/discard pair for each writable aspect. A transient
texture view cannot be used as `resolveTarget`.

## WGSL feature pairs

| WGSL directive | Device/runtime gate |
| --- | --- |
| `enable f16;` | `device.features.has("shader-f16")` |
| `enable subgroups;` | `device.features.has("subgroups")` |
| `enable primitive_index;` | `device.features.has("primitive-index")` |
| `enable subgroup_size_control;` | `device.features.has("subgroup-size-control")` |
| `requires immediate_address_space;` | `navigator.gpu.wgslLanguageFeatures.has("immediate_address_space")` plus Immediate Data host API |
| `requires buffer_view;` | `navigator.gpu.wgslLanguageFeatures.has("buffer_view")` |
| `requires linear_indexing;` | `navigator.gpu.wgslLanguageFeatures.has("linear_indexing")` |

## Normative sources

- <https://gpuweb.github.io/gpuweb/>
- <https://gpuweb.github.io/gpuweb/wgsl/>
- <https://gpuweb.github.io/cts/>
