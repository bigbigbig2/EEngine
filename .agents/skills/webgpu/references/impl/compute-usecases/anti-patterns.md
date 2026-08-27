# Compute Use Cases: Anti-Patterns

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Each anti-pattern lists the
mistake, WHY it fails, and the fix. Verified against the W3C WebGPU spec
(https://www.w3.org/TR/webgpu/) and the W3C WGSL spec (https://www.w3.org/TR/WGSL/).

---

## 1. Mapping a compute-written buffer to the CPU in the same frame without `onSubmittedWorkDone`

```js
// WRONG
device.queue.submit([encoder.finish()]);   // compute pass writes resultBuf
await readback.mapAsync(GPUMapMode.READ);  // may resolve before the GPU finishes
```

WHY it fails: the command encoder orders passes on the GPU timeline, but a CPU
`mapAsync` is NOT ordered against GPU completion. The map promise can resolve while the
compute pass is still running, so `getMappedRange()` returns stale, partially written,
or zero-initialized data. The bug is intermittent and depends on GPU scheduling, which
makes it hard to spot.

```js
// CORRECT
device.queue.submit([encoder.finish()]);
await device.queue.onSubmittedWorkDone();   // wait for the GPU to finish
await readback.mapAsync(GPUMapMode.READ);
const out = new Float32Array(readback.getMappedRange().slice(0));
readback.unmap();
```

ALWAYS `await device.queue.onSubmittedWorkDone()` before mapping a readback buffer. In a
render loop, NEVER block on this every frame; read the result one or two frames late via
a rotating staging buffer instead.

---

## 2. Not double-buffering physics state (read-write hazard)

```wgsl
// WRONG: one buffer, invocations read each other
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  var force = vec3f(0.0);
  for (var j = 0u; j < count; j += 1u) {
    force += gravity(bodies[i].pos, bodies[j].pos); // bodies[j] may already be updated
  }
  bodies[i].pos += force * dt;
}
```

WHY it fails: invocation execution order across a dispatch is unspecified. While
invocation `i` reads `bodies[j].pos`, invocation `j` may have already written its new
position. Each invocation then integrates against a mix of old and new neighbour states.
The result depends on GPU scheduling, so the simulation is nondeterministic, diverges
between machines, and produces visible jitter or explosion.

```wgsl
// CORRECT: read from A, write to B
@group(0) @binding(0) var<storage, read>       bodiesIn:  array<Body>;
@group(0) @binding(1) var<storage, read_write> bodiesOut: array<Body>;

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  var force = vec3f(0.0);
  for (var j = 0u; j < count; j += 1u) {
    force += gravity(bodiesIn[i].pos, bodiesIn[j].pos); // immutable snapshot
  }
  bodiesOut[i].pos = bodiesIn[i].pos + force * dt;
}
```

The host swaps the A and B bindings each step. `bodiesIn` is immutable for the whole
dispatch, so every invocation reads a consistent snapshot.

---

## 3. Missing `workgroupBarrier` in a tiled kernel or tree reduction (data race)

```wgsl
// WRONG: no barrier between the write phase and the read phase
var<workgroup> tile: array<vec4f, 100>;

@compute @workgroup_size(8, 8)
fn blur(@builtin(local_invocation_id) lid: vec3u) {
  tile[lid.y * 10u + lid.x] = textureLoad(src, ..., 0);
  // no workgroupBarrier here
  let neighbour = tile[lid.y * 10u + lid.x + 1u]; // may be unwritten garbage
}
```

WHY it fails: `var<workgroup>` memory is shared across the workgroup, but invocations
run concurrently. Without a barrier, invocation A may read `tile[k]` before invocation B
has written it. Workgroup memory is zero-initialized, so the read returns zero or an old
value rather than the intended neighbour. The reduction or blur produces wrong numbers
with no error.

```wgsl
// CORRECT
tile[lid.y * 10u + lid.x] = textureLoad(src, ..., 0);
workgroupBarrier();                                  // all writes visible
let neighbour = tile[lid.y * 10u + lid.x + 1u];      // race-free
```

ALWAYS place a `workgroupBarrier()` between every write phase to shared memory and the
read phase that depends on it. In a tree reduction, that means a barrier after EVERY
step of the loop, not just before it.

---

## 4. Assuming subgroup builtins exist without feature detection

```js
// WRONG: device requests subgroups unconditionally
const device = await adapter.requestDevice({
  requiredFeatures: ["subgroups"],   // requestDevice REJECTS where unsupported
});
```

```wgsl
// WRONG: shader uses subgroupAdd without enable or feature gating
let total = subgroupAdd(v);          // shader-creation error without the feature
```

WHY it fails: the `subgroups` feature shipped in Chrome 134 and is NOT present on every
device or browser. Listing it in `requiredFeatures` on a device that lacks it makes
`requestDevice()` reject, breaking the whole application. Emitting `subgroupAdd`,
`subgroupInclusiveAdd`, or `subgroupExclusiveAdd` in WGSL without the feature and an
`enable subgroups;` directive is a shader-creation error.

```js
// CORRECT: detect, then request conditionally
const adapter = await navigator.gpu.requestAdapter();
const hasSubgroups = adapter.features.has("subgroups");
const device = await adapter.requestDevice({
  requiredFeatures: hasSubgroups ? ["subgroups"] : [],
});
const reduceCode = hasSubgroups ? subgroupReduceWGSL : treeReduceWGSL;
```

ALWAYS feature-detect on the adapter, request the feature conditionally, and select the
subgroup-accelerated shader only when the feature was granted. ALWAYS keep a
subgroup-free fallback shader for portability.

---

## 5. Using an `-srgb` format for a storage texture

```js
// WRONG
const dst = device.createTexture({
  format: "rgba8unorm-srgb",                 // NOT storage-capable
  usage: GPUTextureUsage.STORAGE_BINDING,
});
```

WHY it fails: storage textures require a storage-capable format. The `-srgb` variants
are never storage-capable because `textureStore` writes raw values with no color-space
conversion. Texture creation fails validation. The bind group layout
`storageTexture.format` would also reject the srgb format.

```js
// CORRECT
const dst = device.createTexture({
  format: "rgba8unorm",                      // storage-capable
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
});
```

ALWAYS use a non-srgb storage-capable format (`rgba8unorm`, `rgba16float`, `r32float`,
and similar) for storage textures. Apply gamma conversion explicitly in the shader if
needed.

---

## 6. Reading and writing the same storage texture in one compute pass

```wgsl
// WRONG: same texture as input and output, in place
@group(0) @binding(0) var img: texture_storage_2d<rgba8unorm, read_write>;

@compute @workgroup_size(8, 8)
fn sharpen(@builtin(global_invocation_id) gid: vec3u) {
  let centre = textureLoad(img, vec2i(gid.xy));
  let right  = textureLoad(img, vec2i(gid.xy) + vec2i(1, 0)); // may be already written
  textureStore(img, vec2i(gid.xy), centre * 2.0 - right);
}
```

WHY it fails: even when `read-write` storage textures are available, neighbouring
invocations have no ordering guarantee. Reading `img` at a neighbour coordinate races
against that neighbour's `textureStore`. The kernel reads a mix of original and modified
texels, producing artifacts that change between runs.

```wgsl
// CORRECT: separate input and output textures
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
```

ALWAYS use a separate output texture, or ping-pong two textures across passes. The same
race-free rule applies as for double-buffered physics state.

---

## 7. Passing invocation counts to `dispatchWorkgroups`

```js
// WRONG: passes the item count, not the workgroup count
pass.dispatchWorkgroups(particleCount);    // launches 64x too many invocations
```

WHY it fails: `dispatchWorkgroups(x, y, z)` arguments are WORKGROUP counts. With
`@workgroup_size(64)`, passing `particleCount` launches `particleCount * 64`
invocations. Most run far out of bounds; the in-shader bounds check stops them from
corrupting memory, but the dispatch wastes 64x the work and can exceed
`maxComputeWorkgroupsPerDimension`, failing validation.

```js
// CORRECT
pass.dispatchWorkgroups(Math.ceil(particleCount / 64));
```

ALWAYS divide the item count by the workgroup size and round up. ALWAYS keep an in-shader
bounds check (`if (gid.x >= count) { return; }`) for the overhang in the last workgroup.

---

## 8. Copying the particle buffer between the compute and render pass

```js
// WRONG: needless copy of the particle buffer between passes
encoder.copyBufferToBuffer(particles, 0, particlesForDraw, 0, size);
```

WHY it fails: the compute pass and the render pass already run in the same command
encoder, which orders the compute pass before the render pass on the GPU timeline. The
render pass can bind the SAME particle buffer directly. The extra copy doubles the
buffer memory, adds a copy command, and adds a synchronization point with no benefit.

```js
// CORRECT: both passes use the one particle buffer
const cp = encoder.beginComputePass(); /* writes particles */ cp.end();
const rp = encoder.beginRenderPass(...); /* draws particles */ rp.end();
device.queue.submit([encoder.finish()]);
```

ALWAYS bind the one particle buffer to both passes. Give it `STORAGE` usage (for the
compute write) plus either `VERTEX` (vertex-buffer draw) or keep it `STORAGE` and read
it in the vertex shader via `@builtin(instance_index)`.
