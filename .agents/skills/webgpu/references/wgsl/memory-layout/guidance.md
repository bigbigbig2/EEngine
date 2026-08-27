# WGSL Memory Layout and Address Spaces

Lay out WGSL structs so a host-side typed array writes to the exact byte offsets
the shader reads, pick the correct address space, and avoid the vec3 16-byte trap.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable: Chrome 113+, Safari 26+,
Firefox 141+.

The six WGSL address spaces:

| Address space | Access mode | Host-shareable | Use for |
|---------------|-------------|----------------|---------|
| `function` | `read_write` | No | Local `var` inside a function (the default there) |
| `private` | `read_write` | No | Module-scope per-invocation `var` (the module-scope default) |
| `workgroup` | `read_write` | No | `var<workgroup>` shared across one compute workgroup |
| `uniform` | `read` only | Yes | `var<uniform>` host buffer binding, read-only in the shader |
| `storage` | `read` or `read_write` | Yes | `var<storage>` host buffer binding |
| `handle` | `read` | No | Textures and samplers |

`AlignOf` and `SizeOf` per type (host buffers must honour both):

| Type | AlignOf | SizeOf | Note |
|------|---------|--------|------|
| `i32`, `u32`, `f32` | 4 | 4 | |
| `f16` | 2 | 2 | Requires `enable f16;` plus the `shader-f16` feature |
| `atomic<i32>`, `atomic<u32>` | 4 | 4 | `workgroup`/`storage` only |
| `vec2<f32>` | 8 | 8 | |
| `vec3<f32>` | 16 | 12 | The trap: alignment 16 but size 12 |
| `vec4<f32>` | 16 | 16 | |
| `mat2x2<f32>` | 8 | 16 | C columns aligned like `vecR` |
| `mat3x3<f32>` | 16 | 48 | Each column is a `vec3` padded to 16 |
| `mat4x4<f32>` | 16 | 64 | |
| `array<E, N>` | `AlignOf(E)` | `N * stride` | `stride = RoundUp(AlignOf(E), SizeOf(E))` |

A struct's `AlignOf` is the maximum alignment of its members. Each member is
placed at the next offset that is a multiple of its own alignment. The struct's
`SizeOf` is rounded up to the struct's alignment.

Uniform address space extra constraint: every array element stride MUST be a
multiple of 16, and a struct or array member MUST start at a 16-byte multiple.
This is the std140-like rule. `array<f32, 4>` in a `uniform` buffer is 64 bytes,
not 16, because each `f32` is padded to a 16-byte stride.

Host-side copy alignment (256-byte dynamic offsets, 256-byte `bytesPerRow`) is
covered by `webgpu-core-memory-model`. This skill does NOT duplicate it.

## Decision Tree

```
Choosing an address space?
├── Local scratch inside one function     -> function (the default; no annotation)
├── Module-scope per-invocation state      -> private (the module-scope default)
├── Shared across one compute workgroup    -> workgroup (compute only, zero-init)
├── Host buffer the shader only reads       -> uniform (read; std140-like rules)
├── Host buffer the shader reads or writes  -> storage (read or read_write)
└── A texture or a sampler                  -> handle (declared via @group/@binding)

Laying out a host-matched struct?
├── Target is a uniform buffer?
│   ├── Contains a bare scalar followed by a vec3/vec4/struct/array?
│   │   └── The later member jumps to the next 16-byte offset. Add an explicit
│   │       padding member or @align so the host array agrees.
│   ├── Contains array<scalar, N>?
│   │   └── Each element is padded to a 16-byte stride. Use array<vec4<f32>, N>
│   │       or wrap the scalar in a @size(16) struct.
│   └── Otherwise -> compute every offset from AlignOf, then size the host
│       Float32Array to the struct's rounded-up SizeOf.
└── Target is a storage buffer?
    ├── Need a variable-length tail?  -> runtime-sized array<E> as the LAST
    │   member only; read its length with arrayLength(&ptr).
    └── No 16-byte array-stride rule applies, but base AlignOf still does.
```

## Core Patterns

### Pattern 1: ALWAYS place a vec3 at a 16-byte offset

`vec3<f32>` has alignment 16. After a bare `f32` at offset 0, a following `vec3f`
lands at offset 16, leaving offsets 4-15 as padding. ALWAYS compute the host
typed-array indices from offset / 4, NEVER from naive field order.

```wgsl
struct Params {
  scale  : f32,     // offset 0,  size 4
  // offsets 4..15 are padding (vec3 alignment forces the jump)
  origin : vec3f,   // offset 16, size 12
}                   // AlignOf 16, SizeOf 32 (rounded up from 28)
```

```js
const data = new Float32Array(8);   // 32 bytes / 4
data[0] = scale;                    // byte offset 0
data[4] = origin[0];                // byte offset 16, NOT 4
data[5] = origin[1];
data[6] = origin[2];
```

### Pattern 2: NEVER expect array<scalar, N> to pack tightly in a uniform buffer

In the `uniform` address space every array element stride is rounded up to a
multiple of 16. `array<f32, 4>` is 64 bytes. ALWAYS use `array<vec4<f32>, N>` so
the stride is naturally 16, or move the array into a `storage` buffer.

```wgsl
// WRONG intent: 16 bytes. ACTUAL in uniform: 64 bytes (16-byte stride each).
struct Bad  { weights : array<f32, 4>, }
// CORRECT: 4 floats packed into one vec4, total 16 bytes.
struct Good { weights : vec4f, }
```

### Pattern 3: ALWAYS put a runtime-sized array last and only in storage

A runtime-sized array (`array<E>` with no count) is legal ONLY as the final
member of a struct in the `storage` address space. Query its element count with
`arrayLength(&ptr)`. NEVER declare one in `function`, `private`, or `uniform`.

```wgsl
struct Particles {
  count : u32,
  // u32 at 0; vec4 array starts at offset 16 (16-byte alignment)
  data  : array<vec4f>,   // runtime-sized, MUST be the last member
}
@group(0) @binding(0) var<storage, read_write> particles : Particles;

fn total() -> u32 { return arrayLength(&particles.data); }
```

### Pattern 4: ALWAYS use @align and @size to make layout explicit

`@align(n)` raises a member's minimum alignment (n a power of two). `@size(n)`
raises a member's minimum byte size, adding trailing padding. Use them to force a
host-friendly layout instead of leaving padding implicit.

```wgsl
struct Camera {
  @size(16) tag : f32,   // 4 bytes of data, padded to 16 so view starts at 16
  view : mat4x4f,        // offset 16, size 64
  proj : mat4x4f,        // offset 80, size 64
}                        // SizeOf 144
```

### Pattern 5: ALWAYS pass a pointer to mutate caller memory

A `ptr<address_space, store_type, access_mode>` is formed with `&` and
dereferenced with `*`. WGSL passes parameters by value, so a helper that must
write back to caller memory ALWAYS takes a pointer parameter.

```wgsl
fn add_one(p : ptr<function, f32>) { *p = *p + 1.0; }

fn caller() {
  var x : f32 = 41.0;
  add_one(&x);          // x is now 42.0
}
```

### Pattern 6: NEVER let the host Float32Array size disagree with SizeOf

The host buffer size MUST equal the WGSL struct's rounded-up `SizeOf`. A struct
ending in a `vec3f` rounds its size up to the next multiple of 16. Size the
typed array from that rounded value, NEVER from the sum of member sizes.

```wgsl
struct Light { dir : vec3f, intensity : f32, }   // AlignOf 16, SizeOf 16
```

```js
const light = new Float32Array(4);   // 16 bytes: dir at 0..2, intensity at 3
```

## Common Anti-Patterns

1. A host struct `{ a: f32, b: vec3f }` mapped straight to a WGSL `uniform`
   struct, writing `b` at byte offset 4. WHY it fails: `vec3f` has alignment 16,
   so the shader reads `b` from offset 16. The host writes land in the padding
   gap and the shader reads garbage.

2. `array<f32, N>` in a `uniform` buffer with a host array of `N * 4` bytes. WHY
   it fails: the uniform std140-like rule pads every element to a 16-byte stride,
   so element `i` lives at offset `i * 16`, not `i * 4`. Only element 0 reads
   correctly.

3. A runtime-sized `array<f32>` declared in a `uniform` buffer or as a non-final
   struct member. WHY it fails: runtime-sized arrays are legal ONLY as the last
   member of a `storage` struct. Any other placement is a shader-creation error.

## Critical Warnings

- NEVER assume `vec3<f32>` occupies 12 bytes for layout. Its alignment is 16; a
  following member starts at the next 16-byte offset.
- NEVER expect tight packing for `array<scalar, N>` in a `uniform` buffer. Every
  element is padded to a 16-byte stride.
- NEVER declare a runtime-sized `array<E>` outside the `storage` address space or
  anywhere but the last struct member.
- NEVER size a host `Float32Array` from the sum of member sizes. Use the WGSL
  struct's `SizeOf` rounded up to its alignment.
- NEVER write to a `uniform` buffer member from the shader. The `uniform` address
  space is `read` only.
- NEVER mutate caller memory by reassigning a value parameter. WGSL passes by
  value; pass a `ptr` and dereference with `*`.

## Reference Files

- `methods.md` : the six address spaces with access modes and
  host-shareability, `AlignOf`/`SizeOf` rules for every type, the uniform 16-byte
  rule, and pointer syntax.
- `examples.md` : a correctly-laid-out uniform struct matched between
  WGSL and a JS typed array, and a storage struct with a runtime array.
- `anti-patterns.md` : layout mistakes with WHY-it-fails explanations.

## Related Skills

- `webgpu-core-memory-model` : host-side copy alignment (256-byte dynamic
  offsets, 256-byte `bytesPerRow`) that this skill deliberately does not cover.
- `webgpu-wgsl-syntax` : WGSL types, declarations, and the `var` address-space
  syntax this skill builds on.
- `webgpu-syntax-buffers` : creating the `GPUBuffer` objects these layouts fill.
- `webgpu-syntax-bind-groups` : binding `uniform` and `storage` buffers into a
  `GPUBindGroup` so `@group`/`@binding` resolve.
