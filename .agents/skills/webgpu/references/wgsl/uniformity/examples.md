# WGSL Uniformity and Directives: Examples

All WGSL verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/)
and the WebGPU specification (https://www.w3.org/TR/webgpu/), 2026-05-20. Target:
WebGPU 1.0-stable, Chrome 113+, Safari 26+, Firefox 141+.

## Example 1: hoisting a sample out of non-uniform control flow

A fragment shader that picks between a base texture and a detail-modulated
result based on `front_facing`. `front_facing` differs per invocation, so the
branch is non-uniform. The sample is hoisted above the branch.

```wgsl
@group(0) @binding(0) var albedo: texture_2d<f32>;
@group(0) @binding(1) var albedoSamp: sampler;

@fragment
fn fs(
  @location(0) uv: vec2f,
  @builtin(front_facing) facing: bool,
) -> @location(0) vec4f {
  // Sampled in uniform control flow: this statement runs for every invocation.
  let base = textureSample(albedo, albedoSamp, uv);

  // The branch is non-uniform, but no restricted builtin runs inside it.
  if (facing) {
    return base;
  }
  return base * vec4f(0.4, 0.4, 0.4, 1.0); // dim the back faces
}
```

The wrong version places `textureSample(albedo, albedoSamp, uv)` inside each
branch body. The uniformity analysis then emits a `derivative_uniformity` error
because the call is reached only along a per-invocation path.

## Example 2: loop-conditional sampling fixed by hoisting

A loop bound that depends on a varying makes the loop body non-uniform. Sample
the texture once before the loop.

```wgsl
@group(0) @binding(0) var noise: texture_2d<f32>;
@group(0) @binding(1) var noiseSamp: sampler;

@fragment
fn fs(@location(0) uv: vec2f, @location(1) iterations: f32) -> @location(0) vec4f {
  let n = textureSample(noise, noiseSamp, uv); // uniform: before the loop
  var acc = vec4f(0.0);
  let count = u32(iterations);                 // per-invocation loop bound
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    acc = acc + n;                             // reuse the hoisted sample
  }
  return acc;
}
```

## Example 3: vertex stage uses textureSampleLevel

`textureSample` is fragment-stage only. A vertex shader displacing geometry by a
height map ALWAYS uses `textureSampleLevel` with an explicit mip level.

```wgsl
@group(0) @binding(0) var heightMap: texture_2d<f32>;
@group(0) @binding(1) var heightSamp: sampler;

@vertex
fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> @builtin(position) vec4f {
  let h = textureSampleLevel(heightMap, heightSamp, uv, 0.0).r;
  return vec4f(pos.x, pos.y + h, pos.z, 1.0);
}
```

## Example 4: correct enable directive with host-side feature guard

The `enable f16` directive requires the `shader-f16` device feature. The host
MUST feature-detect on the adapter and request the feature before compiling.

WGSL shader (`enable` is the first line):

```wgsl
enable f16;

@group(0) @binding(0) var<uniform> gain: vec4<f16>;

@fragment
fn fs(@location(0) color: vec4f) -> @location(0) vec4f {
  let scaled = vec4<f16>(color) * gain;
  return vec4f(scaled);
}
```

Host-side JavaScript that gates the feature:

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter");

const wantF16 = adapter.features.has("shader-f16");
const device = await adapter.requestDevice({
  requiredFeatures: wantF16 ? ["shader-f16"] : [],
});

// Only compile the f16 shader when the feature is present.
const code = wantF16 ? shaderWithF16 : shaderWithoutF16;
const module = device.createShaderModule({ code });
```

Compiling `shaderWithF16` on a device created without `shader-f16` is a
shader-creation error. The branch on `wantF16` selects an f32 fallback shader.

## Example 5: requires directive for a language extension

`requires` gates a language extension and needs no host `GPUDevice` feature.

```wgsl
requires readonly_and_readwrite_storage_textures;

@group(0) @binding(0)
var io: texture_storage_2d<rgba8unorm, read_write>;

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let coord = vec2i(gid.xy);
  let texel = textureLoad(io, coord);
  textureStore(io, coord, texel * 2.0);
}
```

`enable` is for enable-extensions paired with a host feature. `requires` is for
language extensions with no host pairing.

## Example 6: @diagnostic attribute scoped to one function

The `@diagnostic(severity, rule)` attribute lowers a triggering rule's severity
for one function. Severity values are `error`, `warning`, `info`, `off`.

```wgsl
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
@diagnostic(warning, derivative_uniformity)
fn debugShade(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(tex, samp, uv);
}
```

The `warning` severity keeps the message visible in `getCompilationInfo()` while
the call still compiles. The correct long-term fix is hoisting the call into
uniform control flow, not the downgrade.

## Example 7: module-level diagnostic directive

The module-level `diagnostic` directive sits with the other directives at the
top of the shader and sets a rule's severity for the whole module.

```wgsl
diagnostic(info, derivative_uniformity);

enable f16;

// ... declarations follow ...
```

A more specific `@diagnostic` attribute on a function overrides this
module-level setting for calls inside that function.

## Example 8: workgroupUniformLoad for a safe broadcast

`workgroupUniformLoad` executes a control barrier and returns a uniform value
to every invocation. It replaces a manual write-then-barrier-then-read.

```wgsl
var<workgroup> tileCount: u32;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32,
      @builtin(num_workgroups) groups: vec3u) {
  if (lid == 0u) {
    tileCount = groups.x * 64u; // one invocation writes
  }
  // Barrier inside the builtin; result is identical for all invocations.
  let total = workgroupUniformLoad(&tileCount);

  // total is uniform here: this branch is uniform and safe.
  if (total > 0u) {
    // process the tile
  }
}
```

## Example 9: barrier kept in uniform control flow

A workgroup that conditionally processes a tile writes the condition to shared
memory, barriers unconditionally, then branches on the shared value.

```wgsl
var<workgroup> active: u32;
var<workgroup> data: array<f32, 64>;

@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lid: u32,
      @builtin(workgroup_id) wid: vec3u) {
  if (lid == 0u) {
    active = select(0u, 1u, wid.x < 16u); // decide once per workgroup
  }
  workgroupBarrier();                     // uniform: every invocation reaches it

  if (active == 1u) {                     // uniform branch: active is uniform
    data[lid] = f32(lid);
  }
  workgroupBarrier();                     // uniform: still outside any divergent branch
}
```

`active` is written under a uniform `if (lid == 0u)` guard and read after the
barrier, so the second `if (active == 1u)` branch is uniform and contains the
write safely. The barriers themselves are never inside a divergent branch.
