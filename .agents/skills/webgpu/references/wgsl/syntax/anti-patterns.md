# WGSL Syntax Anti-Patterns

WGSL syntax mistakes with WHY-it-fails explanations. Verified against the W3C
WGSL specification (https://www.w3.org/TR/WGSL/). WGSL is the shading language
of WebGPU 1.0-stable.

## 1. Using `type` instead of `alias` for a type alias

```wgsl
// WRONG
type RGB = vec3<f32>;
```

WHY it fails: WGSL has NO `type` keyword. The type-alias keyword is `alias`. The
parser does not recognise `type` as a declaration and rejects the shader at
shader-creation time. This is a common port mistake from languages where `type`
or `typedef` introduces an alias.

```wgsl
// CORRECT
alias RGB = vec3<f32>;
```

## 2. Declaring a runtime-sized array outside storage

```wgsl
// WRONG
var<private> scratch: array<f32>;          // runtime array in private

fn helper() {
  var local: array<f32>;                   // runtime array in function
}

struct UniformData {
  values: array<f32>,                      // runtime array in a uniform struct
}
@group(0) @binding(0) var<uniform> u: UniformData;
```

WHY it fails: a runtime-sized array `array<T>` (no count) has a size that is not
known at shader-creation time. It is legal ONLY as the last member of a struct
in the `storage` address space, where the host buffer supplies the size. In
`function`, `private`, `uniform`, or `workgroup` the size cannot be resolved, so
the shader is rejected. Fixed-size arrays (`array<f32, 16>`) are legal anywhere.

```wgsl
// CORRECT
struct StorageData {
  count: u32,
  values: array<f32>,                      // last member, storage address space
}
@group(0) @binding(0) var<storage, read> s: StorageData;
```

## 3. Omitting the `default` clause in a `switch`

```wgsl
// WRONG
switch mode {
  case 0: { return 0; }
  case 1: { return 1; }
}
```

WHY it fails: WGSL requires every `switch` to have a `default` clause, even when
every possible selector value is explicitly listed. Without `default` the shader
is rejected at shader-creation time. The `default` clause guarantees the switch
is total: every selector value reaches a body.

```wgsl
// CORRECT
switch mode {
  case 0: { return 0; }
  case 1: { return 1; }
  default: { return -1; }
}
```

## 4. Expecting C-style fall-through between `case` labels

```wgsl
// WRONG: assuming case 0 falls through into case 1
switch mode {
  case 0: { x = x + 1; }                   // expecting this to continue into case 1
  case 1: { x = x + 10; }
  default: { }
}
```

WHY it fails: WGSL has NO fall-through. Each case body runs in complete
isolation and control leaves the `switch` at the end of the matched body. Code
that relies on one case bleeding into the next produces wrong results, because
only the matched body executes. To share a body across selector values, list
them comma-separated on one `case`.

```wgsl
// CORRECT: comma-separated values share a single body
switch mode {
  case 0, 1: { x = x + 10; }               // 0 and 1 both run this body
  default: { }
}
```

## 5. Writing a recursive function

```wgsl
// WRONG
fn factorial(n: u32) -> u32 {
  if n <= 1u { return 1u; }
  return n * factorial(n - 1u);            // recursive call
}
```

WHY it fails: recursion is FORBIDDEN in WGSL. The static call graph MUST be
acyclic. A function that calls itself, directly or through a cycle of functions,
is a shader-creation error. GPUs have no general call stack, so unbounded
recursion cannot be compiled. Rewrite the algorithm with a `loop`, `for`, or
`while`.

```wgsl
// CORRECT: iterative
fn factorial(n: u32) -> u32 {
  var result = 1u;
  for (var i = 2u; i <= n; i++) { result = result * i; }
  return result;
}
```

## 6. Calling an entry-point function as a helper

```wgsl
// WRONG
@fragment fn shade(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}

@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return shade(uv) * 0.5;                  // calling an entry point
}
```

WHY it fails: functions marked `@vertex`, `@fragment`, or `@compute` are entry
points. They are invoked only by the pipeline, never from other WGSL code.
Calling an entry point as a helper is a shader-creation error. Extract the
shared logic into a plain (unattributed) function and call that from both entry
points.

```wgsl
// CORRECT: plain helper, called by the entry point
fn shade(uv: vec2f) -> vec4f {
  return vec4f(uv, 0.0, 1.0);
}

@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return shade(uv) * 0.5;
}
```

## 7. Mixing `.xy` with `.rg` in one swizzle

```wgsl
// WRONG
var color = vec4f(1.0, 0.5, 0.25, 1.0);
let bad = color.xr;                        // mixed .xyzw and .rgba sets
```

WHY it fails: a swizzle MUST draw all its components from a single set, either
`.xyzw` or `.rgba`. The two sets cannot be mixed in one swizzle expression.
`color.xr` mixes `x` (position set) with `r` (color set) and is a compile error.
Pick one set for the whole swizzle.

```wgsl
// CORRECT: one consistent set
let pos = color.xy;                        // both from .xyzw
let col = color.rg;                        // both from .rgba
```

## 8. Declaring a user-level `const fn`

```wgsl
// WRONG
const fn area(w: f32, h: f32) -> f32 {     // no such thing in WGSL
  return w * h;
}
```

WHY it fails: WGSL 1.0 has NO user-declarable `const fn`. Const-evaluation is a
property of certain built-in functions and of expressions built only from const
operands; it is not something a user can request on their own functions. The
`const fn` syntax is rejected at shader-creation time. Declare an ordinary `fn`;
when it is called with const arguments inside a `const` initializer the compiler
already evaluates const-expressions where the language permits.

```wgsl
// CORRECT: a plain function
fn area(w: f32, h: f32) -> f32 {
  return w * h;
}
```

## 9. Mixing shifts with bitwise operators without parentheses

```wgsl
// WRONG
let v = a << 2u | b;                       // shift mixed with | , no parentheses
```

WHY it fails: WGSL deliberately does NOT define a precedence between shift
operators (`<<`, `>>`) and the bitwise operators `&`, `|`, `^`. An expression
that mixes them without parentheses is a syntax error. The language forces
explicit grouping so the intended order is unambiguous.

```wgsl
// CORRECT: explicit parentheses
let v = (a << 2u) | b;
```

## 10. Using `f16` or the `h` suffix without `enable f16;`

```wgsl
// WRONG: no enable directive
fn half_value() -> f16 {                   // f16 used without enabling it
  return 1.5h;
}
```

WHY it fails: `f16` is a feature-gated type. The shader MUST begin with
`enable f16;` AND the `GPUDevice` MUST have been created with the `shader-f16`
feature in `requiredFeatures`. Using `f16` or an `h` literal suffix without the
`enable f16;` directive is a shader-creation error.

```wgsl
// CORRECT: enable directive present (device also needs the shader-f16 feature)
enable f16;

fn half_value() -> f16 {
  return 1.5h;
}
```
