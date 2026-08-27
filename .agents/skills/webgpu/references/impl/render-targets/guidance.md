# WebGPU Render Targets

Configure the `GPURenderPassDescriptor` attachments a render pass writes into: the
canvas color target, extra color targets for MRT, a depth-stencil buffer, and MSAA.

## Quick Reference

Color attachment fields (`colorAttachments[]` entries):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `view` | `GPUTextureView` | yes | Texture subresource written by the pass |
| `loadOp` | `"clear"` \| `"load"` | yes | `"clear"` resets to `clearValue`; `"load"` keeps contents |
| `storeOp` | `"store"` \| `"discard"` | yes | `"store"` writes results back; `"discard"` drops them |
| `clearValue` | `{r,g,b,a}` or `[r,g,b,a]` | no | Consumed ONLY when `loadOp` is `"clear"`; default `{0,0,0,0}` |
| `resolveTarget` | `GPUTextureView` | no | MSAA resolve destination; single-sample view |
| `depthSlice` | number | no | Index of a 3D-texture slice to render into |

Depth-stencil attachment fields (`depthStencilAttachment`):

| Field | Type | Notes |
|-------|------|-------|
| `view` | `GPUTextureView` | Depth-stencil texture subresource |
| `depthLoadOp` | `"clear"` \| `"load"` | Required when depth aspect present and `depthReadOnly` false |
| `depthStoreOp` | `"store"` \| `"discard"` | Required when depth aspect present and `depthReadOnly` false |
| `depthClearValue` | number 0.0-1.0 | Used when `depthLoadOp` is `"clear"` |
| `depthReadOnly` | boolean | Default `false`; when `true`, omit `depthLoadOp`/`depthStoreOp` |
| `stencilLoadOp` | `"clear"` \| `"load"` | Required when stencil aspect present and `stencilReadOnly` false |
| `stencilStoreOp` | `"store"` \| `"discard"` | Required when stencil aspect present and `stencilReadOnly` false |
| `stencilClearValue` | number | Default `0`; used when `stencilLoadOp` is `"clear"` |
| `stencilReadOnly` | boolean | Default `false`; when `true`, omit `stencilLoadOp`/`stencilStoreOp` |

Depth formats: `depth16unorm`, `depth24plus`, `depth24plus-stencil8`, `depth32float`,
`depth32float-stencil8`. `depth32float-stencil8` is gated behind the
`depth32float-stencil8` device feature.

Version: WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

## Decision Tree

```
Setting up render pass attachments?
├─ Single color target onto the canvas?
│    -> colorAttachments: [{ view: context.getCurrentTexture().createView(),
│                            loadOp: "clear", storeOp: "store", clearValue }]
├─ Multiple color targets (MRT, e.g. deferred G-buffer)?
│    -> one colorAttachments entry per target
│    -> fragment shader writes @location(0), @location(1), ...
│    -> pipeline fragment.targets count AND formats MUST match attachments
├─ Need depth testing or a stencil buffer?
│    ├─ pure depth, no stencil  -> depth24plus  (portable default)
│    ├─ depth + stencil         -> depth24plus-stencil8
│    └─ high-precision depth    -> depth32float
│    -> add depthStencilAttachment; set depthStencil format in the pipeline
└─ Want anti-aliasing (MSAA)?
     -> color texture with sampleCount: 4
     -> SAME sampleCount in pipeline multisample.count
     -> resolveTarget = a single-sample view (e.g. the canvas view)
```

`sampleCount` of 1 and 4 are the only universally supported values. `depth24plus`
is the portable default for a pure depth buffer.

## Core Patterns

### Pattern 1: Create the canvas color view fresh every frame

ALWAYS call `context.getCurrentTexture().createView()` inside the per-frame function.
NEVER cache the texture or its view across frames.

```js
function frame() {
  const colorView = context.getCurrentTexture().createView(); // fresh each frame
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: colorView,
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
}
```

### Pattern 2: clearValue is consumed only when loadOp is "clear"

ALWAYS pair a `clearValue` with `loadOp: "clear"`. When `loadOp` is `"load"` the
existing attachment contents are kept and `clearValue` is ignored.

```js
{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0.1, g: 0.2, b: 0.4, a: 1 } }
{ view, loadOp: "load",  storeOp: "store" } // keeps previous contents, no clearValue
```

### Pattern 3: MRT attachments must match the pipeline fragment targets

ALWAYS keep `colorAttachments.length` equal to `fragment.targets.length`, and keep
each attachment view's texture format equal to the matching `fragment.targets[i].format`.
The fragment shader writes one `@location(n)` per target.

```js
// 2 color attachments -> pipeline fragment.targets has 2 entries, same formats
colorAttachments: [
  { view: albedoTex.createView(), loadOp: "clear", storeOp: "store" },
  { view: normalTex.createView(), loadOp: "clear", storeOp: "store" },
]
// fragment shader: struct { @location(0) albedo: vec4f, @location(1) normal: vec4f }
```

### Pattern 4: Depth attachment format must match the pipeline depthStencil format

ALWAYS create the depth texture with the same `GPUTextureFormat` declared in the
pipeline's `depthStencil.format`. The depth texture needs `RENDER_ATTACHMENT` usage.

```js
const depthTexture = device.createTexture({
  size: [canvas.width, canvas.height],
  format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
// pipeline: depthStencil: { format: "depth24plus", depthWriteEnabled: true,
//                           depthCompare: "less" }
const pass = encoder.beginRenderPass({
  colorAttachments: [{ view: colorView, loadOp: "clear", storeOp: "store" }],
  depthStencilAttachment: {
    view: depthTexture.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "store",
  },
});
```

### Pattern 5: MSAA needs one sampleCount value in three places

ALWAYS set the SAME `sampleCount` (4) on the multisampled color texture and on the
pipeline `multisample.count`, and supply a single-sample `resolveTarget`. The GPU
resolves the multisampled buffer into the resolve target.

```js
const msaaTexture = device.createTexture({
  size: [canvas.width, canvas.height],
  sampleCount: 4,                 // (1)
  format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
// pipeline: multisample: { count: 4 }   // (2) same value
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: msaaTexture.createView(),                       // multisampled
    resolveTarget: context.getCurrentTexture().createView(), // (3) single-sample
    loadOp: "clear",
    storeOp: "store",
  }],
});
```

### Pattern 6: Depth-only pass omits colorAttachments entries

ALWAYS pass an empty `colorAttachments` array and only a `depthStencilAttachment`
for a depth-only pass (shadow map). The pipeline declares no `fragment` stage.

```js
const pass = encoder.beginRenderPass({
  colorAttachments: [],
  depthStencilAttachment: {
    view: shadowMap.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "store",
  },
});
```

## Common Anti-Patterns

1. **Caching `getCurrentTexture()` or its view across frames.** The swap chain
   rotates textures; a stale view targets a texture that is no longer presentable,
   producing a black canvas or a "texture already in use" validation error. Fix:
   call `context.getCurrentTexture().createView()` fresh inside the frame function.

2. **Pipeline `fragment.targets` not matching `colorAttachments`.** A different
   count or a mismatched format between a `fragment.targets[i]` and the matching
   attachment view fails pipeline or render validation. Fix: keep counts equal and
   formats identical.

3. **Mismatched `sampleCount` between pipeline and attachment texture.** A pipeline
   with `multisample.count: 4` used against a `sampleCount: 1` attachment (or the
   reverse) fails validation. Fix: use the same value (4) in the texture, the
   pipeline, and never set `resolveTarget` on a single-sample-only pass.

See `anti-patterns.md` for the full list with WHY explanations.

## Critical Warnings

- NEVER cache `context.getCurrentTexture()` or its `GPUTextureView` across frames.
- NEVER let `colorAttachments.length` differ from the pipeline `fragment.targets.length`.
- NEVER let an attachment view's format differ from the matching `fragment.targets[i].format`.
- NEVER mix `sampleCount` values: the multisampled texture, `multisample.count`, and
  the pipeline must all agree, and a `resolveTarget` MUST be single-sample (`sampleCount: 1`).
- NEVER let the depth texture format differ from the pipeline `depthStencil.format`.
- NEVER omit `depthLoadOp`/`depthStoreOp` when `depthReadOnly` is `false` and the
  depth aspect is present; NEVER supply them when `depthReadOnly` is `true`.
- NEVER supply a `clearValue` expecting it to apply when `loadOp` is `"load"`.

## Reference Files

- `methods.md` : full `GPURenderPassDescriptor` field reference, color
  attachment and depth-stencil attachment fields, depth formats, and MSAA setup.
- `examples.md` : verified code for a single color target, MRT, a depth
  attachment, and MSAA with `resolveTarget`.
- `anti-patterns.md` : mistakes with WHY-it-fails explanations.

Related skills: `webgpu-syntax-command-encoder` (`beginRenderPass`, pass lifecycle),
`webgpu-syntax-render-pipeline` (`fragment.targets`, `depthStencil`, `multisample`),
`webgpu-syntax-canvas-context` (`getCurrentTexture`, canvas configuration),
`webgpu-impl-multipass` (offscreen targets, post-processing, deferred shading),
`webgpu-syntax-textures` (texture creation, formats, `RENDER_ATTACHMENT` usage).
