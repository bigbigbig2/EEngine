# WGSL Syntax Reference

Complete reference for WGSL types, declarations, operators, control flow, and
functions. Verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/) and the editor's draft
(https://gpuweb.github.io/gpuweb/wgsl/). WGSL is the shading language of WebGPU
1.0-stable: Chrome 113+, Safari 26+, Firefox 141+.

## 1. Types

WGSL is statically typed. Every expression has a concrete type known at
shader-creation time.

### Scalar types

| Type | Meaning | Literal suffix |
|------|---------|----------------|
| `bool` | boolean | none (`true` / `false`) |
| `i32` | signed 32-bit integer | `i` (`42i`) |
| `u32` | unsigned 32-bit integer | `u` (`42u`) |
| `f32` | IEEE 32-bit float | `f` (`1.5f`) |
| `f16` | IEEE 16-bit float | `h` (`1.5h`) |

`f16` is feature-gated. The shader MUST begin with the directive `enable f16;`
AND the `GPUDevice` MUST be created with the `shader-f16` feature. Using an `h`
suffix or the `f16` type without `enable f16;` is a shader-creation error.

### Abstract numeric types and materialization

An unsuffixed numeric literal has an abstract numeric type: `AbstractInt` for
`42`, `AbstractFloat` for `1.5`. Abstract types are implicitly converted
("materialized") to a concrete type at the point of use. `let x = 1;` makes `x`
an `i32` once assigned. Abstract numerics give literals flexible behavior, but
once two operands are both concrete, no implicit conversion happens: `42` and
`42u` are NOT interchangeable when both sides are already concrete; an explicit
conversion (`u32(...)`) is required.

### Vector types

`vecN<T>` where N is 2, 3, or 4 and T is a scalar: `vec2<f32>`, `vec3<i32>`,
`vec4<u32>`. WGSL provides predeclared aliases:

| Alias | Expansion | Alias | Expansion |
|-------|-----------|-------|-----------|
| `vec2f` | `vec2<f32>` | `vec2i` | `vec2<i32>` |
| `vec3f` | `vec3<f32>` | `vec3i` | `vec3<i32>` |
| `vec4f` | `vec4<f32>` | `vec4i` | `vec4<i32>` |
| `vec2u` | `vec2<u32>` | `vec2h` | `vec2<f16>` |
| `vec3u` | `vec3<u32>` | `vec3h` | `vec3<f16>` |
| `vec4u` | `vec4<u32>` | `vec4h` | `vec4<f16>` |

Constructors infer the element type: `vec3(1.0, 2.0, 3.0)` yields `vec3<f32>`.

### Matrix types

`matCxR<T>` has C columns and R rows; T MUST be a floating-point type (`f32` or
`f16`). All nine sizes from `mat2x2` to `mat4x4` exist. Matrices are stored
column-major as an array of C column vectors of length R. Aliases like
`mat4x4f`, `mat3x3f`, `mat2x2f` exist (and `h` variants).

### Array types

- Fixed-size: `array<f32, 16>`. The count is a const-expression.
- Runtime-sized: `array<f32>` (no count). Legal ONLY as the last member of a
  struct in the `storage` address space. Its length is queried with
  `arrayLength(&ptr)`.

### Struct types

```wgsl
struct Light {
  position: vec3f,
  color: vec3f,
}
```

Members may carry layout attributes (`@align`, `@size`) and IO attributes
(`@location`, `@builtin`). Layout detail belongs to `webgpu-wgsl-memory-layout`.

### Atomic types

`atomic<i32>` and `atomic<u32>` only. They are valid ONLY in the `workgroup` or
`storage` address spaces and may be accessed ONLY via atomic builtins.

### Type aliases

`alias RGB = vec3<f32>;`. The keyword is `alias`. WGSL has NO `type` keyword.

## 2. Declarations

WGSL has four declaration forms.

| Form | Syntax | Scope | Mutability |
|------|--------|-------|------------|
| `var` | `var<address_space, access> name: T = init;` | module or function | mutable, in memory |
| `let` | `let name = value;` | block | immutable, runtime value |
| `const` | `const name = expr;` | module or function | immutable, compile-time |
| `override` | `override name: T = default;` | module only | host-set at pipeline creation |

- `var` declares a mutable variable backed by memory. At module scope an address
  space is required, except `private`, which is the default. Inside a function,
  `var x = 0;` defaults to the `function` address space and an explicit address
  space is not written. Optional access mode follows the address space, for
  example `var<storage, read>` or `var<storage, read_write>`.
- `let` is an immutable, block-scoped binding to a runtime value.
- `const` is an immutable compile-time constant; its initializer MUST be a
  const-expression (literals and operations on const operands only).
- `override` declares a pipeline-overridable constant, settable from the host at
  pipeline creation. It may carry `@id(n)` to give it a stable numeric id used by
  the host-side `constants` map. `override` is module-scope only.

Address-space detail (`function`, `private`, `workgroup`, `uniform`, `storage`,
`handle`) and memory layout belong to `webgpu-wgsl-memory-layout`.

## 3. Operators

| Category | Operators | Notes |
|----------|-----------|-------|
| Arithmetic | `+ - * / %` | componentwise on vectors |
| Comparison | `== != < > <= >=` | return `bool` or `vecN<bool>` componentwise |
| Logical | `&& \|\| !` | scalar `bool` only, short-circuiting |
| Bitwise | `& \| ^ ~ << >>` | integers |
| Assignment | `= += -= *= /= %= &= \|= ^= <<= >>=` | statements |
| Increment / decrement | `i++;` `i--;` | statements, NOT expressions |
| Phony assignment | `_ = expr;` | evaluates and discards an expression |

The phony assignment `_ = expr;` evaluates an expression and discards the
result. It is the way to satisfy `@must_use` when the return value is genuinely
not needed.

### Operator precedence

Highest to lowest:

1. Postfix: call `f()`, subscript `a[i]`, member access `s.m`
2. Unary: `! ~ - * &`
3. Multiplicative: `* / %`
4. Additive: `+ -`
5. Shift: `<< >>`
6. Relational: `< > <= >=`
7. Equality: `== !=`
8. Bitwise AND: `&`
9. Bitwise XOR: `^`
10. Bitwise OR: `|`
11. Logical AND: `&&`
12. Logical OR: `||`

WGSL deliberately does NOT define a precedence between shifts and `& | ^`.
Parentheses are REQUIRED to mix a shift operator with `&`, `|`, or `^` in the
same expression. `a << b & c` is a syntax error; write `(a << b) & c`.

### Swizzling

Vectors support component access with the `.xyzw` set OR the `.rgba` set. The
two sets MUST NOT be mixed in one swizzle (`v.xr` is a compile error). A
1-component swizzle yields a scalar; a 2-, 3-, or 4-component swizzle yields a
vector. Components may repeat in a read (`v.xxxx`, `v.rrgg`), but a swizzle used
as an assignment target MUST NOT repeat a component.

## 4. Control flow

| Construct | Form | Notes |
|-----------|------|-------|
| `if` | `if cond { } else if cond { } else { }` | condition is a scalar `bool`; braces mandatory |
| `switch` | `switch sel { case a, b: { } default: { } }` | selector is `i32` or `u32`; `default` mandatory; no fall-through |
| `loop` | `loop { ... continuing { ... } }` | primitive iteration; optional trailing `continuing` block |
| `for` | `for (init; cond; update) { }` | sugar over `loop` |
| `while` | `while cond { }` | sugar over `loop` |
| `break` | `break;` | exits the nearest loop or switch |
| `break if` | `break if cond;` | ends a `continuing` block; structured loop exit |
| `continue` | `continue;` | jumps to the `continuing` block or loop top |
| `return` | `return expr;` | exits a function with a value (or `return;` for void) |
| `discard` | `discard;` | fragment-stage only; demotes the invocation |

- An `if` condition MUST be a scalar `bool`; braces are mandatory on every arm.
- A `switch` selects on an `i32` or `u32`. A `default` clause is mandatory.
  There is no C-style fall-through: each case body runs in isolation. Multiple
  selector values share a body when listed comma-separated (`case 0, 1:`).
- `loop { }` is the primitive iteration construct. It may contain a trailing
  `continuing { }` block executed before each next iteration. The `continuing`
  block may end with `break if (condition);`, the structured way to exit a loop.
- `for` and `while` are syntactic sugar over `loop`.
- `discard;` is a fragment-stage statement that demotes the invocation: no
  further memory writes or color/depth outputs occur, but the invocation keeps
  running so derivatives stay valid. Calling `discard` from a `@vertex` or
  `@compute` entry point is an error.

## 5. Functions

```wgsl
fn name(p1: T1, p2: T2) -> RetType { ... }
```

Function rules:

- Parameters are ALWAYS passed by value. To mutate caller memory, pass a pointer
  (for example `ptr<function, f32>`) and use `&` to take the address and `*` to
  dereference.
- Every non-void control path MUST `return` a value of the declared return type.
  A function with no `-> RetType` returns nothing; `return;` exits it.
- Recursion is FORBIDDEN. The static call graph MUST be acyclic. A function that
  calls itself, directly or through a cycle, is a shader-creation error.
- Entry points are functions marked `@vertex`, `@fragment`, or `@compute`. Entry
  points MUST NOT be called from other WGSL code; they are invoked only by the
  pipeline.
- `@must_use` on a function forces callers to consume the return value (or
  explicitly discard it with `_ =`); otherwise a diagnostic fires.
- There is NO user-declarable `const fn` in WGSL 1.0. Const-evaluation is a
  property of certain built-in functions and of expressions built only from
  const operands. Users cannot annotate their own functions as const-evaluable.

Attributes valid on a function: stage attributes (`@vertex`, `@fragment`,
`@compute`), `@workgroup_size`, `@must_use`, `@diagnostic`. Attributes valid on
parameters and the return type: `@builtin`, `@location`, `@interpolate`,
`@invariant`. Attribute detail belongs to `webgpu-wgsl-vertex-shaders` and
`webgpu-wgsl-builtins`.

## Verified Sources

- https://www.w3.org/TR/WGSL/ — W3C WGSL specification (types, declarations,
  operators, control flow, functions).
- https://gpuweb.github.io/gpuweb/wgsl/ — WGSL editor's draft.
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API — MDN WebGPU API
  overview.
