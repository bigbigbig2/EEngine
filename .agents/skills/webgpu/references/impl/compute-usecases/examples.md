# Compute Use Cases: Verified Working Examples

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every example below uses API
names verified against the W3C WebGPU spec (https://www.w3.org/TR/webgpu/), the W3C
WGSL spec (https://www.w3.org/TR/WGSL/), and the official WebGPU samples
(https://webgpu.github.io/webgpu-samples/).

Each example assumes `device` is a valid `GPUDevice` obtained from
`navigator.gpu.requestAdapter()` then `adapter.requestDevice()` with the documented
null-checks. Compute pipeline creation is shown briefly; see
`webgpu-syntax-compute-pipeline` for the full pipeline-object detail.

---

## Example 1: Image-processing compute pass (box blur with a tiled cache)

A 3 by 3 box blur. The source is a sampled texture, the destination is a storage
texture. Each workgroup processes an 8 by 8 tile and caches a 10 by 10 region (tile plus
a 1-pixel halo) in `var<workgroup>` shared memory.

### WGSL

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

const TILE  : u32 = 8u;
const HALO  : u32 = 1u;
const CACHE : u32 = TILE + 2u * HALO;            // 10
var<workgroup> tile: array<vec4f, CACHE * CACHE>; // 100 texels

fn loadClamped(p: vec2i, dims: vec2u) -> vec4f {
  let c = clamp(p, vec2i(0, 0), vec2i(dims) - vec2i(1, 1));
  return textureLoad(src, c, 0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(local_invocation_id)  lid: vec3u,
        @builtin(workgroup_id)         wid: vec3u) {
  let dims = textureDimensions(src);

  // Cooperative load: 8x8 invocations fill the 10x10 cache (100 texels).
  let origin = vec2i(wid.xy * TILE) - vec2i(i32(HALO), i32(HALO));
  let li = lid.y * TILE + lid.x;                 // 0..63
  for (var idx = li; idx < CACHE * CACHE; idx += TILE * TILE) {
    let cx = i32(idx % CACHE);
    let cy = i32(idx / CACHE);
    tile[idx] = loadClamped(origin + vec2i(cx, cy), dims);
  }
  workgroupBarrier();                            // MANDATORY before reads

  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  // 3x3 average over the cached tile. Centre is at lid + HALO.
  var sum = vec4f(0.0);
  for (var dy = 0u; dy < 3u; dy += 1u) {
    for (var dx = 0u; dx < 3u; dx += 1u) {
      let cx = lid.x + dx;
      let cy = lid.y + dy;
      sum += tile[cy * CACHE + cx];
    }
  }
  textureStore(dst, vec2i(gid.xy), sum / 9.0);
}
```

### Host setup

```js
const W = 1024, H = 1024;

const srcTex = device.createTexture({
  label: "blur-src",
  size: [W, H],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
// device.queue.copyExternalImageToTexture(...) or writeTexture() uploads pixels here.

const dstTex = device.createTexture({
  label: "blur-dst",
  size: [W, H],
  format: "rgba8unorm",                          // storage-capable, NOT -srgb
  usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC |
         GPUTextureUsage.TEXTURE_BINDING,
});

const pipeline = device.createComputePipeline({
  label: "box-blur",
  layout: "auto",
  compute: { module: device.createShaderModule({ code: blurWGSL }), entryPoint: "main" },
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: srcTex.createView() },
    { binding: 1, resource: dstTex.createView() },
  ],
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); // workgroup counts
pass.end();
device.queue.submit([encoder.finish()]);
```

---

## Example 2: Particle update pass

A particle buffer is integrated by a compute pass each frame, then drawn by a render
pass from the same buffer. Both passes share one command encoder, so the encoder orders
the compute pass before the render pass.

### Particle buffer layout

A `Particle` struct is `position: vec3f` + `velocity: vec3f`. WGSL aligns each `vec3f`
to 16 bytes, so the struct is 32 bytes (8 floats including padding).

### WGSL: integration

```wgsl
struct Particle {
  position : vec3f,
  velocity : vec3f,
};
struct Sim {
  dt      : f32,
  gravity : f32,
  count   : u32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> sim: Sim;

@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) { return; }                // last workgroup overhang

  var p = particles[i];
  p.velocity.y -= sim.gravity * sim.dt;
  p.position   += p.velocity * sim.dt;

  if (p.position.y < 0.0) {                       // bounce off the floor
    p.position.y = 0.0;
    p.velocity.y = -p.velocity.y * 0.8;
  }
  particles[i] = p;
}
```

### WGSL: rendering (same buffer, drawn instanced)

```wgsl
struct Particle { position : vec3f, velocity : vec3f, };
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> viewProj: mat4x4f;

@vertex
fn vs(@builtin(instance_index) inst: u32,
      @builtin(vertex_index)   vid:  u32) -> @builtin(position) vec4f {
  // a small quad per particle, expanded from 6 vertices
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f( 1.0, 1.0));
  let centre = particles[inst].position;
  let offset = corners[vid] * 0.02;
  return viewProj * vec4f(centre + vec3f(offset, 0.0), 1.0);
}

@fragment
fn fs() -> @location(0) vec4f { return vec4f(0.4, 0.8, 1.0, 1.0); }
```

### Host: one encoder, compute then render

```js
const COUNT = 100000;
const particleBuf = device.createBuffer({
  label: "particles",
  size: COUNT * 32,                               // 32 bytes per particle
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
// initial state uploaded once with device.queue.writeBuffer(particleBuf, 0, initData)

const integratePipeline = device.createComputePipeline({
  label: "integrate",
  layout: "auto",
  compute: { module: device.createShaderModule({ code: integrateWGSL }),
             entryPoint: "integrate" },
});

function frame() {
  device.queue.writeBuffer(simBuf, 0, simData);   // dt, gravity, count

  const encoder = device.createCommandEncoder();

  const cp = encoder.beginComputePass();
  cp.setPipeline(integratePipeline);
  cp.setBindGroup(0, simBindGroup);               // particleBuf + simBuf
  cp.dispatchWorkgroups(Math.ceil(COUNT / 64));
  cp.end();

  const rp = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear", storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  rp.setPipeline(drawPipeline);
  rp.setBindGroup(0, drawBindGroup);              // particleBuf (read) + viewProj
  rp.draw(6, COUNT);                              // 6 verts per quad, COUNT instances
  rp.end();

  device.queue.submit([encoder.finish()]);        // encoder orders cp before rp
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The frame loop NEVER awaits `mapAsync` or `onSubmittedWorkDone`; it submits and returns.

---

## Example 3: Two-level reduction (sum of an f32 array)

Sum of `N` floats. Dispatch 1 reduces 256-element chunks into a partials buffer.
Dispatch 2 reduces the partials. For very large `N`, repeat dispatch 2 until one value
remains. The result is read back to the CPU after `onSubmittedWorkDone`.

### WGSL

```wgsl
@group(0) @binding(0) var<storage, read>       input:    array<f32>;
@group(0) @binding(1) var<storage, read_write> partials: array<f32>;

const WG : u32 = 256u;
var<workgroup> scratch: array<f32, WG>;

@compute @workgroup_size(256)
fn reduce(@builtin(local_invocation_id) lid: vec3u,
          @builtin(workgroup_id)        wid: vec3u,
          @builtin(global_invocation_id) gid: vec3u) {
  // Load one element per invocation; 0.0 for the overhang past the array.
  var v = 0.0;
  if (gid.x < arrayLength(&input)) { v = input[gid.x]; }
  scratch[lid.x] = v;
  workgroupBarrier();                             // all loads visible

  // In-workgroup tree reduction. workgroupBarrier every step.
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { scratch[lid.x] += scratch[lid.x + s]; }
    workgroupBarrier();
  }
  if (lid.x == 0u) { partials[wid.x] = scratch[0]; }
}
```

### Host: drive the passes and read back

```js
const N = 1_000_000;
const WG = 256;

const inputBuf = device.createBuffer({
  label: "reduce-input",
  size: N * 4,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
// device.queue.writeBuffer(inputBuf, 0, floatArray) uploads the data.

const reducePipeline = device.createComputePipeline({
  label: "reduce",
  layout: "auto",
  compute: { module: device.createShaderModule({ code: reduceWGSL }),
             entryPoint: "reduce" },
});

// One reduction step: reduces `count` elements of `src` into `dst`.
function encodeReduce(encoder, src, dst, count) {
  const groups = Math.ceil(count / WG);
  const bg = device.createBindGroup({
    layout: reducePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: src } },
      { binding: 1, resource: { buffer: dst } },
    ],
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(reducePipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(groups);
  pass.end();
  return groups;                                  // element count for the next step
}

async function sumArray() {
  const encoder = device.createCommandEncoder();

  // Allocate level buffers: each level shrinks by a factor of WG.
  let count = N;
  let src = inputBuf;
  const levelBuffers = [];
  while (count > 1) {
    const next = Math.ceil(count / WG);
    const dst = device.createBuffer({
      size: Math.max(next, 1) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    levelBuffers.push(dst);
    encodeReduce(encoder, src, dst, count);
    src = dst;
    count = next;
  }

  // src now holds one float. Copy it into a mappable readback buffer.
  const readback = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyBufferToBuffer(src, 0, readback, 0, 4);
  device.queue.submit([encoder.finish()]);

  // MANDATORY: wait for GPU completion before mapping.
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const total = new Float32Array(readback.getMappedRange().slice(0))[0];
  readback.unmap();
  return total;
}
```

`slice(0)` copies the data out of the mapped range before `unmap()` detaches the
`ArrayBuffer`. NEVER read the typed view after `unmap()`.

### Subgroup-accelerated variant (Chrome 134+, feature-gated)

When `adapter.features.has("subgroups")` and the device was created with
`requiredFeatures: ["subgroups"]`, the inner tree loop is replaced. The shader begins
with `enable subgroups;` and the per-invocation value is reduced with one builtin call:

```wgsl
enable subgroups;
// inside the entry point, after loading v:
let subTotal = subgroupAdd(v);                    // sum across the subgroup
// one invocation per subgroup accumulates subTotal into workgroup scratch,
// then a short tree reduces the per-subgroup totals.
```

This path MUST only be compiled when the feature was granted. Keep the tree-reduction
shader above as the portable fallback.
