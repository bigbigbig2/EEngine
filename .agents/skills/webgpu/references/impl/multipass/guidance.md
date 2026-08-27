# WebGPU Multi-Pass Rendering

Chain several render passes so earlier passes write intermediate render textures that
later passes sample. Covers post-processing chains, deferred shading, shadow mapping,
and ping-pong buffers on WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

| Pass pattern | Earlier pass writes | Later pass reads | Key requirement |
|--------------|---------------------|------------------|-----------------|
| Post-process chain | Offscreen color texture | Full-screen quad samples it | Intermediate texture needs `RENDER_ATTACHMENT \| TEXTURE_BINDING` |
| Ping-pong | Texture A (pass N) | Texture B (pass N+1) | Two textures, swap roles each pass |
| Deferred shading | G-buffer via MRT (multiple color attachments) | Lighting pass samples every G-buffer texture | Each G-buffer texture needs `RENDER_ATTACHMENT \| TEXTURE_BINDING` |
| Shadow map | Depth-only texture from light view | Main pass samples with comparison sampler | Shadow pass uses `depthStencilAttachment`, no color attachments |

Intermediate render texture usage: ALWAYS
`GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING`.
Without `TEXTURE_BINDING` the texture cannot be sampled in a later pass.

## Decision Tree

```
Need more than one render pass?
├── Apply screen effects (bloom, tone-map, FXAA) to a finished image
│     -> Post-processing chain. Render scene to offscreen texture, run
│        full-screen quad passes, present last result to the canvas.
│     -> If an effect reads and writes the same logical image -> ping-pong two textures.
│
├── Many lights on complex geometry, decouple shading cost from geometry
│     -> Deferred shading. Geometry pass writes a G-buffer with MRT
│        (albedo, normal, depth/position, material). Lighting pass samples all of them.
│
└── Cast shadows from a light source
      -> Shadow mapping. Pass 1 renders scene depth from the light into a depth-only
         texture. Main pass binds that depth texture with a comparison sampler and
         uses textureSampleCompare in WGSL.
```

## Core Patterns

### Pattern 1: Intermediate texture usage flags

ALWAYS create an intermediate render texture with both
`RENDER_ATTACHMENT` and `TEXTURE_BINDING`. NEVER omit `TEXTURE_BINDING` when a later
pass samples the texture.

```js
const sceneTexture = device.createTexture({
  label: "scene-color",
  size: [canvas.width, canvas.height],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

### Pattern 2: Split passes for read after write

NEVER sample a texture inside the same render pass that still has it bound as a color
or depth attachment. WebGPU validation rejects a bind group whose resource is also a
writable attachment of the active pass. ALWAYS end the writing pass before a pass that
samples its output.

```js
const enc = device.createCommandEncoder();

const scenePass = enc.beginRenderPass({
  colorAttachments: [{ view: sceneTexture.createView(),
    loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});
// draw scene
scenePass.end();                       // ALWAYS end before sampling sceneTexture

const postPass = enc.beginRenderPass({
  colorAttachments: [{ view: context.getCurrentTexture().createView(),
    loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
});
// postPass binds sceneTexture and samples it
postPass.end();

device.queue.submit([enc.finish()]);
```

### Pattern 3: Full-screen quad without a vertex buffer

ALWAYS generate a full-screen pass with a 3-vertex oversized triangle from
`@builtin(vertex_index)` in the vertex shader. NEVER bind a vertex buffer for a
full-screen pass.

```wgsl
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
```

### Pattern 4: Ping-pong two textures

ALWAYS use two textures and swap their read/write roles each pass when an effect needs
the previous result as input. NEVER reuse one texture as both the sampled input and the
render attachment of a single pass.

```js
let read = texA, write = texB;
for (const effect of effects) {
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: write.createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  // bind read as the sampled input, draw the full-screen triangle
  pass.end();
  [read, write] = [write, read];       // swap roles for the next pass
}
```

### Pattern 5: Deferred shading G-buffer with MRT

ALWAYS render the G-buffer with one color attachment per channel (albedo, normal,
position or material) in a single geometry pass. The pipeline `fragment.targets` count
and formats MUST match the `colorAttachments` exactly.

```js
const gbufferPass = enc.beginRenderPass({
  colorAttachments: [
    { view: albedoTex.createView(), loadOp: "clear", storeOp: "store" },
    { view: normalTex.createView(), loadOp: "clear", storeOp: "store" },
  ],
  depthStencilAttachment: { view: depthTex.createView(),
    depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
});
```

The fragment shader writes `@location(0)` albedo and `@location(1)` normal. The lighting
pass is a full-screen pass that samples `albedoTex`, `normalTex`, and `depthTex`.

### Pattern 6: Shadow-map pass setup

ALWAYS render the shadow pass into a depth-only texture with `depthStencilAttachment`
and an empty `colorAttachments` array. The main pass binds that depth texture as
`texture_depth_2d` with a `"comparison"` sampler and calls `textureSampleCompare`.

```js
const shadowDepth = device.createTexture({
  label: "shadow-map",
  size: [2048, 2048],
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const shadowPass = enc.beginRenderPass({
  colorAttachments: [],                // shadow pass writes depth only
  depthStencilAttachment: { view: shadowDepth.createView(),
    depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
});
// render scene from the light's view-projection matrix
shadowPass.end();
```

## Common Anti-Patterns

1. **Sampling a texture in the same pass it is bound as an attachment.** WebGPU
   validation rejects a bind group containing a resource that is simultaneously a
   writable color or depth attachment of the active pass, because the read/write
   ordering is undefined. Fix: end the writing pass first, or ping-pong two textures.

2. **Missing `TEXTURE_BINDING` usage on an intermediate texture.** A texture created
   with only `RENDER_ATTACHMENT` cannot appear in a bind group. The later sampling pass
   fails validation. Fix: ALWAYS add `GPUTextureUsage.TEXTURE_BINDING`.

3. **Reusing one texture for read and write in the same pass.** The pass overwrites the
   data it still needs to read, and validation rejects the bind group. Fix: ping-pong
   two textures and swap roles each pass.

## Critical Warnings

- NEVER sample a texture while it is bound as a color or depth attachment of the active
  pass. Split the work into separate passes.
- NEVER omit `TEXTURE_BINDING` on a texture a later pass samples. `RENDER_ATTACHMENT`
  alone is insufficient.
- NEVER reuse a single texture as both the input and the output of one pass. Use
  ping-pong.
- NEVER finish a command encoder with a render pass still open. ALWAYS call
  `pass.end()` before the next `beginRenderPass` or `encoder.finish()`.
- NEVER cache `context.getCurrentTexture()` or its view across frames. The swap-chain
  rotates textures; obtain the canvas texture fresh each frame in the final pass.
- ALWAYS put `@invariant` on the vertex `@builtin(position)` output when a later pass
  depends on bit-identical depth from an earlier pass (depth pre-pass with `loadOp:
  "load"` and `depthCompare: "equal"`). Without it, transforms can differ per pipeline
  and depth equality fails.

## Reference Files

- `methods.md` : intermediate texture setup, the read-write hazard rule,
  ping-pong mechanics, deferred G-buffer layout, shadow-map pass setup.
- `examples.md` : verified working code for a post-process chain, a
  shadow-map pass plus main pass, and a ping-pong blur.
- `anti-patterns.md` : multi-pass mistakes with WHY-it-fails explanations.

Related skills:
- `webgpu-impl-render-targets` : render-pass descriptor fields, MRT attachment detail, MSAA.
- `webgpu-impl-render-usecases` : full-screen quad, screen-space effects, PBR setup.
- `webgpu-syntax-textures` : `createTexture`, usage flags, formats, texture views.
- `webgpu-wgsl-textures` : WGSL texture and sampler handle types per shader stage.
