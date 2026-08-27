# Bind Group Anti-Patterns

WebGPU 1.0-stable. Each entry states the mistake, WHY it fails, and the fix.

## 1. Dynamic offset that is not a multiple of 256

```js
// WRONG: struct is 192 bytes, offset computed from the raw size
const STRUCT_SIZE = 192;
pass.setBindGroup(0, group, [i * STRUCT_SIZE]);     // 192, 384, 576 ...
```

WHY it fails: a dynamic offset MUST be a multiple of
`minUniformBufferOffsetAlignment` (256) for uniform buffers and
`minStorageBufferOffsetAlignment` (256) for storage buffers. `192` is not a
multiple of 256, so `setBindGroup` throws a validation error during encoding.

FIX: pad the struct to a 256-byte stride and index by that stride.

```js
const STRIDE = 256;                                 // padded, NOT 192
pass.setBindGroup(0, group, [i * STRIDE]);          // 256, 512, 768 ...
```

## 2. Reusing an auto-layout bind group across pipelines

```js
// WRONG: group made from pipelineA's implicit layout, used with pipelineB
const group = device.createBindGroup({
  layout: pipelineA.getBindGroupLayout(0), entries,
});
pass.setPipeline(pipelineB);
pass.setBindGroup(0, group);                        // validation error
```

WHY it fails: `layout: "auto"` generates a distinct implicit
`GPUBindGroupLayout` per pipeline. A bind group is only compatible with the
pipeline whose `getBindGroupLayout` produced its layout. `pipelineB` has a
different implicit layout object, so the group is incompatible.

FIX: create one explicit `GPUBindGroupLayout`, build the bind group from it,
and build every pipeline with an explicit `GPUPipelineLayout` over it.

```js
const bgl = device.createBindGroupLayout({ entries: [...] });
const pl  = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
const group = device.createBindGroup({ layout: bgl, entries });
// every pipeline created with `layout: pl` accepts `group`
```

## 3. Binding numbers that do not match WGSL @binding

```js
// WGSL: @group(0) @binding(2) var<uniform> camera : Camera;
// WRONG: layout and bind group use binding 0
const layout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
              buffer: { type: "uniform" } }],
});
```

WHY it fails: WebGPU matches resources to shader declarations by binding index.
The WGSL declares `@binding(2)` but the layout exposes `binding: 0`, so the
pipeline's required layout does not match the provided layout and draw-time
validation reports "bind group is not compatible with the pipeline layout".

FIX: use the same integer in the layout entry, the bind group entry, and the
WGSL `@binding(n)`. The `setBindGroup` index must equal the WGSL `@group(n)`.

## 4. Storage texture with a cube viewDimension

```js
// WRONG: cube view dimension on a storage texture
{ binding: 0, visibility: GPUShaderStage.COMPUTE,
  storageTexture: { access: "write-only", format: "rgba8unorm",
                    viewDimension: "cube" } }
```

WHY it fails: storage textures support `"1d"`, `"2d"`, `"2d-array"`, and `"3d"`
view dimensions only. `"cube"` and `"cube-array"` are not valid for a
`storageTexture` entry, so `createBindGroupLayout` fails validation.

FIX: use `"2d-array"` and address each cube face as an array layer, or write to
a `"2d"` storage texture per face.

```js
{ binding: 0, visibility: GPUShaderStage.COMPUTE,
  storageTexture: { access: "write-only", format: "rgba8unorm",
                    viewDimension: "2d-array" } }
```

## 5. Visibility missing a stage the shader uses

```js
// WGSL reads `camera` in BOTH vertex and fragment stages
// WRONG: visibility only lists VERTEX
{ binding: 0, visibility: GPUShaderStage.VERTEX,
  buffer: { type: "uniform" } }
```

WHY it fails: `visibility` declares exactly which stages may access the
binding. The fragment shader reads `camera`, but the layout makes the binding
invisible to the fragment stage, so pipeline creation reports the shader uses a
binding not exposed to that stage.

FIX: OR-combine every stage that reads the binding.

```js
{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  buffer: { type: "uniform" } }
```

## 6. Passing a bare GPUBuffer as the resource

```js
// WRONG: resource is the buffer itself
entries: [{ binding: 0, resource: uniformBuffer }]
```

WHY it fails: a buffer binding's `resource` must be a `GPUBufferBinding` object.
A bare `GPUBuffer` is not a valid `GPUBindingResource` for a `buffer` layout
entry, so `createBindGroup` throws a `TypeError`.

FIX: wrap the buffer in a `GPUBufferBinding` object.

```js
entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
```

## 7. Two or zero resource layout objects in one entry

```js
// WRONG: both buffer and texture in one entry
{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: "uniform" },
  texture: { sampleType: "float" } }
```

WHY it fails: a `GPUBindGroupLayoutEntry` is a tagged union. Exactly ONE of
`buffer` / `sampler` / `texture` / `storageTexture` / `externalTexture` must be
present. Two objects (or none) fails `createBindGroupLayout` validation.

FIX: split the binding into two separate entries with distinct `binding`
numbers, each carrying exactly one layout object.

## 8. Wrong buffer type for the WGSL declaration

```js
// WGSL: @group(0) @binding(0) var<storage, read> data : array<f32>;
// WRONG: layout declares a uniform buffer
{ binding: 0, visibility: GPUShaderStage.COMPUTE,
  buffer: { type: "uniform" } }
```

WHY it fails: the WGSL variable is `var<storage, read>`, which requires the
layout entry `buffer.type` to be `"read-only-storage"`. A `"uniform"` layout
entry does not match the storage declaration, so pipeline creation fails.

FIX: match `buffer.type` to the WGSL address space and access mode.
`var<uniform>` needs `"uniform"`; `var<storage, read>` needs
`"read-only-storage"`; `var<storage, read_write>` needs `"storage"`.
