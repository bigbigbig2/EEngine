# WGSL Uniformity and Directives: Anti-Patterns

Each anti-pattern lists the broken code, WHY it fails, and the fix. Verified
against the W3C WGSL specification (https://www.w3.org/TR/WGSL/), 2026-05-20.
Target: WebGPU 1.0-stable, Chrome 113+, Safari 26+, Firefox 141+.

## Anti-pattern 1: textureSample inside a per-invocation branch

```wgsl
// BROKEN
@fragment
fn fs(@location(0) uv: vec2f, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  if (facing) {
    return textureSample(tex, samp, uv); // derivative_uniformity error
  }
  return vec4f(0.0);
}
```

WHY it fails: `front_facing` is a per-invocation value, so the `if` body is
non-uniform control flow. `textureSample` computes its mip level from
derivatives differenced across the 2x2 fragment quad. If one quad neighbor took
the `else` path, its differenced value is undefined, so the derivative and the
sampled LOD are undefined. The uniformity analysis cannot prove the call is
uniform and emits a `derivative_uniformity` error at shader-creation time.

FIX: hoist the sample above the branch.

```wgsl
@fragment
fn fs(@location(0) uv: vec2f, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  let sampled = textureSample(tex, samp, uv);
  return select(vec4f(0.0), sampled, facing);
}
```

## Anti-pattern 2: workgroupBarrier inside divergent control flow

```wgsl
// BROKEN
@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  if (lid < 32u) {
    data[lid] = compute(lid);
    workgroupBarrier();                  // undefined behavior
  }
}
```

WHY it fails: a barrier requires every invocation in the workgroup to reach it.
The 32 invocations with `lid >= 32u` never enter the `if` body and never reach
the `workgroupBarrier`. The 32 invocations that do enter wait at a barrier the
others can never satisfy. The result is a deadlock or, on some implementations,
undefined memory state and garbage output. The uniformity analysis rejects the
barrier because it is not in uniform control flow.

FIX: barrier unconditionally; gate the work, not the barrier.

```wgsl
@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  if (lid < 32u) {
    data[lid] = compute(lid);
  }
  workgroupBarrier();                    // every invocation reaches it
}
```

## Anti-pattern 3: enable f16 without the shader-f16 device feature

```js
// BROKEN host code
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();         // no requiredFeatures
const module = device.createShaderModule({
  code: "enable f16;\n@compute @workgroup_size(1) fn cs() {}",
});
```

WHY it fails: `enable f16` is an enable-extension. An enable-extension is only
valid when the `GPUDevice` was created with the matching `GPUFeatureName`, here
`shader-f16`. The device above requested no features, so compiling a shader that
starts with `enable f16` is a shader-creation error. `getCompilationInfo()`
reports an error message and the module is unusable. Adapter support alone is
not enough: the feature must also be on the device.

FIX: feature-detect on the adapter and pass the feature to `requiredFeatures`.

```js
const adapter = await navigator.gpu.requestAdapter();
const hasF16 = adapter.features.has("shader-f16");
const device = await adapter.requestDevice({
  requiredFeatures: hasF16 ? ["shader-f16"] : [],
});
if (hasF16) {
  device.createShaderModule({ code: f16Shader });
} else {
  device.createShaderModule({ code: f32FallbackShader });
}
```

## Anti-pattern 4: silencing a uniformity error with diagnostic(off)

```wgsl
// BROKEN
diagnostic(off, derivative_uniformity);

@fragment
fn fs(@location(0) uv: vec2f, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  if (facing) {
    return textureSample(tex, samp, uv); // analysis suppressed, bug remains
  }
  return vec4f(0.0);
}
```

WHY it fails: `diagnostic(off, derivative_uniformity)` only stops the analysis
from reporting the problem. It does not change how the GPU computes derivatives.
The hardware still differences the sampled coordinate across the 2x2 quad, and a
quad neighbor that took the `else` path still contributes an undefined value.
The sampled mip level is undefined, so the shader renders different garbage on
different GPUs and driver versions. The directive hides a real correctness bug.

FIX: remove the directive and hoist the sample into uniform control flow (see
anti-pattern 1). If a severity override is genuinely needed for triage, use
`@diagnostic(warning, derivative_uniformity)` on the single function so the
message stays visible.

## Anti-pattern 5: textureSample in a vertex or compute entry point

```wgsl
// BROKEN
@vertex
fn vs(@location(0) uv: vec2f) -> @builtin(position) vec4f {
  let h = textureSample(heightMap, samp, uv); // not allowed in @vertex
  return vec4f(uv, h.r, 1.0);
}
```

WHY it fails: `textureSample` derives its mip level from implicit derivatives,
which only exist in the fragment stage where invocations run in 2x2 quads. The
vertex and compute stages have no quad neighbors, so there is no derivative to
compute. Calling `textureSample` from `@vertex` or `@compute` is a
shader-creation error regardless of control flow.

FIX: use `textureSampleLevel` with an explicit mip level, or `textureLoad` with
an explicit texel coordinate.

```wgsl
@vertex
fn vs(@location(0) uv: vec2f) -> @builtin(position) vec4f {
  let h = textureSampleLevel(heightMap, samp, uv, 0.0);
  return vec4f(uv, h.r, 1.0);
}
```

## Anti-pattern 6: reading var<workgroup> without a barrier

```wgsl
// BROKEN
var<workgroup> sum: u32;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) { sum = 100u; }
  let value = sum;                       // race: write may not be visible yet
}
```

WHY it fails: `var<workgroup>` is shared across the workgroup, but a write by
one invocation is not guaranteed visible to others until a barrier orders the
memory access. Without a barrier between the `lid == 0u` write and the read, the
remaining 63 invocations may observe the zero-initialized value or the new
value, nondeterministically. This is a data race and produces garbage results.

FIX: place a `workgroupBarrier` between the write and the read, or use
`workgroupUniformLoad`, which performs the barrier internally and returns a
uniform value.

```wgsl
var<workgroup> sum: u32;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) { sum = 100u; }
  let value = workgroupUniformLoad(&sum); // barrier + uniform broadcast
}
```

## Anti-pattern 7: directive placed after a declaration

```wgsl
// BROKEN
struct Light { color: vec3f }
enable f16;                              // directive after a declaration
```

WHY it fails: `enable`, `requires`, and `diagnostic` are global directives.
WGSL requires every global directive to appear before the first declaration in
the module. A directive that follows any `const`, `override`, `alias`,
`struct`, `var`, or `fn` is a shader-creation error.

FIX: move all directives to the top of the shader.

```wgsl
enable f16;

struct Light { color: vec3f }
```

## Anti-pattern 8: using requires for an enable-extension

```wgsl
// BROKEN
requires f16;                            // f16 is an enable-extension
```

WHY it fails: `f16` is an enable-extension paired with the `shader-f16` device
feature, so it is gated by `enable`, not `requires`. `requires` is for language
extensions, which are syntax or semantic extensions with no host `GPUDevice`
feature pairing. Using the wrong directive keyword for the extension name is a
shader-creation error.

FIX: use `enable` for `f16`, `subgroups`, `clip_distances`, and
`dual_source_blending`. Use `requires` only for language extensions such as
`readonly_and_readwrite_storage_textures` or `packed_4x8_integer_dot_product`.

```wgsl
enable f16;
```
