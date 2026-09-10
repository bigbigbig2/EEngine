# WebGPU Limits and Features: Current Methods Reference

Snapshot: 2026-09-10. Normative authority is the current WebGPU Editor's Draft,
not this copied list. Recheck the draft when a task depends on exact exposure.

## Device Negotiation

```ts
navigator.gpu.requestAdapter(
  options?: GPURequestAdapterOptions,
): Promise<GPUAdapter | null>;

interface GPURequestAdapterOptions {
  featureLevel?: "core" | "compatibility";
  powerPreference?: "low-power" | "high-performance";
  forceFallbackAdapter?: boolean;
  xrCompatible?: boolean;
}

adapter.requestDevice(
  descriptor?: GPUDeviceDescriptor,
): Promise<GPUDevice>;

interface GPUDeviceDescriptor {
  label?: string;
  requiredFeatures?: Iterable<GPUFeatureName>;
  requiredLimits?: Record<string, number>;
  defaultQueue?: GPUQueueDescriptor;
}
```

`requestAdapter()` may resolve to `null`. Descriptor validation failures reject
`requestDevice()`; separately, runtime failure can produce or later cause a lost
device. Always handle both negotiation errors and `device.lost`.

## Complete GPUFeatureName Set

The 2026-09 Editor's Draft defines:

```text
core-features-and-limits
depth-clip-control
depth32float-stencil8
texture-compression-bc
texture-compression-bc-sliced-3d
texture-compression-etc2
texture-compression-astc
texture-compression-astc-sliced-3d
timestamp-query
indirect-first-instance
shader-f16
rg11b10ufloat-renderable
bgra8unorm-storage
float32-filterable
float32-blendable
clip-distances
dual-source-blending
subgroups
texture-formats-tier1
texture-formats-tier2
primitive-index
texture-component-swizzle
subgroup-size-control
texture-compression-unaligned
```

Dependencies:

```text
texture-formats-tier2              -> texture-formats-tier1
texture-formats-tier1              -> rg11b10ufloat-renderable
texture-compression-bc-sliced-3d   -> texture-compression-bc
texture-compression-astc-sliced-3d -> texture-compression-astc
subgroup-size-control              -> subgroups
```

Do not attach browser version numbers to this enum. A name being in the spec
does not mean a particular browser/OS/adapter exposes it.

## GPUSupportedLimits Surface

Current limit names are:

```text
maxTextureDimension1D
maxTextureDimension2D
maxTextureDimension3D
maxTextureArrayLayers
maxBindGroups
maxBindGroupsPlusVertexBuffers
maxBindingsPerBindGroup
maxDynamicUniformBuffersPerPipelineLayout
maxDynamicStorageBuffersPerPipelineLayout
maxSampledTexturesPerShaderStage
maxSamplersPerShaderStage
maxStorageBuffersPerShaderStage
maxStorageBuffersInVertexStage
maxStorageBuffersInFragmentStage
maxStorageTexturesPerShaderStage
maxStorageTexturesInVertexStage
maxStorageTexturesInFragmentStage
maxUniformBuffersPerShaderStage
maxUniformBufferBindingSize
maxStorageBufferBindingSize
minUniformBufferOffsetAlignment
minStorageBufferOffsetAlignment
maxVertexBuffers
maxBufferSize
maxVertexAttributes
maxVertexBufferArrayStride
maxInterStageShaderVariables
maxColorAttachments
maxColorAttachmentBytesPerSample
maxComputeWorkgroupStorageSize
maxComputeInvocationsPerWorkgroup
maxComputeWorkgroupSizeX
maxComputeWorkgroupSizeY
maxComputeWorkgroupSizeZ
maxComputeWorkgroupsPerDimension
maxImmediateSize
```

The fixed numeric table was deliberately removed: current defaults depend on the
adapter feature level and `core-features-and-limits`, and copied tables become
stale. For exact validation use the current specification's Supported Limits
table, then inspect `adapter.limits` and `device.limits` at runtime.

The current default for `maxImmediateSize` is 64 bytes. Treat the four per-stage
storage limit properties as rollout-sensitive in TypeScript because older
`@webgpu/types` releases mark them optional or omit them.

## Immediate Data Signatures

```ts
interface GPUPipelineLayoutDescriptor {
  bindGroupLayouts: Iterable<GPUBindGroupLayout>;
  immediateSize?: number;
}

interface GPURenderPassEncoder {
  setImmediates(offset: number, data: GPUAllowSharedBufferSource,
                dataOffset?: number, size?: number): undefined;
}

interface GPUComputePassEncoder {
  setImmediates(offset: number, data: GPUAllowSharedBufferSource,
                dataOffset?: number, size?: number): undefined;
}

interface GPURenderBundleEncoder {
  setImmediates(offset: number, data: GPUAllowSharedBufferSource,
                dataOffset?: number, size?: number): undefined;
}
```

The WGSL side requires `requires immediate_address_space;` and declares
`var<immediate>`. See `../webgpu-2026/methods.md` for a paired example.

## Normative Sources

- <https://gpuweb.github.io/gpuweb/#supported-limits>
- <https://gpuweb.github.io/gpuweb/#feature-index>
- <https://gpuweb.github.io/gpuweb/#dom-gpuadapter-requestdevice>
- <https://gpuweb.github.io/gpuweb/wgsl/>
