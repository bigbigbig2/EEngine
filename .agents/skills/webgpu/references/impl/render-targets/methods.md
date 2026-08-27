# Render Targets : Methods Reference

Version: WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.
All field names and enum values verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/) and MDN
(https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/beginRenderPass),
fetched 2026-05-20.

## GPURenderPassDescriptor

Passed to `commandEncoder.beginRenderPass(descriptor)`. Returns a
`GPURenderPassEncoder`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `colorAttachments` | array of color attachment objects | yes | One entry per color target; an empty array is valid for a depth-only pass |
| `depthStencilAttachment` | depth-stencil attachment object | no | Present when the pass uses a depth or stencil buffer |
| `occlusionQuerySet` | `GPUQuerySet` of type `"occlusion"` | no | Target for occlusion queries in the pass |
| `timestampWrites` | array of timestamp query objects | no | Requires the `timestamp-query` device feature |
| `maxDrawCount` | number | no | Default `50000000`; upper bound on draw calls in the pass |
| `label` | string | no | Debug label |

## Color attachment object

Each entry of `colorAttachments`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `view` | `GPUTextureView` | yes | The texture subresource the pass writes its color output into |
| `loadOp` | `"clear"` \| `"load"` | yes | Operation applied to the attachment at pass start |
| `storeOp` | `"store"` \| `"discard"` | yes | Operation applied to the attachment at pass end |
| `clearValue` | `{ r, g, b, a }` or `[r, g, b, a]` | no | Default `{ r: 0, g: 0, b: 0, a: 0 }`; consumed ONLY when `loadOp` is `"clear"` |
| `resolveTarget` | `GPUTextureView` | no | MSAA resolve destination; required to be single-sample (`sampleCount` 1) |
| `depthSlice` | number | no | Index of the 3D-texture depth slice to render into; used only when `view` is from a 3D texture |

### loadOp values

- `"clear"` : the attachment is initialized to `clearValue` before the pass runs.
- `"load"` : the attachment keeps its existing contents; `clearValue` is ignored.

### storeOp values

- `"store"` : the rendered results are written back into the attachment texture.
- `"discard"` : the rendered results are thrown away; useful for transient depth or
  intermediate buffers that no later pass reads.

### resolveTarget rules (MSAA)

- Only meaningful when the attachment `view` is multisampled (`sampleCount` greater
  than 1).
- The `resolveTarget` view MUST have `sampleCount` of 1.
- The `resolveTarget` and the multisampled `view` MUST have matching `GPUTextureFormat`
  and matching size.
- After the pass, the GPU resolves (averages) the multisampled samples into the
  `resolveTarget`.

### depthSlice rules (3D textures)

- Specifies which slice of a 3D texture the color output is written to.
- Used only when the attachment `view` is a view of a 3D texture; omitted for 2D
  targets.

## Depth-stencil attachment object

The optional `depthStencilAttachment` of `GPURenderPassDescriptor`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `view` | `GPUTextureView` | yes | The depth-stencil texture subresource |
| `depthLoadOp` | `"clear"` \| `"load"` | conditional | Required when the depth aspect is present and `depthReadOnly` is `false` |
| `depthStoreOp` | `"store"` \| `"discard"` | conditional | Required when the depth aspect is present and `depthReadOnly` is `false` |
| `depthClearValue` | number 0.0-1.0 | no | Used when `depthLoadOp` is `"clear"` |
| `depthReadOnly` | boolean | no | Default `false`; when `true`, omit `depthLoadOp` and `depthStoreOp` |
| `stencilLoadOp` | `"clear"` \| `"load"` | conditional | Required when the stencil aspect is present and `stencilReadOnly` is `false` |
| `stencilStoreOp` | `"store"` \| `"discard"` | conditional | Required when the stencil aspect is present and `stencilReadOnly` is `false` |
| `stencilClearValue` | number | no | Default `0`; used when `stencilLoadOp` is `"clear"` |
| `stencilReadOnly` | boolean | no | Default `false`; when `true`, omit `stencilLoadOp` and `stencilStoreOp` |

### Read-only rules

- `depthReadOnly: true` makes the depth aspect read-only; `depthLoadOp` and
  `depthStoreOp` MUST then be omitted.
- `stencilReadOnly: true` makes the stencil aspect read-only; `stencilLoadOp` and
  `stencilStoreOp` MUST then be omitted.
- For a combined depth-and-stencil format, `depthReadOnly` MUST equal
  `stencilReadOnly`.
- A read-only depth or stencil aspect lets the pass sample that texture as a bound
  resource while still using it for testing, because no write occurs.

## Depth-stencil formats

| Format | Aspects | Notes |
|--------|---------|-------|
| `depth16unorm` | depth | 16-bit unorm depth; lowest precision, low memory |
| `depth24plus` | depth | At least 24-bit depth; the portable default for a pure depth buffer |
| `depth24plus-stencil8` | depth + stencil | At least 24-bit depth plus an 8-bit stencil |
| `depth32float` | depth | 32-bit float depth; high precision |
| `depth32float-stencil8` | depth + stencil | 32-bit float depth plus 8-bit stencil; gated behind the `depth32float-stencil8` device feature |

The depth texture is created with `device.createTexture` using one of these formats
and `GPUTextureUsage.RENDER_ATTACHMENT`. The pipeline declares the same format in
`depthStencil.format`. To use `depth32float-stencil8`, feature-detect on the adapter
and pass it in `requiredFeatures`:

```js
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("depth32float-stencil8")
    ? ["depth32float-stencil8"]
    : [],
});
```

## MSAA setup

MSAA (multisample anti-aliasing) requires the SAME `sampleCount` in three places.

1. The multisampled color texture:

```js
const msaaTexture = device.createTexture({
  size: [width, height],
  sampleCount: 4,
  format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
```

2. The render pipeline's `multisample` state:

```js
const pipeline = device.createRenderPipeline({
  // ... layout, vertex, fragment ...
  multisample: { count: 4 },
});
```

3. The color attachment, where the multisampled view is `view` and a single-sample
   view is `resolveTarget`:

```js
colorAttachments: [{
  view: msaaTexture.createView(),                       // sampleCount 4
  resolveTarget: context.getCurrentTexture().createView(), // sampleCount 1
  loadOp: "clear",
  storeOp: "store",
}]
```

`sampleCount` of 1 and 4 are the only universally supported values. A multisampled
depth texture used alongside the multisampled color texture MUST also use the same
`sampleCount`.

The deeper offscreen multi-pass and post-processing workflow is covered by
`webgpu-impl-multipass`.
