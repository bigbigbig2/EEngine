# WebGL to WebGPU Migration

Map every WebGL concept to its WebGPU equivalent and avoid the two ports that silently break: clip-space Z range and the removed automatic mipmap generation. Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

| WebGL concept | WebGPU equivalent |
|---|---|
| Immediate-mode `gl.draw*` against global state | Record commands into a `GPUCommandEncoder`, submit a `GPUCommandBuffer` via `queue.submit` |
| Global state machine (`gl.enable`, `gl.bindBuffer`, `gl.blendFunc`) | Immutable `GPURenderPipeline` capturing blend, topology, depth, cull state |
| GLSL shaders | WGSL shaders |
| Uniforms set by name (`gl.getUniformLocation`) | `GPUBindGroup` + `GPUBindGroupLayout`, positional `@group(g) @binding(b)` |
| Framebuffer objects (FBOs) | Render pass `colorAttachments` / `depthStencilAttachment` |
| `gl.getError()` synchronous | Asynchronous `pushErrorScope` / `popErrorScope` + `uncapturederror` event |
| `gl.generateMipmap()` | Manual mipmap generation (render-pass downsample chain or compute pass) |
| Resizable buffers/textures via re-upload | Immutable size/format; destroy and recreate the resource to resize |
| Uniform buffer 64 KB limit (`maxUniformBufferBindingSize` 65536) | Storage buffers (`maxStorageBufferBindingSize` 134217728, 128 MiB+) |
| `gl.viewport` / clip Z `[-1, 1]` | Clip Z `[0, 1]`; rebuild the projection matrix |
| `gl.texImage2D` upload | `queue.writeTexture` or `copyExternalImageToTexture` |

## Decision Tree

```
Porting a WebGL app to WebGPU?
├─ Goal is "render the same output, same draw structure"
│  └─ Direct port: translate each gl call to its mapping above.
│     WORKS, but keeps WebGL's per-object CPU cost. Acceptable
│     ONLY for small scenes or a first migration milestone.
│
├─ Goal is "gain WebGPU's performance"
│  └─ Restructure: sort draws by pipeline then bind group,
│     build pipelines once at load time, pack uniforms into one
│     buffer with dynamic offsets, record static scenes into
│     render bundles. See webgpu-impl-performance.
│
└─ Texture uses mipmaps in WebGL?
   └─ gl.generateMipmap has NO equivalent. Add an explicit
      mipmap generation pass (see Core Patterns) BEFORE the
      texture is sampled. See methods.md.
```

## Core Patterns

### ALWAYS rebuild the projection matrix for clip-space Z `[0, 1]`

WebGL clip space has Z in `[-1, 1]` (OpenGL convention). WebGPU clip space has Z in `[0, 1]` (Metal convention) and the framebuffer is Y-down. A WebGL projection matrix used unchanged in WebGPU places the entire scene in the wrong half of the depth range, so depth testing produces wrong results or nothing renders.

```js
// NEVER: a WebGL [-1, 1] gl-matrix perspective matrix used as-is in WebGPU.
mat4.perspective(proj, fovy, aspect, near, far);        // OpenGL [-1, 1] Z

// ALWAYS: use a [0, 1] Z projection. gl-matrix exposes the *ZO variant.
mat4.perspectiveZO(proj, fovy, aspect, near, far);      // WebGPU [0, 1] Z
mat4.orthoZO(proj, left, right, bottom, top, near, far);
```

### ALWAYS record commands into a `GPUCommandEncoder`, never expect immediate execution

WebGL's `gl.drawArrays` executes against global state immediately. WebGPU records into an encoder and runs nothing until `queue.submit`.

```js
const encoder = device.createCommandEncoder({ label: "frame" });
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),     // fresh every frame
    loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
  }],
});
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.setVertexBuffer(0, vertexBuffer);
pass.draw(3);
pass.end();                                             // NEVER omit end()
device.queue.submit([encoder.finish()]);                // nothing runs before this
```

### ALWAYS bind by position, never by name

WebGL resolves uniforms by name through `gl.getUniformLocation`. WebGPU matches `@group(g) @binding(b)` in WGSL to the `binding` index in the `GPUBindGroupLayout`. The shader and the layout MUST be kept in sync manually because no name lookup exists.

```js
// WGSL: @group(0) @binding(0) var<uniform> camera : Camera;
const layout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
});
const bindGroup = device.createBindGroup({
  layout,
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],   // index, not name
});
```

### ALWAYS treat buffers and textures as immutable, recreate to resize

WebGL re-uploads to grow a buffer. WebGPU buffers and textures have fixed `size` and `format` at creation. To resize, call `destroy()` and create a new resource.

```js
function resizeStorageBuffer(device, oldBuffer, newSize) {
  oldBuffer.destroy();                                  // free the old one
  return device.createBuffer({
    label: "particles", size: newSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}
```

### ALWAYS generate mipmaps with an explicit pass, `gl.generateMipmap` has no equivalent

WebGPU has no built-in mipmap generation. Create the texture with `mipLevelCount` and `RENDER_ATTACHMENT` usage, then render each smaller mip by sampling the previous mip. See methods.md and examples.md for the full downsample chain.

```js
const mipCount = 1 + Math.floor(Math.log2(Math.max(width, height)));
const texture = device.createTexture({
  size: [width, height], format: "rgba8unorm", mipLevelCount: mipCount,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
       | GPUTextureUsage.RENDER_ATTACHMENT,             // RENDER_ATTACHMENT is mandatory
});
// then run the downsample chain (examples.md)
```

### ALWAYS treat errors as asynchronous, never poll like `gl.getError`

WebGL's `gl.getError()` returns synchronously. WebGPU errors surface asynchronously through `popErrorScope` (a `Promise`) or the `uncapturederror` event. Errors are contagious: an object built from an invalid descriptor is itself invalid and every dependent operation fails.

```js
device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(descriptor);
const error = await device.popErrorScope();             // async, not synchronous
if (error) console.error("Pipeline invalid:", error.message);
```

## Common Anti-Patterns

1. **Directly translating WebGL's per-object `bindBuffer` + `draw` loop without restructuring.** It compiles and runs, but it keeps WebGL's per-object CPU cost and discards WebGPU's only advantage. Restructure into sorted draws, reused pipelines, and render bundles. See webgpu-impl-performance.

2. **Using a WebGL `[-1, 1]` projection matrix in WebGPU.** WebGPU clip-space Z is `[0, 1]`. A `[-1, 1]` matrix places geometry in the wrong depth half so depth testing fails and the scene renders wrong or blank. Use a `[0, 1]` (Metal-convention) projection.

3. **Expecting `gl.generateMipmap` to have an equivalent.** WebGPU has no automatic mipmap generation. A texture created with `mipLevelCount > 1` but no generation pass samples uninitialized higher mip levels and renders black or garbage at distance.

4. **Treating WebGPU errors as synchronous like `gl.getError`.** Polling for errors finds nothing because errors resolve asynchronously through `popErrorScope` or fire on the `uncapturederror` event later.

## Critical Warnings

- NEVER reuse a WebGL `[-1, 1]` projection matrix in WebGPU. Rebuild it for clip-space Z `[0, 1]`.
- NEVER create a mipmapped texture without `RENDER_ATTACHMENT` usage and a generation pass. `gl.generateMipmap` does not exist in WebGPU.
- NEVER match bindings by name. WebGPU bindings are positional; the WGSL `@binding` index and the `GPUBindGroupLayout` `binding` must agree exactly.
- NEVER expect `gl.draw*` semantics. Nothing runs until `queue.submit`, and a render pass MUST be closed with `pass.end()` before `encoder.finish()`.
- NEVER resize a `GPUBuffer` or `GPUTexture` in place. They are immutable; `destroy()` and recreate.
- NEVER poll for errors. WebGPU errors are asynchronous and contagious; use `pushErrorScope`/`popErrorScope`.

## Reference Files

- `methods.md` : full WebGL-to-WebGPU concept mapping table and manual mipmap generation methods.
- `examples.md` : a WebGL textured-quad pattern ported to WebGPU, plus a complete manual mipmap generation pass.
- `anti-patterns.md` : migration mistakes with WHY-it-fails explanations.

Cross-links: `webgpu-impl-performance` (restructure for speed, render bundles), `webgpu-syntax-render-pipeline` (pipeline state captured from global state), `webgpu-errors-validation` (asynchronous error scopes), `webgpu-syntax-textures` (texture creation, formats, samplers), `webgpu-impl-render-usecases` (full-screen quad, render workloads).
