# Methods: WebGPU Textures, Views and Samplers

API surface for `createTexture`, `createView`, `createSampler`, and
`importExternalTexture`. Verified against the W3C WebGPU spec and MDN on
2026-05-20. Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## device.createTexture(descriptor)

Returns a `GPUTexture`.

### GPUTextureDescriptor fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `label` | string | undefined | Debug label. |
| `size` | `[w, h?, d?]` or `{ width, height?, depthOrArrayLayers? }` | required | `height` and `depthOrArrayLayers` default to 1. |
| `mipLevelCount` | number | 1 | Number of mip levels. Levels are allocated, NOT generated. |
| `sampleCount` | number | 1 | `1` or `4` only. `4` = MSAA. |
| `dimension` | `"1d"` \| `"2d"` \| `"3d"` | `"2d"` | Texel grid dimensionality. |
| `format` | GPUTextureFormat | required | See format list below. |
| `usage` | GPUTextureUsage bitmask | required | See usage flags below. |
| `viewFormats` | GPUTextureFormat[] | `[]` | Extra formats allowed in `createView`. Each must be format-compatible with `format`. |

### Validation rules

- `sampleCount` MUST be `1` or `4`.
- When `sampleCount` is `4`: `mipLevelCount` MUST be `1`, `depthOrArrayLayers`
  MUST be `1`, `usage` MUST include `RENDER_ATTACHMENT`, and `usage` MUST NOT
  include `STORAGE_BINDING`.
- `RENDER_ATTACHMENT` requires a renderable `format` and `dimension: "2d"`.
- `STORAGE_BINDING` requires a storage-capable `format` and forbids
  `sampleCount > 1`.
- Each format in `viewFormats`, plus `format` itself, MUST be view-compatible
  (an `-srgb` format and its non-srgb sibling are compatible).
- Width / height MUST NOT exceed `device.limits.maxTextureDimension2D`
  (default 8192), depth `maxTextureDimension3D` (default 2048), array layers
  `maxTextureArrayLayers` (default 256).

### GPUTexture properties and methods

| Member | Type | Notes |
|--------|------|-------|
| `width` `height` `depthOrArrayLayers` | number | Read-only dimensions. |
| `mipLevelCount` `sampleCount` | number | Read-only. |
| `dimension` `format` `usage` | enum / number | Read-only. |
| `createView(descriptor?)` | GPUTextureView | See below. |
| `destroy()` | void | Frees GPU memory; the texture becomes unusable. |

## GPUTextureFormat

The values in scope for this skill. The full enum is larger (compressed BC /
ETC2 / ASTC formats are gated behind their `texture-compression-*` features).

| Format | Bytes/texel | Notes |
|--------|-------------|-------|
| `rgba8unorm` | 4 | Linear 8-bit RGBA. Use for normal maps, data textures. |
| `rgba8unorm-srgb` | 4 | sRGB-decoded on sample. Use for color art assets. |
| `bgra8unorm` | 4 | Common canvas format. Use the preferred-format query. |
| `bgra8unorm-srgb` | 4 | sRGB sibling of `bgra8unorm`. |
| `r16float` | 2 | Single-channel half-float. |
| `rgba16float` | 8 | HDR / intermediate render targets. Filterable by default. |
| `r32float` | 4 | Single-channel float. Filtering needs `float32-filterable`. |
| `rgba32float` | 16 | Full float RGBA. Filtering needs `float32-filterable`. |
| `depth16unorm` | 2 | 16-bit depth. |
| `depth24plus` | -- | Portable default depth buffer. Implementation-chosen precision. |
| `depth24plus-stencil8` | -- | Depth + 8-bit stencil. |
| `depth32float` | 4 | 32-bit float depth. |
| `depth32float-stencil8` | -- | Gated behind the `depth32float-stencil8` feature. |

`navigator.gpu.getPreferredCanvasFormat()` returns `"bgra8unorm"` or
`"rgba8unorm"` for the platform. ALWAYS use it for the canvas texture format.
See `webgpu-syntax-canvas-context`.

## GPUTextureUsage flags

Bitmask flags combined with `|`.

| Flag | Capability granted |
|------|--------------------|
| `GPUTextureUsage.COPY_SRC` | Source of `copyTextureToBuffer` / `copyTextureToTexture`. |
| `GPUTextureUsage.COPY_DST` | Destination of `queue.writeTexture` / `copyBufferToTexture`. |
| `GPUTextureUsage.TEXTURE_BINDING` | Bound as a sampled texture in a shader. |
| `GPUTextureUsage.STORAGE_BINDING` | Bound as a storage texture (shader read / write). |
| `GPUTextureUsage.RENDER_ATTACHMENT` | Used as a color or depth-stencil attachment. |

A texture supports only the capabilities its `usage` declares. A texture that
is uploaded and then sampled needs `COPY_DST | TEXTURE_BINDING`. An offscreen
render target that is later sampled needs `RENDER_ATTACHMENT | TEXTURE_BINDING`.

## texture.createView(descriptor?)

Returns a `GPUTextureView`. With no descriptor, returns a view covering all mip
levels and array layers with a dimension inferred from the texture.

### GPUTextureViewDescriptor fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `label` | string | undefined | Debug label. |
| `format` | GPUTextureFormat | texture's format | MUST be the texture format or a `viewFormats` entry. |
| `dimension` | GPUTextureViewDimension | inferred | See dimension table. |
| `aspect` | `"all"` \| `"depth-only"` \| `"stencil-only"` | `"all"` | Which aspect of a depth-stencil texture. |
| `baseMipLevel` | number | 0 | First mip level the view exposes. |
| `mipLevelCount` | number | remaining levels | Number of mip levels in the view. |
| `baseArrayLayer` | number | 0 | First array layer the view exposes. |
| `arrayLayerCount` | number | remaining layers | Number of array layers in the view. |

### GPUTextureViewDimension values

| Value | Use |
|-------|-----|
| `"1d"` | 1D texture. |
| `"2d"` | Single 2D image (the common default). |
| `"2d-array"` | Array of 2D images, indexed in the shader. |
| `"cube"` | Cubemap: requires exactly 6 array layers. |
| `"cube-array"` | Array of cubemaps: array layers a multiple of 6. |
| `"3d"` | Volume texture. |

`storageTexture` bindings cannot use `"cube"` or `"cube-array"`.

## device.createSampler(descriptor?)

Returns a `GPUSampler`. All fields are optional; defaults below.

### GPUSamplerDescriptor fields

| Field | Type | Default | Allowed values |
|-------|------|---------|----------------|
| `label` | string | undefined | Any string. |
| `addressModeU` | enum | `"clamp-to-edge"` | `"clamp-to-edge"`, `"repeat"`, `"mirror-repeat"` |
| `addressModeV` | enum | `"clamp-to-edge"` | same |
| `addressModeW` | enum | `"clamp-to-edge"` | same |
| `magFilter` | enum | `"nearest"` | `"nearest"`, `"linear"` |
| `minFilter` | enum | `"nearest"` | `"nearest"`, `"linear"` |
| `mipmapFilter` | enum | `"nearest"` | `"nearest"`, `"linear"` |
| `lodMinClamp` | number | `0` | `>= 0` |
| `lodMaxClamp` | number | `32` | `>= lodMinClamp` |
| `compare` | enum | undefined | `"never"`, `"less"`, `"equal"`, `"less-equal"`, `"greater"`, `"not-equal"`, `"greater-equal"`, `"always"` |
| `maxAnisotropy` | number | `1` | `>= 1`, typically `1`-`16` |

### Sampler rules

- A sampler with `compare` set is a **comparison sampler** for shadow-map
  depth comparison. It MUST be bound to a `sampler: { type: "comparison" }`
  layout entry and sampled in WGSL with `textureSampleCompare`.
- A sampler with `compare` unset is a normal sampler. If any of `magFilter`,
  `minFilter`, `mipmapFilter` is `"linear"` it is a **filtering** sampler and
  MUST bind to `sampler: { type: "filtering" }`. If all three are `"nearest"`
  it MAY bind to `sampler: { type: "non-filtering" }`.
- If `maxAnisotropy > 1`, then `magFilter`, `minFilter`, and `mipmapFilter`
  MUST all be `"linear"`.
- `lodMaxClamp` MUST be `>= lodMinClamp`.

## device.importExternalTexture(descriptor)

Returns a `GPUExternalTexture` that wraps a snapshot of the current frame of a
video source. Used to render video without an explicit upload.

### GPUExternalTextureDescriptor fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `source` | `HTMLVideoElement` \| `VideoFrame` | required | The video source. |
| `colorSpace` | `"srgb"` \| `"display-p3"` | `"srgb"` | Target color space of the frame. |
| `label` | string | undefined | Debug label. |

### Lifetime rules

- With an **`HTMLVideoElement`** source, the returned `GPUExternalTexture`
  expires at the end of the current task (single-frame lifetime). It MUST be
  re-imported every frame, and the bind group rebuilt every frame.
- With a **`VideoFrame`** source, the external texture stays valid until
  `VideoFrame.close()` is called.
- The video MUST be same-origin or CORS-enabled and loaded with non-zero
  dimensions, otherwise `importExternalTexture` throws a validation or security
  error.

### Binding rules

- An external texture is placed in a bind group as `{ binding, resource }`
  where `resource` is the `GPUExternalTexture`.
- The matching layout entry is `externalTexture: {}` (an empty object).
- In WGSL the handle type is `texture_external`, sampled with
  `textureSampleBaseClampToEdge` or `textureLoad`. See `webgpu-wgsl-textures`.

## Cross-references

- `webgpu-syntax-canvas-context` : `getPreferredCanvasFormat`,
  `getCurrentTexture`, canvas configuration.
- `webgpu-syntax-bind-groups` : bind-group layout entries, `sampler`,
  `texture`, `storageTexture`, `externalTexture` types.
- `webgpu-wgsl-textures` : WGSL handle types and texture builtin functions.
- `webgpu-impl-render-targets` : render passes, MSAA resolve, mipmap chains.
