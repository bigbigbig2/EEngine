# WGSL Compute Shader Anti-Patterns

Compute-shader mistakes, why each one fails, and the correct pattern. Verified
against the W3C WGSL specification (https://www.w3.org/TR/WGSL/) for WebGPU
1.0-stable.

## 1. A @compute entry point without @workgroup_size

```wgsl
// WRONG: shader-creation error
@compute
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }
```

WHY IT FAILS: WGSL requires every `@compute` function to carry `@workgroup_size`.
The workgroup grid has no default, so the shader cannot be created without it.
`createShaderModule` reports a compilation error and pipeline creation fails.

```wgsl
// CORRECT
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }
```

## 2. Reading var<workgroup> written by other invocations without a barrier

```wgsl
var<workgroup> tile: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32) {
  tile[li] = input[li];
  // WRONG: no barrier before reading a neighbour's slot
  let sum = tile[li] + tile[(li + 1u) % 64u];
}
```

WHY IT FAILS: invocations of a workgroup do not run in lockstep. When this
invocation reads `tile[(li + 1u) % 64u]`, the invocation that owns that slot may not
have written it yet. The read returns garbage. This is a data race. Zero-initialization
of `workgroup` memory does not help, because the race is between the write and the
read, not against the initial state.

```wgsl
// CORRECT: barrier separates the write phase from the read phase
tile[li] = input[li];
workgroupBarrier();
let sum = tile[li] + tile[(li + 1u) % 64u];
```

## 3. A barrier inside divergent control flow

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x < arrayLength(&data)) {
    data[gid.x] = data[gid.x] * 2.0;
    // WRONG: this if condition varies per invocation; the barrier is divergent
    workgroupBarrier();
  }
}
```

WHY IT FAILS: a barrier must be reached by every invocation of the workgroup. The
condition `gid.x < arrayLength(&data)` is true for some invocations and false for
others (the tail), so only part of the workgroup reaches the barrier. The other
invocations never arrive. The result is undefined behavior and a uniformity
violation flagged by the compiler. See `webgpu-wgsl-uniformity`.

```wgsl
// CORRECT: do per-invocation work under the guard, keep the barrier uniform
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_index) li: u32) {
  var v = 0.0;
  if (gid.x < arrayLength(&data)) { v = data[gid.x]; }
  tile[li] = v;
  workgroupBarrier();   // every invocation reaches this call
}
```

## 4. Using subgroup builtins without feature-detecting subgroups

```wgsl
// WRONG: assumes the subgroups feature is present
@compute @workgroup_size(64)
fn main(@builtin(subgroup_invocation_id) sid: u32) {
  let total = subgroupAdd(1u);
}
```

WHY IT FAILS: `subgroupAdd`, `subgroupBallot`, `subgroup_invocation_id`, and
`subgroup_size` require the optional `subgroups` device feature. On a device where
the feature was not requested, or a browser that does not implement it (Safari and
Firefox lag Chrome here), the shader fails to compile or the pipeline fails to
create. The app breaks cross-browser.

```js
// CORRECT: detect on the adapter, request only if present, compile the right variant
const hasSubgroups = adapter.features.has("subgroups");
const device = await adapter.requestDevice({
  requiredFeatures: hasSubgroups ? ["subgroups"] : [],
});
const code = hasSubgroups ? subgroupShader : workgroupMemoryShader;
```

## 5. Confusing workgroup count with workgroup size

```wgsl
// WRONG mental model: thinking @workgroup_size sets how many workgroups run
@compute @workgroup_size(1024)   // intended "1024 workgroups"
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }
```

WHY IT FAILS: `@workgroup_size` is the number of invocations INSIDE one workgroup,
not the number of workgroups. `@workgroup_size(1024)` launches 1024 invocations per
workgroup, which often exceeds `maxComputeInvocationsPerWorkgroup` (commonly 256) and
fails pipeline creation. The workgroup COUNT is set on the host by
`pass.dispatchWorkgroups(x, y, z)`, and that count is what `num_workgroups` reports.
Total invocations launched is `dispatchWorkgroups count * @workgroup_size`.

```wgsl
// CORRECT: small per-workgroup size in the shader
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }
```

```js
// CORRECT: the host sets how many workgroups, e.g. for N elements at size 64
pass.dispatchWorkgroups(Math.ceil(N / 64));
```

## 6. Non-atomic read-modify-write on a shared counter

```wgsl
@group(0) @binding(0) var<storage, read_write> counter: u32;   // plain u32

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // WRONG: load, add, store from many invocations races and loses updates
  counter = counter + 1u;
}
```

WHY IT FAILS: the increment is three separate operations (read, add, write). Two
invocations can both read the same old value, both add one, and both write the same
new value, so one increment is lost. The final count is too low and non-deterministic.

```wgsl
// CORRECT: atomic type plus an indivisible atomicAdd
@group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  atomicAdd(&counter, 1u);
}
```

## 7. Reading an atomic with plain assignment

```wgsl
@group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;

@compute @workgroup_size(1)
fn main() {
  let v = counter;        // WRONG: cannot read atomic<u32> with =
}
```

WHY IT FAILS: an `atomic<T>` is a distinct type, not a `u32`. It cannot be read or
assigned with `=`; only the atomic functions operate on it. The shader fails to
compile with a type error.

```wgsl
// CORRECT
let v = atomicLoad(&counter);
```

## 8. Indexing storage by global_invocation_id with no bounds check

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  data[gid.x] = data[gid.x] * 2.0;   // WRONG: overshoots the tail
}
```

WHY IT FAILS: dispatch launches whole workgroups. When `arrayLength(&data)` is not a
multiple of 64, the last workgroup runs invocations with `gid.x` past the end of the
array. Out-of-bounds access in WGSL is defined to be safe (clamped or yields a
default), but writing those clamped indices corrupts valid data and wastes work.

```wgsl
// CORRECT: guard against the tail
if (gid.x >= arrayLength(&data)) { return; }
data[gid.x] = data[gid.x] * 2.0;
```

## 9. Expecting storageBarrier to order writes across workgroups

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  output[gid.x] = compute_value(gid.x);
  storageBarrier();
  // WRONG: assuming every workgroup's writes are now visible here
  let neighbour = output[gid.x + 64u];
}
```

WHY IT FAILS: `storageBarrier()` synchronizes accesses only within ONE workgroup. It
says nothing about other workgroups, which may not have started or finished. There is
no in-shader primitive that orders work across workgroups. Cross-workgroup ordering
requires splitting the work into separate compute passes within a command encoder.

CORRECT: write the first stage in one `@compute` dispatch, end the pass, then run a
second dispatch that reads the results. Pass-to-pass ordering inside one
`queue.submit` is guaranteed by the command encoder.
