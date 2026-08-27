# WGSL Uniformity and Directives: Methods Reference

Verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/) and the
WGSL editor's draft (https://gpuweb.github.io/gpuweb/wgsl/), 2026-05-20. WGSL is
the shading language of WebGPU 1.0-stable: Chrome 113+, Safari 26+, Firefox 141+.

## Uniform control flow

Uniform control flow is code reached by every invocation in a group along the
same path from the entry point. The "group" is the fragment quad and its
neighbors for derivatives, and the compute workgroup for barriers.

Control flow becomes non-uniform (divergent) when an `if`, `switch`, `loop`,
`for`, `while`, `break`, `continue`, or `return` depends on a value that is not
provably the same across the group. Per-invocation values include:

- inter-stage varyings (`@location` fragment inputs)
- `@builtin(position)` in the fragment stage (the pixel coordinate)
- `@builtin(front_facing)`, `@builtin(sample_index)`
- `@builtin(local_invocation_id)`, `@builtin(global_invocation_id)`,
  `@builtin(local_invocation_index)`, `@builtin(vertex_index)`,
  `@builtin(instance_index)`
- any value read from a texture or storage buffer that itself depends on the above
- any value derived by arithmetic from a non-uniform value

Values that ARE uniform: module-scope `const`, `override` pipeline constants,
`uniform` buffer contents, `@builtin(num_workgroups)`, `@builtin(workgroup_id)`,
and expressions built only from uniform operands.

## The uniformity analysis

The uniformity analysis runs at shader-creation time
(`device.createShaderModule`). It builds a dataflow graph and proves whether
each call to a restricted builtin is reached in uniform control flow. When the
analysis cannot prove uniformity, it emits a diagnostic governed by a triggering
rule. The analysis is conservative: a call it cannot prove uniform is treated as
non-uniform even if it would be uniform at runtime.

## Builtins restricted to uniform control flow

Derivative builtins (fragment stage only), all require uniform control flow:
`dpdx`, `dpdy`, `fwidth`, `dpdxCoarse`, `dpdyCoarse`, `fwidthCoarse`,
`dpdxFine`, `dpdyFine`, `fwidthFine`.

Texture builtins that compute implicit derivatives (fragment stage only),
require uniform control flow: `textureSample`, `textureSampleBias`,
`textureSampleCompare`, and `textureGather` called without an explicit level.

Synchronization builtins (compute stage only), require uniform control flow:
`workgroupBarrier`, `storageBarrier`, `textureBarrier`, `workgroupUniformLoad`.

Subgroup and quad builtins, require uniform control flow under the
`subgroup_uniformity` rule (gated by `enable subgroups`).

Texture builtins that take an explicit level or gradient and do NOT require
uniform control flow, usable in any stage and in divergent branches:
`textureSampleLevel`, `textureSampleGrad`, `textureSampleCompareLevel`,
`textureLoad`, `textureStore`, and `textureGather` with an explicit level.

## Why uniformity is required

Derivatives are computed by differencing the value across neighboring fragment
invocations in a 2x2 quad. If one neighbor took a different branch, its value
for the differenced expression is undefined, so the derivative and the LOD
derived from it are undefined. `textureSample` derives its mip level from these
derivatives, so it inherits the restriction.

Barriers require every invocation in the workgroup to arrive. An invocation that
skips a branch containing the barrier never arrives, so the remaining
invocations wait forever or proceed with an undefined memory state.

## Fixes

| Problem | Fix |
|---------|-----|
| `textureSample` in non-uniform flow | Hoist the call above the divergent branch into a `let`, then branch on the `let`. |
| `textureSample` in `@vertex` / `@compute` | Replace with `textureSampleLevel` (explicit level) or `textureLoad` (explicit texel). |
| Per-invocation LOD genuinely needed | Compute gradients once in uniform flow and call `textureSampleGrad`. |
| `dpdx` / `fwidth` in non-uniform flow | Compute the derivative in uniform flow, store the result, branch on it. |
| `workgroupBarrier` in divergent flow | Move the barrier so all invocations reach it; write the condition to `var<workgroup>` and branch after the barrier. |
| Reading shared `var<workgroup>` after a write by another invocation | Place a `workgroupBarrier` between write and read, or use `workgroupUniformLoad`. |

## workgroupUniformLoad

Signature (compute stage only):

```
fn workgroupUniformLoad(ptr: ptr<workgroup, T, read_write>) -> T
```

`workgroupUniformLoad` executes a control barrier synchronization, then returns
the value pointed to by `ptr` to all invocations in the workgroup. It must only
be called in uniform control flow. The returned value is identical (uniform)
across every invocation of the workgroup. It is the safe way to broadcast a
single workgroup-shared value to all invocations: the internal barrier
guarantees the value is fully written before any invocation reads it.

The pointer must target the `workgroup` address space. `T` is a concrete
plain type other than an atomic type.

## The diagnostic directive

A triggering rule has a name and a current severity. WGSL defines two
uniformity-related triggering rules:

| Triggering rule | Default severity | Fires on |
|-----------------|------------------|----------|
| `derivative_uniformity` | `error` | a derivative builtin or `textureSample`/`textureSampleBias`/`textureSampleCompare` call the analysis cannot prove uniform |
| `subgroup_uniformity` | `error` | a subgroup or quad builtin call the analysis cannot prove uniform |

Severity values, highest to lowest: `error`, `warning`, `info`, `off`.

Module-level diagnostic directive, placed at the top of the shader with the
other directives, sets a rule's severity for the whole module:

```
diagnostic(off, derivative_uniformity);
diagnostic(warning, subgroup_uniformity);
```

`@diagnostic(severity, rule)` attribute scopes a severity override to one
function, compound statement, or control-flow statement. The range covered is
the syntactic extent of the construct the attribute is attached to:

```
@diagnostic(warning, derivative_uniformity)
fn shade(uv: vec2f) -> vec4f { ... }
```

The innermost enclosing `@diagnostic` attribute wins over the module-level
directive for any call inside its range.

Lowering `derivative_uniformity` to `off` does NOT make the shader correct: the
GPU still differences neighbor invocations, and a divergent neighbor still
produces an undefined LOD. Use the directive only to triage, and fix the flow.

## The enable directive

`enable` turns on an enable-extension: an optional WGSL feature that also
requires a matching `GPUDevice` feature on the host.

```
enable f16;
enable subgroups;
enable f16, subgroups;          // multiple names in one directive
```

Enable-extension to host `GPUFeatureName` mapping:

| `enable` extension | Required device feature | Effect |
|--------------------|-------------------------|--------|
| `f16` | `shader-f16` | the `f16` type and `h` literal suffix |
| `subgroups` | `subgroups` | subgroup builtins and `subgroup_*` builtin values |
| `clip_distances` | `clip-distances` | `@builtin(clip_distances)` vertex output |
| `dual_source_blending` | `dual-source-blending` | a second `@blend_src` color output |

Emitting `enable f16` while the device was created without `shader-f16` is a
shader-creation error. ALWAYS feature-detect on the adapter and add the feature
to `requiredFeatures` before emitting the directive.

## The requires directive

`requires` turns on a language extension: a WGSL syntax or semantic extension
that does NOT need a separate host `GPUDevice` feature. The implementation
either supports the language extension or rejects the shader.

```
requires readonly_and_readwrite_storage_textures;
requires packed_4x8_integer_dot_product;
```

Language extension names defined by WGSL include
`readonly_and_readwrite_storage_textures`, `packed_4x8_integer_dot_product`,
`unrestricted_pointer_parameters`, and `pointer_composite_access`. Many are
already folded into core WGSL on current implementations; `requires` makes the
dependency explicit and fails fast on an implementation that lacks it.

`enable` gates an enable-extension paired with a host feature. `requires` gates
a language extension with no host pairing. NEVER use `enable` for a language
extension or `requires` for `f16`.

## Directive placement

`enable`, `requires`, and `diagnostic` are global directives. They ALWAYS
appear at the start of the shader module, before any `const`, `override`,
`alias`, `struct`, `var`, or `fn` declaration. A directive after the first
declaration is a shader-creation error.
