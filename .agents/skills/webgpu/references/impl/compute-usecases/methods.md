# Compute Use Cases: Per-Use-Case API and Resource Recipe

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). All API names verified
against the W3C WebGPU spec (https://www.w3.org/TR/webgpu/) and the official WebGPU
samples (https://webgpu.github.io/webgpu-samples/).

This file lists the resources, usage flags, formats, bind group layout entries, and
dispatch sizing for each compute use case. The compute pipeline object itself
(`createComputePipeline`, `beginComputePass`) is covered by
`webgpu-syntax-compute-pipeline`.

---

## Shared mechanics

### Dispatch sizing

`computePass.dispatchWorkgroups(countX, countY, countZ)` arguments are WORKGROUP counts,
not invocation counts. Total invocations are `count * @workgroup_size` per axis.

- For N items, 1D, at `@workgroup_size(64)`: `dispatchWorkgroups(Math.ceil(N / 64))`.
- For a W by H image at `@workgroup_size(8, 8)`:
  `dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8))`.
- Each axis count MUST NOT exceed `device.limits.maxComputeWorkgroupsPerDimension`
  (default 65535).
- The workgroup-size product MUST NOT exceed
  `device.limits.maxComputeInvocationsPerWorkgroup` (default 256).

ALWAYS bounds-check inside the shader (`if (gid.x >= dims.x) { return; }`) because the
last workgroup overhangs the data when N is not a multiple of the workgroup size.

### Workgroup-size guidance

The workgroup-size product should be a multiple of the hardware subgroup width
(commonly 32 or 64). 64 is a robust portable 1D default; `8 by 8` (= 64) is the common
2D image default. `var<workgroup>` storage MUST stay within
`device.limits.maxComputeWorkgroupStorageSize`.

### Ordering vs readback

Within one `queue.submit([...])`, the command encoder establishes ordering: a compute
pass completes before a later render pass or compute pass in the same encoder reads its
output on the GPU timeline. NO barrier between passes is needed for that.

CPU readback is different. To read a compute result on the CPU:

1. Create a readback buffer with `GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ`.
2. `encoder.copyBufferToBuffer(src, 0, readback, 0, size)`.
3. `device.queue.submit([encoder.finish()])`.
4. `await readback.mapAsync(GPUMapMode.READ)`.
5. Read `readback.getMappedRange()`, copy out, `readback.unmap()`.

`MAP_READ` may only be combined with `COPY_DST`. A `STORAGE` buffer can NEVER be mapped
directly.

---

## Use case 1: Image processing (blur, convolution, color grading)

### Resources

| Resource | Creation | Usage flags |
|---|---|---|
| Input texture | `device.createTexture` | `TEXTURE_BINDING \| COPY_DST` (sampled) or `STORAGE_BINDING` (read in shader) |
| Output texture | `device.createTexture` | `STORAGE_BINDING \| COPY_SRC` (add `TEXTURE_BINDING` to sample later) |
| Sampler (optional) | `device.createSampler` | for `textureSample` in fragment stage only |
| Kernel weights | `device.createBuffer` | `UNIFORM \| COPY_DST` |

### Texture formats

A storage texture format MUST be storage-capable. Verified storage-capable formats
include `rgba8unorm`, `rgba8snorm`, `rgba8uint`, `rgba8sint`, `rgba16uint`,
`rgba16sint`, `rgba16float`, `r32uint`, `r32sint`, `r32float`, `rg32float`,
`rgba32uint`, `rgba32sint`, `rgba32float`. The `-srgb` formats are NEVER
storage-capable. `bgra8unorm` as a storage texture requires the `bgra8unorm-storage`
feature.

### Bind group layout entries

```js
const bgl = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "float", viewDimension: "2d" } },          // src
    { binding: 1, visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: "rgba8unorm",
                        viewDimension: "2d" } },                        // dst
    { binding: 2, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" } },                                    // kernel
  ],
});
```

`access` is `"write-only"`, `"read-only"`, or `"read-write"`. `"read-write"` and
`"read-only"` storage textures require the `readonly_and_readwrite_storage_textures`
WGSL language feature; check `navigator.gpu.wgslLanguageFeatures.has(...)`.
`"write-only"` is always available. The matching WGSL type is
`texture_storage_2d<rgba8unorm, write>`.

### WGSL access functions

- `textureLoad(tex, coords, level)` reads a `texture_2d` texel by integer coordinate; no
  filtering, valid in `@compute`.
- `textureStore(storageTex, coords, value)` writes a `texture_storage_2d` texel.
- `textureDimensions(tex)` returns the size for bounds checks.
- `textureSample` is fragment-stage only; NEVER call it in `@compute`. Use `textureLoad`
  or `textureSampleLevel`.

### Tiling

Dispatch one workgroup per pixel tile (for example `@workgroup_size(8, 8)`). Declare
`var<workgroup> tile: array<vec4f, K>` sized for the tile plus the kernel halo. All
invocations load their texels into `tile`, then `workgroupBarrier()`, then read `tile`
for the kernel. This reduces texture reads from `kernelSize` per pixel to one.

---

## Use case 2: Particle systems

### Resources

| Resource | Creation | Usage flags |
|---|---|---|
| Particle state | `device.createBuffer` | `STORAGE \| VERTEX \| COPY_DST` |
| Sim uniforms (dt, gravity) | `device.createBuffer` | `UNIFORM \| COPY_DST` |
| Indirect args (optional) | `device.createBuffer` | `INDIRECT \| STORAGE \| COPY_DST` |

`STORAGE` lets the compute pass write the buffer. `VERTEX` lets the render pass bind it
as a vertex buffer; alternatively keep it `STORAGE` only and read it in the vertex
shader via `@builtin(instance_index)`. `COPY_DST` allows the initial CPU upload.

### Bind group layout entries

```js
const simBgl = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" } },          // particles, read_write
    { binding: 1, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" } },          // sim params
  ],
});
```

`buffer.type` is `"uniform"`, `"storage"` (read-write), or `"read-only-storage"`. A
particle buffer integrated in place uses `"storage"`; the WGSL declaration is
`var<storage, read_write>`.

### Pipeline split

One `GPUComputePipeline` integrates `position += velocity * dt` and applies forces. One
`GPURenderPipeline` draws each particle (a quad or point sprite) using
`@builtin(instance_index)` to index the same particle buffer. Both run in the same
command encoder so the compute pass is ordered before the render pass.

### GPU-decided count

When particle spawn or culling decides the live count on the GPU, write the draw or
dispatch arguments into an `INDIRECT` buffer from a compute pass and call
`drawIndirect` / `dispatchWorkgroupsIndirect`. This avoids a CPU readback of the count.
The `drawIndirect` record is 16 bytes (`vertexCount, instanceCount, firstVertex,
firstInstance`); `dispatchWorkgroupsIndirect` is 12 bytes (`x, y, z`). See
`webgpu-impl-instancing-indirect` for exact layouts.

### Buffer layout note

A particle struct in a `storage` buffer follows WGSL alignment rules: a `vec3f` aligns
to 16 bytes. A `{ position: vec3f, velocity: vec3f }` struct is 32 bytes, not 24, after
alignment padding. Match the JS `Float32Array` stride to the WGSL layout. See
`webgpu-wgsl-memory-layout`.

---

## Use case 3: Physics simulation

### Resources

| Resource | Creation | Usage flags |
|---|---|---|
| State buffer A | `device.createBuffer` | `STORAGE \| COPY_DST` (add `COPY_SRC` for readback) |
| State buffer B | `device.createBuffer` | `STORAGE \| COPY_DST` |
| Sim uniforms | `device.createBuffer` | `UNIFORM \| COPY_DST` |

Two buffers of identical size and layout. Each step reads one and writes the other.

### Bind group layout entries

```js
const physicsBgl = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" } },   // state IN
    { binding: 1, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" } },             // state OUT (read_write)
    { binding: 2, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" } },             // params
  ],
});
```

Build TWO bind groups from this one layout: one binding A to slot 0 and B to slot 1, the
other binding B to slot 0 and A to slot 1. Alternate them each step. WGSL declares
`var<storage, read>` for the input and `var<storage, read_write>` for the output.

### Synchronization

- `workgroupBarrier()` synchronizes invocations within ONE workgroup over `workgroup`
  address space.
- `storageBarrier()` orders accesses to `storage` address space within ONE workgroup.
- NEITHER barrier synchronizes across different workgroups. Cross-workgroup
  communication uses separate dispatches; the encoder orders dispatch N before dispatch
  N+1.

### Why double-buffering is mandatory

Invocation execution order across a dispatch is unspecified. With one buffer, particle i
reading particle j's position races against the write to particle j. Double-buffering
makes the input immutable for the whole step, so every invocation reads a consistent
snapshot.

---

## Use case 4: Reduction and prefix-sum (scan)

### Resources

| Resource | Creation | Usage flags |
|---|---|---|
| Input array | `device.createBuffer` | `STORAGE \| COPY_DST` |
| Partials array | `device.createBuffer` | `STORAGE \| COPY_DST` |
| Final result | `device.createBuffer` | `STORAGE \| COPY_SRC` (then copy to a readback buffer) |

For a scan, additional per-level buffers hold the block sums.

### Bind group layout entries

```js
const reduceBgl = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" } },   // input chunk
    { binding: 1, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" } },             // partials out
  ],
});
```

### Multi-pass structure

A reduction over N elements does not fit one workgroup (limited by
`maxComputeInvocationsPerWorkgroup`, 256). Use a tree of dispatches:

1. Dispatch 1: `ceil(N / chunkSize)` workgroups. Each reduces its chunk in
   `var<workgroup>` scratch memory and writes one partial.
2. Dispatch 2: reduce the partials array the same way.
3. Repeat until one value remains.

ALWAYS `workgroupBarrier()` between every step of the in-workgroup tree, because each
step reads slots the previous step wrote.

### In-workgroup tree reduction

```wgsl
var<workgroup> scratch: array<f32, 256>;
// load scratch[lid], workgroupBarrier()
for (var s = 128u; s > 0u; s = s >> 1u) {
  if (lid.x < s) { scratch[lid.x] += scratch[lid.x + s]; }
  workgroupBarrier();
}
// scratch[0] is the chunk sum
```

### Subgroup acceleration (Chrome 134+, feature-gated)

When `adapter.features.has("subgroups")`, the inner tree step is replaced by hardware
SIMD primitives:

- `subgroupAdd(v)` returns the sum of `v` across the subgroup (reduction).
- `subgroupInclusiveAdd(v)` returns the inclusive prefix sum across the subgroup.
- `subgroupExclusiveAdd(v)` returns the exclusive prefix sum across the subgroup.

The shader MUST begin with `enable subgroups;`, the device MUST be created with
`requiredFeatures: ["subgroups"]`, and that path MUST only be selected when the feature
was granted. NEVER emit subgroup builtins on a device without the feature; it is a
shader-creation error. A subgroup-free fallback path is mandatory for portability.

`subgroup_size` is hardware-dependent (commonly 32 or 64). A scan combines the
per-subgroup prefix sums with a second level over the subgroup totals.

---

## Verified sources

- https://www.w3.org/TR/webgpu/ (texture usage, storage texture formats, buffer usage,
  bind group layout entries, `dispatchWorkgroups`, limits)
- https://www.w3.org/TR/WGSL/ (`textureLoad`, `textureStore`, `workgroupBarrier`,
  `storageBarrier`, `var<workgroup>`, address spaces)
- https://webgpu.github.io/webgpu-samples/ (compute use case samples: image processing,
  particles, reduction)
- https://developer.chrome.com/blog/new-in-webgpu-131 (inclusive scan, subgroup builtin
  timeline)
