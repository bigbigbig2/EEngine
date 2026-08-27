# WGSL Syntax

Write valid WGSL (WebGPU Shading Language) shader code: types, declarations,
operators, control flow, and functions, without triggering shader-creation errors.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). WGSL is statically typed: every expression has a type known at
shader-creation time.

| Type group | Forms | Notes |
|------------|-------|-------|
| Scalar | `bool`, `i32`, `u32`, `f32`, `f16` | `f16` needs `enable f16;` plus the `shader-f16` device feature |
| Literal suffix | `42i` (i32), `42u` (u32), `1.5f` (f32), `1.5h` (f16) | Unsuffixed `42` / `1.5` is an abstract numeric, materialized at use |
| Vector | `vec2<T>`, `vec3<T>`, `vec4<T>` | Aliases: `vec3f`, `vec4u`, `vec2i`, `vec3h`, etc. |
| Matrix | `matCxR<T>`, C columns x R rows, T floating-point | Column-major. Aliases: `mat4x4f`, `mat3x3f`, etc. |
| Array (fixed) | `array<f32, 16>` | Count is a const-expression |
| Array (runtime) | `array<f32>` | ONLY as the last member of a `storage` struct |
| Struct | `struct Light { position: vec3f, color: vec3f, }` | Members may carry `@align`, `@size`, `@location`, `@builtin` |
| Atomic | `atomic<i32>`, `atomic<u32>` | ONLY in `workgroup` or `storage`, accessed via atomic builtins |
| Type alias | `alias RGB = vec3<f32>;` | Keyword is `alias`, NEVER `type` |

| Declaration | Form | Mutability |
|-------------|------|------------|
| `var` | `var<address_space, access> name: T = init;` | Mutable, lives in memory |
| `let` | `let name = value;` | Immutable, block-scoped, runtime value |
| `const` | `const name = expr;` | Immutable, compile-time const-expression |
| `override` | `override name: T = default;` | Pipeline-overridable, set by host, may carry `@id(n)` |

Inside a function `var x = 0;` defaults to the `function` address space. At
module scope a `var` needs an address space, except `private` which is the
default. Address-space detail and memory layout: `webgpu-wgsl-memory-layout`.

## Decision Tree

```
Need to introduce a name in WGSL?
├── Value must change after first assignment (a mutable variable)?
│   └── var name = init;            (function scope inside fn; needs an
│       address space at module scope)
│
├── Value is fixed but only known at runtime (a function argument, a
│   computed result you reuse)?
│   └── let name = value;           (immutable, block-scoped)
│
├── Value is fixed AND computable entirely at shader-creation time
│   (a literal, math on literals)?
│   └── const name = expr;          (compile-time constant)
│
└── Value must be chosen by the host at pipeline-creation time
    (a quality setting, a workgroup dimension)?
    └── override name: T = default; (add @id(n) for a stable numeric id)
```

## Core Patterns

### Pattern 1: ALWAYS use the `alias` keyword for type aliases

WGSL spells the type-alias keyword `alias`. There is NO `type` keyword in WGSL.
Writing `type RGB = vec3<f32>;` is a shader-creation error.

```wgsl
alias RGB = vec3<f32>;
alias Mat = mat4x4<f32>;

fn tint(c: RGB) -> RGB { return c * 0.5; }
```

### Pattern 2: ALWAYS declare a runtime-sized array only in a storage struct

`array<T>` with no count is legal ONLY as the last member of a struct in the
`storage` address space. Its length is queried with `arrayLength(&ptr)`. A
runtime-sized array in a `function`, `private`, `uniform`, or `workgroup`
variable is a shader-creation error.

```wgsl
struct Particles {
  count: u32,
  data: array<vec4f>,          // runtime-sized: legal here, last member, storage
}
@group(0) @binding(0) var<storage, read> particles: Particles;

fn total() -> u32 { return arrayLength(&particles.data); }
```

### Pattern 3: ALWAYS give `switch` a `default` and NEVER expect fall-through

A `switch` selects on an `i32` or `u32`. A `default` clause is mandatory. WGSL
has NO C-style fall-through: each case body runs in isolation. List multiple
selector values comma-separated to share one body.

```wgsl
fn classify(x: i32) -> i32 {
  switch x {
    case 0, 1: { return 10; }    // 0 and 1 share this body
    case 2:    { return 20; }
    default:   { return -1; }    // mandatory, even if logically unreachable
  }
}
```

### Pattern 4: ALWAYS pass a pointer to mutate caller memory

WGSL function parameters are ALWAYS passed by value. To let a helper write back
into the caller's variable, declare a `ptr` parameter, pass `&var`, and write
through `*ptr`.

```wgsl
fn add_one(p: ptr<function, f32>) { *p = *p + 1.0; }

fn use_it() -> f32 {
  var v = 4.0;
  add_one(&v);                   // v is now 5.0
  return v;
}
```

### Pattern 5: NEVER write a recursive WGSL function

Recursion is forbidden in WGSL. The static call graph MUST be acyclic. A
function that calls itself, directly or through a cycle, is a shader-creation
error. Rewrite recursion as a `loop`, `for`, or `while`.

```wgsl
// CORRECT: iterative factorial, no recursion
fn factorial(n: u32) -> u32 {
  var result = 1u;
  for (var i = 2u; i <= n; i++) { result = result * i; }
  return result;
}
```

### Pattern 6: NEVER mix `.xyzw` and `.rgba` in one swizzle

Vectors support component access with either the `.xyzw` set OR the `.rgba` set,
never mixed in a single swizzle. `v.xr` is a compile error. A 1-component swizzle
yields a scalar; 2-4 components yield a vector. Components may repeat in a read
(`v.xxxx`), never in an assignment target.

```wgsl
var color = vec4f(1.0, 0.5, 0.25, 1.0);
let rgb  = color.rgb;            // vec3f, single set
let flip = color.wzyx;           // vec4f, single set
color.xy = vec2f(0.0, 0.0);      // assignment target: no repeats
// let bad = color.xr;           // ERROR: mixed .xyzw and .rgba
```

## Common Anti-Patterns

1. `type RGB = vec3<f32>;` to declare a type alias. WHY it fails: WGSL has no
   `type` keyword. The alias keyword is `alias`. `type` is a shader-creation
   error.

2. Declaring `var<private> buf: array<f32>;` or a runtime-sized array in a
   function or uniform. WHY it fails: a runtime-sized `array<T>` is legal ONLY
   as the last member of a `storage`-address-space struct. Anywhere else it is
   a shader-creation error.

3. A `switch` with no `default`, or expecting one `case` to fall through into
   the next. WHY it fails: WGSL requires a `default` clause and runs each case
   body in isolation. Missing `default` is a shader-creation error; there is no
   fall-through to rely on.

## Critical Warnings

- NEVER use `type` for a type alias. The keyword is `alias`.
- NEVER declare a runtime-sized `array<T>` outside the last member of a
  `storage` struct. It is a shader-creation error in `function`, `private`,
  `uniform`, and `workgroup`.
- NEVER omit the `default` clause in a `switch`, and NEVER expect C-style
  fall-through between `case` labels.
- NEVER write a recursive function or a cyclic call graph. Recursion is
  forbidden; rewrite it as a loop.
- NEVER call an entry-point function (`@vertex`, `@fragment`, `@compute`) from
  other WGSL code. Entry points cannot be invoked as helpers.
- NEVER declare a `const fn`. WGSL 1.0 has NO user-declarable const functions;
  const-evaluation is a property of certain builtins only.
- NEVER mix `.xyzw` with `.rgba` in one swizzle, and NEVER repeat a component
  in a swizzle assignment target.
- NEVER use an `h` literal suffix or `f16` without `enable f16;` at the top of
  the shader plus the `shader-f16` device feature.

## Reference Files

- `methods.md` : the complete type list, all four declaration forms,
  the operator and precedence table, control-flow constructs, and function rules.
- `examples.md` : verified WGSL snippets for types, declarations,
  operators, control flow, and functions.
- `anti-patterns.md` : WGSL syntax mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-wgsl-memory-layout` : address-space detail and the `@align` / `@size`
  struct layout rules referenced but not duplicated here.
- `webgpu-wgsl-builtins` : `@builtin` values and the WGSL builtin function set.
- `webgpu-wgsl-vertex-shaders` : `@vertex` entry points, attributes, and
  inter-stage varyings.
- `webgpu-wgsl-uniformity` : uniform control flow and why `textureSample` and
  barriers are restricted.
