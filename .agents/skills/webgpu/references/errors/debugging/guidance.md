# WebGPU Debugging

Make WebGPU failures diagnosable: label every object, surface WGSL compile errors with
exact line and column, isolate failing operations with error scopes, and annotate the
command stream so GPU captures are readable. Applies to WebGPU 1.0-stable (Chrome 113+,
Safari 26+, Firefox 141+).

## Quick Reference

| Tool | API or location | What it diagnoses |
|------|-----------------|-------------------|
| Object labels | `label` field on every descriptor | Which object a validation message refers to |
| Error scopes | `device.pushErrorScope` / `device.popErrorScope` | Which exact call produced an error |
| Shader compile info | `shaderModule.getCompilationInfo()` | WGSL syntax and type errors with line and column |
| Debug groups | `encoder.pushDebugGroup` / `popDebugGroup` | Hierarchy of work in a GPU capture |
| Debug markers | `encoder.insertDebugMarker` | A single named point in the command stream |
| Console | Chrome DevTools console | Uncaptured WebGPU errors at runtime |
| `chrome://gpu` | Browser address bar | Adapter and driver status, blocklisting |
| `chrome://flags/#enable-unsafe-webgpu` | Browser address bar | Enables experimental WebGPU features |
| GPU frame capture | RenderDoc, or PIX on Windows via Dawn | Full per-draw state of a captured frame |

## Decision Tree

```
Symptom: a validation error mentions "a texture" / "a buffer" but you cannot tell which
  -> Labels are missing. ALWAYS set a meaningful label on every descriptor.
     Re-run; the message now quotes your label.

Symptom: createRenderPipeline / createComputePipeline fails with an opaque message
  -> The WGSL has a compile error. Call shaderModule.getCompilationInfo() and read
     messages where type === "error" for exact lineNum and linePos.

Symptom: an error fires but you do not know which call site caused it
  -> Bracket the suspect block with pushErrorScope("validation") / popErrorScope().
     See webgpu-errors-validation for filter selection.

Symptom: many errors fire at once after one bad object
  -> Errors are contagious. Find the FIRST error: bracket each creation call
     individually and fix the earliest failure, not the downstream noise.

Symptom: a GPU frame capture is an unreadable flat list of draw calls
  -> Debug groups are missing. Wrap each pass or phase with
     pushDebugGroup(name) / popDebugGroup().

Symptom: navigator.gpu is undefined or requestAdapter() returns null
  -> Check chrome://gpu for adapter status and confirm a secure context (https or
     localhost). See webgpu-core-architecture.
```

## Core Patterns

### Pattern 1: ALWAYS label every object

Every WebGPU descriptor accepts an optional `label` string. `GPUError` messages quote
these labels. ALWAYS set a descriptive label on every buffer, texture, sampler, pipeline,
bind group, bind group layout, shader module, and command encoder.

```javascript
const depthTexture = device.createTexture({
  label: "shadow-depth-texture",          // ALWAYS label
  size: [2048, 2048],
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
```

A validation error then reads `... texture "shadow-depth-texture" ...` instead of
`... a texture ...`. NEVER ship descriptors without a label.

### Pattern 2: ALWAYS check getCompilationInfo after createShaderModule

`createShaderModule` does not throw on a WGSL error. The error surfaces later, as an
opaque pipeline-creation failure. ALWAYS inspect compilation info immediately after
creating the module.

```javascript
const module = device.createShaderModule({ label: "main-shader", code: wgsl });
const info = await module.getCompilationInfo();
for (const msg of info.messages) {
  console[msg.type === "error" ? "error" : "warn"](
    `${msg.type} at ${msg.lineNum}:${msg.linePos} - ${msg.message}`,
  );
}
```

`info.messages` is an array of `GPUCompilationMessage`, each with `type`
(`"error"` / `"warning"` / `"info"`), `message`, `lineNum`, `linePos`, `offset`, and
`length`. A `type === "error"` message means the module is invalid; NEVER build a
pipeline from it.

### Pattern 3: ALWAYS bracket a suspect call with an error scope

To tie an error to one call site, push a validation error scope before the suspect
operation and pop it after. The promise from `popErrorScope()` resolves to the first
captured `GPUError` or `null`.

```javascript
device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(pipelineDescriptor);
const error = await device.popErrorScope();
if (error) console.error("Pipeline invalid:", error.message);
```

See webgpu-errors-validation for the full error-scope and `uncapturederror` model.

### Pattern 4: ALWAYS annotate the command stream with debug groups

`pushDebugGroup` / `popDebugGroup` and `insertDebugMarker` attach names to the command
stream. These names appear in GPU frame captures and turn a flat draw list into a
readable hierarchy. ALWAYS wrap each pass or rendering phase in a debug group.

```javascript
encoder.pushDebugGroup("shadow-pass");
const shadowPass = encoder.beginRenderPass(shadowPassDescriptor);
// ... draw calls ...
shadowPass.end();
encoder.popDebugGroup();
```

Groups nest. Every `pushDebugGroup` MUST be matched by exactly one `popDebugGroup` on the
same encoder before `finish()`, or encoding fails validation.

### Pattern 5: NEVER debug a downstream error first

WebGPU errors are contagious: an object built from an invalid descriptor is itself
invalid, and every later operation that consumes it also fails. ALWAYS find and fix the
FIRST reported error. Bracket each creation call with its own error scope to locate the
root cause instead of chasing the cascade.

### Pattern 6: ALWAYS check chrome://gpu before deep debugging

When WebGPU is entirely unavailable, the problem is environmental, not code. `chrome://gpu`
reports adapter and driver status and whether WebGPU is blocklisted. WebGPU also requires
a secure context (https or localhost). Confirm the environment before instrumenting code.

## Common Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|--------------|--------------|-----|
| Shipping descriptors with no `label` | Validation messages can only say "a texture"; you cannot tell which one | Set a meaningful `label` on every descriptor |
| Ignoring `getCompilationInfo()` after `createShaderModule` | WGSL errors never throw at module creation; they surface only as opaque pipeline-creation failures | Inspect `compilationInfo.messages` for `type === "error"` with `lineNum` and `linePos` |
| No debug groups around passes | GPU captures are an unreadable flat list with no phase boundaries | Wrap each pass with `pushDebugGroup` / `popDebugGroup` |

## Critical Warnings

- NEVER ship a descriptor without a `label`. Unlabeled objects make every validation
  message a guessing game.
- NEVER build a pipeline from a shader module whose `getCompilationInfo()` returned a
  `type === "error"` message. The module is invalid and the pipeline will fail.
- NEVER assume `createShaderModule` throws on a WGSL error. It does not. The only channel
  for compile diagnostics is `getCompilationInfo()`.
- NEVER chase the last error in a cascade. Errors are contagious; fix the FIRST one.
- NEVER leave a `pushDebugGroup` unmatched. Every push MUST have exactly one
  `popDebugGroup` on the same encoder before `finish()`.
- NEVER treat `uncapturederror` as a diagnosis tool. It is telemetry only; it cannot tie
  an error to a call site. Use error scopes instead. See webgpu-errors-validation.

## Reference Files

- `methods.md` : label discipline, `getCompilationInfo` and
  `GPUCompilationMessage` fields, debug groups and markers, browser GPU tooling.
- `examples.md` : verified code for labeled descriptors, checking
  compilation info, and debug groups.
- `anti-patterns.md` : debugging mistakes with WHY-it-fails explanations.

Related skills: webgpu-errors-validation (error scopes and filters),
webgpu-errors-device-loss (device-loss diagnosis), webgpu-core-pipeline-architecture
(shader module and pipeline creation).
