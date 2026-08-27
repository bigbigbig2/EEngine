# WebGPU Textures, Views and Samplers

Create `GPUTexture`, `GPUTextureView`, and `GPUSampler` objects with correct
formats, usage flags, and binding-type matching. Targets WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

### createTexture descriptor

```js
const texture = device.createTexture({
  label: "albedo",          // optional, string
  size: [width, height, 1], // [w, h, depthOrArrayLayers]; h and depth default to 1
  mipLevelCount: 1,         // optional, default 1
  sampleCount: 1,           // optional, 1 or 4 only; default 1
  dimension: "2d",          // optional, "1d" | "2d" | "3d"; default "2d"
  format: "rgba8unorm",     // required GPUTextureFormat
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, // required
  viewFormats: [],          // optional, alternative formats for createView
});
```

### GPUTextureFormat (most common values)

| Group | Formats |
|-------|---------|
| 8-bit color | `rgba8unorm`, `rgba8unorm-srgb`, `bgra8unorm`, `bgra8unorm-srgb` |
| 16-bit float | `r16float`, `rgba16float` |
| 32-bit float | `r32float`, `rgba32float` (filtering needs `float32-filterable`) |
| Depth / stencil | `depth16unorm`, `depth24plus`, `depth24plus-stencil8`, `depth32float` |
| Depth gated | `depth32float-stencil8` (needs `depth32float-stencil8` feature) |

ALWAYS take the canvas format from `navigator.gpu.getPreferredCanvasFormat()`.
See `webgpu-syntax-canvas-context`.

### GPUTextureUsage flags

| Flag | Allows the texture to be |
|------|--------------------------|
| `COPY_SRC` | source of `copyTextureToBuffer` / `copyTextureToTexture` |
| `COPY_DST` | destination of `writeTexture` / `copyBufferToTexture` |
| `TEXTURE_BINDING` | bound and sampled in a shader |
| `STORAGE_BINDING` | bound as a storage texture (read/write in a shader) |
| `RENDER_ATTACHMENT` | a color or depth-stencil attachment of a render pass |

### createSampler descriptor

```js
const sampler = device.createSampler({
  addressModeU: "clamp-to-edge", // "clamp-to-edge" | "repeat" | "mirror-repeat"
  addressModeV: "clamp-to-edge",
  addressModeW: "clamp-to-edge",
  magFilter: "linear",   // "nearest" | "linear"; default "nearest"
  minFilter: "linear",
  mipmapFilter: "linear",
  lodMinClamp: 0,        // default 0
  lodMaxClamp: 32,       // default 32, must be >= lodMinClamp
  maxAnisotropy: 1,      // default 1; values > 1 require all 3 filters "linear"
  // compare: "less",    // present = comparison sampler (shadow maps)
});
```

### Sampler binding types

| Sampler | Binding-layout `sampler.type` |
|---------|-------------------------------|
| Any filter "linear", no `compare` | `"filtering"` |
| All filters "nearest", no `compare` | `"non-filtering"` |
| `compare` set | `"comparison"` |

## Decision Tree

```
Need a texture? -> what is it for?
  Sampled in a shader               -> usage |= TEXTURE_BINDING (+ COPY_DST to upload)
  Render pass output                -> usage |= RENDER_ATTACHMENT
  Sampled later AND a render output -> usage = RENDER_ATTACHMENT | TEXTURE_BINDING
  Compute storage texture           -> usage |= STORAGE_BINDING (sampleCount must be 1)
  Read back to CPU                  -> usage |= COPY_SRC

Pick a format:
  Canvas / swap-chain        -> navigator.gpu.getPreferredCanvasFormat()
  Color art assets, sRGB     -> rgba8unorm-srgb
  Linear data (normal maps)  -> rgba8unorm
  HDR / intermediate render  -> rgba16float
  Pure depth buffer          -> depth24plus
  Depth + stencil            -> depth24plus-stencil8

Pick a view dimension:
  Plain 2D image       -> "2d" (default)
  Texture array        -> "2d-array"
  Cubemap (6 layers)   -> "cube"
  Volume texture       -> "3d"

Pick a sampler:
  Smooth scaling           -> magFilter/minFilter "linear"
  Pixel-art / data lookup  -> magFilter/minFilter "nearest"
  Mipmapped texture        -> mipmapFilter "linear"
  Shadow map depth compare -> set compare, e.g. "less"
```

## Core Patterns

### ALWAYS include every usage the texture is actually used for

A texture used as both a render target and a sampled input needs both flags.
A missing flag fails validation at bind-group or render-pass time, not at
`createTexture` time.

```js
const offscreen = device.createTexture({
  size: [w, h],
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

### ALWAYS create texture views fresh from the owning texture

`texture.createView(descriptor?)` returns a `GPUTextureView`. For a plain 2D
single-mip texture, `texture.createView()` with no descriptor is correct.

```js
const fullView = texture.createView();
const oneMip = texture.createView({ baseMipLevel: 2, mipLevelCount: 1 });
const faceView = cubeTex.createView({ dimension: "cube" });
```

### ALWAYS match the sampler binding type to the sampler

A `"filtering"` sampler binding accepts a sampler with `"linear"` filters. A
`"non-filtering"` binding rejects any sampler with a `"linear"` filter. A
`compare` sampler requires a `"comparison"` binding. See `webgpu-syntax-bind-groups`.

```js
// layout entry
{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
// bind-group entry
{ binding: 0, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) }
```

### ALWAYS set sampleCount to 4 on both the texture and the pipeline for MSAA

`sampleCount` is `1` or `4` only. A multisample texture requires
`usage |= RENDER_ATTACHMENT`, forbids `STORAGE_BINDING`, and requires
`mipLevelCount: 1`. The render pipeline `multisample.count` MUST equal `4` too.

```js
const msaaColor = device.createTexture({
  size: [w, h],
  sampleCount: 4,
  format: presentationFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
```

### NEVER cache a GPUExternalTexture across frames

`device.importExternalTexture({ source })` returns a `GPUExternalTexture`. With
an `HTMLVideoElement` source it expires immediately after first use (single-frame
lifetime). Re-import every frame and rebuild the bind group every frame.

```js
function frame() {
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: device.importExternalTexture({ source: videoEl }) },
    ],
  });
  // ...record and submit using bindGroup...
  requestAnimationFrame(frame);
}
```

### ALWAYS gate feature-dependent formats on adapter.features

`depth32float-stencil8` needs the `depth32float-stencil8` feature. Filtering an
`r32float` / `rgba32float` texture needs `float32-filterable`. Request the
feature on the device only after confirming the adapter has it.

```js
const requiredFeatures = adapter.features.has("float32-filterable")
  ? ["float32-filterable"] : [];
const device = await adapter.requestDevice({ requiredFeatures });
```

## Common Anti-Patterns

1. **Missing `TEXTURE_BINDING` or `RENDER_ATTACHMENT` usage.** A texture created
   with only `COPY_DST` cannot be sampled or rendered into. WHY it fails:
   bind-group and render-pass validation check the texture's usage flags and
   reject a texture that lacks the required capability.

2. **Hard-coding `bgra8unorm` for the canvas.** `getPreferredCanvasFormat()`
   returns `rgba8unorm` on some platforms. WHY it fails: a mismatch forces a
   per-frame format conversion and can break pipeline `fragment.targets` format
   matching.

3. **Caching a `GPUExternalTexture`.** WHY it fails: an external texture from an
   `HTMLVideoElement` expires after the task that first uses it; reusing the
   stale handle fails validation on the next frame.

## Critical Warnings

- NEVER use a `"non-filtering"` sampler binding type with a sampler that has a
  `"linear"` filter. Validation rejects the bind group.
- NEVER sample an `r32float` / `rgba32float` texture with a filtering sampler
  unless the device was created with the `float32-filterable` feature.
- NEVER set `sampleCount` to any value other than `1` or `4`.
- NEVER combine `sampleCount: 4` with `STORAGE_BINDING` or `mipLevelCount > 1`.
- NEVER expect WebGPU to generate mipmaps automatically. `mipLevelCount > 1`
  allocates the levels; you MUST fill them. See `webgpu-impl-render-targets`.
- NEVER set `maxAnisotropy > 1` unless `magFilter`, `minFilter`, and
  `mipmapFilter` are all `"linear"`.
- NEVER reuse a texture view created from `context.getCurrentTexture()` across
  frames. See `webgpu-syntax-canvas-context`.

## Reference Files

- `methods.md` : full descriptors, format list, usage flags, view
  dimensions, sampler fields, importExternalTexture signature.
- `examples.md` : verified code for sampled upload, render target,
  mipmapped views, sampler creation, external texture from video.
- `anti-patterns.md` : detailed mistakes with WHY-it-fails analysis.

Related skills: `webgpu-syntax-canvas-context`, `webgpu-syntax-bind-groups`,
`webgpu-wgsl-textures`, `webgpu-impl-render-targets`.
