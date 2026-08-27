# Multi-Pass Rendering Anti-Patterns

Each anti-pattern lists the mistake, WHY it fails, and the fix. Verified against WebGPU
1.0-stable (Chrome 113+, Safari 26+, Firefox 141+) and the W3C WebGPU specification.

## 1. Sampling a texture in the same pass it is bound as an attachment

```js
// WRONG: targetTexture is a color attachment AND sampled in the same pass.
const pass = encoder.beginRenderPass({
  colorAttachments: [{ view: targetTexture.createView(),
    loadOp: "clear", storeOp: "store" }],
});
const bindGroup = device.createBindGroup({
  layout, entries: [{ binding: 0, resource: targetTexture.createView() }],
});
pass.setBindGroup(0, bindGroup);   // validation error
```

WHY it fails: WebGPU validation rejects a bind group that contains a resource which is
simultaneously a writable color or depth attachment of the active render pass. The
order in which the GPU reads the sampled value relative to writing the attachment is
undefined, so the specification forbids the overlap entirely. The error fires at
`setBindGroup` or pass-encoding time.

FIX: end the writing pass with `pass.end()`, then `beginRenderPass` again for the pass
that samples the result. Passes within one encoder run in order on the GPU timeline, so
the second pass sees the finished output. When an effect logically reads and writes the
same image, use ping-pong (anti-pattern 3).

## 2. Missing TEXTURE_BINDING usage on an intermediate texture

```js
// WRONG: only RENDER_ATTACHMENT, no TEXTURE_BINDING.
const intermediate = device.createTexture({
  size: [w, h], format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
// Later: device.createBindGroup with intermediate.createView() -> validation error.
```

WHY it fails: a texture can only appear in a bind group entry if it was created with
`GPUTextureUsage.TEXTURE_BINDING`. `RENDER_ATTACHMENT` only authorizes the texture as a
render target. A multi-pass intermediate is both: an earlier pass renders into it, a
later pass samples it. Without `TEXTURE_BINDING` the later pass's `createBindGroup`
fails validation.

FIX: ALWAYS create an intermediate render texture with
`GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING`. For a texture
that is also copied, add `COPY_SRC` or `COPY_DST` as needed.

## 3. Reusing one texture for read and write in the same pass

```js
// WRONG: iterative effect feeds its own output texture as input.
for (let i = 0; i < passes; i++) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: effectTexture.createView(),
      loadOp: "load", storeOp: "store" }],
  });
  pass.setBindGroup(0, bindGroupSamplingEffectTexture);  // same texture: hazard
  pass.draw(3);
  pass.end();
}
```

WHY it fails: this is anti-pattern 1 applied to an iterative effect. The texture is the
render attachment and the sampled input of the same pass, so validation rejects it.
Even if validation were bypassed, the pass would overwrite texels it still needs to
read, producing undefined results.

FIX: ping-pong two textures. Create `texA` and `texB` of identical size and format.
Each pass samples one and renders into the other, then swap the roles. The result lives
in whichever texture is the read target after the final swap.

```js
let read = texA, write = texB;
for (let i = 0; i < passes; i++) {
  runFullScreenPass(encoder, read, write);
  [read, write] = [write, read];
}
```

## 4. Forgetting @invariant on position when a later pass needs depth equality

```wgsl
// WRONG: depth pre-pass and main pass share this vertex transform without @invariant.
@vertex fn vs(@location(0) pos : vec3f) -> @builtin(position) vec4f {
  return mvp * vec4f(pos, 1.0);
}
```

```js
// Main pass relies on exact depth equality against the pre-pass result.
depthStencil: { format: "depth24plus", depthWriteEnabled: false,
  depthCompare: "equal" }   // depth pre-pass + "equal" comparison
```

WHY it fails: WebGPU does not guarantee that the same arithmetic produces bit-identical
results across two different `GPURenderPipeline` objects. Floating-point optimizations
(fused multiply-add, reassociation) can differ per compiled pipeline. When a depth
pre-pass writes depth with one pipeline and the main pass reads depth with
`depthCompare: "equal"` using another pipeline, tiny differences cause fragments to
fail the equality test, producing Z-fighting flicker or missing surfaces.

FIX: ALWAYS apply the `@invariant` attribute to the vertex `@builtin(position)` output
in every pipeline that must agree on depth. `@invariant` forces the implementation to
compute bit-identical position results across pipelines.

```wgsl
@vertex fn vs(@location(0) pos : vec3f) -> @builtin(position) @invariant vec4f {
  return mvp * vec4f(pos, 1.0);
}
```

The same rule applies to a shadow pass plus a depth pre-pass that compare depth, and to
any multi-pass setup using `depthCompare: "equal"`.

## 5. Caching getCurrentTexture across passes or frames

```js
// WRONG: the canvas view is obtained once and reused.
const canvasView = context.getCurrentTexture().createView();
function frame() {
  // ... uses canvasView every frame ...
}
```

WHY it fails: `context.getCurrentTexture()` returns a different texture on every call
because the swap-chain rotates presentable textures. A stale view targets a texture that
is no longer the presentable one, producing a black canvas or a validation error that
the texture is already in use.

FIX: in the final present pass of every frame, call
`context.getCurrentTexture().createView()` fresh. Intermediate textures created with
`createTexture` are owned by the app and stay valid across frames; only the canvas
texture rotates.

## 6. Mismatched fragment.targets and colorAttachments in a deferred G-buffer

```js
// WRONG: pipeline declares 2 targets, the geometry pass binds 3 attachments.
fragment: { module, targets: [{ format: "rgba8unorm" }, { format: "rgba16float" }] }
// ... pass has albedo + normal + material = 3 colorAttachments
```

WHY it fails: deferred shading writes a G-buffer with MRT. The render pipeline's
`fragment.targets` array length and each entry's `format` MUST match the render pass's
`colorAttachments` array exactly. A count or format mismatch fails pipeline creation or
render-pass validation, because the fragment shader's `@location` outputs would not map
cleanly onto the attachments.

FIX: keep the pipeline's `fragment.targets` aligned with the geometry pass's
`colorAttachments`, entry for entry, format for format. The fragment shader must write
one `@location(n)` output per attachment.

## 7. Giving the shadow pass color attachments

```js
// WRONG: a shadow pass with a color attachment it does not need.
const shadowPass = encoder.beginRenderPass({
  colorAttachments: [{ view: someColorTexture.createView(),
    loadOp: "clear", storeOp: "store" }],
  depthStencilAttachment: { view: shadowDepth.createView(),
    depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store" },
});
```

WHY it fails functionally it can still run, but the shadow pass only needs depth. A
color attachment forces the GPU to allocate, clear, and store color memory that nothing
consumes, wasting bandwidth and memory. It also requires the shadow pipeline to declare
a `fragment` stage with matching targets, adding needless fragment work.

FIX: render the shadow pass with `colorAttachments: []` and only a
`depthStencilAttachment`. Omit the `fragment` stage from the shadow pipeline. The main
pass binds the resulting depth texture as `texture_depth_2d` with a comparison sampler.

## 8. Using a non-comparison sampler with a depth shadow texture

```js
// WRONG: a plain filtering sampler bound to a "comparison" sampler binding.
const sampler = device.createSampler({ magFilter: "linear" });  // no compare
const layout = device.createBindGroupLayout({
  entries: [{ binding: 1, visibility: GPUShaderStage.FRAGMENT,
    sampler: { type: "comparison" } }],
});
```

WHY it fails: a `"comparison"` sampler binding requires a sampler created with a
`compare` function. A sampler without `compare` is a filtering sampler and does not
match a `"comparison"` binding, so `createBindGroup` fails validation. In WGSL,
`textureSampleCompare` also requires a `sampler_comparison`, not a plain `sampler`.

FIX: create the shadow sampler with a `compare` function, such as
`device.createSampler({ compare: "less" })`. Match it to a `sampler: { type:
"comparison" }` bind group layout entry and a `texture: { sampleType: "depth" }`
texture entry.

## 9. HDR post-processing through an 8-bit intermediate texture

```js
// WRONG: bloom input clamped to [0,1] by an 8-bit format.
const sceneTexture = device.createTexture({
  size: [w, h], format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

WHY it fails: bloom, exposure, and tone-mapping passes need scene values above 1.0 to
isolate bright highlights. An `rgba8unorm` intermediate clamps every channel to the
0.0 to 1.0 range. The bloom threshold pass then has no super-bright pixels to extract,
and tone-mapping receives already-clamped input, so highlights look flat.

FIX: render the HDR scene into an `rgba16float` intermediate texture. Keep float
formats through the bloom and tone-mapping chain. Only the final present pass writes to
the canvas in the preferred 8-bit format.
