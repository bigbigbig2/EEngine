# Multi-Pass Rendering Methods

Verified against WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+), the W3C
WebGPU specification, and the official WebGPU Samples.

## 1. Intermediate render texture setup

A multi-pass chain writes to offscreen textures and samples them in a later pass. Each
intermediate texture is created with BOTH usage flags:

```js
const intermediate = device.createTexture({
  label: "intermediate-color",
  size: [width, height],            // match the pass that renders into it
  format: "rgba8unorm",             // or "rgba16float" for HDR intermediate results
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

Rules for intermediate textures:

- ALWAYS combine `RENDER_ATTACHMENT` (the texture is a render target) with
  `TEXTURE_BINDING` (the texture is sampled in a bind group). Either flag alone is
  insufficient for a multi-pass intermediate.
- For HDR post-processing (bloom, tone-mapping), ALWAYS use a float format such as
  `rgba16float` so values above 1.0 survive into later passes. An 8-bit format clamps
  highlights and destroys bloom input.
- The intermediate size SHOULD match the render-pass size. A downsample chain uses
  smaller textures per level on purpose.
- ALWAYS recreate intermediate textures on canvas resize. Texture size is immutable;
  resizing means destroy and recreate.
- ALWAYS set a `label` so validation messages identify the texture.

## 2. The read-write hazard rule

WebGPU forbids sampling a texture while it is bound as a render attachment in the SAME
render pass. The specification rejects a bind group whose resource (a `GPUTextureView`)
is simultaneously a writable color attachment, depth attachment, or stencil attachment
of the active pass. The read/write ordering across that overlap is undefined, so
validation rejects it at `setBindGroup` or pass-encoding time.

This rule applies WITHIN one pass. It does NOT forbid:

- Sampling texture A in pass 2 after pass 1 wrote it and ended. This is the normal
  multi-pass case.
- Binding a texture as a read-only depth attachment (`depthReadOnly: true`) while also
  sampling it. A read-only attachment is not a writable attachment.

The two fixes:

1. **Split passes.** End the writing pass with `pass.end()`, then `beginRenderPass`
   again for the pass that samples the result. WebGPU inserts the necessary barrier
   between passes automatically.
2. **Ping-pong.** When an effect logically reads and writes "the same image", use two
   distinct textures and swap their roles each pass (see section 3).

The encoder ordering also matters: a command encoder records passes in order, and
`queue.submit` executes them in order. Pass N+1 sees the finished output of pass N
because the GPU timeline serializes passes within a submission.

## 3. Ping-pong mechanics

A ping-pong pair is two textures of identical size and format. Each pass reads one and
writes the other, then the roles swap. Ping-pong is mandatory whenever an iterative
effect (separable blur, iterative bloom downsample/upsample, simulation feedback) needs
the previous frame's or previous pass's full result as input.

```js
const texA = device.createTexture({
  label: "pingpong-a", size: [w, h], format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
const texB = device.createTexture({
  label: "pingpong-b", size: [w, h], format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

let read = texA;
let write = texB;
for (let i = 0; i < iterations; i++) {
  runFullScreenPass(encoder, read, write);   // samples read, renders into write
  [read, write] = [write, read];             // swap for the next iteration
}
```

Ping-pong rules:

- ALWAYS create one bind group per texture-as-input (a bind group referencing `texA`
  and one referencing `texB`). NEVER mutate a bind group between passes; bind groups
  are immutable. Select the matching bind group based on which texture is `read`.
- The final result lives in whichever texture is `read` after the last swap. Track it
  and sample it in the final present pass.
- NEVER reuse one texture as both `read` and `write` in the same pass. That is the
  read-write hazard from section 2.

## 4. Deferred shading G-buffer layout

Deferred shading splits rendering into a geometry pass and a lighting pass. The geometry
pass renders a G-buffer using multiple render targets (MRT): several color attachments
written in one pass. The lighting pass is a full-screen pass that samples every G-buffer
texture and computes lighting once per pixel.

A typical G-buffer layout:

| Attachment | Format | Contents |
|------------|--------|----------|
| `@location(0)` | `rgba8unorm` | Albedo (RGB) + optional packed flag (A) |
| `@location(1)` | `rgba16float` | World-space or view-space normal (XYZ) |
| `@location(2)` | `rgba8unorm` | Material: metallic, roughness, occlusion |
| Depth attachment | `depth24plus` | Scene depth, used to reconstruct position |

Layout rules:

- Each G-buffer color texture is created with
  `RENDER_ATTACHMENT | TEXTURE_BINDING`.
- The geometry pipeline's `fragment.targets` array MUST have one entry per color
  attachment, with formats matching exactly. A mismatch fails pipeline or pass
  validation.
- Storing depth and reconstructing position from depth plus the inverse projection
  matrix avoids a dedicated position attachment and saves bandwidth.
- The normal attachment SHOULD be a float format (`rgba16float`); `rgba8unorm` packing
  of normals loses precision and causes banding on smooth surfaces.
- The depth texture is created with `RENDER_ATTACHMENT | TEXTURE_BINDING` so the
  lighting pass can sample it as `texture_depth_2d`.
- The official `deferredRendering` WebGPU sample demonstrates this geometry-pass /
  lighting-pass split.

The lighting pass binds all G-buffer textures plus a non-filtering or filtering sampler,
draws the full-screen triangle, and accumulates light contributions in the fragment
shader.

## 5. Shadow-map pass setup

Shadow mapping uses a first pass that renders scene depth from the light's point of
view, and a main pass that tests each fragment's depth against that shadow map.

### Shadow pass (depth-only)

```js
const shadowDepth = device.createTexture({
  label: "shadow-map",
  size: [2048, 2048],                 // shadow-map resolution
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const shadowPass = encoder.beginRenderPass({
  label: "shadow-pass",
  colorAttachments: [],               // depth-only: no color attachments
  depthStencilAttachment: {
    view: shadowDepth.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "store",
  },
});
```

Shadow-pass rules:

- The shadow pass renders the scene with the light's view-projection matrix. Only
  position output matters; the fragment shader can be omitted or minimal.
- `colorAttachments` is an empty array. A depth-only pass has no color output.
- `depthStoreOp` MUST be `"store"` so the main pass can sample the result.
- The shadow pipeline's `depthStencil` state format MUST equal the shadow texture
  format (`depth32float` here).
- ALWAYS apply `@invariant` to the vertex `@builtin(position)` output when the same
  vertex transform runs in both the shadow pass and a depth pre-pass that later relies
  on depth equality. Different pipelines can otherwise compute slightly different
  positions and break exact depth comparisons.

### Main pass (sampling the shadow map)

The main pass binds the shadow depth texture with a comparison sampler. The bind group
layout entries:

```js
const layout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "comparison" } },
  ],
});

const shadowSampler = device.createSampler({
  label: "shadow-comparison-sampler",
  compare: "less",                    // a compare function makes it a comparison sampler
});
```

Main-pass rules:

- The bind group layout texture entry MUST use `sampleType: "depth"`; the sampler entry
  MUST use `type: "comparison"`.
- The sampler MUST be created with a `compare` function (such as `"less"`). A sampler
  without `compare` is a normal filtering sampler and fails to match a `"comparison"`
  binding.
- In WGSL the texture handle is `texture_depth_2d` and the sampler is
  `sampler_comparison`. The shader calls `textureSampleCompare(shadowMap, shadowSampler,
  uv, currentDepth)`, which returns a 0.0 to 1.0 visibility value (hardware percentage-
  closer filtering when the sampler filters).
- `textureSampleCompare` computes derivatives, so it MUST run in the fragment stage in
  uniform control flow. In other stages use `textureSampleCompareLevel`.

## 6. Encoder structure across passes

All passes of one frame normally record into a single `GPUCommandEncoder` and submit
together:

```js
const encoder = device.createCommandEncoder({ label: "frame" });
// pass 1 (shadow / geometry / scene)
// pass 2 (lighting / post-process)
// final pass renders into context.getCurrentTexture().createView()
device.queue.submit([encoder.finish()]);
```

Rules:

- ALWAYS call `pass.end()` before opening the next pass or calling `encoder.finish()`.
  An open pass at `finish()` time throws.
- ALWAYS obtain `context.getCurrentTexture()` fresh in the final present pass each
  frame. NEVER cache it across frames.
- Passes within one encoder run in record order on the GPU timeline, so a later pass
  sees the finished output of an earlier pass without manual barriers.
