# WGSL Memory Layout: Reference

Verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/,
section "Memory Layout" and "Address Spaces") on 2026-05-20. WGSL is the shading
language of WebGPU 1.0-stable: Chrome 113+, Safari 26+, Firefox 141+.

## The six address spaces

Every memory location in WGSL belongs to exactly one address space. The address
space fixes the access mode and whether the host (the WebGPU JavaScript API) can
share memory with the shader.

| Address space | Default access mode | Host-shareable | Declared by |
|---------------|---------------------|----------------|-------------|
| `function` | `read_write` | No | `var` inside a function body |
| `private` | `read_write` | No | `var<private>` at module scope |
| `workgroup` | `read_write` | No | `var<workgroup>` at module scope |
| `uniform` | `read` (only) | Yes | `var<uniform>` at module scope |
| `storage` | `read` | Yes | `var<storage>` or `var<storage, read_write>` |
| `handle` | `read` (only) | No | `var` for a texture or sampler resource |

Rules per space:

- `function`: per-invocation local storage. A `var` declared in a function body
  is in `function` space with no annotation needed. Access is `read_write`. Not
  host-shareable. Cannot hold a runtime-sized array.
- `private`: per-invocation storage declared at module scope. `private` is the
  default address space for a module-scope `var` when none is written. Access is
  `read_write`. Not host-shareable.
- `workgroup`: storage shared by all invocations of a single compute workgroup.
  Declared `var<workgroup>`. Access is `read_write`. Zero-initialized by the
  implementation. Not host-shareable. Valid only in the compute stage.
- `uniform`: a host-supplied buffer binding. Access is `read` only; the shader
  CANNOT write a `uniform`. Host-shareable. Subject to the extra 16-byte layout
  constraint described below. Bound via `@group(g) @binding(b)`.
- `storage`: a host-supplied buffer binding. Access mode is `read` (the default)
  or `read_write`; the access mode is written in the declaration as
  `var<storage, read>` or `var<storage, read_write>`. Write-only is not a WGSL
  declaration mode. Host-shareable. The only space allowed to hold a
  runtime-sized array, and only as the last member of its struct.
- `handle`: holds opaque resources, that is textures and samplers. Access is
  `read`. Not host-shareable in the buffer-layout sense; the resource is supplied
  through a bind group.

## Pointers

A pointer type is `ptr<address_space, store_type, access_mode>`. The
`access_mode` is optional and defaults to the address space's default.

- A pointer is formed with the address-of operator `&` applied to a variable or
  to a memory reference: `&x`, `&myStruct.field`, `&myArray[i]`.
- A pointer is dereferenced with the indirection operator `*`: `*p` reads or
  writes the pointed-to memory.
- WGSL passes function parameters by value. To let a helper function mutate
  caller memory, declare a pointer parameter and pass `&variable` at the call
  site.

```wgsl
fn scale_in_place(p : ptr<function, vec3f>, k : f32) {
  *p = *p * k;
}

fn caller() {
  var v : vec3f = vec3f(1.0, 2.0, 3.0);
  scale_in_place(&v, 2.0);   // v becomes (2,4,6)
}
```

The pointer's address space must match the address space of the variable whose
address is taken. A `ptr<function, ...>` cannot point at a `var<private>`.

## AlignOf and SizeOf

Every WGSL type has an `AlignOf` (the byte alignment its storage must satisfy)
and a `SizeOf` (the number of bytes it occupies). These determine the byte
offsets used by host-shareable buffers.

### Scalars

| Type | AlignOf | SizeOf |
|------|---------|--------|
| `bool` | not host-shareable | not host-shareable |
| `i32` | 4 | 4 |
| `u32` | 4 | 4 |
| `f32` | 4 | 4 |
| `f16` | 2 | 2 |
| `atomic<i32>` | 4 | 4 |
| `atomic<u32>` | 4 | 4 |

`bool` has no defined host-shareable layout and cannot appear in a `uniform` or
`storage` buffer. `f16` requires `enable f16;` in the shader and the
`shader-f16` device feature. `atomic<T>` is valid only in `workgroup` and
`storage` address spaces.

### Vectors

| Type | AlignOf | SizeOf |
|------|---------|--------|
| `vec2<f32>`, `vec2<i32>`, `vec2<u32>` | 8 | 8 |
| `vec3<f32>`, `vec3<i32>`, `vec3<u32>` | 16 | 12 |
| `vec4<f32>`, `vec4<i32>`, `vec4<u32>` | 16 | 16 |
| `vec2<f16>` | 4 | 4 |
| `vec3<f16>` | 8 | 6 |
| `vec4<f16>` | 8 | 8 |

The classic trap: `vec3<f32>` has `AlignOf` 16 but `SizeOf` 12. It occupies 12
bytes of data, but anything placed after it starts at the next 16-byte multiple,
and any `vec3` member is itself placed at a 16-byte offset. A `vec3` effectively
reserves the space of a `vec4` for alignment purposes while only storing 3
components.

### Matrices

A `matCxR<T>` is laid out as `C` columns, each column a `vecR<T>` and aligned
like that `vecR`. The matrix `AlignOf` equals `AlignOf(vecR<T>)`.

| Type | AlignOf | SizeOf |
|------|---------|--------|
| `mat2x2<f32>` | 8 | 16 |
| `mat3x2<f32>` | 8 | 24 |
| `mat4x2<f32>` | 8 | 32 |
| `mat2x3<f32>` | 16 | 32 |
| `mat3x3<f32>` | 16 | 48 |
| `mat4x3<f32>` | 16 | 64 |
| `mat2x4<f32>` | 16 | 32 |
| `mat3x4<f32>` | 16 | 48 |
| `mat4x4<f32>` | 16 | 64 |

A `matCx3` stores each column as a `vec3` padded to 16 bytes, so `mat3x3<f32>`
is 48 bytes (3 columns x 16), not 36.

### Arrays

For `array<E, N>`:

- `AlignOf(array<E, N>)` = `AlignOf(E)` (in `uniform`, raised as below).
- The element stride = `RoundUp(AlignOf(E), SizeOf(E))`.
- `SizeOf(array<E, N>)` = `N * stride`.

`RoundUp(k, n)` is the smallest multiple of `k` that is greater than or equal
to `n`.

### Structs

For a struct `S` with members `m1, m2, ..., mK`:

- `AlignOf(S)` = the maximum of `AlignOf(mi)` over all members (in `uniform`,
  at least 16 when any member needs 16).
- Member `mi` is placed at the smallest offset that is a multiple of its
  alignment and is greater than or equal to the end of member `mi-1`.
- `SizeOf(S)` = `RoundUp(AlignOf(S), offsetOf(mK) + SizeOf(mK))`. The struct's
  size is rounded up to its own alignment, which adds trailing padding.

Worked example, `struct { a: f32, b: vec3f }`:

- `a` at offset 0, size 4. End at 4.
- `b` is a `vec3f`, alignment 16, so it is placed at offset 16 (not 4). Size 12.
  End at 28.
- `AlignOf(struct)` = max(4, 16) = 16.
- `SizeOf(struct)` = `RoundUp(16, 28)` = 32.

## The uniform address space 16-byte rule

A type used in the `uniform` address space MUST satisfy an extra constraint on
top of the base `AlignOf`/`SizeOf` rules. This mirrors the std140 layout rule of
GLSL and exists because many GPUs fetch uniform memory in 16-byte registers.

For a type used in `uniform`:

1. Every array element stride MUST be a multiple of 16. The element stride is
   `RoundUp(16, RoundUp(AlignOf(E), SizeOf(E)))`.
2. A struct member that is itself a struct or an array MUST start at an offset
   that is a multiple of 16.

Consequence: `array<f32, 4>` in a `uniform` buffer is NOT 16 bytes. Each `f32`
is padded to a 16-byte stride, so the array is 64 bytes (4 x 16). To store four
floats in 16 bytes, use `vec4<f32>`; to store an array of scalars compactly,
use `array<vec4<f32>, N>` so the natural 16-byte stride already satisfies the
rule, or wrap each element in a `@size(16)` struct.

The `storage` address space does NOT impose this 16-byte array-stride rule. The
base `AlignOf`/`SizeOf` rules still apply there.

## Runtime-sized arrays and arrayLength

A runtime-sized array is written `array<E>` with no element count. It is legal
ONLY as the last member of a struct in the `storage` address space. Its element
count is not known at shader-creation time; it is derived from the bound
buffer's size.

`arrayLength(&ptr)` returns the `u32` element count of the runtime-sized array
that `ptr` points at. The argument is a pointer to the runtime-sized array
member, formed with `&`.

```wgsl
struct Data { header : vec4u, values : array<f32>, }
@group(0) @binding(0) var<storage, read> data : Data;

fn count() -> u32 { return arrayLength(&data.values); }
```

## The @align and @size attributes

Both attributes are written on a struct member declaration.

- `@align(n)`: `n` MUST be a power of two. It raises the member's minimum
  alignment to `n`. The member's offset becomes a multiple of
  `max(n, AlignOf(member))`.
- `@size(n)`: `n` is a byte count. It raises the member's minimum size to `n`,
  adding trailing padding inside that member. The member still starts at its
  natural alignment, but the next member starts `n` bytes later.

```wgsl
struct Layout {
  @align(16) a : f32,   // forced to a 16-byte offset
  @size(16)  b : f32,   // 4 bytes of data, but the next member starts 16 later
  c : vec4f,
}
```

Use `@align`/`@size` to make a host-matched layout explicit instead of relying
on implicit padding, especially when porting a std140 layout.

## Host-side coupling (cross-link, not duplicated)

Host-side copy alignment, that is the 256-byte dynamic-offset rule for
`setBindGroup` dynamic offsets and the 256-byte `bytesPerRow` rule for
buffer-to-texture copies, is covered by `webgpu-core-memory-model`. The two
interact: a `uniform` struct that is 144 bytes by WGSL `SizeOf` still needs a
256-byte stride when bound with a dynamic offset, because the host-side dynamic
offset must be a multiple of `minUniformBufferOffsetAlignment` (256).

## Verified Sources

- https://www.w3.org/TR/WGSL/ : address spaces, access modes, pointers,
  `AlignOf`/`SizeOf`, the uniform-address-space layout constraint, runtime-sized
  arrays, `arrayLength`, the `@align` and `@size` attributes.
- https://gpuweb.github.io/gpuweb/wgsl/ : WGSL editor's draft, cross-checked for
  the memory-layout section.
