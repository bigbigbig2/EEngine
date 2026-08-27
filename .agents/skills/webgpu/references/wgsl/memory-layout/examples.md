# WGSL Memory Layout: Examples

Every layout below is computed from the `AlignOf`/`SizeOf` rules in
`methods.md`, verified against the W3C WGSL specification on 2026-05-20. WGSL is
the shading language of WebGPU 1.0-stable: Chrome 113+, Safari 26+, Firefox 141+.

## Example 1: a uniform struct matched between WGSL and a JS typed array

This is the layout that prevents the most common WGSL bug. The WGSL struct, the
byte-offset table, and the JS `Float32Array` writes are kept in lock-step.

### The WGSL struct

```wgsl
struct Camera {
  view       : mat4x4f,   // offset  0, size 64
  proj       : mat4x4f,   // offset 64, size 64
  cameraPos  : vec3f,     // offset 128, size 12
  exposure   : f32,       // offset 140, size 4  (fills the vec3 tail slot)
  tint       : vec3f,     // offset 144, size 12 (vec3 -> next 16-byte offset)
  // offsets 156..159 are trailing padding
}                          // AlignOf 16, SizeOf 160

@group(0) @binding(0) var<uniform> camera : Camera;
```

Offset reasoning, member by member:

- `view`: `mat4x4f`, alignment 16, at offset 0. Ends at 64.
- `proj`: `mat4x4f`, alignment 16, next multiple of 16 at or after 64 is 64.
  Ends at 128.
- `cameraPos`: `vec3f`, alignment 16, offset 128. Occupies 12 bytes, ends at 140.
- `exposure`: `f32`, alignment 4, next multiple of 4 at or after 140 is 140. It
  fits in the 4 bytes the `vec3f` did not use. Ends at 144.
- `tint`: `vec3f`, alignment 16, next multiple of 16 at or after 144 is 144.
  Ends at 156.
- `AlignOf(Camera)` = 16. `SizeOf(Camera)` = `RoundUp(16, 156)` = 160.

### The matching host code

```js
// 160 bytes total -> 40 floats.
const CAMERA_SIZE = 160;
const buffer = device.createBuffer({
  label: "camera-uniform",
  size: CAMERA_SIZE,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

// Write into one ArrayBuffer, then upload once.
const data = new ArrayBuffer(CAMERA_SIZE);
const f32 = new Float32Array(data);

// view  : float indices 0..15  (byte offset 0)
f32.set(viewMatrix, 0);
// proj  : float indices 16..31 (byte offset 64)
f32.set(projMatrix, 16);
// cameraPos : float indices 32..34 (byte offset 128)
f32[32] = camX;
f32[33] = camY;
f32[34] = camZ;
// exposure  : float index 35 (byte offset 140)
f32[35] = exposure;
// tint  : float indices 36..38 (byte offset 144)
f32[36] = tintR;
f32[37] = tintG;
f32[38] = tintB;
// float index 39 (byte offset 156) is padding, left as 0.

device.queue.writeBuffer(buffer, 0, data);
```

Each float index is the byte offset divided by 4. `tint` starts at byte 144, so
float index 36. Writing `tint` at float index 35 would land it in the
`exposure` slot and the shader would read garbage. ALWAYS derive the index from
the byte offset, never from member order.

## Example 2: a storage struct with a runtime-sized array

A `storage` struct may end in a runtime-sized array. The `storage` space does
not impose the uniform 16-byte array-stride rule, but the base `AlignOf` rules
still apply.

### The WGSL struct

```wgsl
struct Particle {
  position : vec3f,   // offset 0,  size 12
  lifetime : f32,     // offset 12, size 4  (fills the vec3 tail slot)
  velocity : vec3f,   // offset 16, size 12
  mass     : f32,     // offset 28, size 4
}                      // AlignOf 16, SizeOf 32

struct ParticleBuffer {
  count     : u32,            // offset 0, size 4
  // offsets 4..15 are padding: the array member must start at a 16-byte offset
  particles : array<Particle>, // offset 16, runtime-sized, MUST be last
}

@group(0) @binding(0) var<storage, read_write> sim : ParticleBuffer;

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&sim.particles)) {
    return;                       // guard against the dispatch tail
  }
  let p = sim.particles[i];
  sim.particles[i].position = p.position + p.velocity;
}
```

Offset reasoning:

- `Particle`: `position` `vec3f` at 0; `lifetime` `f32` at 12 (fits the vec3
  tail); `velocity` `vec3f` at 16; `mass` `f32` at 28. `AlignOf` 16,
  `SizeOf` `RoundUp(16, 32)` = 32.
- `ParticleBuffer`: `count` `u32` at 0; `particles` is a struct array, its
  alignment is `AlignOf(Particle)` = 16, so it starts at offset 16. The element
  stride is `RoundUp(16, 32)` = 32.

### The matching host code

```js
const PARTICLE_STRIDE = 32;       // SizeOf(Particle)
const HEADER_SIZE = 16;           // count u32 + 12 bytes padding
const particleCount = 1000;

const buffer = device.createBuffer({
  label: "particle-storage",
  size: HEADER_SIZE + particleCount * PARTICLE_STRIDE,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
});

// Initialize the header and particles.
const init = new ArrayBuffer(HEADER_SIZE + particleCount * PARTICLE_STRIDE);
new Uint32Array(init, 0, 1)[0] = particleCount;   // count at byte 0

const f32 = new Float32Array(init);
for (let i = 0; i < particleCount; i++) {
  // each particle occupies 8 floats (32 bytes); array body starts at byte 16.
  const base = (HEADER_SIZE / 4) + i * (PARTICLE_STRIDE / 4);
  f32[base + 0] = posX[i];       // position.x  (byte offset base*4 + 0)
  f32[base + 1] = posY[i];
  f32[base + 2] = posZ[i];
  f32[base + 3] = lifetime[i];   // byte offset +12
  f32[base + 4] = velX[i];       // velocity.x  byte offset +16
  f32[base + 5] = velY[i];
  f32[base + 6] = velZ[i];
  f32[base + 7] = mass[i];       // byte offset +28
}
device.queue.writeBuffer(buffer, 0, init);
```

The shader derives the element count from `arrayLength(&sim.particles)`, which
equals `(buffer.size - 16) / 32`. The host never has to pass the count as a
separate uniform, although the explicit `count` header field is also available.

## Example 3: the array<f32, N> uniform fix

```wgsl
// WRONG in a uniform buffer: weights occupies 64 bytes (16-byte stride each).
struct BadWeights  { weights : array<f32, 4>, }

// CORRECT: pack four floats into one vec4, total 16 bytes.
struct GoodWeights { weights : vec4f, }

// CORRECT for a longer list: array of vec4, natural 16-byte stride.
struct Kernel { taps : array<vec4f, 8>, }   // 128 bytes, tightly strided
```

```js
// Host side for GoodWeights: a single vec4, 16 bytes.
const data = new Float32Array([w0, w1, w2, w3]);   // 16 bytes
device.queue.writeBuffer(weightBuffer, 0, data);
```

Read a single weight in WGSL with a swizzle: `weights.x`, `weights.y`, and so
on, or index a `vec4` component dynamically is not allowed, so for dynamic
indexing keep the data in a `storage` buffer instead.
