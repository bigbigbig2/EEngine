# WGSL Memory Layout: Anti-Patterns

Each anti-pattern below states the mistake, shows the WRONG and CORRECT code,
and explains WHY the wrong version fails. Verified against the W3C WGSL
specification on 2026-05-20. WGSL is the shading language of WebGPU 1.0-stable:
Chrome 113+, Safari 26+, Firefox 141+.

## Anti-pattern 1: scalar then vec3 mapped without the 16-byte jump

This is the single most common WGSL bug.

```wgsl
struct Params { scale : f32, origin : vec3f, }
```

```js
// WRONG: writes origin at byte offset 4.
const data = new Float32Array([scale, ox, oy, oz]);   // 16 bytes
device.queue.writeBuffer(paramsBuffer, 0, data);
```

WHY it fails: `vec3f` has `AlignOf` 16. After the `f32` at offset 0, `origin` is
placed at offset 16, not offset 4. Offsets 4 through 15 are padding. The host
writes `origin` into the padding gap, the shader reads `origin` from offset 16
where the buffer is still zero, and the geometry collapses to the origin or the
shader produces nonsense.

```js
// CORRECT: origin starts at byte offset 16 -> float index 4.
const data = new Float32Array(8);   // SizeOf(Params) = 32 -> 8 floats
data[0] = scale;
data[4] = ox;                       // float index 4 == byte offset 16
data[5] = oy;
data[6] = oz;
device.queue.writeBuffer(paramsBuffer, 0, data);
```

## Anti-pattern 2: array<f32, N> in a uniform buffer expecting tight packing

```wgsl
@group(0) @binding(0) var<uniform> kernel : array<f32, 4>;
```

```js
// WRONG: 16-byte host array for a 4-element f32 array.
device.queue.writeBuffer(kernelBuffer, 0, new Float32Array([a, b, c, d]));
```

WHY it fails: in the `uniform` address space every array element stride is
rounded up to a multiple of 16. `array<f32, 4>` is 64 bytes, with element `i`
at byte offset `i * 16`. The host writes a tight 16-byte array, so only element
0 lands at the right offset; elements 1, 2, 3 read from offsets 16, 32, 48,
which the host never wrote, so the shader reads zeros.

```wgsl
// CORRECT: pack into a vec4, which is naturally 16 bytes.
@group(0) @binding(0) var<uniform> kernel : vec4f;
```

```js
device.queue.writeBuffer(kernelBuffer, 0, new Float32Array([a, b, c, d]));
```

For a longer list use `array<vec4f, N>` (natural 16-byte stride) or move the
data to a `storage` buffer, which does not impose the 16-byte array-stride rule.

## Anti-pattern 3: runtime-sized array outside the storage address space

```wgsl
// WRONG: runtime-sized array in a uniform buffer.
@group(0) @binding(0) var<uniform> values : array<f32>;

// WRONG: runtime-sized array as a non-final struct member.
struct Bad { tail : array<f32>, count : u32, }

// WRONG: runtime-sized array as a local variable.
fn f() { var scratch : array<f32>; }
```

WHY it fails: a runtime-sized array (`array<E>` with no count) is legal ONLY as
the last member of a struct in the `storage` address space. Its size is not
known at shader-creation time; only a bound storage buffer supplies the count.
A `uniform` buffer, a non-final struct member, and a `function`/`private`
variable all require a statically known size. Each WRONG line is a
shader-creation error and `createShaderModule` reports it in
`getCompilationInfo()`.

```wgsl
// CORRECT: last member of a storage struct.
struct Good { count : u32, values : array<f32>, }
@group(0) @binding(0) var<storage, read> data : Good;
```

## Anti-pattern 4: reading garbage because the Float32Array offsets do not match

```wgsl
struct Light {
  color     : vec3f,   // offset 0,  size 12
  intensity : f32,     // offset 12, size 4
  direction : vec3f,   // offset 16, size 12
}                       // AlignOf 16, SizeOf 32
```

```js
// WRONG: assumes members pack at 0, 12, 16 by counting fields.
const data = new Float32Array([
  cr, cg, cb,          // color   -> indices 0,1,2  (correct here)
  intensity,           // index 3 -> byte 12          (correct here)
  dr, dg, db,          // intended direction
]);                    // only 7 floats: SizeOf is 32 -> 8 floats needed
```

WHY it fails twice. First, the array has 7 floats (28 bytes) but `SizeOf(Light)`
is 32; `writeBuffer` either rejects the short write or leaves the last 4 bytes
stale. Second, even when the byte count is fixed, any struct whose members do
not all happen to align at consecutive float slots will desync; counting fields
instead of computing byte offsets is the root cause. If `intensity` came before
`color`, `color` would jump to offset 16 and the naive packing would be wrong.

```js
// CORRECT: 8-float buffer, every value at its computed byte offset / 4.
const data = new Float32Array(8);   // SizeOf(Light) = 32
data[0] = cr; data[1] = cg; data[2] = cb;   // color     byte 0
data[3] = intensity;                         // intensity byte 12
data[4] = dr; data[5] = dg; data[6] = db;   // direction byte 16
// data[7] is padding, left 0.
device.queue.writeBuffer(lightBuffer, 0, data);
```

Rule: ALWAYS compute each member's byte offset from the `AlignOf` rules, divide
by 4 for a `Float32Array` index, and size the array from the struct's `SizeOf`
rounded up to its alignment. NEVER infer offsets from the order of fields.

## Anti-pattern 5: writing to a uniform buffer member from the shader

```wgsl
@group(0) @binding(0) var<uniform> params : Params;

@compute @workgroup_size(1)
fn main() {
  params.scale = 2.0;   // WRONG
}
```

WHY it fails: the `uniform` address space has access mode `read` only. Assigning
to a `uniform` member is a shader-creation error. To produce a value the host
reads back, declare a `storage` buffer with `read_write` access instead.

```wgsl
@group(0) @binding(0) var<storage, read_write> out : Params;
```

## Anti-pattern 6: mutating a value parameter and expecting the caller to see it

```wgsl
fn add_offset(v : vec3f) {   // WRONG: v is a by-value copy
  v = v + vec3f(1.0);
}
```

WHY it fails: WGSL passes function parameters by value. Reassigning `v` mutates
only the local copy; the caller's variable is unchanged. The compiler does not
error, so the bug is silent: the shader runs but the offset is never applied.

```wgsl
fn add_offset(p : ptr<function, vec3f>) {   // CORRECT: pointer parameter
  *p = *p + vec3f(1.0);
}

fn caller() {
  var v : vec3f = vec3f(0.0);
  add_offset(&v);   // v is now (1,1,1)
}
```
