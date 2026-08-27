# GPURenderPipelineDescriptor: Complete Reference

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Verified against the
W3C WebGPU specification (https://www.w3.org/TR/webgpu/) and MDN
`GPUDevice/createRenderPipeline`.

## Creation methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `createRenderPipeline` | `device.createRenderPipeline(descriptor)` -> `GPURenderPipeline` | Synchronous; validates and compiles on the content timeline |
| `createRenderPipelineAsync` | `device.createRenderPipelineAsync(descriptor)` -> `Promise<GPURenderPipeline>` | Compiles off the content timeline; rejects with `GPUPipelineError` on failure |
| `getBindGroupLayout` | `pipeline.getBindGroupLayout(index)` -> `GPUBindGroupLayout` | Retrieves an implicit layout when `layout` was `"auto"` |

`GPURenderPipeline` objects are immutable. The `label` property is read-only.

## GPURenderPipelineDescriptor

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `label` | `string` | No | `""` |
| `layout` | `GPUPipelineLayout` or `"auto"` | Yes | none |
| `vertex` | `GPUVertexState` | Yes | none |
| `primitive` | `GPUPrimitiveState` | No | see primitive defaults |
| `depthStencil` | `GPUDepthStencilState` | No | none (no depth-stencil attachment) |
| `multisample` | `GPUMultisampleState` | No | `{ count: 1, mask: 0xFFFFFFFF, alphaToCoverageEnabled: false }` |
| `fragment` | `GPUFragmentState` | No | none (no color output, depth-only pass) |

The `layout` field is either a `GPUPipelineLayout` from
`device.createPipelineLayout({ bindGroupLayouts: [...] })` or the string `"auto"`.
With `"auto"`, implicit bind-group layouts are generated and retrieved via
`pipeline.getBindGroupLayout(index)`. Auto-layout bind groups are NOT reusable
across pipelines. Layout selection is covered in
`webgpu-core-pipeline-architecture`.

## GPUVertexState (vertex)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `module` | `GPUShaderModule` | Yes | none |
| `entryPoint` | `string` | No | the single `@vertex` entry point if exactly one exists |
| `constants` | `Record<string, number>` | No | `{}` |
| `buffers` | `(GPUVertexBufferLayout or null)[]` | No | `[]` |

`constants` supplies values for WGSL pipeline-overridable constants (`override`).
A `null` entry in `buffers` declares an unused vertex buffer slot.

### GPUVertexBufferLayout

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `arrayStride` | `number` (bytes) | Yes | none |
| `stepMode` | `"vertex"` or `"instance"` | No | `"vertex"` |
| `attributes` | `GPUVertexAttribute[]` | Yes | none |

`arrayStride` is the byte distance between consecutive structures in the buffer.
`stepMode "vertex"` advances per vertex; `"instance"` advances per instance.

### GPUVertexAttribute

| Field | Type | Required |
|-------|------|----------|
| `shaderLocation` | `number` | Yes |
| `offset` | `number` (bytes from structure start) | Yes |
| `format` | `GPUVertexFormat` | Yes |

`shaderLocation` MUST match a WGSL `@location(n)` on a vertex-stage input.
`offset` plus the format size MUST not exceed `arrayStride`.

### GPUVertexFormat values

Naming pattern: `{type}{bits}` plus optional `x{components}`. `unorm`/`snorm`
are normalized integers decoded to floats; `uint`/`sint` stay integers; `float`
is floating-point. Byte size = bits/8 times component count.

| Format | Bytes | WGSL type |
|--------|-------|-----------|
| `uint8` | 1 | `u32` |
| `uint8x2` | 2 | `vec2<u32>` |
| `uint8x4` | 4 | `vec4<u32>` |
| `sint8` | 1 | `i32` |
| `sint8x2` | 2 | `vec2<i32>` |
| `sint8x4` | 4 | `vec4<i32>` |
| `unorm8` | 1 | `f32` |
| `unorm8x2` | 2 | `vec2<f32>` |
| `unorm8x4` | 4 | `vec4<f32>` |
| `snorm8` | 1 | `f32` |
| `snorm8x2` | 2 | `vec2<f32>` |
| `snorm8x4` | 4 | `vec4<f32>` |
| `uint16` | 2 | `u32` |
| `uint16x2` | 4 | `vec2<u32>` |
| `uint16x4` | 8 | `vec4<u32>` |
| `sint16` | 2 | `i32` |
| `sint16x2` | 4 | `vec2<i32>` |
| `sint16x4` | 8 | `vec4<i32>` |
| `unorm16` | 2 | `f32` |
| `unorm16x2` | 4 | `vec2<f32>` |
| `unorm16x4` | 8 | `vec4<f32>` |
| `snorm16` | 2 | `f32` |
| `snorm16x2` | 4 | `vec2<f32>` |
| `snorm16x4` | 8 | `vec4<f32>` |
| `float16` | 2 | `f32` |
| `float16x2` | 4 | `vec2<f32>` |
| `float16x4` | 8 | `vec4<f32>` |
| `float32` | 4 | `f32` |
| `float32x2` | 8 | `vec2<f32>` |
| `float32x3` | 12 | `vec3<f32>` |
| `float32x4` | 16 | `vec4<f32>` |
| `uint32` | 4 | `u32` |
| `uint32x2` | 8 | `vec2<u32>` |
| `uint32x3` | 12 | `vec3<u32>` |
| `uint32x4` | 16 | `vec4<u32>` |
| `sint32` | 4 | `i32` |
| `sint32x2` | 8 | `vec2<i32>` |
| `sint32x3` | 12 | `vec3<i32>` |
| `sint32x4` | 16 | `vec4<i32>` |
| `unorm10-10-10-2` | 4 | `vec4<f32>` |
| `unorm8x4-bgra` | 4 | `vec4<f32>` |

The single-component 8-bit and 16-bit formats (`uint8`, `unorm16`, `float16`, and
their siblings) require WebGPU 1.0-stable; older drafts only had the `x2`/`x4`
variants. `unorm8x4-bgra` reads the four bytes in BGRA order.

## GPUPrimitiveState (primitive)

| Field | Type | Default |
|-------|------|---------|
| `topology` | `GPUPrimitiveTopology` | `"triangle-list"` |
| `stripIndexFormat` | `GPUIndexFormat` | none |
| `frontFace` | `"ccw"` or `"cw"` | `"ccw"` |
| `cullMode` | `"none"`, `"front"`, or `"back"` | `"none"` |
| `unclippedDepth` | `boolean` | `false` (requires `depth-clip-control` feature) |

`GPUPrimitiveTopology` values: `"point-list"`, `"line-list"`, `"line-strip"`,
`"triangle-list"`, `"triangle-strip"`.

`GPUIndexFormat` values: `"uint16"`, `"uint32"`.

`stripIndexFormat` is required when `topology` is `"line-strip"` or
`"triangle-strip"` AND the pipeline is used with `drawIndexed`; it MUST equal the
index format given to `setIndexBuffer`. For list topologies, omit it.

`frontFace` sets which winding is the front face. `cullMode` discards back-facing
or front-facing triangles; `"none"` draws both.

## GPUDepthStencilState (depthStencil)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `format` | `GPUTextureFormat` (depth or depth-stencil) | Yes | none |
| `depthWriteEnabled` | `boolean` | Required if `format` has a depth aspect | none |
| `depthCompare` | `GPUCompareFunction` | Required if `format` has a depth aspect | none |
| `stencilFront` | `GPUStencilFaceState` | No | all-default face state |
| `stencilBack` | `GPUStencilFaceState` | No | all-default face state |
| `stencilReadMask` | `number` | No | `0xFFFFFFFF` |
| `stencilWriteMask` | `number` | No | `0xFFFFFFFF` |
| `depthBias` | `number` | No | `0` |
| `depthBiasSlopeScale` | `number` | No | `0` |
| `depthBiasClamp` | `number` | No | `0` |

Depth-or-stencil formats: `"depth16unorm"`, `"depth24plus"`,
`"depth24plus-stencil8"`, `"depth32float"`, `"depth32float-stencil8"`. The last
requires the `depth32float-stencil8` device feature. `"depth24plus"` is the
portable default for a pure depth buffer.

When `format` has a depth aspect, both `depthWriteEnabled` and `depthCompare` MUST
be specified. `depthWriteEnabled true` writes the fragment depth into the buffer;
`false` makes depth read-only for this pipeline.

### GPUStencilFaceState (stencilFront / stencilBack)

| Field | Type | Default |
|-------|------|---------|
| `compare` | `GPUCompareFunction` | `"always"` |
| `failOp` | `GPUStencilOperation` | `"keep"` |
| `depthFailOp` | `GPUStencilOperation` | `"keep"` |
| `passOp` | `GPUStencilOperation` | `"keep"` |

`failOp` runs when the stencil test fails; `depthFailOp` runs when stencil passes
but depth fails; `passOp` runs when both pass.

`GPUStencilOperation` values: `"keep"`, `"zero"`, `"replace"`, `"invert"`,
`"increment-clamp"`, `"increment-wrap"`, `"decrement-clamp"`, `"decrement-wrap"`.

`GPUCompareFunction` values (used by `depthCompare` and stencil `compare`):
`"never"`, `"less"`, `"equal"`, `"less-equal"`, `"greater"`, `"not-equal"`,
`"greater-equal"`, `"always"`.

## GPUMultisampleState (multisample)

| Field | Type | Default |
|-------|------|---------|
| `count` | `number` | `1` |
| `mask` | `number` | `0xFFFFFFFF` |
| `alphaToCoverageEnabled` | `boolean` | `false` |

`count` MUST equal the `sampleCount` of every attachment texture. Valid values are
1 and 4. `mask` is a sample coverage bitmask. `alphaToCoverageEnabled` derives a
coverage mask from the fragment alpha; it is valid only when `count` is greater
than 1.

## GPUFragmentState (fragment)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `module` | `GPUShaderModule` | Yes | none |
| `entryPoint` | `string` | No | the single `@fragment` entry point if exactly one exists |
| `constants` | `Record<string, number>` | No | `{}` |
| `targets` | `(GPUColorTargetState or null)[]` | Yes | none |

A `null` target entry declares an unused color attachment slot.

### GPUColorTargetState (each entry of targets)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `format` | `GPUTextureFormat` | Yes | none |
| `blend` | `GPUBlendState` | No | none (output replaces the target) |
| `writeMask` | `GPUColorWriteFlags` | No | `GPUColorWrite.ALL` |

`format` MUST equal the texture format of the matching `colorAttachments[i]` view
in the render pass. The number of `targets` MUST equal the number of color
attachments.

`writeMask` is a bitmask of `GPUColorWrite` flags combined with `|`:
`GPUColorWrite.RED`, `GPUColorWrite.GREEN`, `GPUColorWrite.BLUE`,
`GPUColorWrite.ALPHA`, `GPUColorWrite.ALL`.

### GPUBlendState

| Field | Type | Required |
|-------|------|----------|
| `color` | `GPUBlendComponent` | Yes |
| `alpha` | `GPUBlendComponent` | Yes |

`color` blends the RGB channels; `alpha` blends the alpha channel separately.

### GPUBlendComponent (color / alpha)

| Field | Type | Default |
|-------|------|---------|
| `operation` | `GPUBlendOperation` | `"add"` |
| `srcFactor` | `GPUBlendFactor` | `"one"` |
| `dstFactor` | `GPUBlendFactor` | `"zero"` |

Blend result = `(srcColor * srcFactor) operation (dstColor * dstFactor)`.

`GPUBlendOperation` values: `"add"`, `"subtract"`, `"reverse-subtract"`,
`"min"`, `"max"`. With `"min"` and `"max"` the factors are ignored.

`GPUBlendFactor` values: `"zero"`, `"one"`, `"src"`, `"one-minus-src"`,
`"src-alpha"`, `"one-minus-src-alpha"`, `"dst"`, `"one-minus-dst"`,
`"dst-alpha"`, `"one-minus-dst-alpha"`, `"src-alpha-saturated"`, `"constant"`,
`"one-minus-constant"`, `"src1"`, `"one-minus-src1"`, `"src1-alpha"`,
`"one-minus-src1-alpha"`. The four `src1*` factors require the
`dual-source-blending` device feature. `"constant"` and `"one-minus-constant"`
use the value set by `passEncoder.setBlendConstant(color)`.

## GPUTextureFormat (common render target formats)

8-bit color: `"rgba8unorm"`, `"rgba8unorm-srgb"`, `"bgra8unorm"`,
`"bgra8unorm-srgb"`. Float color: `"rgba16float"`, `"r16float"`,
`"rgba32float"`, `"r32float"`. The canvas format MUST come from
`navigator.gpu.getPreferredCanvasFormat()`.

## Reference sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification, render pipeline,
  vertex state, depth-stencil state, blend state, vertex formats)
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipeline
- `docs/research/vooronderzoek-webgpu.md` PART A section 3 (Pipeline Architecture)
