# WGSL Compute Shader Methods

API reference for the `@compute` stage in WebGPU 1.0-stable (Chrome 113+, Safari
26+, Firefox 141+). Verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/).

## The @compute entry point and @workgroup_size

A compute shader is a single module-scope function carrying both `@compute` and
`@workgroup_size`. The pair is mandatory.

```wgsl
@compute @workgroup_size(x [, y [, z]])
fn name(/* builtin parameters */) { /* body */ }
```

Rules:

- `@workgroup_size` is REQUIRED on every `@compute` function. Omitting it is a
  shader-creation error.
- `@workgroup_size(x)`, `@workgroup_size(x, y)`, and `@workgroup_size(x, y, z)` are
  all valid. A missing `y` or `z` defaults to `1`.
- Each argument is a positive integer. It may be a literal, a `const` expression, or
  an `override` constant whose value is supplied by the host at pipeline creation.
- The product `x*y*z` is the number of invocations per workgroup. It MUST NOT exceed
  `device.limits.maxComputeInvocationsPerWorkgroup`; each axis MUST NOT exceed
  `maxComputeWorkgroupSizeX/Y/Z`.
- A `@compute` function returns nothing. It has no `@location` inputs or outputs;
  data flows through resource bindings.

Override-driven workgroup size:

```wgsl
override wgSize: u32 = 64u;            // host can override via pipeline constants
@compute @workgroup_size(wgSize)
fn main(@builtin(local_invocation_index) li: u32) { /* ... */ }
```

## Compute builtin values

All compute builtins are inputs, declared with `@builtin(name)` on entry-point
parameters. Types are fixed.

| Builtin | Type | Description |
|---------|------|-------------|
| `global_invocation_id` | `vec3<u32>` | Position of this invocation in the whole dispatch grid of invocations |
| `local_invocation_id` | `vec3<u32>` | Position within the workgroup, each component `0 .. workgroup_size_axis - 1` |
| `local_invocation_index` | `u32` | Linearized `local_invocation_id`, `0 .. (x*y*z - 1)` |
| `workgroup_id` | `vec3<u32>` | Position of this workgroup in the dispatch grid |
| `num_workgroups` | `vec3<u32>` | The grid size passed to `dispatchWorkgroups(x, y, z)` on the host |

Every type is `vec3<u32>` except `local_invocation_index`, which is `u32`.

The defining relation between the ids:

```
global_invocation_id = workgroup_id * workgroup_size + local_invocation_id
```

The linearization, given a workgroup size `(sx, sy, sz)`:

```
local_invocation_index =
    local_invocation_id.x
  + local_invocation_id.y * sx
  + local_invocation_id.z * sx * sy
```

Declare only the builtins the shader uses:

```wgsl
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_id)  lid: vec3<u32>,
        @builtin(workgroup_id)         wid: vec3<u32>,
        @builtin(num_workgroups)       n:   vec3<u32>) { /* ... */ }
```

## var<workgroup> shared memory

`var<workgroup>` declares a module-scope variable in the `workgroup` address space.
Properties:

- The memory is shared by ALL invocations of one workgroup. Different workgroups get
  separate, independent instances.
- Access mode is `read_write`. It is not host-shareable; there is no buffer binding.
- The implementation zero-initializes `workgroup` memory before the workgroup runs.
- Cross-invocation visibility of a write still REQUIRES a `workgroupBarrier()`
  between the write and the read. Zero-initialization does not remove the data race.
- Total `workgroup` memory per shader MUST NOT exceed
  `device.limits.maxComputeWorkgroupStorageSize`.
- `var<workgroup>` may NOT have an initializer expression and may NOT hold a
  runtime-sized array. Its size must be fixed at compile time.

```wgsl
var<workgroup> tile: array<f32, 256>;        // fixed size, no initializer
var<workgroup> partial: atomic<u32>;          // atomic in workgroup space
```

## Atomic types and functions

`atomic<i32>` and `atomic<u32>` are the only atomic types. An `atomic<T>` is legal
only in the `workgroup` address space or in `storage` with `read_write` access.
NEVER read an `atomic<T>` with `=`; use `atomicLoad`.

Atomic functions, where `p` is `ptr<AS, atomic<T>, read_write>` formed with `&`:

| Function | Signature | Effect |
|----------|-----------|--------|
| `atomicLoad(p)` | `-> T` | Atomic read |
| `atomicStore(p, v)` | `-> ()` | Atomic write |
| `atomicAdd(p, v)` | `-> T` | Atomic `*p += v`, returns the old value |
| `atomicSub(p, v)` | `-> T` | Atomic `*p -= v`, returns the old value |
| `atomicMax(p, v)` | `-> T` | Atomic max, returns the old value |
| `atomicMin(p, v)` | `-> T` | Atomic min, returns the old value |
| `atomicAnd(p, v)` | `-> T` | Atomic bitwise and, returns the old value |
| `atomicOr(p, v)` | `-> T` | Atomic bitwise or, returns the old value |
| `atomicXor(p, v)` | `-> T` | Atomic bitwise xor, returns the old value |
| `atomicExchange(p, v)` | `-> T` | Atomic swap, returns the old value |
| `atomicCompareExchangeWeak(p, cmp, v)` | `-> __atomic_compare_exchange_result<T>` | Compare-and-swap |

`atomicCompareExchangeWeak` returns a struct with members `old_value: T` and
`exchanged: bool`. The swap may spuriously fail even when `old_value == cmp`, which
is why a CAS is written inside a retry loop.

```wgsl
@group(0) @binding(0) var<storage, read_write> cell: atomic<u32>;

fn cas_increment() {
  loop {
    let cur = atomicLoad(&cell);
    let res = atomicCompareExchangeWeak(&cell, cur, cur + 1u);
    if (res.exchanged) { break; }
  }
}
```

## Barriers

Barriers are control-flow synchronization functions for the compute stage. Each
takes no arguments and returns nothing.

| Function | Synchronizes |
|----------|--------------|
| `workgroupBarrier()` | Control + `workgroup`-memory accesses across the workgroup |
| `storageBarrier()` | Control + `storage`-memory accesses across the workgroup |
| `textureBarrier()` | Control + storage-texture accesses across the workgroup |

Rules:

- A barrier is COMPUTE STAGE ONLY. It is invalid in `@vertex` and `@fragment`.
- A barrier MUST execute in uniform control flow: every invocation of the workgroup
  must reach the same barrier call. Placing it in divergent control flow is
  undefined behavior and a uniformity violation. See `webgpu-wgsl-uniformity`.
- A barrier orders accesses WITHIN one workgroup only. It does NOT order accesses
  between different workgroups. Cross-workgroup ordering needs separate dispatches.
- `workgroupBarrier()` is required between a `var<workgroup>` write and any read of
  that location by a different invocation.

`workgroupUniformLoad(p)` is a related synchronization function: it reads a
`workgroup` location and returns a value that is uniform across the workgroup, with
an implied barrier. Like the barriers it must run in uniform control flow.

## Subgroup builtins (optional `subgroups` feature)

Subgroups expose the SIMD lanes of the hardware. They need the `subgroups` device
feature, requested on the device after checking `adapter.features.has("subgroups")`.
Support is most complete in Chrome and lags in Safari and Firefox. ALWAYS gate
subgroup code behind runtime feature detection.

Subgroup builtin values, declared with `@builtin(name)` on entry-point parameters:

| Builtin | Type | Description |
|---------|------|-------------|
| `subgroup_invocation_id` | `u32` | This invocation's index within its subgroup |
| `subgroup_size` | `u32` | Number of invocations in the subgroup |

Subgroup builtin functions (a representative set):

| Function | Effect |
|----------|--------|
| `subgroupAdd(v)` | Sum of `v` across all active invocations of the subgroup |
| `subgroupInclusiveAdd(v)` | Inclusive prefix sum across the subgroup |
| `subgroupExclusiveAdd(v)` | Exclusive prefix sum across the subgroup |
| `subgroupBallot(pred)` | `vec4<u32>` bitmask of which invocations had `pred` true |
| `subgroupBroadcast(v, id)` | Value of `v` from the lane `id`, shared to all lanes |
| `subgroupBroadcastFirst(v)` | Value of `v` from the lowest active lane |

Subgroup operations interact with control-flow uniformity in the same way barriers
do. A subgroup is a subset of one workgroup, so subgroup ops never cross workgroup
boundaries.

## Host-side dispatch versus @workgroup_size

`@workgroup_size` lives in the WGSL shader and sets invocations PER workgroup. The
host call `pass.dispatchWorkgroups(countX, countY, countZ)` sets how MANY workgroups
run, and that count is what `num_workgroups` reports. They are independent. Total
invocations launched is `dispatchWorkgroups count * @workgroup_size`. The host-side
pipeline and dispatch are covered by `webgpu-syntax-compute-pipeline`.
