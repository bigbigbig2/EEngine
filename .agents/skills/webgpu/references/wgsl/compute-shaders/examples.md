# WGSL Compute Shader Examples

Working WGSL verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/) for WebGPU 1.0-stable. Each example is a complete,
self-contained shader module.

## Example 1: Basic compute kernel with global_invocation_id

A one-dimensional kernel that doubles every element of a storage buffer. Each
invocation handles one element, identified by `global_invocation_id.x`. The tail
guard handles a buffer length that is not a multiple of the workgroup size.

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  // The dispatch launches whole workgroups, so the final workgroup may run
  // invocations past the end of the array. Guard before indexing.
  if (i >= arrayLength(&data)) {
    return;
  }
  data[i] = data[i] * 2.0;
}
```

Host side: for an array of `N` floats, dispatch `ceil(N / 64)` workgroups with
`pass.dispatchWorkgroups(Math.ceil(N / 64))`. See `webgpu-syntax-compute-pipeline`.

A two-dimensional variant for image-shaped data uses `global_invocation_id.xy` and a
`@workgroup_size(8, 8)` tile:

```wgsl
@group(0) @binding(0) var<storage, read_write> img: array<f32>;
@group(0) @binding(1) var<uniform> dims: vec2<u32>;   // width, height

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  let idx = gid.y * dims.x + gid.x;
  img[idx] = img[idx] * 0.5;
}
```

## Example 2: Workgroup-shared-memory reduction with barriers

A per-workgroup sum reduction. Each invocation loads one element into `var<workgroup>`
shared memory, then the workgroup cooperatively folds the tile in half repeatedly.
Each fold reads slots written by other invocations, so a `workgroupBarrier()`
separates every write phase from the next read phase.

```wgsl
const WG: u32 = 256u;

@group(0) @binding(0) var<storage, read>       input:   array<f32>;
@group(0) @binding(1) var<storage, read_write> partial: array<f32>;  // one per workgroup

var<workgroup> tile: array<f32, WG>;

@compute @workgroup_size(WG)
fn reduce(@builtin(global_invocation_id) gid: vec3<u32>,
          @builtin(local_invocation_index) li: u32,
          @builtin(workgroup_id) wid: vec3<u32>) {
  // Phase 1: each invocation loads its element, or 0.0 past the end.
  var v = 0.0;
  if (gid.x < arrayLength(&input)) {
    v = input[gid.x];
  }
  tile[li] = v;

  // Barrier: every invocation must finish writing tile before any fold reads it.
  workgroupBarrier();

  // Phase 2: tree reduction. Halve the active range each step.
  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      tile[li] = tile[li] + tile[li + stride];
    }
    // Barrier in uniform control flow: the loop condition on `stride` is the same
    // for every invocation, so every invocation reaches this call.
    workgroupBarrier();
    stride = stride / 2u;
  }

  // Phase 3: invocation 0 writes the workgroup's partial sum.
  if (li == 0u) {
    partial[wid.x] = tile[0];
  }
}
```

A second dispatch reduces the `partial` array the same way to produce one final
total. The full multi-pass scan pattern is covered by `webgpu-impl-compute-usecases`.

## Example 3: Atomic counter

Many invocations conditionally increment a single shared counter. A plain
load-add-store would lose updates under concurrency. `atomic<u32>` plus `atomicAdd`
make each increment indivisible.

```wgsl
@group(0) @binding(0) var<storage, read>       values: array<f32>;
@group(0) @binding(1) var<storage, read_write> hits:   atomic<u32>;

@compute @workgroup_size(64)
fn count_positive(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&values)) {
    return;
  }
  if (values[i] > 0.0) {
    // atomicAdd is indivisible: concurrent increments from other invocations
    // and other workgroups are all counted. It returns the old value (ignored).
    atomicAdd(&hits, 1u);
  }
}
```

To read the result on the host: `atomic<u32>` occupies 4 bytes like a plain `u32`,
so copy the storage buffer to a mapped staging buffer and read it as a `Uint32Array`
after `await queue.onSubmittedWorkDone()`.

Workgroup-local accumulation reduces atomic contention. Each workgroup sums into one
`var<workgroup>` atomic, then a single invocation adds that subtotal to the global
counter:

```wgsl
@group(0) @binding(0) var<storage, read>       values: array<f32>;
@group(0) @binding(1) var<storage, read_write> hits:   atomic<u32>;

var<workgroup> local_hits: atomic<u32>;

@compute @workgroup_size(64)
fn count_tiled(@builtin(global_invocation_id) gid: vec3<u32>,
               @builtin(local_invocation_index) li: u32) {
  // local_hits is zero-initialized by the implementation. A barrier still ensures
  // every invocation observes the initialized state before the first atomic op.
  workgroupBarrier();

  let i = gid.x;
  if (i < arrayLength(&values) && values[i] > 0.0) {
    atomicAdd(&local_hits, 1u);
  }

  // All workgroup atomic increments must complete before the subtotal is read.
  workgroupBarrier();

  if (li == 0u) {
    atomicAdd(&hits, atomicLoad(&local_hits));
  }
}
```
