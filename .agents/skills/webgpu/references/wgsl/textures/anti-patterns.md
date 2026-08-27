# WGSL Texture Anti-Patterns

Each entry states the mistake, why it fails, and the deterministic fix. All references
target WebGPU 1.0-stable and the W3C WGSL specification.

## AP-1: Calling textureSample from a vertex or compute shader

```wgsl
// WRONG: textureSample in @compute.
@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) id : vec3u) {
  let c = textureSample(srcTex, srcSampler, vec2f(id.xy)); // shader-creation error
}
```

WHY IT FAILS: `textureSample` selects the mip level from screen-space derivatives of
the texture coordinates. Derivatives are computed across a 2x2 quad of fragment
invocations and exist only in the fragment stage. The vertex and compute stages have no
quads, so the derivative is undefined and WGSL rejects the call at shader creation. The
same applies to `textureSampleBias`, `textureSampleGrad`, and `textureSampleCompare`.

FIX: Use a builtin that takes an explicit level. In compute and vertex stages call
`textureSampleLevel` (you supply the mip `level`), `textureSampleCompareLevel` for depth
comparison, or `textureLoad` for an unfiltered integer-coordinate fetch.

## AP-2: Calling textureSample in non-uniform control flow

```wgsl
// WRONG: textureSample inside a per-invocation-varying branch.
@fragment
fn fs(@location(0) uv : vec2f, @location(1) sel : f32) -> @location(0) vec4f {
  if (sel > 0.5) {
    return textureSample(tex, samp, uv); // derivative_uniformity violation
  }
  return vec4f(0.0);
}
```

WHY IT FAILS: Derivatives require that all four invocations in a quad agree on whether
the `textureSample` call executes. When the branch condition is non-uniform (it differs
between invocations of the same quad), some invocations skip the call and the quad
cannot form a valid derivative. The WGSL uniformity analysis flags this as a
`derivative_uniformity` error.

FIX: Hoist the sample out of the divergent branch so it always executes in uniform
control flow, then branch on the already-fetched value. If the sample genuinely depends
on a per-invocation value, switch to `textureSampleLevel` with an explicit level, which
has no uniformity requirement. See `webgpu-wgsl-uniformity`.

## AP-3: Using sampler instead of sampler_comparison with a depth texture

```wgsl
// WRONG: plain sampler passed to textureSampleCompare.
@group(0) @binding(1) var shadowSampler : sampler;
// ...
let lit = textureSampleCompare(shadowMap, shadowSampler, uv, ref); // type error
```

WHY IT FAILS: `textureSampleCompare`, `textureSampleCompareLevel`, and
`textureGatherCompare` perform a per-texel comparison against `depth_ref` and return the
filtered fraction that passes. That comparison is defined by a comparison function that
only a `sampler_comparison` carries. A plain `sampler` has no comparison function, so
the builtin overload does not match and shader creation fails. The mirror mistake also
fails: passing a `sampler_comparison` to `textureSample` does not match either.

FIX: Declare the variable as `sampler_comparison`, create the host sampler with
`GPUSamplerDescriptor.compare` set, and give its bind-group-layout entry
`sampler: { type: "comparison" }`. Use `sampler_comparison` only with the comparison
builtins; use a plain `sampler` for non-comparison reads.

## AP-4: Wrong storage-texture format or access mode

```wgsl
// Host layout: storageTexture { access: "write-only", format: "rgba8unorm" }

// WRONG: format mismatch.
@group(0) @binding(0) var out : texture_storage_2d<rgba16float, write>;

// WRONG: access mismatch, and textureStore needs write access.
@group(0) @binding(0) var out : texture_storage_2d<rgba8unorm, read>;
let v = textureLoad(out, coord); // textureLoad needs read; store needs write
```

WHY IT FAILS: A storage texture's WGSL declaration carries the format `F` and access
`A` as part of its type. Pipeline validation matches that type against the host
`storageTexture` bind-group-layout entry. A different `format` or a different `access`
makes the layout incompatible and pipeline creation fails. Separately, `textureStore`
requires `A` to include `write` (`write` or `read_write`) and `textureLoad` on a
storage texture requires `A` to include `read`; using the wrong access for the
operation is a shader-creation error.

FIX: Copy the exact `format` from the host layout into `F`, and pick `A` to match the
host `access`: `"write-only"` becomes `write`, `"read-only"` becomes `read`,
`"read-write"` becomes `read_write`. Ensure the chosen `access` permits the operation
you call. Confirm the format is storage-capable; not every `GPUTextureFormat` is.

## AP-5: WGSL handle type not matching the bind-group-layout texture entry

```wgsl
// Host layout: texture: { sampleType: "depth", viewDimension: "2d" }

// WRONG: declared as a color texture against a depth layout entry.
@group(0) @binding(0) var tex : texture_2d<f32>;
```

WHY IT FAILS: The WGSL texture handle type encodes dimension, sample type, and the
multisampled flag. Pipeline creation matches the handle type at `@group(g) @binding(b)`
against the host `GPUBindGroupLayoutEntry` at the same `binding`. A depth layout entry
(`sampleType: "depth"`) requires a `texture_depth_*` WGSL type, a `uint` entry requires
`texture_2d<u32>`, a `multisampled: true` entry requires `texture_multisampled_2d<T>`,
and `viewDimension` must match (`"2d"` -> `texture_2d`, `"cube"` -> `texture_cube`, and
so on). Any drift makes the bind-group layout incompatible and pipeline creation fails.

FIX: Derive the WGSL handle type directly from the host layout entry using the
correspondence table in `references/methods.md` section 3. When the host side changes,
update the WGSL declaration in the same edit. See `webgpu-syntax-bind-groups`.

## AP-6: Calling textureSample on a multisampled, storage, or external texture

```wgsl
// WRONG: textureSample on a multisampled texture.
@group(0) @binding(0) var msaa : texture_multisampled_2d<f32>;
let c = textureSample(msaa, samp, uv); // no matching overload
```

WHY IT FAILS: `texture_multisampled_2d<T>` and `texture_depth_multisampled_2d` have a
single mip level and per-sample data, so filtered sampling is not defined for them;
only `textureLoad` (with a `sample_index`), `textureDimensions`, and
`textureNumSamples` apply. `texture_storage_*` textures have no associated sampler and
are accessed only via `textureLoad` / `textureStore`. `texture_external` supports only
`textureSampleBaseClampToEdge`, `textureLoad`, and `textureDimensions`. Calling
`textureSample` on any of these has no matching overload and fails shader creation.

FIX: For multisampled textures use `textureLoad` with an explicit `sample_index`. For
storage textures use `textureLoad` (read access) or `textureStore` (write access). For
external textures use `textureSampleBaseClampToEdge` or `textureLoad`.

## AP-7: Using float (sub-texel) coordinates with textureLoad

```wgsl
// WRONG: textureLoad expects integer texel coordinates.
let c = textureLoad(tex, uv, 0); // uv is vec2f -> type error
```

WHY IT FAILS: `textureLoad` indexes an exact texel and takes integer coordinates
(`vec2<i32>` or `vec2<u32>`), not the normalized `[0,1]` floating-point coordinates that
`textureSample` uses. Passing a `vec2f` does not match the overload. There is no
implicit conversion that snaps a normalized coordinate to a texel index.

FIX: Convert normalized coordinates to integer texel indices explicitly with
`textureDimensions`, for example
`textureLoad(tex, vec2i(uv * vec2f(textureDimensions(tex))), 0)`, or feed
`textureLoad` integer values directly (a compute `global_invocation_id` cast to `i32`).

## AP-8: Omitting the sample_index or level argument in textureLoad

```wgsl
// WRONG: missing mip level for a sampled texture.
let c = textureLoad(colorTex, vec2i(x, y)); // no matching overload
```

WHY IT FAILS: For a sampled `texture_2d<T>` the `textureLoad` overload requires the mip
`level` argument; for a `texture_multisampled_2d<T>` it requires a `sample_index`
argument instead. The argument count and meaning differ per texture type. Storage and
external textures (single level, no samples) take neither. Omitting a required argument
leaves no matching overload.

FIX: For a normal sampled texture pass the mip level (`0` for the base level). For a
multisampled texture pass the sample index. For a storage or external texture pass
neither. The exact per-type overloads are in `references/methods.md` section 4.
