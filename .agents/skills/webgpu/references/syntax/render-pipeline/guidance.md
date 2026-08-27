# WebGPU Render Pipeline

Create an immutable `GPURenderPipeline` that captures vertex layout, fragment
targets, blending, primitive topology, and depth-stencil state without triggering
WebGPU pipeline-creation validation errors.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

`device.createRenderPipeline(descriptor)` returns a `GPURenderPipeline`.
`device.createRenderPipelineAsync(descriptor)` returns `Promise<GPURenderPipeline>`
and compiles off the content timeline.

| Descriptor field | Required | Purpose |
|------------------|----------|---------|
| `label` | No | Diagnostic name quoted in `GPUError` messages |
| `layout` | Yes | `GPUPipelineLayout` or the string `"auto"` |
| `vertex` | Yes | Vertex stage: shader module, entry point, vertex buffer layouts |
| `primitive` | No | Topology, strip index format, winding, cull mode |
| `depthStencil` | No | Depth-stencil attachment format and test/write state |
| `multisample` | No | MSAA sample count, coverage mask |
| `fragment` | No | Fragment stage: shader module, entry point, color targets |

`vertex` is `{ module, entryPoint?, constants?, buffers? }`. `buffers` is an array
of `GPUVertexBufferLayout`: `{ arrayStride, stepMode?, attributes }`. Each
attribute is `{ shaderLocation, offset, format }`.

`fragment` is `{ module, entryPoint?, constants?, targets }`. Each target is
`{ format, blend?, writeMask? }`. `blend` is `{ color, alpha }` with each side
`{ srcFactor?, dstFactor?, operation? }`.

`primitive` is `{ topology?, stripIndexFormat?, frontFace?, cullMode? }`.
`depthStencil` is `{ format, depthWriteEnabled?, depthCompare?, stencilFront?,
stencilBack?, stencilReadMask?, stencilWriteMask?, depthBias?, depthBiasSlopeScale?,
depthBiasClamp? }`. `multisample` is `{ count?, mask?, alphaToCoverageEnabled? }`.

The `layout` field is `"auto"` (implicit per-pipeline layouts) or an explicit
`GPUPipelineLayout`. See `webgpu-core-pipeline-architecture` for the layout choice.

Full field tables, every enum value, and defaults: see `methods.md`.

## Decision Tree

### Vertex data: vertex buffers or vertex-pulling

```
Drawing a fixed-size full-screen pass (3 vertices)?
  YES -> generate vertices in WGSL from @builtin(vertex_index); omit vertex.buffers
  NO  -> need per-vertex mesh data
         Data accessed only as sequential vertex stream?
           YES -> vertex.buffers with GPUVertexBufferLayout entries
           NO (random index, compute reads same data) -> bind as storage buffer
               and read via @builtin(vertex_index) in WGSL (vertex-pulling)
```

### Blend setup

```
Fragment output fully replaces the target (opaque geometry)?
  YES -> omit blend entirely on the target
  NO  -> alpha-composite over existing pixels
         Source alpha already multiplied into RGB (premultiplied)?
           YES -> color { srcFactor "one", dstFactor "one-minus-src-alpha" }
           NO  -> color { srcFactor "src-alpha", dstFactor "one-minus-src-alpha" }
         alpha { srcFactor "one", dstFactor "one-minus-src-alpha", operation "add" }
```

### Depth setup

```
Pipeline draws into a render pass that has a depthStencilAttachment?
  NO  -> omit depthStencil entirely
  YES -> set depthStencil.format to the EXACT depth attachment texture format
         Geometry should occlude what is behind it?
           YES -> depthWriteEnabled true, depthCompare "less"
           NO (transparent overlay, read-only depth) -> depthWriteEnabled false,
               depthCompare "less-equal", and depthReadOnly true on the attachment
```

## Core Patterns

### ALWAYS match the fragment target format to the color attachment format

The `format` of each `fragment.targets[i]` MUST equal the `GPUTextureView` format
of `colorAttachments[i]` in the render pass. For the canvas, ALWAYS use the value
from `navigator.gpu.getPreferredCanvasFormat()` for both.

```js
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
const pipeline = device.createRenderPipeline({
  label: "triangle",
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
});
```

### ALWAYS match vertex attribute offset and shaderLocation to the WGSL @location

Each attribute `shaderLocation` MUST equal a WGSL `@location(n)` on a vertex-stage
input. The `offset` is the byte offset of that attribute inside one vertex; the
`format` component count and type MUST match the WGSL type. `arrayStride` is the
total byte size of one vertex.

```js
// WGSL: @vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f)
vertex: {
  module, entryPoint: "vs",
  buffers: [{
    arrayStride: 20, // 3*4 + 2*4
    attributes: [
      { shaderLocation: 0, offset: 0,  format: "float32x3" },
      { shaderLocation: 1, offset: 12, format: "float32x2" },
    ],
  }],
}
```

### ALWAYS set depthStencil.format to the depth attachment's exact texture format

If the render pass has a `depthStencilAttachment`, the pipeline MUST declare
`depthStencil` with a `format` equal to that depth texture's format. NEVER omit
`depthStencil` when the pass uses a depth attachment.

```js
depthStencil: {
  format: "depth24plus",
  depthWriteEnabled: true,
  depthCompare: "less",
}
```

### ALWAYS create the pipeline once and reuse it every frame

`GPURenderPipeline` objects are immutable and expensive to build. Create them at
load time and reuse the same object across all frames. NEVER call
`createRenderPipeline` inside `requestAnimationFrame`.

### ALWAYS set stripIndexFormat for strip topologies used with indexed draws

When `topology` is `"line-strip"` or `"triangle-strip"` AND the pipeline is used
with `drawIndexed`, `stripIndexFormat` MUST be set and MUST equal the index
format passed to `setIndexBuffer` (`"uint16"` or `"uint32"`). For list topologies,
omit `stripIndexFormat`.

### ALWAYS keep multisample.count equal to the attachment sampleCount

`multisample.count` MUST equal the `sampleCount` of every color and depth
attachment texture. Valid values are 1 and 4. A mismatch fails pipeline or
render-pass validation.

## Common Anti-Patterns

### Fragment target format not matching the attachment format

NEVER hardcode `"bgra8unorm"` for a canvas target. The preferred canvas format is
platform-dependent. WHY it fails: pipeline creation succeeds, but `beginRenderPass`
or the draw call fails validation because the pipeline target format does not equal
the color attachment view format, producing a blank canvas or a validation error.

### Vertex attribute offset or shaderLocation not matching WGSL

NEVER set `offset`, `shaderLocation`, or `format` without checking the WGSL vertex
input. WHY it fails: a `shaderLocation` with no matching WGSL `@location` fails
validation; a wrong `offset` or `format` reads the wrong bytes and the mesh renders
as garbage geometry with no error.

### Recreating the pipeline every frame

NEVER call `createRenderPipeline` inside the render loop. WHY it fails: it is not a
validation error, but each call recompiles and re-validates shader and state,
causing severe per-frame jank and dropped frames.

## Critical Warnings

- NEVER omit `depthStencil` when the render pass has a `depthStencilAttachment`;
  the pipeline-versus-attachment depth mismatch fails validation.
- NEVER set `depthStencil.format` to a value different from the depth attachment
  texture format.
- NEVER set a `fragment.targets[i].format` that differs from the matching
  `colorAttachments[i]` view format.
- NEVER use a strip topology with `drawIndexed` without a matching
  `stripIndexFormat`.
- NEVER set `multisample.count` to a value other than the attachment `sampleCount`.
- NEVER call `device.queue` as a function; it is a read-only property.
- NEVER reuse an `"auto"`-layout bind group across pipelines; it binds to the one
  pipeline that produced its layout.

## Reference Files

- `methods.md` : complete `GPURenderPipelineDescriptor` field tables,
  `GPUVertexBufferLayout`, `GPUBlendState`, and every enum value with defaults.
- `examples.md` : verified working code for a minimal triangle pipeline
  and a pipeline with vertex buffers, blending, and depth.
- `anti-patterns.md` : pipeline mistakes with WHY-it-fails explanations.

Related skills: `webgpu-core-pipeline-architecture` (layout choice, immutability),
`webgpu-syntax-bind-groups` (explicit layouts and resource binding),
`webgpu-wgsl-vertex-shaders` (vertex stage and `@location` matching),
`webgpu-wgsl-fragment-shaders` (fragment outputs and MRT),
`webgpu-impl-render-targets` (render pass attachments and formats).
