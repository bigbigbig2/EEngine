# WebGL to WebGPU Migration: Anti-Patterns

Each entry states the mistake, WHY it fails, and the fix. Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## 1. Directly translating the WebGL per-object `bindBuffer` + `draw` loop without restructuring

```js
// ANTI-PATTERN: a one-to-one port of the WebGL draw loop.
for (const obj of scene) {
  pass.setBindGroup(0, obj.bindGroup);
  pass.setVertexBuffer(0, obj.vertexBuffer);
  pass.setPipeline(obj.pipeline);            // pipeline switch per object
  pass.draw(obj.vertexCount);
}
```

WHY IT FAILS: the port compiles and renders correctly, so the failure is silent. WebGL's value comes from a thin driver; WebGPU's value comes from cheap command replay and reduced state churn. A literal per-object translation keeps WebGL's per-object CPU submission cost and gains nothing. Switching pipeline and bind group per object is the most expensive thing a render pass does.

FIX: restructure. Sort draws by pipeline, then by bind group, so identical state is set once for many draws. Build every `GPURenderPipeline` and `GPUBindGroup` once at load time. Pack per-object uniforms into one buffer and select per object with dynamic offsets on `setBindGroup`. Record static or mostly-static scenes into a `GPURenderBundle` and replay it. See webgpu-impl-performance.

## 2. Using a WebGL `[-1, 1]` projection matrix in WebGPU

```js
// ANTI-PATTERN: an OpenGL-convention projection used unchanged in WebGPU.
mat4.perspective(proj, fovy, aspect, 0.1, 100.0);   // maps Z to [-1, 1]
device.queue.writeBuffer(cameraBuffer, 0, proj);
```

WHY IT FAILS: WebGL clip-space Z is `[-1, 1]` (OpenGL convention); WebGPU clip-space Z is `[0, 1]` (Metal convention). A `[-1, 1]` matrix sends every vertex's depth into a range that WebGPU rasterizes incorrectly. Geometry with NDC Z below 0 is clipped away, the rest occupies a compressed depth range, and `depthCompare: "less"` produces wrong occlusion. The scene renders blank, partially clipped, or with broken depth sorting. There is no error, only wrong pixels.

FIX: build the projection for `[0, 1]` Z. With `gl-matrix` use `mat4.perspectiveZO` and `mat4.orthoZO` instead of `mat4.perspective` and `mat4.ortho`. If the matrix library has no `ZO` variant, premultiply by a depth-remap matrix that maps `[-1, 1]` to `[0, 1]`. The framebuffer is also Y-down in WebGPU, so flip the V texture coordinate or the projection Y as needed.

## 3. Expecting `gl.generateMipmap` to have an equivalent

```js
// ANTI-PATTERN: a mipmapped texture created with no generation step.
const texture = device.createTexture({
  size: [1024, 1024], format: "rgba8unorm",
  mipLevelCount: 11,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});
device.queue.writeTexture({ texture }, pixels, { bytesPerRow: 4096 }, [1024, 1024]);
// no mipmap generation -> levels 1..10 are uninitialized
```

WHY IT FAILS: WebGPU has no built-in mipmap generation. `gl.generateMipmap` does not exist and has no direct equivalent. `queue.writeTexture` writes only mip level 0. Levels 1 through 10 are left uninitialized. When the texture is minified, the sampler reads those empty levels and the surface renders black, transparent, or visibly aliased at distance. The texture also lacks `RENDER_ATTACHMENT` usage, so even adding a render-based generation pass later fails validation.

FIX: create the texture with `RENDER_ATTACHMENT` usage and run an explicit mipmap generation pass after uploading mip 0. Render each smaller mip by sampling the previous mip with a linear sampler in a full-screen pass, or use a compute pass with `textureStore`. See references/methods.md and references/examples.md.

## 4. Treating WebGPU errors as synchronous like `gl.getError`

```js
// ANTI-PATTERN: polling for errors the WebGL way.
const pipeline = device.createRenderPipeline(descriptor);
const err = device.popErrorScope();          // no scope was pushed
if (err) console.error(err);                 // err is a Promise, always truthy
```

WHY IT FAILS: WebGL's `gl.getError()` returns a value synchronously right after the failing call. WebGPU errors are asynchronous: `popErrorScope()` returns a `Promise<GPUError | null>`, not an error object. Calling `popErrorScope()` without a matching `pushErrorScope()` is itself a validation error. Treating the returned Promise as a truthy error logs noise for every call and never reveals the real error message. Real validation failures surface later through the `uncapturederror` event or an unawaited Promise, after the call site is long gone.

FIX: bracket the suspect operation with `device.pushErrorScope("validation")` before and `await device.popErrorScope()` after, and inspect the resolved value. Add an `uncapturederror` event listener as a last-resort telemetry channel only. Errors are contagious: an object built from an invalid descriptor is invalid and every dependent operation fails, so the first reported error is the root cause. See webgpu-errors-validation.

## 5. Resizing a buffer or texture in place

```js
// ANTI-PATTERN: trying to grow a WebGPU buffer like gl.bufferData.
device.queue.writeBuffer(particleBuffer, 0, largerData);   // larger than the buffer
```

WHY IT FAILS: WebGL re-specifies a buffer's store with another `gl.bufferData` call. WebGPU buffers and textures have a fixed `size` and `format` set at `createBuffer` / `createTexture`. Writing past the allocated size is a validation error; there is no in-place resize.

FIX: call `resource.destroy()` on the old buffer or texture and create a new one with the new size. If old contents must survive, `copyBufferToBuffer` or `copyTextureToTexture` into the new resource before destroying the old one. Plan capacity ahead for resources that grow each frame.

## 6. Caching `context.getCurrentTexture()` across frames

```js
// ANTI-PATTERN: WebGL had one persistent drawing buffer, so cache the view.
const canvasView = context.getCurrentTexture().createView();   // cached once
function frame() {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: canvasView, loadOp: "clear", storeOp: "store" }],
  });
}
```

WHY IT FAILS: WebGL's default framebuffer is one persistent drawing buffer. WebGPU's canvas context rotates through a set of swap-chain textures; `getCurrentTexture()` returns a different texture each frame. A cached view targets a texture that is no longer the presentable one, producing a black canvas or a validation error that the texture is in use.

FIX: call `context.getCurrentTexture().createView()` fresh at the start of every frame. See webgpu-impl-render-usecases.

## 7. Assuming GLSL semantics carry over to WGSL unchanged

WHY IT FAILS: WGSL is not GLSL with renamed keywords. Differences that break a literal translation: WGSL entry points are marked `@vertex` / `@fragment` / `@compute` and cannot be called as helpers; uniforms and textures are module-scope `var` with `@group`/`@binding`; the vertex position output is `@builtin(position)`; integer inter-stage variables require `@interpolate(flat)`; texture sampling is `textureSample`, not `texture()`; matrices are column-major; `vec3` aligns to 16 bytes in uniform buffers. A direct GLSL-to-WGSL text substitution produces shader-creation errors or wrong memory layout.

FIX: rewrite shaders against the WGSL specification, not by find-and-replace. Match every `@binding` index to the bind group layout. Account for `vec3` 16-byte alignment when mapping a host struct to a WGSL `uniform` struct.

## Reference URLs

- https://developer.chrome.com/blog/from-webgl-to-webgpu
- https://www.w3.org/TR/webgpu/
- https://www.w3.org/TR/WGSL/
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/getCurrentTexture
