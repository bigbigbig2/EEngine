# Render Targets : Anti-Patterns

Version: WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.
Each entry states the mistake, WHY it fails, and the fix. Verified against the W3C
WebGPU specification, MDN `GPUCommandEncoder/beginRenderPass`, and PART C section 1
of the WebGPU vooronderzoek (verified 2026-05-20).

## 1. Caching getCurrentTexture or its view across frames

WRONG:

```js
const colorView = context.getCurrentTexture().createView(); // cached once
function frame() {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: colorView, loadOp: "clear", storeOp: "store" }],
  });
}
```

WHY IT FAILS: the canvas swap chain rotates between several backing textures.
`getCurrentTexture()` returns a NEW texture each frame, valid only for the frame it
was obtained in. A view cached from an earlier frame points at a texture that is no
longer the presentable one. The result is a black canvas, a stale frame, or a
validation error stating the texture is already in use or invalid.

FIX: call `context.getCurrentTexture().createView()` inside the per-frame function,
once per frame.

```js
function frame() {
  const view = context.getCurrentTexture().createView(); // fresh each frame
}
```

## 2. Pipeline fragment.targets count not matching colorAttachments count

WRONG:

```js
// pipeline declares ONE target
fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }
// pass declares TWO color attachments
colorAttachments: [
  { view: a.createView(), loadOp: "clear", storeOp: "store" },
  { view: b.createView(), loadOp: "clear", storeOp: "store" },
]
```

WHY IT FAILS: WebGPU requires the render pipeline's `fragment.targets` array to have
exactly the same number of entries as the active render pass `colorAttachments`
array. The pipeline-against-pass compatibility check rejects a count mismatch, so
`setPipeline` or the draw call produces a validation error.

FIX: keep `fragment.targets.length` equal to `colorAttachments.length`. Add or
remove pipeline targets so the counts match. The fragment shader writes one
`@location(n)` output per target.

## 3. Pipeline target format not matching the attachment view format

WRONG:

```js
// attachment view comes from an rgba16float texture
colorAttachments: [{ view: hdrTex.createView(), loadOp: "clear", storeOp: "store" }]
// pipeline target declares a different format
fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }
```

WHY IT FAILS: each `fragment.targets[i].format` MUST equal the `GPUTextureFormat` of
the texture behind the matching color attachment view. The formats drive how the
fragment shader output is encoded; a mismatch makes the pipeline incompatible with
the pass and fails render validation.

FIX: set each `fragment.targets[i].format` to the exact format of the matching
attachment texture. For the canvas target, use the format from
`navigator.gpu.getPreferredCanvasFormat()` for both `context.configure` and the
pipeline target.

## 4. Mismatched sampleCount between pipeline and attachment texture

WRONG:

```js
const msaaTexture = device.createTexture({
  size: [w, h], sampleCount: 4, format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  // ... multisample omitted, so count defaults to 1 ...
});
```

WHY IT FAILS: the render pipeline `multisample.count` MUST equal the `sampleCount`
of every color and depth attachment texture used with it. A pipeline with the
default `count: 1` drawn into a `sampleCount: 4` attachment (or the reverse) is
incompatible with the pass and fails validation. This is the wrong-sampleCount MSAA
bug: forgetting to add `multisample: { count: 4 }` to the pipeline after creating a
multisampled texture.

FIX: set the SAME value in three places: the multisampled texture `sampleCount`, the
multisampled depth texture `sampleCount` if depth is used, and the pipeline
`multisample.count`.

```js
const sampleCount = 4;
device.createTexture({ /* ... */ sampleCount });
device.createRenderPipeline({ /* ... */ multisample: { count: sampleCount } });
```

## 5. resolveTarget that is not single-sampled

WRONG:

```js
colorAttachments: [{
  view: msaaTexture.createView(),                 // sampleCount 4
  resolveTarget: anotherMsaaTexture.createView(),  // also sampleCount 4
  loadOp: "clear",
  storeOp: "store",
}]
```

WHY IT FAILS: a `resolveTarget` is the destination the GPU resolves the multisampled
samples into. It MUST be a view of a texture with `sampleCount` of 1. A multisampled
`resolveTarget` is invalid because there is nothing to resolve into; WebGPU rejects
the render pass. The `resolveTarget` and the multisampled `view` must also share the
same format and size.

FIX: use a single-sample texture for the resolve target. For on-screen rendering the
canvas view is the natural resolve target: `context.getCurrentTexture().createView()`
is always single-sample.

## 6. Depth attachment format not matching the pipeline depthStencil format

WRONG:

```js
const depthTexture = device.createTexture({
  size: [w, h], format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  // ...
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
});
```

WHY IT FAILS: the format of the texture behind `depthStencilAttachment.view` MUST
equal the pipeline `depthStencil.format`. The depth format determines precision and
the depth-test encoding; a mismatch makes the pipeline incompatible with the pass
and fails render validation.

FIX: create the depth texture with the exact format the pipeline declares. Pick one
format (`depth24plus` is the portable default) and use it in both places.

## 7. Supplying clearValue with loadOp "load"

WRONG (a misunderstanding, not always a hard error):

```js
{ view, loadOp: "load", storeOp: "store", clearValue: { r: 1, g: 0, b: 0, a: 1 } }
```

WHY IT FAILS TO DO WHAT IS EXPECTED: `clearValue` is consumed ONLY when `loadOp` is
`"clear"`. With `loadOp: "load"` the attachment keeps its existing contents and
`clearValue` is ignored. Code that expects the red clear to appear sees the previous
frame's contents instead.

FIX: use `loadOp: "clear"` together with `clearValue` to reset the attachment, or
use `loadOp: "load"` (and drop `clearValue`) to preserve prior contents.

## 8. Providing depth load/store ops when depthReadOnly is true

WRONG:

```js
depthStencilAttachment: {
  view: depthTexture.createView(),
  depthReadOnly: true,
  depthLoadOp: "clear",   // invalid with depthReadOnly: true
  depthStoreOp: "store",  // invalid with depthReadOnly: true
}
```

WHY IT FAILS: when `depthReadOnly` is `true` the pass performs no depth writes, so
`depthLoadOp` and `depthStoreOp` MUST be omitted; supplying them is a validation
error. The reverse is also an error: when `depthReadOnly` is `false` and the depth
aspect is present, `depthLoadOp` and `depthStoreOp` are required. For a combined
depth-and-stencil format, `depthReadOnly` MUST equal `stencilReadOnly`.

FIX: when `depthReadOnly: true`, omit `depthLoadOp`/`depthStoreOp`. When the pass
writes depth, set `depthReadOnly: false` (or omit it) and provide both ops. Use
`depthReadOnly: true` only to sample the depth texture as a bound resource while it
is still attached.

## 9. Forgetting an empty colorAttachments array for a depth-only pass

WRONG:

```js
const pass = encoder.beginRenderPass({
  depthStencilAttachment: { /* ... */ }, // colorAttachments missing entirely
});
```

WHY IT FAILS: `colorAttachments` is a required field of `GPURenderPassDescriptor`.
A depth-only pass (such as a shadow-map pass) still MUST provide the field, as an
empty array.

FIX: pass `colorAttachments: []` and supply only `depthStencilAttachment`. The
pipeline for the pass declares no `fragment` stage.

## 10. Not resizing MSAA and depth textures with the canvas

WRONG:

```js
// canvas resized, but msaaTexture and depthTexture keep the old size
canvas.width = newWidth;
canvas.height = newHeight;
```

WHY IT FAILS: a `resolveTarget` and its multisampled `view` MUST have matching size,
and depth and color attachments in one pass MUST share dimensions. After a canvas
resize the swap-chain textures change size, so a stale multisampled or depth texture
no longer matches the resolve target and the pass fails validation.

FIX: in the resize handler (typically a `ResizeObserver`), destroy and recreate the
multisampled color texture and the depth texture at the new clamped size before the
next frame.
