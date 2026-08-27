# WebGPU Debugging: Anti-Patterns

Common debugging mistakes, each with a WHY-it-fails explanation and the fix. Applies to
WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## 1. Shipping Descriptors With No Label

### The mistake

Creating buffers, textures, pipelines, bind groups, shader modules, and command encoders
without setting the `label` field, leaving it at its empty-string default.

```javascript
// WRONG: no label.
const texture = device.createTexture({
  size: [1024, 1024],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING,
});
```

### Why it fails

`GPUError.message` references objects by their `label`. With no label, the implementation
can only emit `a texture` or `a buffer`. A real frame creates dozens of textures and
buffers, so a message like `usage of a texture is invalid` does not identify which one.
A 30-second fix becomes a guessing game across every creation call in the codebase.

### The fix

ALWAYS set a descriptive `label` on every descriptor. Name the object by its role.

```javascript
// CORRECT: labeled with a role-identifying name.
const texture = device.createTexture({
  label: "lightmap-atlas",
  size: [1024, 1024],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING,
});
```

The message now reads `usage of texture "lightmap-atlas" is invalid`, which points
straight at the failing object.

## 2. Ignoring getCompilationInfo After createShaderModule

### The mistake

Calling `device.createShaderModule({ code })` and immediately passing the module to
`createRenderPipeline` or `createComputePipeline` without calling `getCompilationInfo()`.

```javascript
// WRONG: no compilation check.
const module = device.createShaderModule({ label: "main-shader", code: wgsl });
const pipeline = device.createRenderPipeline({ /* ... uses module ... */ });
```

### Why it fails

`createShaderModule` does NOT throw on a WGSL syntax or type error. It returns a module
that may be invalid. The WGSL error then surfaces only as an opaque pipeline-creation
failure with a generic message and no source location. The actual line and column of the
WGSL mistake are lost, so a one-character typo in a shader becomes hours of blind
bisecting.

### The fix

ALWAYS call `module.getCompilationInfo()` immediately after `createShaderModule` and
treat any `type === "error"` message as a hard failure. NEVER build a pipeline from a
module that produced an error.

```javascript
// CORRECT: check compilation info first.
const module = device.createShaderModule({ label: "main-shader", code: wgsl });
const info = await module.getCompilationInfo();
const errors = info.messages.filter((m) => m.type === "error");
for (const m of errors) {
  console.error(`WGSL error at ${m.lineNum}:${m.linePos} - ${m.message}`);
}
if (errors.length > 0) {
  throw new Error('Shader "main-shader" failed WGSL compilation.');
}
```

Each `GPUCompilationMessage` carries the exact `lineNum` and `linePos`, so the error
points straight at the offending WGSL.

## 3. Not Using Debug Groups So Captures Are Unreadable

### The mistake

Encoding every render and compute pass without `pushDebugGroup` / `popDebugGroup` or
`insertDebugMarker`, then taking a GPU frame capture.

```javascript
// WRONG: no annotations on the command stream.
const shadowPass = encoder.beginRenderPass(shadowDescriptor);
shadowPass.draw(shadowVertexCount);
shadowPass.end();
const colorPass = encoder.beginRenderPass(colorDescriptor);
colorPass.draw(sceneVertexCount);
colorPass.end();
```

### Why it fails

A GPU frame capture in RenderDoc or PIX shows the raw command stream. Without debug
groups, the capture is a flat, unlabeled list of draw calls with no phase boundaries.
There is no way to tell where the shadow pass ends and the color pass begins, which
makes it slow to locate the draw that produced a visual artifact.

### The fix

ALWAYS wrap each pass or logical phase in a `pushDebugGroup` / `popDebugGroup` pair, and
use `insertDebugMarker` for one-off landmarks. Every `pushDebugGroup` MUST be matched by
exactly one `popDebugGroup` on the same encoder.

```javascript
// CORRECT: each pass is a named, navigable group in the capture.
encoder.pushDebugGroup("shadow-pass");
const shadowPass = encoder.beginRenderPass(shadowDescriptor);
shadowPass.draw(shadowVertexCount);
shadowPass.end();
encoder.popDebugGroup();

encoder.pushDebugGroup("color-pass");
const colorPass = encoder.beginRenderPass(colorDescriptor);
colorPass.insertDebugMarker("begin-scene-draws");
colorPass.draw(sceneVertexCount);
colorPass.end();
encoder.popDebugGroup();
```

## 4. Debugging a Contagious Downstream Error Instead of the Root Call

### The mistake

Seeing many validation errors fire at once and starting to debug the last or loudest
one, or the one at the draw call.

### Why it fails

WebGPU errors are contagious. An object created from an invalid descriptor is itself
invalid, and every later operation that consumes it also fails. One bad bind group layout
can produce errors at the layout creation, the bind group creation, the pipeline
creation, and every draw call that uses the pipeline. Debugging the draw-call error is
debugging a symptom. The draw call is correct; the layout was wrong. Fixing the symptom
changes nothing because the root object is still invalid.

### The fix

ALWAYS find and fix the FIRST reported error. Bracket each creation call with its own
`pushErrorScope("validation")` / `popErrorScope()` pair so each failure is tied to its
exact call site, then fix the earliest one.

```javascript
// CORRECT: each creation call is individually bracketed.
device.pushErrorScope("validation");
const layout = device.createBindGroupLayout(layoutDescriptor);
const layoutError = await device.popErrorScope();

device.pushErrorScope("validation");
const bindGroup = device.createBindGroup({ ...bindGroupDescriptor, layout });
const bindGroupError = await device.popErrorScope();

// The earliest non-null error is the root cause. Fix it first.
if (layoutError) console.error("ROOT CAUSE - layout:", layoutError.message);
else if (bindGroupError) console.error("bind group:", bindGroupError.message);
```

## 5. Treating uncapturederror As the Primary Diagnosis Tool

### The mistake

Relying on the device `uncapturederror` event as the main way to catch and diagnose
errors, treating it like WebGL's `getError()`.

```javascript
// WRONG: uncapturederror used as the diagnosis mechanism.
device.addEventListener("uncapturederror", (e) => {
  console.error("Something failed somewhere:", e.error.message);
});
```

### Why it fails

`uncapturederror` is a last-resort telemetry channel. It fires for any error that no
error scope captured, with no information about which call site produced it. It cannot
tie an error to a specific operation, so it tells you that something failed but never
where. Targeted diagnosis is impossible from `uncapturederror` alone.

### The fix

Use `uncapturederror` ONLY for global telemetry and last-resort logging. For diagnosis,
ALWAYS bracket the suspect call with `pushErrorScope("validation")` / `popErrorScope()`,
which ties the error to one exact call site.

```javascript
// CORRECT: uncapturederror for telemetry, error scopes for diagnosis.
device.addEventListener("uncapturederror", (e) => {
  reportTelemetry("webgpu-uncaptured", e.error.message);
});

device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(pipelineDescriptor);
const error = await device.popErrorScope();
if (error) console.error("Pipeline creation failed:", error.message);
```

See webgpu-errors-validation for the full error-scope and `uncapturederror` model.

## 6. Leaving a pushDebugGroup Unmatched

### The mistake

Calling `pushDebugGroup` and forgetting the matching `popDebugGroup`, often when an early
return or a thrown exception skips the pop.

```javascript
// WRONG: pop is skipped when the guard returns early.
encoder.pushDebugGroup("particle-pass");
if (particleCount === 0) return; // pop never runs
const pass = encoder.beginRenderPass(particleDescriptor);
pass.draw(particleCount);
pass.end();
encoder.popDebugGroup();
```

### Why it fails

Every `pushDebugGroup` MUST be matched by exactly one `popDebugGroup` on the same encoder
before `finish()` or `end()`. An unmatched push is a validation error, so the whole
command buffer is rejected at `finish()`. The root cause is an early return that skips
the pop, but the error surfaces far away at `finish()`, which makes it hard to trace.

### The fix

ALWAYS pair every `pushDebugGroup` with its `popDebugGroup` on every code path. Place the
guard before the push, or pop before any early return.

```javascript
// CORRECT: the guard runs before the push, so push and pop are always paired.
if (particleCount === 0) return;
encoder.pushDebugGroup("particle-pass");
const pass = encoder.beginRenderPass(particleDescriptor);
pass.draw(particleCount);
pass.end();
encoder.popDebugGroup();
```

## Reference Sources

- https://developer.mozilla.org/en-US/docs/Web/API/GPUShaderModule/getCompilationInfo
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://developer.chrome.com/docs/web-platform/webgpu
- https://www.w3.org/TR/webgpu/
- vooronderzoek-webgpu.md PART C sections 10 and 11, PART A section 3
