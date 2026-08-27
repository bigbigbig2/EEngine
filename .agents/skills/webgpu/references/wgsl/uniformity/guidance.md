# WGSL Uniformity and Directives

Keep WGSL shaders valid by calling derivative, sample, and barrier builtins only
in uniform control flow, and gate optional features with the correct directives.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable: Chrome 113+, Safari 26+,
Firefox 141+.

Uniform control flow means code reached by all invocations in a group taking the
same path. Non-uniform (divergent) control flow means the path depends on a
per-invocation value. The uniformity analysis runs at shader-creation time and
proves, or fails to prove, that a restricted builtin is reached uniformly.

Builtins that ALWAYS require uniform control flow:

| Builtin | Stage | Why restricted |
|---------|-------|----------------|
| `textureSample` | fragment | computes the LOD via implicit derivatives |
| `textureSampleBias` | fragment | implicit derivatives plus bias |
| `textureSampleCompare` | fragment | implicit derivatives for shadow LOD |
| `textureGather` (no level arg) | fragment | implicit derivatives |
| `dpdx`, `dpdy`, `fwidth` | fragment | derivatives use neighbor invocations |
| `dpdxCoarse`, `dpdyCoarse`, `fwidthCoarse` | fragment | derivative variant |
| `dpdxFine`, `dpdyFine`, `fwidthFine` | fragment | derivative variant |
| `workgroupBarrier`, `storageBarrier`, `textureBarrier` | compute | every invocation must reach the barrier |
| `workgroupUniformLoad` | compute | executes a control barrier internally |

Builtins that DO NOT require uniform control flow (safe in divergent branches):
`textureSampleLevel`, `textureSampleGrad`, `textureSampleCompareLevel`,
`textureLoad`, `textureStore`, `textureGather` with an explicit level.

The two diagnostic triggering rules and the three directives:

| Name | Kind | Purpose |
|------|------|---------|
| `derivative_uniformity` | triggering rule | fires when a derivative or `textureSample` call is not provably uniform; default severity `error` |
| `subgroup_uniformity` | triggering rule | fires when a subgroup or quad builtin is not provably uniform; default severity `error` |
| `enable` | directive | turns on an enable-extension: `f16`, `subgroups`, `clip_distances`, `dual_source_blending` |
| `requires` | directive | turns on a language extension (no host feature needed), for example `readonly_and_readwrite_storage_textures` |
| `diagnostic` | directive | sets the severity of a triggering rule at module scope |

Directives ALWAYS appear at the top of the shader, before any declaration.
`@diagnostic(severity, rule)` is an attribute placed on a function, compound
statement, or control-flow statement to scope a severity override.

## Decision Tree

How to fix a `derivative_uniformity` diagnostic:

1. Is the call in a `@vertex` or `@compute` entry point? Then replace
   `textureSample` with `textureSampleLevel` or `textureLoad`. Derivative and
   plain-sample builtins are fragment-stage only.
2. Is the call inside an `if`, `switch`, `loop`, `for`, or `while` whose
   condition depends on a per-invocation value (a varying, `front_facing`,
   `instance_index`, a sampled value)? Then HOIST the sample or derivative
   above the branch and store the result in a `let`, then branch on that `let`.
3. Does the result genuinely need a per-invocation level of detail? Compute the
   derivative once in uniform flow with `textureSampleGrad`, passing explicit
   `ddx`/`ddy` gradients.
4. NEVER silence the diagnostic with `diagnostic(off, derivative_uniformity)`.
   The GPU still computes derivatives from neighbor invocations that may have
   diverged, so the sampled LOD is undefined.

How to fix a barrier uniformity violation in a `@compute` shader:

1. Move the `workgroupBarrier` / `storageBarrier` out of every `if`, `loop`, or
   early `return` path so all invocations in the workgroup reach it.
2. To conditionally skip work, write the condition's result to `var<workgroup>`
   memory, barrier unconditionally, then branch on the shared value.
3. To read shared memory safely, use `workgroupUniformLoad` in uniform flow.

## Core Patterns

### Pattern 1: ALWAYS hoist textureSample out of non-uniform control flow

```wgsl
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(@location(0) uv: vec2f, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  let sampled = textureSample(tex, samp, uv); // uniform: outside any branch
  if (facing) {
    return sampled;
  }
  return sampled * 0.5;
}
```

NEVER call `textureSample` inside the `if (facing)` body. `front_facing` differs
per invocation, so the branch is non-uniform and the analysis rejects the call.

### Pattern 2: ALWAYS use textureSampleLevel in vertex and compute stages

```wgsl
@vertex
fn vs(@location(0) uv: vec2f) -> @builtin(position) vec4f {
  let height = textureSampleLevel(heightMap, heightSamp, uv, 0.0);
  return vec4f(uv, height.r, 1.0);
}
```

`textureSample` is fragment-stage only because it needs neighbor derivatives.
`textureSampleLevel` and `textureLoad` take an explicit level and ALWAYS work in
any stage and in non-uniform control flow.

### Pattern 3: NEVER place a barrier in divergent compute control flow

```wgsl
var<workgroup> tile: array<f32, 64>;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  tile[lid] = f32(lid);
  workgroupBarrier();              // every invocation reaches this
  let neighbor = tile[(lid + 1u) % 64u];
}
```

A `workgroupBarrier` inside `if (lid < 32u) { ... }` is undefined behavior:
invocations that skip the branch never reach the barrier, so the workgroup
hangs or produces garbage. The barrier ALWAYS sits in uniform control flow.

### Pattern 4: ALWAYS use workgroupUniformLoad for a safe workgroup read

```wgsl
var<workgroup> shared_count: u32;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) { shared_count = 64u; }
  let count = workgroupUniformLoad(&shared_count); // barrier + uniform broadcast
  // count is identical for every invocation here
}
```

`workgroupUniformLoad(ptr: ptr<workgroup, T, read_write>) -> T` executes a
control barrier and returns the loaded value to all invocations. NEVER read
`var<workgroup>` written by another invocation without a barrier or
`workgroupUniformLoad` between the write and the read.

### Pattern 5: ALWAYS feature-detect before emitting an enable directive

```wgsl
enable f16;                        // first line of the shader

@group(0) @binding(0) var<uniform> weights: array<vec4<f16>, 16>;
```

`enable f16` REQUIRES the host to create the `GPUDevice` with the `shader-f16`
feature. ALWAYS check `adapter.features.has("shader-f16")` and pass it in
`requiredFeatures`. `enable subgroups` requires the `subgroups` feature;
`enable clip_distances` requires the `clip-distances` feature. Emitting an
`enable` directive without the matching device feature is a shader-creation
error. See examples.md for the host-side guard.

### Pattern 6: ALWAYS scope a diagnostic override with @diagnostic on the smallest unit

```wgsl
@fragment
@diagnostic(warning, derivative_uniformity)
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(tex, samp, uv);
}
```

The `@diagnostic(severity, rule)` attribute lowers severity for one function
only. Severity values are `error`, `warning`, `info`, and `off`. NEVER use
`off`: a downgrade to `warning` keeps the message visible while the real fix is
hoisting the call into uniform flow.

## Common Anti-Patterns

1. Calling `textureSample` inside an `if` whose condition varies per invocation.
   The branch is non-uniform, so the GPU cannot compute valid derivatives and
   the analysis rejects the shader. Fix: hoist the sample out of the branch.
2. Placing `workgroupBarrier` inside divergent control flow. Invocations that
   skip the branch never reach the barrier, which is undefined behavior. Fix:
   barrier unconditionally, branch on `var<workgroup>` state.
3. Emitting `enable f16` without requesting the `shader-f16` device feature.
   The shader fails creation. Fix: feature-detect on the adapter first.

## Critical Warnings

- NEVER call `textureSample`, `textureSampleBias`, `textureSampleCompare`,
  `dpdx`, `dpdy`, or `fwidth` from a `@vertex` or `@compute` entry point. They
  are fragment-stage only.
- NEVER suppress a `derivative_uniformity` error with
  `diagnostic(off, derivative_uniformity)`. The sampled LOD becomes undefined.
- NEVER put a `workgroupBarrier`, `storageBarrier`, or `textureBarrier` in any
  branch, loop body, or early-return path that some invocations skip.
- NEVER emit an `enable` directive for a feature the adapter does not report.
- ALWAYS place `enable`, `requires`, and `diagnostic` directives before any
  declaration in the shader.

## Reference Files

- `methods.md`: uniform control flow rules, the `enable` / `requires`
  / `diagnostic` directives, triggering-rule names, `workgroupUniformLoad`.
- `examples.md`: verified WGSL hoisting a sample out of non-uniform
  flow, correct `enable` directive with host guard, `@diagnostic` usage.
- `anti-patterns.md`: uniformity mistakes with WHY-it-fails analysis.

## Related Skills

- `webgpu-wgsl-builtins`: full builtin function catalog per stage.
- `webgpu-wgsl-textures`: texture and sampler handle types and sampling.
- `webgpu-wgsl-compute-shaders`: workgroups, barriers, shared memory.
- `webgpu-core-limits-features`: adapter feature detection and `requiredFeatures`.
