# WGSL Syntax Examples

Working, verified WGSL snippets for types, declarations, operators, control
flow, and functions. Verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/). WGSL is the shading language of WebGPU 1.0-stable.

## Example 1: Scalar types and literal suffixes

```wgsl
fn scalar_types() {
  let flag: bool = true;
  let signed: i32 = -42i;        // i suffix fixes i32
  let unsigned: u32 = 42u;       // u suffix fixes u32
  let real: f32 = 1.5f;          // f suffix fixes f32

  // Unsuffixed literals are abstract numerics, materialized at use.
  let count = 10;                // materializes to i32 here
  let ratio = 0.25;              // materializes to f32 here
}
```

## Example 2: f16 with the enable directive

`f16` requires the `enable f16;` directive at the top of the shader AND the
`shader-f16` device feature on the `GPUDevice`.

```wgsl
enable f16;                      // MUST appear before any declaration

fn half_math() -> f16 {
  let a: f16 = 0.5h;             // h suffix fixes f16
  let b = vec3h(1.0h, 2.0h, 3.0h);
  return a + b.x;
}
```

## Example 3: Vector and matrix types with aliases

```wgsl
fn vectors_and_matrices() {
  let position = vec3f(0.0, 1.0, 0.0);    // vec3f == vec3<f32>
  let indices  = vec4u(0u, 1u, 2u, 3u);   // vec4u == vec4<u32>
  let inferred = vec2(3.0, 4.0);          // constructor infers vec2<f32>

  let identity = mat4x4f(
    1.0, 0.0, 0.0, 0.0,                   // column 0 (column-major)
    0.0, 1.0, 0.0, 0.0,                   // column 1
    0.0, 0.0, 1.0, 0.0,                   // column 2
    0.0, 0.0, 0.0, 1.0,                   // column 3
  );
  let scaled = identity * 2.0;
}
```

## Example 4: Type aliases with the `alias` keyword

```wgsl
alias RGB = vec3<f32>;
alias Index = u32;
alias Transform = mat4x4<f32>;

fn brighten(c: RGB, factor: f32) -> RGB {
  return c * factor;
}
```

## Example 5: Fixed and runtime-sized arrays

```wgsl
// Fixed-size array: count is a const-expression, usable anywhere.
fn weighted_sum() -> f32 {
  let weights = array<f32, 4>(0.1, 0.2, 0.3, 0.4);
  var total = 0.0;
  for (var i = 0; i < 4; i++) { total = total + weights[i]; }
  return total;
}

// Runtime-sized array: ONLY as the last member of a storage struct.
struct ParticleBuffer {
  active: u32,
  particles: array<vec4f>,       // runtime-sized, last member, storage
}
@group(0) @binding(0) var<storage, read> buf: ParticleBuffer;

fn particle_count() -> u32 {
  return arrayLength(&buf.particles);
}
```

## Example 6: The four declaration forms

```wgsl
override quality: u32 = 2u;      // host-set at pipeline creation
@id(7) override exposure: f32 = 1.0;   // stable numeric id 7

const PI: f32 = 3.14159265;      // compile-time constant
const TWO_PI = PI * 2.0;         // const-expression of const operands

fn declarations() -> f32 {
  var accumulator = 0.0;         // function-scope var, mutable
  let step = exposure / 4.0;     // immutable runtime binding
  for (var i = 0u; i < quality; i++) {
    accumulator = accumulator + step;
  }
  return accumulator * TWO_PI;
}
```

## Example 7: Operators and parenthesised shift mixing

```wgsl
fn operators(a: u32, b: u32) -> u32 {
  let sum = a + b;
  let masked = a & 0xFFu;
  let shifted = a << 2u;

  // Parentheses are REQUIRED to mix a shift with & | ^.
  let combined = (a << 4u) | (b & 0x0Fu);

  // Increment is a statement, not an expression.
  var counter = 0u;
  counter++;

  // Phony assignment discards an expression result.
  _ = sum + masked + shifted;
  return combined;
}
```

## Example 8: Swizzling

```wgsl
fn swizzle() -> vec4f {
  var color = vec4f(1.0, 0.5, 0.25, 1.0);

  let rgb  = color.rgb;          // vec3f, single set
  let alpha = color.a;           // scalar f32
  let flipped = color.wzyx;      // vec4f, reversed
  let doubled = color.xx;        // vec2f, repeat allowed in a read

  color.xy = vec2f(0.0, 0.0);    // assignment target: no repeated component
  return color;
}
```

## Example 9: Control flow with if, switch, and loop

```wgsl
fn control_flow(mode: i32, n: u32) -> i32 {
  // if with mandatory braces
  if mode < 0 {
    return -1;
  } else if mode == 0 {
    return 0;
  }

  // switch: default mandatory, no fall-through, comma-shared cases
  switch mode {
    case 1, 2: { return 100; }
    case 3:    { return 300; }
    default:   { return -999; }
  }
}

// loop with continuing and break if
fn sum_to(n: u32) -> u32 {
  var total = 0u;
  var i = 0u;
  loop {
    total = total + i;
    continuing {
      i = i + 1u;
      break if i > n;            // structured loop exit
    }
  }
  return total;
}
```

## Example 10: Functions, by-value parameters, and pointer mutation

```wgsl
// Parameters are passed by value: this cannot change the caller's variable.
fn double_value(x: f32) -> f32 {
  return x * 2.0;
}

// To mutate caller memory, take a pointer parameter.
fn scale_in_place(p: ptr<function, f32>, factor: f32) {
  *p = *p * factor;
}

@must_use
fn squared(x: f32) -> f32 {
  return x * x;
}

fn use_functions() -> f32 {
  var v = 3.0;
  scale_in_place(&v, 4.0);       // v becomes 12.0
  let d = double_value(v);       // d is 24.0, v unchanged by double_value
  let s = squared(d);            // @must_use: return value consumed
  return s;
}
```

## Example 11: Recursion rewritten as iteration

WGSL forbids recursion. An iterative form replaces it.

```wgsl
// Iterative Fibonacci: no recursive call, acyclic call graph.
fn fibonacci(n: u32) -> u32 {
  if n < 2u { return n; }
  var prev = 0u;
  var curr = 1u;
  for (var i = 2u; i <= n; i++) {
    let next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}
```
