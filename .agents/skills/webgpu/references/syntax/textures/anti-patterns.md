# Anti-Patterns: WebGPU Textures, Views and Samplers

Each entry pairs a wrong pattern with the correct one and a WHY-it-fails
analysis. Verified against the W3C WebGPU spec and MDN on 2026-05-20.

## 1. Non-filtering sampler binding with a filtering sampler

### Wrong

```js
const layout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
    sampler: { type: "non-filtering" } }],
});
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
device.createBindGroup({ layout, entries: [{ binding: 0, resource: sampler }] });
```

### Correct

```js
const layout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
    sampler: { type: "filtering" } }],
});
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
```

### Why it fails

A sampler with any `"linear"` filter is a filtering sampler. A
`"non-filtering"` layout entry promises that only point-sampled samplers will
be bound. WebGPU validates the sampler against the declared type at
`createBindGroup` time and rejects the bind group. A `"non-filtering"` binding
accepts only samplers whose `magFilter`, `minFilter`, and `mipmapFilter` are
all `"nearest"`.

## 2. Filtering a float32 texture without float32-filterable

### Wrong

```js
const device = await adapter.requestDevice(); // no features requested
const hdr = device.createTexture({
  size: [w, h], format: "rgba32float",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
// Binding this filtering sampler against an rgba32float texture fails.
```

### Correct

```js
const requiredFeatures = adapter.features.has("float32-filterable")
  ? ["float32-filterable"] : [];
const device = await adapter.requestDevice({ requiredFeatures });
// If the feature is unavailable, use rgba16float (filterable by default)
// or a non-filtering sampler.
```

### Why it fails

`r32float`, `rg32float`, and `rgba32float` textures are not filterable in core
WebGPU. Sampling them with a `magFilter` or `minFilter` of `"linear"` requires
the `float32-filterable` feature on the device. Without it, the texture's
`sampleType` is `"unfilterable-float"`, which a filtering sampler cannot pair
with. `rgba16float` is filterable in core WebGPU and needs no feature.

## 3. Caching a GPUExternalTexture across frames

### Wrong

```js
const externalTexture = device.importExternalTexture({ source: video });
const bindGroup = device.createBindGroup({
  layout, entries: [{ binding: 1, resource: externalTexture }],
});
function frame() {
  // Reusing the same bindGroup and externalTexture every frame.
  renderWith(bindGroup);
  requestAnimationFrame(frame);
}
```

### Correct

```js
function frame() {
  const externalTexture = device.importExternalTexture({ source: video });
  const bindGroup = device.createBindGroup({
    layout, entries: [{ binding: 1, resource: externalTexture }],
  });
  renderWith(bindGroup);
  requestAnimationFrame(frame);
}
```

### Why it fails

A `GPUExternalTexture` imported from an `HTMLVideoElement` has single-frame
lifetime. It expires at the end of the task in which it was first used. On the
next frame the cached handle is stale, and any bind group referencing it fails
validation when the render pass runs. The external texture, and the bind group
that holds it, MUST be recreated every frame. A `VideoFrame` source is the
exception: that handle lives until `VideoFrame.close()`.

## 4. Hard-coding bgra8unorm for the canvas

### Wrong

```js
context.configure({ device, format: "bgra8unorm" });
```

### Correct

```js
const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format: presentationFormat });
```

### Why it fails

`getPreferredCanvasFormat()` returns `"rgba8unorm"` on some platforms and
`"bgra8unorm"` on others. Hard-coding one value forces the compositor to
convert every frame on the platforms where it does not match, costing
performance. It also breaks pipeline `fragment.targets` format matching when
the pipeline format is derived from the preferred format but the context uses
a different one. See `webgpu-syntax-canvas-context`.

## 5. Missing RENDER_ATTACHMENT or TEXTURE_BINDING usage

### Wrong

```js
// Intended as an offscreen render target, then sampled.
const target = device.createTexture({
  size: [w, h], format: "rgba16float",
  usage: GPUTextureUsage.TEXTURE_BINDING, // missing RENDER_ATTACHMENT
});
encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), /* ... */ }] });
```

### Correct

```js
const target = device.createTexture({
  size: [w, h], format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

### Why it fails

A texture supports only the capabilities its `usage` mask declares. A texture
without `RENDER_ATTACHMENT` cannot be a render-pass attachment; a texture
without `TEXTURE_BINDING` cannot be sampled in a shader. The error does not
surface at `createTexture` time. It surfaces later, at `beginRenderPass` or
`createBindGroup`, as a validation error. ALWAYS declare every usage the
texture will actually be used for at creation time.

## 6. Expecting automatic mipmap generation

### Wrong

```js
const tex = device.createTexture({
  size: [512, 512], mipLevelCount: 10, format: "rgba8unorm-srgb",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
device.queue.writeTexture({ texture: tex }, level0Pixels, /* ... */, [512, 512]);
// Sampling with mipmapFilter "linear" reads uninitialized levels 1..9.
```

### Correct

Allocate the levels, then fill every level explicitly. Generate the chain with
a render-based downsample pass (the texture then also needs
`RENDER_ATTACHMENT`), or upload pre-computed mip data per level. See
`webgpu-impl-render-targets`.

### Why it fails

WebGPU never generates mipmaps automatically. `mipLevelCount` only allocates
storage for the levels; their contents start uninitialized. A sampler with
`mipmapFilter: "linear"` reads from those empty levels for minified surfaces,
producing black or garbage results. This is a recurring port pitfall from
OpenGL, which had `glGenerateMipmap`.

## 7. sampleCount mismatch between texture and pipeline

### Wrong

```js
const msaa = device.createTexture({
  size: [w, h], sampleCount: 4, format: presentationFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  /* ... */ multisample: { count: 1 }, // mismatch
});
```

### Correct

```js
const pipeline = device.createRenderPipeline({
  /* ... */ multisample: { count: 4 },
});
```

### Why it fails

A render pipeline's `multisample.count` MUST equal the `sampleCount` of every
color attachment used with it. A 4x texture rendered with a 1x pipeline fails
render-pass validation. `sampleCount` is `1` or `4` only; a 4x texture also
forbids `STORAGE_BINDING` and requires `mipLevelCount: 1`.

## Cross-references

- `webgpu-syntax-canvas-context` : preferred format and per-frame texture.
- `webgpu-syntax-bind-groups` : layout entry types and binding rules.
- `webgpu-wgsl-textures` : WGSL texture handle types per stage.
- `webgpu-impl-render-targets` : MSAA resolve and mipmap-generation workflows.
