# WGSL Builtin Functions and Values

Call the right WGSL builtin function and declare builtin input/output values with
the correct stage, direction, and type, without triggering shader-creation errors.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). Builtin functions need no import. Builtin values bind to system
inputs/outputs via the `@builtin(name)` attribute on entry-point parameters and
return members.

### Builtin function categories

| Category | Functions |
|----------|-----------|
| Math/numeric | `abs`, `clamp`, `min`, `max`, `floor`, `ceil`, `round`, `trunc`, `fract`, `sign`, `mix`, `step`, `smoothstep`, `saturate`, `fma`, `pow`, `sqrt`, `inverseSqrt`, `exp`, `exp2`, `log`, `log2`, `modf`, `frexp`, `ldexp`, `quantizeToF16` |
| Trigonometric | `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `degrees`, `radians` |
| Geometric/vector | `dot`, `cross`, `length`, `distance`, `normalize`, `reflect`, `refract`, `faceForward` |
| Matrix | `transpose`, `determinant` |
| Integer/bit | `countOneBits`, `countLeadingZeros`, `countTrailingZeros`, `firstLeadingBit`, `firstTrailingBit`, `extractBits`, `insertBits`, `reverseBits`, `dot4U8Packed`, `dot4I8Packed` |
| Pack/unpack | `pack4x8snorm`, `pack4x8unorm`, `pack4xI8`, `pack4xU8`, `pack4xI8Clamp`, `pack4xU8Clamp`, `pack2x16snorm`, `pack2x16unorm`, `pack2x16float` + `unpack*` inverses |
| Texture (fragment-restricted variants) | `textureSample`, `textureSampleBias`, `textureSampleCompare`, `textureGather`, `textureGatherCompare` |
| Texture (any stage) | `textureSampleLevel`, `textureSampleGrad`, `textureSampleCompareLevel`, `textureLoad`, `textureStore`, `textureDimensions`, `textureNumLayers`, `textureNumLevels`, `textureNumSamples` |
| Derivative (fragment only) | `dpdx`, `dpdy`, `fwidth` + `Coarse`/`Fine` variants |
| Atomic (workgroup/storage memory) | `atomicLoad`, `atomicStore`, `atomicAdd`, `atomicSub`, `atomicMax`, `atomicMin`, `atomicAnd`, `atomicOr`, `atomicXor`, `atomicExchange`, `atomicCompareExchangeWeak` |
| Synchronization (compute only) | `workgroupBarrier`, `storageBarrier`, `textureBarrier`, `workgroupUniformLoad` |
| Array | `arrayLength` |

Texture builtins are documented in detail in `webgpu-wgsl-textures`. Atomic and
synchronization builtins are documented in `webgpu-wgsl-compute-shaders` and
`webgpu-wgsl-uniformity`. This skill lists them and states their stage rule only.

### Builtin values via @builtin(name)

| Builtin | Stage | Direction | Type |
|---------|-------|-----------|------|
| `vertex_index` | vertex | input | `u32` |
| `instance_index` | vertex | input | `u32` |
| `position` | vertex | output | `vec4<f32>` |
| `position` | fragment | input | `vec4<f32>` |
| `clip_distances` | vertex | output | `array<f32, N>` |
| `front_facing` | fragment | input | `bool` |
| `frag_depth` | fragment | output | `f32` |
| `sample_index` | fragment | input | `u32` |
| `sample_mask` | fragment | input/output | `u32` |
| `local_invocation_id` | compute | input | `vec3<u32>` |
| `local_invocation_index` | compute | input | `u32` |
| `global_invocation_id` | compute | input | `vec3<u32>` |
| `workgroup_id` | compute | input | `vec3<u32>` |
| `num_workgroups` | compute | input | `vec3<u32>` |
| `subgroup_invocation_id` | compute/fragment | input | `u32` |
| `subgroup_size` | compute/fragment | input | `u32` |

`clip_distances` needs the `clip-distances` device feature. `subgroup_invocation_id`
and `subgroup_size` need the `subgroups` device feature plus `enable subgroups;` in
the shader. All other builtin values are core WGSL 1.0 with no feature gate.

## Decision Tree

```
Need to read or sample a texture in WGSL?
├── Entry point is @fragment AND control flow is uniform?
│   └── textureSample / textureSampleBias / textureSampleCompare /
│       textureGather / textureGatherCompare    (implicit-derivative builtins)
└── Entry point is @vertex or @compute, OR control flow is non-uniform?
    └── textureSampleLevel (explicit LOD) / textureSampleGrad (explicit grad) /
        textureLoad (no sampler)               (no implicit derivative)

Need a screen-space derivative (dpdx / dpdy / fwidth)?
└── Legal ONLY in @fragment. NEVER call from @vertex or @compute.

Need to synchronize compute invocations (workgroupBarrier / storageBarrier)?
└── Legal ONLY in @compute, and ONLY in uniform control flow.
    See webgpu-wgsl-uniformity.

Need an atomic operation (atomicAdd, atomicCompareExchangeWeak, ...)?
└── Pointer must target workgroup or storage memory with read_write access.
    See webgpu-wgsl-compute-shaders.
```

## Core Patterns

### ALWAYS use textureSampleLevel or textureLoad outside the fragment stage

`textureSample` and the other implicit-derivative texture builtins compute the LOD
from screen-space derivatives. Derivatives exist ONLY in the fragment stage. In
`@vertex` or `@compute`, ALWAYS supply an explicit level with `textureSampleLevel`
or use `textureLoad`.

```wgsl
@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid : vec3u) {
  let texel = textureLoad(src, vec2i(gid.xy), 0);   // explicit mip level 0
}
```

### ALWAYS mark integer builtin inputs that cross stages with @interpolate(flat)

Integer inter-stage values cannot be interpolated. A `u32`/`i32` `@location` varying
ALWAYS needs `@interpolate(flat)` on both the vertex output and the fragment input,
or shader creation fails. Builtin values themselves are not user varyings, but values
derived from `vertex_index`/`instance_index` and passed via `@location` follow this
rule.

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4f,
  @location(0) @interpolate(flat) material_id : u32,
}
```

### ALWAYS treat instance_index as including the draw firstInstance base

`@builtin(instance_index)` includes the `firstInstance` argument of `draw` /
`drawIndexed`. To index a per-instance array from element 0, ALWAYS subtract the
known base, or set `firstInstance` to 0.

```wgsl
@vertex fn vs(@builtin(instance_index) ii : u32) -> @builtin(position) vec4f {
  let xform = instances[ii];   // ii is already firstInstance + local index
  ...
}
```

### NEVER write @builtin(frag_depth) unless the depth-stencil state writes depth

`frag_depth` is meaningful ONLY when the pipeline has a `depthStencil` state with
`depthWriteEnabled: true`. Writing `frag_depth` also disables early-Z: the GPU
cannot reject the fragment before running the shader.

### ALWAYS use the const-evaluable builtins on const operands to fold at compile time

Math builtins (`sqrt`, `pow`, `clamp`, `mix`, etc.) const-evaluate when every
argument is a const-expression. This lets a `const` declaration hold a precomputed
value with zero runtime cost. Users cannot annotate their own functions as const.

### NEVER call a synchronization builtin in divergent control flow

`workgroupBarrier`, `storageBarrier`, and `textureBarrier` ALWAYS run in uniform
control flow. Calling one inside an `if` whose condition varies per invocation is a
uniformity violation with undefined results. See `webgpu-wgsl-uniformity`.

## Common Anti-Patterns

1. Calling `textureSample` or `dpdx`/`dpdy`/`fwidth` from a `@vertex` or `@compute`
   entry point. WHY it fails: implicit derivatives do not exist outside the fragment
   stage, so this is a shader-creation error. Use `textureSampleLevel`/`textureLoad`.

2. Indexing a per-instance buffer with `instance_index` while `firstInstance` is
   non-zero. WHY it fails: `instance_index` includes the `firstInstance` base, so the
   index runs past the array end and reads garbage or fails bounds-checking.

3. Writing `@builtin(frag_depth)` and expecting early depth rejection. WHY it fails:
   any explicit `frag_depth` write forces the depth test after the fragment shader,
   so early-Z is disabled and overdraw cost rises.

## Critical Warnings

- NEVER call `textureSample`, `textureSampleBias`, `textureSampleCompare`,
  `textureGather`, or `textureGatherCompare` outside the fragment stage.
- NEVER call `dpdx`, `dpdy`, `fwidth`, or their `Coarse`/`Fine` variants outside the
  fragment stage.
- NEVER call `workgroupBarrier`, `storageBarrier`, or `textureBarrier` outside the
  compute stage or in non-uniform control flow.
- NEVER call `discard` from a `@vertex` or `@compute` entry point; `discard` is a
  fragment-stage statement.
- NEVER put `@location` and `@builtin` on the same struct member or parameter.
- NEVER use a `subgroup_*` builtin without the `subgroups` device feature and
  `enable subgroups;`; NEVER use `clip_distances` without the `clip-distances`
  feature.
- NEVER assume a builtin value is writable: only `position` (vertex), `frag_depth`,
  `sample_mask`, and `clip_distances` are outputs. All others are inputs.

## Reference Files

- `methods.md` : every builtin function by category and the complete
  builtin-value table with stage, direction, and type.
- `examples.md` : verified WGSL snippets using builtin functions and
  builtin values across all three shader stages.
- `anti-patterns.md` : builtin mistakes with WHY-it-fails explanations.

## Related Skills

- `webgpu-wgsl-syntax` : WGSL types, declarations, operators, control flow.
- `webgpu-wgsl-textures` : texture and sampler handle types, full texture builtins.
- `webgpu-wgsl-uniformity` : uniform control flow rules for derivatives and barriers.
- `webgpu-wgsl-compute-shaders` : compute stage, atomics, workgroup memory.
