# WebGPU Compute Use Cases

Map four common GPGPU workloads, image processing, particle systems, physics
simulation, and reduction or prefix-sum, onto the WebGPU compute pipeline with the
correct resources, buffering, and synchronization.

## Quick Reference

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

| Use case | Input resource | Output resource | Buffering | Synchronization |
|---|---|---|---|---|
| Image processing | Sampled or storage texture | Storage texture (`STORAGE_BINDING`) | Two textures if in-place | `workgroupBarrier` after tile load |
| Particle system | Storage buffer (`STORAGE`) | Same storage buffer | Single buffer, integrate in place | None within a workgroup if no shared state |
| Physics simulation | Storage buffer A (`read`) | Storage buffer B (`read_write`) | Double-buffer, swap each step | `workgroupBarrier` / `storageBarrier` |
| Reduction / scan | Storage buffer | Partials buffer, then final | Multi-pass, one buffer per level | `workgroupBarrier` between tree steps |

Rules that ALWAYS hold:

- A storage texture used as a compute output MUST be created with
  `GPUTextureUsage.STORAGE_BINDING` and a storage-capable format (`rgba8unorm`,
  `rgba16float`, `r32float`, and similar). NEVER use `rgba8unorm-srgb` as a storage
  texture format.
- A WGSL `var<workgroup>` array shared across invocations MUST be followed by
  `workgroupBarrier()` between the write phase and the read phase.
- Physics state MUST be double-buffered. NEVER read and write the same particle index
  across neighbours in one pass.
- `dispatchWorkgroups(x, y, z)` arguments are workgroup COUNTS, not invocation counts.
  For N items at `@workgroup_size(64)`, dispatch `Math.ceil(N / 64)`.
- Reading a compute-written storage buffer on the CPU in the same frame requires
  `await device.queue.onSubmittedWorkDone()` first. NEVER map it immediately.

## Decision Tree

```
What is the compute workload?
├─ Per-pixel image transform (blur, convolution, color grading)
│  └─ Input texture + output STORAGE texture. One workgroup per pixel tile.
│     Cache the tile + halo in var<workgroup>, workgroupBarrier, then write.
│
├─ Many independent agents updated each frame (particles)
│  └─ Particle state in one STORAGE buffer. Compute pass integrates
│     position += velocity * dt. Render pass draws the SAME buffer via
│     @builtin(instance_index). GPU-decided count → dispatchWorkgroupsIndirect.
│
├─ Agents that read each other's state (physics, n-body, cloth)
│  └─ Double-buffer: read state A, write state B, swap buffers each step.
│     A single buffer creates a read-write hazard and nondeterministic results.
│
└─ Collapse an array to one value, or compute a running total (scan)
   └─ Multi-pass tree reduction. Each workgroup reduces a chunk in
      var<workgroup>, writes one partial. A second dispatch reduces the
      partials. Chrome 134+ subgroup builtins accelerate the inner step.
```

The compute pipeline object and the WGSL `@compute` shader mechanics are NOT taught
here. See `webgpu-syntax-compute-pipeline` and `webgpu-wgsl-compute-shaders`.

## Core Patterns

### Pattern 1: ALWAYS output image results to a storage texture

For per-pixel image processing, bind the source as a sampled or storage texture and
write the result into a SEPARATE storage texture. NEVER write into the same texture you
are reading, because read-write ordering across invocations is undefined.

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(src);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; } // ALWAYS bounds-check
  let c = textureLoad(src, vec2i(gid.xy), 0);
  textureStore(dst, vec2i(gid.xy), c);
}
```

The output texture descriptor MUST include `STORAGE_BINDING` and a storage-capable
format. The bind group layout entry uses `storageTexture: { access: "write-only",
format: "rgba8unorm" }`.

### Pattern 2: ALWAYS cache a tile in var<workgroup> for neighbour-reading kernels

A blur or convolution reads neighbouring pixels. Caching the tile plus a halo in
`var<workgroup>` shared memory cuts texture reads from `kernelSize` per pixel to one.
ALWAYS place a `workgroupBarrier()` between the load phase and the compute phase.

```wgsl
var<workgroup> tile: array<vec4f, 100>; // 8x8 tile + 1px halo = 10x10

@compute @workgroup_size(8, 8)
fn blur(@builtin(local_invocation_id) lid: vec3u,
        @builtin(workgroup_id) wid: vec3u) {
  // each invocation loads its texels into tile[...]
  workgroupBarrier(); // MANDATORY: all loads complete before any read
  // now read tile[...] for the kernel; race-free
}
```

### Pattern 3: ALWAYS integrate particles in place, draw the same buffer

Particle state lives in ONE storage buffer with `STORAGE` usage. The compute pass
integrates each particle independently. The render pass draws that exact buffer via
`@builtin(instance_index)`. NEVER copy the buffer between the two passes.

```js
const particles = device.createBuffer({
  size: count * 32, // e.g. pos:vec3 + pad + vel:vec3 + pad
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
const enc = device.createCommandEncoder();
const cp = enc.beginComputePass();
cp.setPipeline(integratePipeline);
cp.setBindGroup(0, simBindGroup);
cp.dispatchWorkgroups(Math.ceil(count / 64));
cp.end();
const rp = enc.beginRenderPass(renderPassDesc);
rp.setPipeline(drawPipeline);
rp.draw(6, count); // instanceCount = particle count
rp.end();
device.queue.submit([enc.finish()]); // encoder orders compute before render
```

The command encoder establishes ordering between the compute and render pass within
one `queue.submit`. NO barrier or readback is needed between them.

### Pattern 4: ALWAYS double-buffer physics state

When an invocation reads a neighbour's state, read from buffer A and write to buffer B,
then swap the bindings for the next step. NEVER mutate one buffer in place when
invocations read each other.

```js
let read = stateBufferA, write = stateBufferB;
function step() {
  const enc = device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(physicsPipeline);
  cp.setBindGroup(0, makeBindGroup(read, write)); // read A, write B
  cp.dispatchWorkgroups(Math.ceil(count / 64));
  cp.end();
  device.queue.submit([enc.finish()]);
  [read, write] = [write, read]; // swap for next step
}
```

WGSL declares the bindings as `var<storage, read>` and `var<storage, read_write>`.
Within a workgroup use `workgroupBarrier()`; for visibility across `storage` memory
within a dispatch use `storageBarrier()`.

### Pattern 5: ALWAYS reduce in multiple passes with a partials buffer

A reduction or prefix-sum over a large array does NOT fit one workgroup. Each workgroup
reduces a chunk into `var<workgroup>`, writes ONE partial; a second dispatch reduces the
partials. ALWAYS `workgroupBarrier()` between each step of the in-workgroup tree.

```wgsl
var<workgroup> scratch: array<f32, 64>;

@compute @workgroup_size(64)
fn reduce(@builtin(local_invocation_id) lid: vec3u,
          @builtin(workgroup_id) wid: vec3u) {
  scratch[lid.x] = input[wid.x * 64u + lid.x];
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { scratch[lid.x] += scratch[lid.x + s]; }
    workgroupBarrier(); // MANDATORY every tree step
  }
  if (lid.x == 0u) { partials[wid.x] = scratch[0]; }
}
```

### Pattern 6: ALWAYS feature-detect subgroup builtins

`subgroupAdd`, `subgroupInclusiveAdd`, and `subgroupExclusiveAdd` accelerate reduction
and scan but require the `subgroups` feature (Chrome 134+). NEVER emit them
unconditionally.

```js
const adapter = await navigator.gpu.requestAdapter();
const hasSubgroups = adapter.features.has("subgroups");
const device = await adapter.requestDevice({
  requiredFeatures: hasSubgroups ? ["subgroups"] : [],
});
// Select the subgroup-accelerated WGSL only when hasSubgroups is true.
```

A subgroup-accelerated shader MUST begin with `enable subgroups;` and that shader MUST
only be compiled when the feature was granted.

## Common Anti-Patterns

1. **Mapping a compute-written storage buffer to the CPU in the same frame without
   `onSubmittedWorkDone`.** WHY it fails: the encoder orders passes on the GPU timeline,
   but a CPU `mapAsync` is not ordered against GPU completion. The map can resolve
   before the compute pass finishes, so `getMappedRange` returns stale or partial data.
   Fix: `await device.queue.onSubmittedWorkDone()` before mapping the readback buffer.

2. **Mutating one physics state buffer in place.** WHY it fails: invocation order across
   a dispatch is unspecified. If particle i reads particle j's position while particle j
   is being written, the result depends on scheduling and is nondeterministic. Fix:
   double-buffer, read A and write B, swap each step.

3. **Omitting `workgroupBarrier()` in a tiled kernel or tree reduction.** WHY it fails:
   `var<workgroup>` memory is shared, but invocations run concurrently. Reading a slot
   another invocation has not written yet is a data race that yields garbage. Fix: place
   `workgroupBarrier()` between every write phase and the read phase that follows it.

## Critical Warnings

- NEVER assume subgroup builtins exist. `subgroupAdd` / `subgroupInclusiveAdd` /
  `subgroupExclusiveAdd` require the `subgroups` feature and an `enable subgroups;`
  directive. Compiling them without the feature is a shader-creation error.
- NEVER use an `-srgb` format for a storage texture. Storage textures require a
  non-srgb storage-capable format.
- NEVER call `workgroupBarrier()` inside divergent (non-uniform) control flow. All
  invocations of the workgroup MUST reach the same barrier; a barrier inside an `if`
  that varies per invocation is undefined behaviour.
- NEVER pass invocation counts to `dispatchWorkgroups`. The arguments are workgroup
  counts. For N items at `@workgroup_size(64)`, dispatch `Math.ceil(N / 64)`.
- NEVER read and write the same storage texture in one compute pass. Use two textures
  or ping-pong.
- NEVER map a `STORAGE`-usage buffer directly. Copy it into a separate
  `COPY_DST | MAP_READ` staging buffer with `copyBufferToBuffer` first.

## Reference Files

- `methods.md` : per-use-case API and resource recipe for image processing,
  particle systems, physics simulation, and reduction or scan, including buffer usage
  flags, texture formats, bind group layout entries, and dispatch sizing.
- `examples.md` : verified working code for an image-processing compute
  pass, a particle update pass, and a two-level reduction.
- `anti-patterns.md` : mistakes with WHY-it-fails analysis.

Related skills: `webgpu-syntax-compute-pipeline` (creating the compute pipeline and
compute pass), `webgpu-wgsl-compute-shaders` (`@compute`, `@workgroup_size`, builtins,
barriers), `webgpu-impl-instancing-indirect` (`dispatchWorkgroupsIndirect`, drawing a
particle buffer instanced), `webgpu-impl-buffer-upload` (uploading initial particle and
input data).
