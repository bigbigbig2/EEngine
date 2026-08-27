# WebGL to WebGPU: Concept Mapping and Methods

Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Verified against the W3C WebGPU specification and Chrome's "From WebGL to WebGPU" guide.

## Full concept mapping table

| WebGL concept | WebGL API | WebGPU equivalent | WebGPU API |
|---|---|---|---|
| Immediate-mode draw | `gl.drawArrays`, `gl.drawElements` | Recorded command, deferred submit | `encoder.beginRenderPass`, `pass.draw`, `pass.drawIndexed`, `queue.submit` |
| Global state machine | `gl.enable`, `gl.disable`, `gl.blendFunc`, `gl.cullFace`, `gl.depthFunc` | Immutable pipeline object | `device.createRenderPipeline({ primitive, depthStencil, fragment.targets[].blend, multisample })` |
| Shader program | `gl.createShader`, `gl.linkProgram` (GLSL) | Shader module (WGSL) | `device.createShaderModule({ code })` |
| Uniform by name | `gl.getUniformLocation`, `gl.uniform*` | Positional bind group | `device.createBindGroupLayout`, `device.createBindGroup`, `pass.setBindGroup` |
| Vertex attribute binding | `gl.vertexAttribPointer`, `gl.enableVertexAttribArray` | Vertex buffer layout in the pipeline | `vertex.buffers[].attributes[]` with `shaderLocation`, `offset`, `format` |
| Buffer | `gl.createBuffer`, `gl.bufferData` | GPU buffer with fixed size and usage | `device.createBuffer({ size, usage })`, `queue.writeBuffer` |
| Texture | `gl.createTexture`, `gl.texImage2D` | GPU texture with fixed size and format | `device.createTexture`, `queue.writeTexture`, `device.queue.copyExternalImageToTexture` |
| Framebuffer object (FBO) | `gl.createFramebuffer`, `gl.framebufferTexture2D` | Render pass attachments | `beginRenderPass({ colorAttachments, depthStencilAttachment })` |
| Default framebuffer (canvas) | the drawing buffer | Canvas context texture | `canvas.getContext("webgpu")`, `context.getCurrentTexture()` |
| Render to texture | bind FBO, draw | Pass `view` is an offscreen texture view | `colorAttachments[].view = offscreenTexture.createView()` |
| Mipmap generation | `gl.generateMipmap` | Manual generation pass (no built-in) | render-pass downsample chain or compute pass |
| Error query | `gl.getError` (synchronous) | Asynchronous error scopes and event | `device.pushErrorScope`, `device.popErrorScope`, `uncapturederror` event |
| Multisample | `gl.renderbufferStorageMultisample` | Pipeline + attachment sample count | `multisample.count: 4`, attachment `sampleCount: 4`, `resolveTarget` |
| Resize buffer/texture | re-call `gl.bufferData` / `gl.texImage2D` | Destroy and recreate (immutable) | `resource.destroy()` then `device.createBuffer`/`createTexture` |
| Large data store | uniform buffer (`MAX_UNIFORM_BLOCK_SIZE`) | Storage buffer | `GPUBufferUsage.STORAGE`, `maxStorageBufferBindingSize` 134217728 |
| Viewport / scissor | `gl.viewport`, `gl.scissor` | Pass encoder calls | `pass.setViewport`, `pass.setScissorRect` |
| Instanced draw | `gl.drawArraysInstanced` | Same call, `instanceCount` argument | `pass.draw(vertexCount, instanceCount)` |

## Clip-space and coordinate-system differences

| Axis / space | WebGL (OpenGL convention) | WebGPU (Metal convention) |
|---|---|---|
| Clip-space Z (NDC depth) | `[-1, 1]` | `[0, 1]` |
| Framebuffer Y direction | Y-up | Y-down |
| Clip-space Y | Y-up | Y-up |
| Texture coordinate origin | bottom-left | top-left |

Method for porting projection matrices:

- A perspective or orthographic matrix built for OpenGL maps near/far depth into `[-1, 1]`. WebGPU expects `[0, 1]`.
- `gl-matrix` provides `mat4.perspectiveZO`, `mat4.orthoZO`, `mat4.perspectiveFromFovZO` for the `[0, 1]` Z range. The default `mat4.perspective` and `mat4.ortho` produce `[-1, 1]` and MUST NOT be used unchanged in WebGPU.
- If a matrix library has no `ZO` variant, premultiply the projection by the depth-remap matrix `diag(1, 1, 0.5, 1)` with a `+0.5` translation on the Z row, which maps `[-1, 1]` to `[0, 1]`.
- The framebuffer Y-down convention means texture coordinates and screen-space UVs ported from WebGL may need a `1.0 - v` flip on the V coordinate when sampling, or a Y flip on the projection.

## Bind group correspondence

WebGL uniform locations are resolved by name at link time. WebGPU has no name lookup. The correspondence is purely positional:

- WGSL `@group(g) @binding(b)` declares the slot.
- `GPUBindGroupLayout` `entries[].binding` MUST equal `b`.
- `GPUBindGroup` `entries[].binding` MUST equal `b`.
- `pass.setBindGroup(g, bindGroup)` selects group index `g`.
- A mismatch between the WGSL `@binding` index and the layout `binding` is a validation error, never a silent name fallback.

Group a uniform block per `gl.uniformBlockBinding` into one `GPUBindGroup`. Per-object uniforms that WebGL set with many `gl.uniform*` calls map to a single uniform buffer written with `queue.writeBuffer`, and the per-object variation is driven by dynamic offsets on `setBindGroup`.

## Error model correspondence

| WebGL | WebGPU |
|---|---|
| `gl.getError()` returns an error code synchronously after each call | Errors resolve asynchronously |
| Poll after every suspect call | Bracket a suspect block with `pushErrorScope(filter)` / `popErrorScope()` |
| No error type categories beyond codes | `GPUValidationError`, `GPUOutOfMemoryError`, `GPUInternalError` |
| One error at a time | LIFO scope stack; uncaptured errors fire `uncapturederror` |

`filter` for `pushErrorScope` is `"validation"`, `"out-of-memory"`, or `"internal"`. `popErrorScope()` returns a `Promise<GPUError | null>`. See webgpu-errors-validation for the full error workflow.

## Manual mipmap generation methods

WebGPU removed `gl.generateMipmap`. Two methods generate the mip chain.

### Method A: render-pass downsample chain (the default)

Render each smaller mip level by sampling the previous (larger) mip level through a linear-filtering sampler in a full-screen pass.

Steps:

1. Create the destination texture with `mipLevelCount = 1 + floor(log2(max(width, height)))` and usage `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`. `RENDER_ATTACHMENT` is mandatory because each mip level is rendered into.
2. Upload or render the base level (mip 0).
3. Build a render pipeline whose vertex shader generates a full-screen triangle from `@builtin(vertex_index)` and whose fragment shader does `textureSample` of the source mip.
4. For each level `i` from 1 to `mipLevelCount - 1`:
   - Source view: `texture.createView({ baseMipLevel: i - 1, mipLevelCount: 1 })`.
   - Destination view: `texture.createView({ baseMipLevel: i, mipLevelCount: 1 })`.
   - Begin a render pass with the destination view as the single color attachment, `loadOp: "clear"`, `storeOp: "store"`.
   - Bind a bind group containing the source view and a linear sampler, draw 3 vertices.
   - End the pass.
5. Submit one command buffer containing all the per-level passes.

The sampler MUST use `minFilter: "linear"` and `magFilter: "linear"` so each downsample averages four texels. The full code is in references/examples.md.

### Method B: compute pass

A `@compute` shader reads the previous mip with `textureLoad` (or a sampler) and writes the current mip with `textureStore` into a `storageTexture` bound with `access: "write-only"`. The texture needs `STORAGE_BINDING` usage instead of `RENDER_ATTACHMENT`. Method B avoids a render pipeline but requires a storage-capable format and one `dispatchWorkgroups` per level. Method A is the portable default; use Method B only when the texture is already part of a compute workflow.

### When mipmaps are needed

Generate mipmaps for any texture sampled at varying distance or scale (albedo, normal, environment maps). Skip generation for render targets sampled 1:1, single-mip lookup tables, and depth textures. A texture created with `mipLevelCount > 1` but no generation pass samples uninitialized levels and renders black or aliased at distance.

## Reference URLs

- https://developer.chrome.com/blog/from-webgl-to-webgpu
- https://www.w3.org/TR/webgpu/
- https://developer.mozilla.org/en-US/docs/Web/API/GPUTexture/createView
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/beginRenderPass
