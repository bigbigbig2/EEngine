# WGSL Builtin Functions and Values: Anti-Patterns

Each entry states the mistake, WHY it fails, and the fix. Verified against the W3C
WGSL specification and the vooronderzoek research base. Version baseline: WGSL of
WebGPU 1.0-stable.

## 1. Calling a fragment-only derivative from vertex or compute

```wgsl
// WRONG: dpdx in a compute entry point
@compute @workgroup_size(8)
fn cs(@builtin(global_invocation_id) gid : vec3u) {
  let slope = dpdx(f32(gid.x));     // shader-creation error
}
```

WHY it fails: `dpdx`, `dpdy`, `fwidth`, and their `Coarse`/`Fine` variants compute
screen-space derivatives from neighboring fragment invocations in a 2x2 quad. Quads
exist ONLY in the fragment stage. The vertex and compute stages have no quad
neighbors, so the call is rejected at shader creation.

```wgsl
// CORRECT: compute the rate of change explicitly, or move the work to @fragment
@compute @workgroup_size(8)
fn cs(@builtin(global_invocation_id) gid : vec3u) {
  let slope = f32(gid.x + 1u) - f32(gid.x);   // explicit finite difference
}
```

## 2. Calling textureSample from vertex or compute

```wgsl
// WRONG: textureSample in a vertex entry point
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let h = textureSample(heightmap, samp, vec2f(0.5, 0.5));  // shader-creation error
  return vec4f(0.0, h.r, 0.0, 1.0);
}
```

WHY it fails: `textureSample` (and `textureSampleBias`, `textureSampleCompare`,
`textureGather`, `textureGatherCompare`) picks the mip level from implicit
derivatives, which only exist in the fragment stage. Outside `@fragment` the
implicit-derivative texture builtins are illegal.

```wgsl
// CORRECT: supply an explicit LOD with textureSampleLevel
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let h = textureSampleLevel(heightmap, samp, vec2f(0.5, 0.5), 0.0);
  return vec4f(0.0, h.r, 0.0, 1.0);
}
```

`textureLoad` (no sampler, integer coordinates) is the other any-stage option.

## 3. Assuming instance_index excludes the firstInstance base

```wgsl
// WRONG: indexing instances[ii] when the draw used a non-zero firstInstance
@vertex
fn vs(@builtin(instance_index) ii : u32) -> @builtin(position) vec4f {
  let inst = instances[ii];     // out-of-range when firstInstance != 0
  ...
}
```

WHY it fails: `@builtin(instance_index)` equals `firstInstance + localInstance`. A
draw issued as `draw(vertexCount, instanceCount, firstVertex, 100)` makes
`instance_index` start at 100. Indexing a `instanceCount`-element array with that
value reads past the end, returning garbage or a bounds-check clamp.

```wgsl
// CORRECT: subtract the known base, or always pass firstInstance 0
@group(0) @binding(1) var<uniform> first_instance : u32;

@vertex
fn vs(@builtin(instance_index) ii : u32) -> @builtin(position) vec4f {
  let inst = instances[ii - first_instance];
  ...
}
```

The host-side `firstInstance` argument is the second number passed to `draw` /
`drawIndexed`. The same rule applies to `vertex_index` and `firstVertex`.

## 4. Writing frag_depth and expecting early-Z

```wgsl
// PERFORMANCE TRAP: every fragment writes frag_depth
struct FSOut {
  @location(0)         color : vec4f,
  @builtin(frag_depth) depth : f32,
}
@fragment
fn fs(@builtin(position) pos : vec4f) -> FSOut {
  var o : FSOut;
  o.color = shade(pos);
  o.depth = pos.z;          // writing the same value the GPU already had
}
```

WHY it fails: any explicit `frag_depth` write forces the depth test to run AFTER the
fragment shader, because the GPU cannot know the final depth before the shader
finishes. Early-Z (rejecting occluded fragments before shading) is disabled, so
every fragment runs the full shader even when it is later overwritten. Writing
`frag_depth` to the value the GPU already interpolated is pure overhead.

Fix: NEVER declare a `@builtin(frag_depth)` output unless the shader genuinely
modifies depth (depth bias, soft particles, raymarched depth). When depth is not
modified, omit the builtin entirely and let the GPU keep early-Z.

## 5. Integer inter-stage value without @interpolate(flat)

```wgsl
// WRONG: a u32 varying with no interpolation attribute
struct VSOut {
  @builtin(position) clip_pos    : vec4f,
  @location(0)       material_id : u32,    // shader-creation error
}
```

WHY it fails: the rasterizer interpolates `@location` varyings across the primitive.
Integers cannot be interpolated. WGSL requires every integer (`u32`/`i32`)
inter-stage value to carry `@interpolate(flat)` on BOTH the vertex output member and
the matching fragment input member; omitting it is a shader-creation error.

```wgsl
// CORRECT: flat interpolation on both sides
struct VSOut {
  @builtin(position) clip_pos    : vec4f,
  @location(0) @interpolate(flat) material_id : u32,
}
struct FSIn {
  @builtin(position) frag_pos    : vec4f,
  @location(0) @interpolate(flat) material_id : u32,
}
```

## 6. Putting @location and @builtin on the same member

```wgsl
// WRONG: two IO attributes on one member
struct VSOut {
  @builtin(position) @location(0) clip_pos : vec4f,   // shader-creation error
}
```

WHY it fails: `@builtin(name)` binds a member to a system value; `@location(n)` binds
a member to a user IO slot. A member is one or the other, never both. WGSL rejects
the combination.

```wgsl
// CORRECT: builtin and user varyings are separate members
struct VSOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       uv       : vec2f,
}
```

## 7. Using a subgroup builtin without the feature and directive

```wgsl
// WRONG: subgroup_size with no enable directive and no device feature
@compute @workgroup_size(64)
fn cs(@builtin(subgroup_size) ssz : u32) { ... }   // shader-creation error
```

WHY it fails: `subgroup_invocation_id` and `subgroup_size` are gated behind the
`subgroups` device feature. The shader needs `enable subgroups;` at the top, AND the
`GPUDevice` must have been created with `requiredFeatures: ["subgroups"]`. Missing
either side is a hard error: the shader fails to compile, or device creation fails on
machines without the feature.

```wgsl
// CORRECT: enable directive present; host feature-detects before requesting
enable subgroups;

@compute @workgroup_size(64)
fn cs(@builtin(subgroup_size) ssz : u32) { ... }
```

Host side: `const dev = await adapter.requestDevice({ requiredFeatures:
adapter.features.has("subgroups") ? ["subgroups"] : [] });`. The same gating applies
to `clip_distances` with the `clip-distances` feature (no `enable` directive needed
for `clip-distances`).

## 8. Calling a synchronization builtin in divergent control flow

```wgsl
// WRONG: workgroupBarrier inside a per-invocation branch
@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lii : u32) {
  if (lii < 32u) {
    workgroupBarrier();      // uniformity violation
  }
}
```

WHY it fails: `workgroupBarrier`, `storageBarrier`, and `textureBarrier` must be
reached by every invocation of the workgroup together. Placing one inside a branch
whose condition varies per invocation means some invocations reach the barrier and
others do not, which is undefined behavior and a uniformity violation flagged at
shader creation.

```wgsl
// CORRECT: the barrier is in uniform control flow
@compute @workgroup_size(64)
fn cs(@builtin(local_invocation_index) lii : u32) {
  var v = 0.0;
  if (lii < 32u) { v = 1.0; }
  workgroupBarrier();        // every invocation reaches this
}
```

See `webgpu-wgsl-uniformity` for the full uniform-control-flow rules.

## 9. Treating an input builtin as writable

```wgsl
// WRONG: assigning to an input builtin
@fragment
fn fs(@builtin(front_facing) ff : bool) -> @location(0) vec4f {
  ff = true;                 // input builtins are immutable parameters
  ...
}
```

WHY it fails: `front_facing`, `sample_index`, `vertex_index`, `instance_index`, the
compute id builtins, and `subgroup_*` are INPUT builtins. They arrive as entry-point
parameters, which are immutable. Only `position` (vertex), `frag_depth`,
`sample_mask`, and `clip_distances` are output builtins, declared on the return type.

Fix: copy the value into a local `var` if a mutable working copy is needed, and never
attempt to feed an input builtin back as an output.
