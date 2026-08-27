# Bind Group Examples

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Every example is
verified against the W3C WebGPU specification and the official WebGPU samples.

## Example 1: Uniform + Texture + Sampler Bind Group

A typical fragment-stage material binding: a uniform buffer, a sampled texture,
and a filtering sampler in one group. The layout binding numbers match the WGSL
`@binding(n)` exactly.

```js
// WGSL the layout targets:
//   struct Material { tint : vec4f }
//   @group(0) @binding(0) var<uniform> material : Material;
//   @group(0) @binding(1) var albedoTex  : texture_2d<f32>;
//   @group(0) @binding(2) var albedoSamp : sampler;

const materialBuffer = device.createBuffer({
  label: "material-uniforms",
  size: 16,                                         // one vec4f
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
queue.writeBuffer(materialBuffer, 0, new Float32Array([1, 1, 1, 1]));

const albedoSampler = device.createSampler({
  magFilter: "linear",
  minFilter: "linear",
});

const materialLayout = device.createBindGroupLayout({
  label: "material-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" } },
  ],
});

const materialGroup = device.createBindGroup({
  label: "material-group",
  layout: materialLayout,
  entries: [
    { binding: 0, resource: { buffer: materialBuffer } },   // GPUBufferBinding
    { binding: 1, resource: albedoTexture.createView() },   // GPUTextureView
    { binding: 2, resource: albedoSampler },                // GPUSampler
  ],
});

// During the render pass:
pass.setBindGroup(0, materialGroup);                        // index 0 == @group(0)
```

## Example 2: Storage Buffer Bind Group (Compute)

A compute pipeline reading one storage buffer and writing another. The input
uses `"read-only-storage"`, the output uses `"storage"`.

```js
// WGSL the layout targets:
//   @group(0) @binding(0) var<storage, read>       inputData  : array<f32>;
//   @group(0) @binding(1) var<storage, read_write> outputData : array<f32>;

const inputBuffer = device.createBuffer({
  label: "compute-input",
  size: 1024,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
const outputBuffer = device.createBuffer({
  label: "compute-output",
  size: 1024,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
});

const computeLayout = device.createBindGroupLayout({
  label: "compute-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" } },
  ],
});

const computeGroup = device.createBindGroup({
  label: "compute-group",
  layout: computeLayout,
  entries: [
    { binding: 0, resource: { buffer: inputBuffer } },
    { binding: 1, resource: { buffer: outputBuffer } },
  ],
});

// Explicit pipeline layout so the group is reusable across compute pipelines:
const computePipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [computeLayout],
});

// During the compute pass:
computePass.setBindGroup(0, computeGroup);
```

## Example 3: Dynamic Offset Bind Group

One uniform buffer holds many per-object structs. A single bind group is rebound
at a different 256-aligned offset for each object. The struct is padded so its
stride is exactly 256 bytes.

```js
// WGSL the layout targets:
//   struct ObjectData { model : mat4x4f }          // 64 bytes of real data
//   @group(0) @binding(0) var<uniform> object : ObjectData;

const OBJECT_COUNT  = 8;
const OBJECT_STRIDE = 256;                          // padded, NOT 64

// One buffer large enough for every object at the 256-byte stride.
const objectBuffer = device.createBuffer({
  label: "object-uniforms",
  size: OBJECT_COUNT * OBJECT_STRIDE,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

// Layout marks the buffer as dynamic. minBindingSize is the real struct size.
const objectLayout = device.createBindGroupLayout({
  label: "object-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 64 } },
  ],
});

// The bind group does NOT bake in an offset. size is the real struct size.
const objectGroup = device.createBindGroup({
  label: "object-group",
  layout: objectLayout,
  entries: [
    { binding: 0, resource: { buffer: objectBuffer, offset: 0, size: 64 } },
  ],
});

// Write each object's matrix at its 256-aligned slot.
for (let i = 0; i < OBJECT_COUNT; i++) {
  queue.writeBuffer(objectBuffer, i * OBJECT_STRIDE, modelMatrices[i]);
}

// Draw each object, rebinding the same group at its dynamic offset.
for (let i = 0; i < OBJECT_COUNT; i++) {
  const dynamicOffset = i * OBJECT_STRIDE;          // every value is a multiple of 256
  pass.setBindGroup(0, objectGroup, [dynamicOffset]);
  pass.draw(vertexCount);
}
```

## Example 4: Explicit Pipeline Layout for Cross-Pipeline Sharing

A `frame` group (group 0) shared by every pipeline, plus a per-pipeline
`material` group (group 1). The explicit `GPUPipelineLayout` makes the frame
group reusable.

```js
const frameLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },                // camera + lighting
  ],
});
const materialLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" } },
  ],
});

// Both pipelines share this layout, so frameGroup binds to both.
const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [frameLayout, materialLayout],  // index 0, index 1
});

const opaquePipeline = device.createRenderPipeline({
  layout: pipelineLayout, vertex: { /* ... */ }, fragment: { /* ... */ },
});
const transparentPipeline = device.createRenderPipeline({
  layout: pipelineLayout, vertex: { /* ... */ }, fragment: { /* ... */ },
});

const frameGroup = device.createBindGroup({
  layout: frameLayout,
  entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
});

// frameGroup is valid with BOTH pipelines because the layout is explicit.
pass.setPipeline(opaquePipeline);
pass.setBindGroup(0, frameGroup);
// ... draw opaque objects ...
pass.setPipeline(transparentPipeline);
pass.setBindGroup(0, frameGroup);                   // same group, still valid
```

## Example 5: Comparison Sampler for Shadow Maps

A depth texture bound with a comparison sampler, used by `textureSampleCompare`
in WGSL. The sampler MUST be created with a `compare` function and the layout
MUST use `sampler: { type: "comparison" }`.

```js
// WGSL the layout targets:
//   @group(0) @binding(0) var shadowMap  : texture_depth_2d;
//   @group(0) @binding(1) var shadowSamp : sampler_comparison;

const shadowSampler = device.createSampler({
  compare: "less",                                  // makes it a comparison sampler
  magFilter: "linear",
  minFilter: "linear",
});

const shadowLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "comparison" } },
  ],
});

const shadowGroup = device.createBindGroup({
  layout: shadowLayout,
  entries: [
    { binding: 0, resource: shadowDepthTexture.createView() },
    { binding: 1, resource: shadowSampler },
  ],
});
```
