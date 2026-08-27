# WGSL Builtin Functions and Values: Examples

Working WGSL snippets. Every snippet is verified against the W3C WGSL specification
and the vooronderzoek research base. Version baseline: WGSL of WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+).

## 1. Vertex stage: vertex_index and position output

`vertex_index` drives a hardcoded triangle with no vertex buffer. `position` is the
vertex-stage output builtin.

```wgsl
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5),
    vec2f( 0.0,  0.5),
  );
  return vec4f(corners[vi], 0.0, 1.0);
}
```

## 2. Vertex stage: instance_index with the firstInstance base

`instance_index` includes the draw `firstInstance` base. With `firstInstance` 0 the
value indexes the instance buffer directly.

```wgsl
struct Instance { offset : vec2f, scale : f32 }
@group(0) @binding(0) var<storage, read> instances : array<Instance>;

@vertex
fn vs(
  @builtin(vertex_index)   vi : u32,
  @builtin(instance_index) ii : u32,
) -> @builtin(position) vec4f {
  let inst = instances[ii];          // firstInstance assumed 0
  var unit = array<vec2f, 3>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  );
  let p = unit[vi] * inst.scale + inst.offset;
  return vec4f(p, 0.0, 1.0);
}
```

When the host issues `draw(3, n, 0, base)` with a non-zero `base`, index with
`instances[ii - base]` instead.

## 3. Geometric builtins: normalize, dot, reflect for lighting

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       world_n  : vec3f,
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let n = normalize(in.world_n);
  let light_dir = normalize(vec3f(0.4, 1.0, 0.3));
  let diffuse = max(dot(n, light_dir), 0.0);
  let view_dir = vec3f(0.0, 0.0, 1.0);
  let r = reflect(-light_dir, n);
  let spec = pow(max(dot(r, view_dir), 0.0), 32.0);
  let color = vec3f(0.2) + diffuse * vec3f(0.8) + spec * vec3f(1.0);
  return vec4f(color, 1.0);
}
```

## 4. Math builtins: mix, clamp, smoothstep, fma

```wgsl
fn shade(t : f32, a : vec3f, b : vec3f) -> vec3f {
  let blended = mix(a, b, clamp(t, 0.0, 1.0));    // linear interpolation
  let edge    = smoothstep(0.2, 0.8, t);          // smooth ramp
  return blended * fma(edge, 0.5, 0.5);           // edge*0.5 + 0.5
}
```

## 5. Fragment stage: front_facing and discard

`front_facing` is a fragment-input builtin. `discard` is fragment-only.

```wgsl
@fragment
fn fs(
  @builtin(position)      pos : vec4f,
  @builtin(front_facing)  ff  : bool,
  @location(0)            uv  : vec2f,
) -> @location(0) vec4f {
  if (uv.x < 0.0) {
    discard;                       // legal: fragment stage only
  }
  let tint = select(vec3f(1.0, 0.5, 0.5), vec3f(0.5, 0.5, 1.0), ff);
  return vec4f(tint, 1.0);
}
```

## 6. Fragment stage: derivatives with fwidth for anti-aliased edges

`dpdx`, `dpdy`, and `fwidth` are fragment-only.

```wgsl
@fragment
fn grid(@location(0) uv : vec2f) -> @location(0) vec4f {
  let line = abs(fract(uv) - 0.5);
  let aa   = fwidth(uv);                       // pixel-space derivative
  let mask = smoothstep(vec2f(0.0), aa, line);
  let v    = min(mask.x, mask.y);
  return vec4f(vec3f(v), 1.0);
}
```

## 7. Fragment stage: textureSample versus textureSampleLevel

`textureSample` is legal here because the entry point is `@fragment` and the call is
in uniform control flow.

```wgsl
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex  : texture_2d<f32>;

@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  return textureSample(tex, samp, uv);          // implicit LOD: fragment only
}
```

The same texture read from a `@compute` entry point must use an explicit level:

```wgsl
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex  : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> out : array<vec4f>;

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid : vec3u) {
  let uv = vec2f(gid.xy) / 256.0;
  let c  = textureSampleLevel(tex, samp, uv, 0.0);   // explicit LOD: any stage
  out[gid.y * 256u + gid.x] = c;
}
```

## 8. Fragment stage: frag_depth output

Writing `frag_depth` overrides interpolated depth and disables early-Z.

```wgsl
struct FSOut {
  @location(0)         color : vec4f,
  @builtin(frag_depth) depth : f32,
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> FSOut {
  var o : FSOut;
  o.color = vec4f(1.0, 0.0, 0.0, 1.0);
  o.depth = clamp(pos.z + 0.001, 0.0, 1.0);   // depth bias
  return o;
}
```

The pipeline must declare a `depthStencil` state with `depthWriteEnabled: true` for
`frag_depth` to take effect.

## 9. Compute stage: the three id builtins

`global_invocation_id = workgroup_id * workgroup_size + local_invocation_id`.

```wgsl
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;

@compute @workgroup_size(64)
fn double_values(
  @builtin(global_invocation_id) gid : vec3u,
  @builtin(local_invocation_id)  lid : vec3u,
  @builtin(workgroup_id)         wid : vec3u,
  @builtin(num_workgroups)       ng  : vec3u,
) {
  let i = gid.x;
  if (i >= arrayLength(&src)) {     // arrayLength on a runtime-sized array
    return;
  }
  dst[i] = src[i] * 2.0;
}
```

## 10. Compute stage: local_invocation_index linearization

```wgsl
var<workgroup> tile : array<f32, 64>;

@compute @workgroup_size(8, 8)
fn cs(
  @builtin(local_invocation_index) lii : u32,
  @builtin(global_invocation_id)   gid : vec3u,
) {
  tile[lii] = f32(gid.x + gid.y);   // lii is 0..63, the linearized local id
  workgroupBarrier();               // compute-only, uniform control flow
}
```

## 11. Integer and pack builtins: color compression

`pack4x8unorm` compresses a normalized `vec4f` color into a single `u32`;
`unpack4x8unorm` reverses it. `countOneBits` is an integer builtin.

```wgsl
fn store_color(c : vec4f) -> u32 {
  return pack4x8unorm(clamp(c, vec4f(0.0), vec4f(1.0)));
}

fn load_color(packed : u32) -> vec4f {
  return unpack4x8unorm(packed);
}

fn set_bit_count(mask : u32) -> u32 {
  return countOneBits(mask);        // population count
}
```

## 12. Subgroup builtins (feature-gated)

`subgroup_size` and `subgroup_invocation_id` need the `subgroups` device feature and
`enable subgroups;`. ALWAYS feature-detect on the adapter first.

```wgsl
enable subgroups;

@group(0) @binding(0) var<storage, read_write> out : array<u32>;

@compute @workgroup_size(64)
fn cs(
  @builtin(global_invocation_id)   gid : vec3u,
  @builtin(subgroup_size)          ssz : u32,
  @builtin(subgroup_invocation_id) sid : u32,
) {
  out[gid.x] = ssz * 1000u + sid;
}
```
