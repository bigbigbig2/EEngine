# WGSL Compute Shaders

Write a WGSL `@compute` entry point with a correct workgroup size, invocation ids,
shared workgroup memory, atomics, and barriers, without shader-creation errors or
workgroup-memory data races.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). A compute shader is one function marked `@compute` and
`@workgroup_size(x, y, z)`. The host dispatches a grid of workgroups; each workgroup
runs `x*y*z` invocations that can share `var<workgroup>` memory.

### Compute builtin values

All compute builtins are inputs declared with `@builtin(name)` on entry-point
parameters. All are `vec3<u32>` except `local_invocation_index`.

| Builtin | Type | Meaning |
|---------|------|---------|
| `global_invocation_id` | `vec3<u32>` | Unique id across the whole dispatch |
| `local_invocation_id` | `vec3<u32>` | Id within the workgroup, `0..workgroup_size` |
| `local_invocation_index` | `u32` | Linearized `local_invocation_id` |
| `workgroup_id` | `vec3<u32>` | Id of this workgroup within the dispatch grid |
| `num_workgroups` | `vec3<u32>` | Dispatch grid size from `dispatchWorkgroups` |

The defining relation: `global_invocation_id = workgroup_id * workgroup_size +
local_invocation_id`.

### Workgroup primitives

| Primitive | Purpose |
|-----------|---------|
| `var<workgroup> x: T;` | Memory shared by all invocations of one workgroup, zero-initialized |
| `atomic<i32>` / `atomic<u32>` | Atomic-access wrapper, legal in `workgroup` and `storage` |
| `atomicLoad`, `atomicStore`, `atomicAdd`, `atomicSub`, `atomicMax`, `atomicMin`, `atomicAnd`, `atomicOr`, `atomicXor`, `atomicExchange`, `atomicCompareExchangeWeak` | Atomic operations |
| `workgroupBarrier()` | Control + workgroup-memory sync barrier |
| `storageBarrier()` | Control + storage-memory sync barrier |
| `textureBarrier()` | Control + storage-texture sync barrier |
| `subgroupAdd`, `subgroupBallot`, ... | SIMD-lane ops, need the `subgroups` feature |

## Decision Tree

```
Sharing data between invocations in a compute shader?
├── Data shared only WITHIN one workgroup, transient
│      → var<workgroup>; needs a workgroupBarrier between write and read
├── Data shared ACROSS workgroups or read back by the host
│      → var<storage, read_write> buffer binding
│      → use atomics or storageBarrier for ordering, or split into passes
└── Counter or accumulator hit by many invocations at once
       → wrap the cell in atomic<u32>/atomic<i32>; use atomicAdd, never load+store

Need a barrier?
├── One invocation reads var<workgroup> another invocation wrote
│      → YES: workgroupBarrier() between the write and the read
├── One invocation reads storage another invocation wrote, same dispatch
│      → storageBarrier() (within a workgroup only; cross-workgroup needs separate passes)
└── Each invocation only touches its own slot, no sharing
       → NO barrier needed

Barrier inside an if / for / while?
└── ONLY if the condition is uniform across the whole workgroup.
   Divergent control flow around a barrier is undefined. See webgpu-wgsl-uniformity.
```

## Core Patterns

### ALWAYS mark a @compute function with @workgroup_size

`@workgroup_size` is mandatory. Omitting it is a shader-creation error. Missing `y`
and `z` default to 1. Arguments may be `override` constants.

```wgsl
@compute @workgroup_size(64)            // y and z default to 1
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }

@compute @workgroup_size(8, 8)          // 2D tile, z defaults to 1
fn tile(@builtin(local_invocation_id) lid: vec3<u32>) { /* ... */ }
```

### ALWAYS bounds-check global_invocation_id against the data length

The dispatch launches whole workgroups, so the last workgroup overshoots when the
data length is not a multiple of `@workgroup_size`. NEVER index without a guard.

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&data)) { return; }   // guard the tail
  data[i] = data[i] * 2.0;
}
```

### ALWAYS put a workgroupBarrier between a workgroup write and a cross-invocation read

`var<workgroup>` is zero-initialized by the implementation, but one invocation
seeing another invocation's write REQUIRES a `workgroupBarrier()` between them.
Without it the read returns garbage (a data race).

```wgsl
var<workgroup> tile: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li: u32,
        @builtin(global_invocation_id) gid: vec3<u32>) {
  tile[li] = input[gid.x];   // each invocation writes its own slot
  workgroupBarrier();        // MANDATORY before reading neighbour slots
  let neighbour = tile[(li + 1u) % 64u];
}
```

### ALWAYS use an atomic for a value many invocations update concurrently

A plain `load`, add, `store` from many invocations loses updates. Wrap the cell in
`atomic<T>` and use `atomicAdd`. NEVER read an `atomic<T>` with `=`; use `atomicLoad`.

```wgsl
@group(0) @binding(0) var<storage, read_write> counter: atomic<u32>;

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (passes(gid.x)) { atomicAdd(&counter, 1u); }
}
```

### ALWAYS keep a barrier in uniform control flow

A barrier must be reached by every invocation of the workgroup. NEVER place
`workgroupBarrier`, `storageBarrier`, or `textureBarrier` inside an `if` or loop
whose condition varies per invocation. Place it at workgroup-uniform scope.

```wgsl
// CORRECT: barrier outside the per-invocation guard
fn reduce(li: u32) {
  if (li < 32u) { tile[li] += tile[li + 32u]; }
  workgroupBarrier();   // uniform: every invocation reaches it
}
```

### ALWAYS feature-detect subgroups before using subgroup builtins

`subgroupAdd`, `subgroupBallot`, `subgroup_invocation_id`, and `subgroup_size`
need the `subgroups` device feature. Support is most complete in Chrome and lags in
Safari and Firefox. Gate them at runtime and provide a workgroup-memory path.

```js
const subgroups = adapter.features.has("subgroups");
const device = await adapter.requestDevice({
  requiredFeatures: subgroups ? ["subgroups"] : [],
});
// Compile the subgroup variant only when `subgroups` is true.
```

## Common Anti-Patterns

1. **`@compute` function without `@workgroup_size`.** Shader-creation error: every
   `@compute` entry point MUST carry `@workgroup_size(x, y, z)`.

2. **Reading `var<workgroup>` written by another invocation without a
   `workgroupBarrier`.** Data race: the read happens before the write completes and
   returns garbage. Add `workgroupBarrier()` between write and read.

3. **Confusing workgroup count with workgroup size.** `@workgroup_size` is the
   invocations PER workgroup; the `dispatchWorkgroups(x, y, z)` count is how many
   workgroups run. Total invocations is the product. They are set in different
   places, the shader and the host.

## Critical Warnings

- NEVER omit `@workgroup_size` on a `@compute` function: it is a hard
  shader-creation error.
- NEVER read or write `var<workgroup>` data produced by other invocations without a
  `workgroupBarrier()` separating the write and the read.
- NEVER place a barrier in non-uniform (divergent) control flow: the result is
  undefined and a uniformity violation.
- NEVER read or write an `atomic<T>` with `=`: use `atomicLoad` and `atomicStore`.
  Atomic operations are legal only in `workgroup` and `read_write` `storage` memory.
- NEVER use `subgroupAdd`, `subgroupBallot`, `subgroup_invocation_id`, or
  `subgroup_size` without first confirming `adapter.features.has("subgroups")`.
- NEVER assume `storageBarrier()` orders writes across different workgroups: a
  barrier synchronizes only within one workgroup. Use separate compute passes for
  cross-workgroup ordering.
- NEVER index `array` storage by `global_invocation_id` without a bounds check: the
  final workgroup overshoots when the length is not a multiple of the workgroup size.

## Reference Files

- `methods.md` : `@compute` and `@workgroup_size`, the invocation-id
  builtins, `var<workgroup>`, atomic types and functions, barriers, subgroup builtins.
- `examples.md` : verified WGSL for a basic kernel, a workgroup-memory
  reduction with barriers, and an atomic counter.
- `anti-patterns.md` : compute-shader mistakes with why-it-fails analysis.

### Related skills

- `webgpu-wgsl-memory-layout` : alignment and layout of `storage` and `workgroup` types.
- `webgpu-wgsl-uniformity` : uniform control flow rules that govern barrier placement.
- `webgpu-syntax-compute-pipeline` : host-side `dispatchWorkgroups` and pipeline setup.
- `webgpu-impl-compute-usecases` : reduction, scan, particle, and image-processing patterns.
