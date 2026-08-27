# WebGPU Pipeline Architecture

Conceptual model of WebGPU pipelines: how shader modules, render and compute pipelines, and pipeline layouts fit together, and how to choose auto layout versus an explicit layout. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

A pipeline is an immutable, pre-compiled object that fixes all shader code and fixed-function state for a GPU pass. Two kinds exist.

| Aspect | GPURenderPipeline | GPUComputePipeline |
|--------|-------------------|--------------------|
| Purpose | Rasterized graphics: draw triangles, lines, points to attachments | General-purpose parallel work over a dispatch grid |
| Created by | `device.createRenderPipeline(desc)` / `createRenderPipelineAsync(desc)` | `device.createComputePipeline(desc)` / `createComputePipelineAsync(desc)` |
| Shader stages | `vertex` (required) + `fragment` (optional) | `compute` (required) |
| Used inside | `GPURenderPassEncoder` via `setPipeline` then `draw`/`drawIndexed` | `GPUComputePassEncoder` via `setPipeline` then `dispatchWorkgroups` |
| Writes to | Color and depth/stencil attachments | Storage buffers and storage textures |

Three object types form the pipeline graph:

| Object | Created by | Role |
|--------|-----------|------|
| `GPUShaderModule` | `device.createShaderModule({ code })` | Compiled WGSL source; one module can host vertex, fragment, and compute entry points |
| `GPUPipelineLayout` | `device.createPipelineLayout({ bindGroupLayouts })` | Declares the bind-group-layout slots a pipeline uses; enables resource sharing |
| `GPURenderPipeline` / `GPUComputePipeline` | `device.createRenderPipeline*` / `createComputePipeline*` | Immutable compiled pipeline; bound per pass and reused every frame |

The `layout` field of any pipeline descriptor is EITHER a `GPUPipelineLayout` object OR the string `"auto"`. There is no third option.

## Decision Tree

### Auto layout versus explicit pipeline layout

```
Will any bind group be shared across more than one pipeline?
├── NO  (one pipeline owns its resources, e.g. a single full-screen pass)
│        → layout: "auto"
│          Read each bind-group layout back with pipeline.getBindGroupLayout(index)
│
└── YES (a camera/lights uniform, a shared texture, used by many pipelines)
         → Build an explicit GPUPipelineLayout
           1. device.createBindGroupLayout(...) for each shared group
           2. device.createPipelineLayout({ bindGroupLayouts: [...] })
           3. Pass that layout to every pipeline that shares the group
           Now one GPUBindGroup binds to all of them
```

### Synchronous versus async pipeline creation

```
Is this pipeline created during a frame the user is watching?
├── YES, or it compiles a heavy/complex shader during loading
│        → createRenderPipelineAsync / createComputePipelineAsync
│          await the Promise; compilation runs off the main thread
│
└── NO  (one-time startup, tiny shader, before the first frame)
         → createRenderPipeline / createComputePipeline is acceptable
```

## Core Patterns

### ALWAYS create pipelines once and reuse them

Pipeline creation compiles and validates shader code; it is expensive. Pipeline objects are immutable. ALWAYS create every pipeline during initialization or asset loading and store the reference. NEVER call `createRenderPipeline` or `createComputePipeline` inside the per-frame render loop.

```js
// Init time, once.
const pipeline = device.createRenderPipeline({ layout: "auto", vertex, fragment });

// Render loop, every frame: reuse the same object.
function frame() {
  const pass = encoder.beginRenderPass(passDesc);
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
}
```

### ALWAYS use an explicit GPUPipelineLayout for shared resources

A bind group created from `pipelineA.getBindGroupLayout(0)` is compatible ONLY with `pipelineA`. To bind one `GPUBindGroup` (camera uniforms, a shared texture) across multiple pipelines, ALWAYS build an explicit `GPUPipelineLayout` from explicit `GPUBindGroupLayout` objects and pass that same layout to every pipeline.

```js
const frameLayout = device.createBindGroupLayout({ entries: [/* camera uniform */] });
const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout] });

const opaquePipeline = device.createRenderPipeline({ layout: pipelineLayout, vertex, fragment: fragOpaque });
const wirePipeline   = device.createRenderPipeline({ layout: pipelineLayout, vertex, fragment: fragWire });

// One bind group, valid for both pipelines.
const frameGroup = device.createBindGroup({ layout: frameLayout, entries: [/* camera buffer */] });
```

### ALWAYS prefer the async pipeline variants during a live frame

`createRenderPipelineAsync` and `createComputePipelineAsync` return a `Promise` and compile the shader off the main thread. ALWAYS use them when a pipeline is built while frames are rendering, so shader compilation never blocks the main thread and causes visible jank.

```js
const pipeline = await device.createRenderPipelineAsync({ layout: "auto", vertex, fragment });
```

### ALWAYS match the fragment target format to the attachment format

Each entry in `fragment.targets` has a `format`. That format MUST equal the texture format of the corresponding color attachment in the render pass. For the canvas, both MUST be `navigator.gpu.getPreferredCanvasFormat()`. A mismatch fails pipeline or render-pass validation.

```js
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
const pipeline = device.createRenderPipeline({
  layout: "auto", vertex,
  fragment: { module, targets: [{ format }] }, // same `format` value
});
```

### ALWAYS inspect compilation messages during development

`module.getCompilationInfo()` returns a `Promise<GPUCompilationInfo>` whose `messages` array holds `GPUCompilationMessage` objects (`message`, `type`, `lineNum`, `linePos`). A WGSL error does not throw from `createShaderModule`; the module is created and the error surfaces here, and again at pipeline creation. ALWAYS log compilation info while developing.

```js
const module = device.createShaderModule({ code: wgsl });
for (const m of (await module.getCompilationInfo()).messages) {
  if (m.type === "error") console.error(`WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
}
```

### NEVER mix auto-layout bind groups between pipelines

Auto-generated bind-group layouts are pipeline-private. A `GPUBindGroup` built from one pipeline's `getBindGroupLayout` is rejected when set on a pass that uses a different pipeline. Use an explicit layout instead.

## Common Anti-Patterns

1. **Binding an auto-layout bind group to a different pipeline.** A bind group from `pipelineA.getBindGroupLayout(0)` set while `pipelineB` is bound fails validation, because each `"auto"` pipeline generates its own private bind-group layouts that are not interchangeable. Fix: build an explicit `GPUPipelineLayout` and share it.

2. **Calling synchronous `createRenderPipeline` for many heavy shaders during a frame.** Each synchronous call blocks the main thread while the shader compiles; doing this for several heavy pipelines mid-frame stalls rendering and produces visible jank. Fix: use `createRenderPipelineAsync` / `createComputePipelineAsync` and `await` them off the critical path.

3. **Recreating pipelines every frame.** Pipeline objects are immutable and expensive to compile; rebuilding them per frame burns CPU and re-runs validation needlessly. Fix: create once at init or load time, store the reference, and reuse it.

## Critical Warnings

- NEVER call `createRenderPipeline` or `createComputePipeline` inside the render loop. Create pipelines once and reuse the immutable object.
- NEVER bind a `GPUBindGroup` derived from `getBindGroupLayout` of one pipeline to a different pipeline. Auto-layout bind groups are not reusable.
- NEVER use synchronous pipeline creation for heavy shaders during a live frame. Use the async variants to avoid jank.
- NEVER let the `fragment.targets[i].format` differ from the matching render-pass attachment format. The mismatch fails validation.
- NEVER assume a WGSL syntax error throws from `createShaderModule`. The module is still returned; check `getCompilationInfo()` and expect the error at pipeline creation.
- NEVER pass anything other than a `GPUPipelineLayout` object or the string `"auto"` to the `layout` field.

## Reference Files

- `methods.md` — Signatures for `createShaderModule`, `createPipelineLayout`, `createRenderPipeline(Async)`, `createComputePipeline(Async)`, `getBindGroupLayout`, `getCompilationInfo`.
- `examples.md` — Verified pipeline-creation code: explicit layout, auto layout, async creation.
- `anti-patterns.md` — Pipeline mistakes with WHY-it-fails explanations.

## Related Skills

- `webgpu-syntax-render-pipeline` — Full `GPURenderPipelineDescriptor` field reference (vertex, primitive, depthStencil, multisample, fragment).
- `webgpu-syntax-compute-pipeline` — Full `GPUComputePipelineDescriptor` field reference.
- `webgpu-syntax-bind-groups` — `GPUBindGroupLayout` and `GPUBindGroup` entry shapes.
- `webgpu-impl-performance` — Frame-loop performance, including pipeline reuse and async loading.
