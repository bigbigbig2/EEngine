# WGSL Builtin Functions and Values: Reference

All names verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/)
and the vooronderzoek WebGPU research base. Version baseline: WGSL of WebGPU
1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). NEVER invent a builtin name.

## 1. Builtin functions by category

Builtin functions need no import. Most math, trigonometric, geometric, matrix,
integer, and pack functions accept scalars or `vecN<T>` and apply componentwise on
vectors. Each function const-evaluates when every argument is a const-expression.

### 1.1 Math/numeric functions

| Function | Purpose |
|----------|---------|
| `abs(x)` | Absolute value. |
| `clamp(x, lo, hi)` | Constrain `x` to the range `[lo, hi]`. |
| `min(x, y)` | Smaller of two values. |
| `max(x, y)` | Larger of two values. |
| `floor(x)` | Largest integer not greater than `x`. |
| `ceil(x)` | Smallest integer not less than `x`. |
| `round(x)` | Round to nearest, ties to even. |
| `trunc(x)` | Round toward zero. |
| `fract(x)` | Fractional part, `x - floor(x)`. |
| `sign(x)` | -1, 0, or +1 by sign of `x`. |
| `mix(a, b, t)` | Linear interpolation `a*(1-t) + b*t`. |
| `step(edge, x)` | 0.0 when `x < edge`, else 1.0. |
| `smoothstep(lo, hi, x)` | Smooth Hermite interpolation between 0 and 1. |
| `saturate(x)` | `clamp(x, 0.0, 1.0)`. |
| `fma(a, b, c)` | Fused multiply-add `a*b + c`. |
| `pow(x, y)` | `x` raised to power `y`. |
| `sqrt(x)` | Square root. |
| `inverseSqrt(x)` | `1.0 / sqrt(x)`. |
| `exp(x)` | `e` raised to `x`. |
| `exp2(x)` | 2 raised to `x`. |
| `log(x)` | Natural logarithm. |
| `log2(x)` | Base-2 logarithm. |
| `modf(x)` | Split into fractional and whole parts; returns a `__modf_result_*` struct with `.fract` and `.whole`. |
| `frexp(x)` | Split into significand and exponent; returns a `__frexp_result_*` struct with `.fract` and `.exp`. |
| `ldexp(x, e)` | `x * 2^e`. |
| `quantizeToF16(x)` | Round an `f32` to the nearest representable `f16` value, result stays `f32`. |

### 1.2 Trigonometric functions

All operate on `f32`/`f16` scalars or vectors. Angles are in radians.

| Function | Purpose |
|----------|---------|
| `sin(x)` / `cos(x)` / `tan(x)` | Sine, cosine, tangent. |
| `asin(x)` / `acos(x)` / `atan(x)` | Inverse sine, cosine, tangent. |
| `atan2(y, x)` | Arctangent of `y/x` using the signs of both to pick the quadrant. |
| `sinh(x)` / `cosh(x)` / `tanh(x)` | Hyperbolic sine, cosine, tangent. |
| `asinh(x)` / `acosh(x)` / `atanh(x)` | Inverse hyperbolic functions. |
| `degrees(x)` | Convert radians to degrees. |
| `radians(x)` | Convert degrees to radians. |

### 1.3 Geometric/vector functions

| Function | Purpose |
|----------|---------|
| `dot(a, b)` | Dot product of two vectors, returns a scalar. |
| `cross(a, b)` | Cross product, `vec3` arguments only, returns a `vec3`. |
| `length(v)` | Euclidean length of a vector (or absolute value of a scalar). |
| `distance(a, b)` | `length(a - b)`. |
| `normalize(v)` | Unit vector in the direction of `v`. |
| `reflect(i, n)` | Reflection of incident vector `i` about unit normal `n`. |
| `refract(i, n, eta)` | Refraction of `i` about unit normal `n` with index ratio `eta`. |
| `faceForward(n, i, nref)` | Returns `n` if `dot(nref, i) < 0`, else `-n`. |

`cross` requires three-component vectors. `normalize` of a zero vector is
indeterminate; guard with a length check when the input may be zero.

### 1.4 Matrix functions

| Function | Purpose |
|----------|---------|
| `transpose(m)` | Transpose of a `matCxR<f32>`, result is `matRxC<f32>`. |
| `determinant(m)` | Determinant of a square `matNxN<f32>`, returns a scalar. |

WGSL has NO builtin matrix `inverse`. Compute an inverse on the host and pass it as
a uniform, or write an explicit WGSL helper.

### 1.5 Integer/bit functions

Operate on `i32`/`u32` scalars or vectors of them.

| Function | Purpose |
|----------|---------|
| `countOneBits(x)` | Number of set bits (population count). |
| `countLeadingZeros(x)` | Number of leading zero bits. |
| `countTrailingZeros(x)` | Number of trailing zero bits. |
| `firstLeadingBit(x)` | Index of the most significant set bit, or -1/0xFFFFFFFF if none. |
| `firstTrailingBit(x)` | Index of the least significant set bit, or -1/0xFFFFFFFF if none. |
| `extractBits(x, offset, count)` | Extract `count` bits starting at `offset`. |
| `insertBits(x, newbits, offset, count)` | Insert `count` bits of `newbits` into `x` at `offset`. |
| `reverseBits(x)` | Reverse the bit order. |
| `dot4U8Packed(a, b)` | Dot product of two `u32` values each treated as 4 packed `u8`, returns `u32`. |
| `dot4I8Packed(a, b)` | Dot product of two `u32` values each treated as 4 packed `i8`, returns `i32`. |

### 1.6 Pack/unpack functions

Pack functions convert a `vec2`/`vec4` into a single `u32`. Unpack functions are the
inverses, converting a `u32` back into a `vec2`/`vec4`.

| Pack function | Input | Output |
|---------------|-------|--------|
| `pack4x8snorm(v)` | `vec4<f32>` clamped to [-1, 1] | `u32` (4 signed-normalized bytes) |
| `pack4x8unorm(v)` | `vec4<f32>` clamped to [0, 1] | `u32` (4 unsigned-normalized bytes) |
| `pack4xI8(v)` | `vec4<i32>` (low 8 bits used) | `u32` (4 signed bytes) |
| `pack4xU8(v)` | `vec4<u32>` (low 8 bits used) | `u32` (4 unsigned bytes) |
| `pack4xI8Clamp(v)` | `vec4<i32>` clamped to [-128, 127] | `u32` (4 signed bytes) |
| `pack4xU8Clamp(v)` | `vec4<u32>` clamped to [0, 255] | `u32` (4 unsigned bytes) |
| `pack2x16snorm(v)` | `vec2<f32>` clamped to [-1, 1] | `u32` (2 signed-normalized halves) |
| `pack2x16unorm(v)` | `vec2<f32>` clamped to [0, 1] | `u32` (2 unsigned-normalized halves) |
| `pack2x16float(v)` | `vec2<f32>` | `u32` (2 IEEE f16 halves) |

| Unpack function | Input | Output |
|-----------------|-------|--------|
| `unpack4x8snorm(u)` | `u32` | `vec4<f32>` in [-1, 1] |
| `unpack4x8unorm(u)` | `u32` | `vec4<f32>` in [0, 1] |
| `unpack4xI8(u)` | `u32` | `vec4<i32>` |
| `unpack4xU8(u)` | `u32` | `vec4<u32>` |
| `unpack2x16snorm(u)` | `u32` | `vec2<f32>` in [-1, 1] |
| `unpack2x16unorm(u)` | `u32` | `vec2<f32>` in [0, 1] |
| `unpack2x16float(u)` | `u32` | `vec2<f32>` from 2 f16 halves |

There is NO `pack4xI8Clamp` unpack counterpart distinct from `unpack4xI8`; the clamp
variants share the same unpack inverse as their non-clamp form.

### 1.7 Array function

| Function | Purpose |
|----------|---------|
| `arrayLength(&p)` | Number of elements in a runtime-sized array pointed to by `p`. |

`arrayLength` takes a pointer to a runtime-sized `array<T>`, which lives only as the
last member of a `storage` struct.

### 1.8 Texture functions (cross-linked to webgpu-wgsl-textures)

Texture builtins are documented in full in `webgpu-wgsl-textures`. This skill states
only the stage rule. Two groups exist:

| Builtin | Stage rule |
|---------|-----------|
| `textureSample`, `textureSampleBias`, `textureSampleCompare`, `textureGather`, `textureGatherCompare` | `@fragment` ONLY, in uniform control flow. They compute the mip level from implicit screen-space derivatives. |
| `textureSampleLevel`, `textureSampleGrad`, `textureSampleCompareLevel`, `textureSampleBaseClampToEdge`, `textureLoad`, `textureStore`, `textureDimensions`, `textureNumLayers`, `textureNumLevels`, `textureNumSamples` | Any stage. No implicit derivative; the level or gradient is explicit, or no sampling occurs. |

### 1.9 Derivative functions (fragment stage only)

| Builtin | Variants |
|---------|----------|
| `dpdx` | `dpdxCoarse`, `dpdxFine` |
| `dpdy` | `dpdyCoarse`, `dpdyFine` |
| `fwidth` | `fwidthCoarse`, `fwidthFine` |

All derivative builtins are legal ONLY in `@fragment` and must run in uniform
control flow. `fwidth(p)` equals `abs(dpdx(p)) + abs(dpdy(p))`. Detail and the
uniformity rules: `webgpu-wgsl-uniformity`.

### 1.10 Atomic functions (cross-linked to webgpu-wgsl-compute-shaders)

| Builtin | Purpose |
|---------|---------|
| `atomicLoad(&a)` | Atomically read the value. |
| `atomicStore(&a, v)` | Atomically write a value. |
| `atomicAdd` / `atomicSub` | Atomic add / subtract, returns the old value. |
| `atomicMax` / `atomicMin` | Atomic maximum / minimum, returns the old value. |
| `atomicAnd` / `atomicOr` / `atomicXor` | Atomic bitwise op, returns the old value. |
| `atomicExchange(&a, v)` | Atomically swap, returns the old value. |
| `atomicCompareExchangeWeak(&a, cmp, v)` | Compare-and-swap, returns an `__atomic_compare_exchange_result` struct with `.old_value` and `.exchanged`. |

The atomic pointer ALWAYS targets `workgroup` or `storage` memory with `read_write`
access; the pointed-to type is `atomic<i32>` or `atomic<u32>`. Detail:
`webgpu-wgsl-compute-shaders`.

### 1.11 Synchronization functions (compute stage only)

| Builtin | Purpose |
|---------|---------|
| `workgroupBarrier()` | Synchronize all invocations in a workgroup and order workgroup-memory accesses. |
| `storageBarrier()` | Synchronize and order storage-buffer accesses. |
| `textureBarrier()` | Synchronize and order storage-texture accesses. |
| `workgroupUniformLoad(&p)` | Synchronizing load of a `workgroup` value, broadcast uniformly. |

All four are legal ONLY in `@compute` and must execute in uniform control flow.
Detail: `webgpu-wgsl-uniformity`.

## 2. Builtin values: complete table

`@builtin(name)` binds an entry-point parameter or return-struct member to a system
input or output. The `position` builtin appears twice because its direction and
meaning change between stages.

| Builtin | Stage | Direction | Type | Notes |
|---------|-------|-----------|------|-------|
| `vertex_index` | vertex | input | `u32` | Index of the current vertex within the draw, including the non-indexed `firstVertex` base. |
| `instance_index` | vertex | input | `u32` | Index of the current instance, INCLUDING the draw `firstInstance` base. |
| `position` | vertex | output | `vec4<f32>` | Clip-space position. The host divides by `w`. |
| `position` | fragment | input | `vec4<f32>` | Framebuffer-space pixel coordinate (`xy` in pixels, `z` is depth, `w` is `1/clip.w`). |
| `clip_distances` | vertex | output | `array<f32, N>` | User clip planes. Needs the `clip-distances` device feature. |
| `front_facing` | fragment | input | `bool` | `true` if the fragment belongs to a front-facing primitive. |
| `frag_depth` | fragment | output | `f32` | Overrides the interpolated depth. Disables early-Z when written. |
| `sample_index` | fragment | input | `u32` | Index of the current sample in MSAA. Reading it forces sample-rate shading. |
| `sample_mask` | fragment | input/output | `u32` | Coverage bitmask. As output it can clear sample coverage. |
| `local_invocation_id` | compute | input | `vec3<u32>` | Invocation coordinate within the workgroup. |
| `local_invocation_index` | compute | input | `u32` | Linearized form of `local_invocation_id`. |
| `global_invocation_id` | compute | input | `vec3<u32>` | `workgroup_id * workgroup_size + local_invocation_id`. |
| `workgroup_id` | compute | input | `vec3<u32>` | Coordinate of the workgroup in the dispatch grid. |
| `num_workgroups` | compute | input | `vec3<u32>` | The dispatch grid size passed to `dispatchWorkgroups`. |
| `subgroup_invocation_id` | compute/fragment | input | `u32` | Invocation index within the subgroup. Needs the `subgroups` feature. |
| `subgroup_size` | compute/fragment | input | `u32` | Number of invocations in the subgroup. Needs the `subgroups` feature. |

### Direction rules

- Inputs: declared as `@builtin(name)` on an entry-point parameter (or a member of a
  parameter struct).
- Outputs: declared as `@builtin(name)` on an entry-point return type (or a member
  of the return struct).
- Only `position` (vertex), `frag_depth`, `sample_mask`, and `clip_distances` are
  outputs. Every other builtin value is an input.

### Feature gating

| Builtin | Required device feature | Required shader directive |
|---------|------------------------|---------------------------|
| `clip_distances` | `clip-distances` | none |
| `subgroup_invocation_id` | `subgroups` | `enable subgroups;` |
| `subgroup_size` | `subgroups` | `enable subgroups;` |

ALWAYS feature-detect on the adapter (`adapter.features.has("subgroups")`) before
requesting the feature and emitting the `enable` directive. See
`webgpu-wgsl-enable-directives` and `webgpu-wgsl-subgroups`.
