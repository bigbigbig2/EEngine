# WebGPU Limits and Features: Methods Reference

All values verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/#limits) and the WebGPU 1.0-stable feature set.
Baseline: Chrome 113+, Safari 26+, Firefox 141+.

## GPUSupportedLimits: complete table

`GPUAdapter.limits` and `GPUDevice.limits` are both `GPUSupportedLimits` objects.
Every limit has a spec-mandated default. A real adapter reports a value at least
as good as the default: for a `maximum`-class limit the adapter value is greater
than or equal to the default; for an `alignment`-class limit the adapter value is
less than or equal to the default. The default value is the WORST value any
conformant adapter is allowed to report.

| Limit | Default | Class |
|-------|---------|-------|
| maxTextureDimension1D | 8192 | maximum |
| maxTextureDimension2D | 8192 | maximum |
| maxTextureDimension3D | 2048 | maximum |
| maxTextureArrayLayers | 256 | maximum |
| maxBindGroups | 4 | maximum |
| maxBindGroupsPlusVertexBuffers | 24 | maximum |
| maxBindingsPerBindGroup | 1000 | maximum |
| maxDynamicUniformBuffersPerPipelineLayout | 8 | maximum |
| maxDynamicStorageBuffersPerPipelineLayout | 4 | maximum |
| maxSampledTexturesPerShaderStage | 16 | maximum |
| maxSamplersPerShaderStage | 16 | maximum |
| maxStorageBuffersPerShaderStage | 8 | maximum |
| maxStorageTexturesPerShaderStage | 4 | maximum |
| maxUniformBuffersPerShaderStage | 12 | maximum |
| maxUniformBufferBindingSize | 65536 | maximum |
| maxStorageBufferBindingSize | 134217728 | maximum |
| minUniformBufferOffsetAlignment | 256 | alignment |
| minStorageBufferOffsetAlignment | 256 | alignment |
| maxBufferSize | 268435456 | maximum |
| maxVertexBuffers | 16 | maximum |
| maxVertexAttributes | 32 | maximum |
| maxVertexBufferArrayStride | 2048 | maximum |
| maxInterStageShaderVariables | 16 | maximum |
| maxColorAttachments | 8 | maximum |
| maxColorAttachmentBytesPerSample | 32 | maximum |
| maxComputeWorkgroupStorageSize | 49152 | maximum |
| maxComputeInvocationsPerWorkgroup | 256 | maximum |
| maxComputeWorkgroupSizeX | 256 | maximum |
| maxComputeWorkgroupSizeY | 256 | maximum |
| maxComputeWorkgroupSizeZ | 64 | maximum |
| maxComputeWorkgroupsPerDimension | 65535 | maximum |

### Notes on specific limits

- `maxUniformBufferBindingSize` 65536 = 64 KiB. `maxStorageBufferBindingSize`
  134217728 = 128 MiB. `maxBufferSize` 268435456 = 256 MiB.
- `minUniformBufferOffsetAlignment` and `minStorageBufferOffsetAlignment` are
  `alignment`-class: the default 256 is the LARGEST value a conformant adapter
  reports. An adapter may report a smaller (better) alignment. Dynamic buffer
  binding offsets MUST be a multiple of this limit.
- `maxColorAttachmentBytesPerSample` default 32; many desktop adapters report 64.
- Browser divergence: some Chrome builds raise reported maxima above the spec
  default (a Chrome 120-era update reports `maxStorageBuffersPerShaderStage` 10
  on capable hardware). ALWAYS read `adapter.limits` rather than assuming the
  spec default; the spec default is the floor, not the actual value.

## GPUSupportedLimits class semantics

- `maximum` class: "better" means a larger number. To raise a `maximum` limit,
  put a larger value in `requiredLimits`. `requestDevice` fails when the
  requested value exceeds `adapter.limits.<name>`.
- `alignment` class: "better" means a smaller number. To request a finer
  alignment, put a smaller value in `requiredLimits`. `requestDevice` fails when
  the requested value is below `adapter.limits.<name>`. Requesting a value worse
  than the default is also invalid.

## GPUFeatureName: complete enum

`GPUAdapter.features` and `GPUDevice.features` are `GPUSupportedFeatures`
set-like objects. The complete `GPUFeatureName` enum, verified against the W3C
WebGPU specification:

| GPUFeatureName | Capability unlocked | Version gate |
|----------------|---------------------|--------------|
| depth-clip-control | disable depth clipping (`unclippedDepth` in primitive state) | WebGPU 1.0 baseline |
| depth32float-stencil8 | the `depth32float-stencil8` texture format | WebGPU 1.0 baseline |
| texture-compression-bc | BC1 to BC7 compressed texture formats | WebGPU 1.0 baseline |
| texture-compression-etc2 | ETC2 / EAC compressed texture formats | WebGPU 1.0 baseline |
| texture-compression-astc | ASTC compressed texture formats | WebGPU 1.0 baseline |
| timestamp-query | timestamp `GPUQuerySet` and `timestampWrites` on passes | WebGPU 1.0 baseline |
| indirect-first-instance | non-zero `firstInstance` in indirect draws | WebGPU 1.0 baseline |
| shader-f16 | WGSL `enable f16;` and the `f16` scalar type | Chrome 120+ |
| rg11b10ufloat-renderable | use `rg11b10ufloat` as a render attachment with blending and multisampling | WebGPU 1.0 baseline |
| bgra8unorm-storage | `bgra8unorm` as a storage-texture binding | WebGPU 1.0 baseline |
| float32-filterable | filtering samplers on `r32float` / `rg32float` / `rgba32float` textures | WebGPU 1.0 baseline |
| float32-blendable | blending on `float32` render targets | WebGPU 1.0 baseline |
| clip-distances | WGSL `clip_distances` vertex builtin | WebGPU 1.0 baseline (Chrome 131+) |
| dual-source-blending | dual-source blend factors (`src1`, `one-minus-src1`) | Chrome 130+ |
| subgroups | WGSL subgroup builtins and operations | Chrome 134+ |

### Feature gating rules

- A feature name not in this enum is invalid. Passing an unrecognised string in
  `requiredFeatures` makes `requestDevice` reject. NEVER invent feature names.
- A feature absent from `adapter.features` cannot be requested. Adding it to
  `requiredFeatures` makes `requestDevice` reject.
- `shader-f16` has two requirements together: the device MUST be created with
  `requiredFeatures: ["shader-f16"]` AND the WGSL source MUST begin with
  `enable f16;`. One without the other fails.
- `indirect-first-instance`: without this feature a non-zero `firstInstance` in
  an indirect draw is forced to zero rather than throwing.
- Optional-feature availability differs by browser and adapter. Chrome leads
  rollout; Safari 26.0 to 26.5 and Firefox expose smaller sets. ALWAYS detect
  per adapter via `adapter.features.has(name)`.

## requestAdapter signature

```ts
navigator.gpu.requestAdapter(
  options?: GPURequestAdapterOptions
): Promise<GPUAdapter | null>

interface GPURequestAdapterOptions {
  featureLevel?: "core" | "compatibility"; // default "core"
  powerPreference?: "low-power" | "high-performance";
  forceFallbackAdapter?: boolean;          // default false
  xrCompatible?: boolean;                  // default false
}
```

- `featureLevel: "core"` (default): the full WebGPU feature and limit tier.
- `featureLevel: "compatibility"`: an adapter mapped to OpenGL ES 3.1 /
  D3D11-class hardware. Reduced limits and a smaller feature set. `adapter.limits`
  on a compatibility adapter reflect the lower tier.
- The Promise resolves to `null` (NOT a rejection) when no compatible adapter
  exists. ALWAYS null-check before reading `.features` or `.limits`.

## requestDevice negotiation signature

```ts
adapter.requestDevice(
  descriptor?: GPUDeviceDescriptor
): Promise<GPUDevice>

interface GPUDeviceDescriptor {
  label?: string;
  requiredFeatures?: GPUFeatureName[];        // default []
  requiredLimits?: Record<string, number>;    // default {}
  defaultQueue?: GPUQueueDescriptor;
}
```

## The negotiation algorithm

1. The device's limits start from the spec-mandated DEFAULT values, not the
   adapter's reported values.
2. For each `(key, value)` entry in `requiredLimits`:
   - If `key` is not a known limit name, `requestDevice` fails.
   - The limit is set to `value`. For a `maximum`-class limit, `value` must be
     no greater than `adapter.limits[key]`; for an `alignment`-class limit,
     `value` must be no less than `adapter.limits[key]` and no greater than the
     default. Out-of-range causes `requestDevice` to fail.
3. For each name in `requiredFeatures`: if `adapter.features` does not contain
   the name, or the name is not a valid `GPUFeatureName`, `requestDevice` fails.
4. The created `GPUDevice` exposes the negotiated set as `device.limits` and
   `device.features`. Every later API call is validated against these negotiated
   values, NOT against the adapter's full limits.

`requestDevice` "never throws for runtime failures": a failed negotiation makes
the Promise reject, and an unrecoverable device returns a `GPUDevice` whose
`lost` promise has already resolved. Code MUST handle both.

Requesting a lower (`maximum`-class) or higher (`alignment`-class) limit than the
adapter offers is VALID and is the deliberate way to test that an app stays
within a portable budget.
