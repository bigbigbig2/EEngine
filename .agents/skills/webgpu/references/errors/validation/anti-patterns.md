# Anti-Patterns: WebGPU Validation and Errors

Common WebGPU validation-failure mistakes, why each fails, and the fix. WebGPU
1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Verified against the
vooronderzoek research base and the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/).

## 1. Relying solely on uncapturederror, treating it like gl.getError()

**The mistake:** Adding only an `uncapturederror` listener and expecting it to
work like WebGL's synchronous `gl.getError()`, where the developer queries the
error of the last call right after that call.

```javascript
// WRONG: uncapturederror used as a per-call query
device.addEventListener("uncapturederror", (e) => { lastError = e.error; });
device.createRenderPipeline(descriptor);
if (lastError) { /* which call set this? unknown */ }
```

**WHY it fails:** The `uncapturederror` event fires asynchronously on the device
timeline, not synchronously after the call. It carries only the `GPUError`
object, never the call site. By the time the listener runs, many other
operations may have been recorded. `uncapturederror` is for telemetry and
last-resort logging, not for attributing an error to one operation.

**The fix:** ALWAYS bracket a suspect operation with `pushErrorScope` /
`popErrorScope`. The scope localises the error to exactly the bracketed call.
Keep one `uncapturederror` listener as a safety net only.

## 2. Not bracketing suspect calls with pushErrorScope / popErrorScope

**The mistake:** Calling `createRenderPipeline`, `createBindGroup`, or another
fallible operation with no error scope around it, then wondering why nothing
reports the failure.

```javascript
// WRONG: no scope, the failure surfaces later or not at all
const pipeline = device.createRenderPipeline(descriptor);
// pipeline may be an invalid object; nothing here tells you
```

**WHY it fails:** Without an enclosing scope, the validation error routes to the
`uncapturederror` event, decoupled from this call site. If a stale unpopped scope
of the same filter sits on the stack, it swallows the error instead. Either way
the developer cannot tell which operation failed, and the invalid object silently
poisons everything that consumes it (the contagious-error model).

**The fix:** Wrap each resource-creation block with a push and an awaited pop.

```javascript
device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(descriptor);
const error = await device.popErrorScope();
if (error) console.error("Pipeline invalid:", error.message);
```

## 3. Chasing a downstream contagious error instead of the first one

**The mistake:** Reading a cascade of validation errors and fixing a later one,
for example fixing the `createBindGroup` complaint while the `createBindGroupLayout`
that feeds it is the real problem.

**WHY it fails:** WebGPU errors are contagious. An object built from an invalid
descriptor becomes an invalid object instead of throwing. Every operation that
consumes that invalid object also fails validation, producing more invalid
objects. The result is a cascade from one root cause. Fixing a downstream error
does nothing: the dependent operation still receives an invalid input. Error
scopes keep only the FIRST captured error precisely because it is the root.

**The fix:** ALWAYS read and fix the FIRST reported error. Once the root object
is valid, every dependent error in the cascade disappears.

```javascript
device.pushErrorScope("validation");
const layout = device.createBindGroupLayout(layoutDesc);   // root failure
const group = device.createBindGroup({ layout, entries }); // contagious failure
const error = await device.popErrorScope();
// error is the FIRST error: the bad layout. Fix the layout descriptor.
```

## 4. Assuming popErrorScope() is synchronous

**The mistake:** Reading the return value of `popErrorScope()` directly as if it
were a `GPUError`, with no `await`.

```javascript
// WRONG: error is a Promise, never a GPUError
device.pushErrorScope("validation");
device.createRenderPipeline(descriptor);
const error = device.popErrorScope();
if (error) console.error(error.message); // logs "undefined" or throws
```

**WHY it fails:** `popErrorScope()` returns a `Promise<GPUError | null>`, not a
`GPUError`. Errors are reported on the device timeline, which runs ahead of the
content timeline, so the result is inherently asynchronous. The truthy `Promise`
makes the `if` always pass, and `error.message` reads a property that does not
exist on a Promise. WebGPU has no synchronous error query; there is no
`getError()` equivalent.

**The fix:** ALWAYS `await` `popErrorScope()` inside an `async` function.

```javascript
device.pushErrorScope("validation");
device.createRenderPipeline(descriptor);
const error = await device.popErrorScope();
if (error) console.error(error.message);
```

## 5. Pushing a dynamic buffer binding offset that is not 256-aligned

**The mistake:** Computing a dynamic offset for `setBindGroup` as
`index * structSize` where `structSize` is not a multiple of 256, for example a
192-byte uniform struct.

```javascript
// WRONG: 192 is not a multiple of 256
const dynamicOffset = objectIndex * 192;
passEncoder.setBindGroup(0, bindGroup, [dynamicOffset]);
```

**WHY it fails:** Each dynamic offset MUST be a multiple of
`minUniformBufferOffsetAlignment` (256) for uniform buffers, or
`minStorageBufferOffsetAlignment` (256) for storage buffers. These are
`minimum`-class limits an adapter never reports below. An unaligned offset is a
`GPUValidationError` and the `setBindGroup` call is dropped, so the draw reads
the wrong region or fails outright.

**The fix:** Pad the per-object struct stride up to a 256-byte multiple and
compute offsets from the padded stride. A 192-byte struct uses a 256-byte stride.

```javascript
const PADDED_STRIDE = 256; // next multiple of 256 above 192
const dynamicOffset = objectIndex * PADDED_STRIDE;
passEncoder.setBindGroup(0, bindGroup, [dynamicOffset]);
```

## 6. Mismatched bind group layout between pipeline and bind group

**The mistake:** Binding a bind group created from one pipeline's auto-generated
layout to a different pipeline, or building a bind group whose layout entries do
not match what the shader declares.

```javascript
// WRONG: bind group from pipelineA's auto layout used on pipelineB
const bindGroup = device.createBindGroup({
  layout: pipelineA.getBindGroupLayout(0),
  entries,
});
passEncoder.setPipeline(pipelineB);
passEncoder.setBindGroup(0, bindGroup); // validation error
```

**WHY it fails:** With `layout: "auto"`, a pipeline generates implicit
bind-group layouts that are NOT reusable across pipelines. A bind group made from
`pipelineA.getBindGroupLayout(0)` is bound to `pipelineA` only. Setting it on
`pipelineB` is a `GPUValidationError` because the layouts are distinct objects.
The same error appears when bind group entry types (buffer type, sampler type,
texture sampleType) do not match the `GPUBindGroupLayout`. Because errors are
contagious, the failure can also surface later as a draw-time validation error.

**The fix:** For resources shared across multiple pipelines, create an explicit
`GPUPipelineLayout` from a shared `GPUBindGroupLayout` and pass it to every
pipeline. Bind groups built from that shared layout work with all of them. ALWAYS
keep bind group entry types exactly matching the layout entry types.

```javascript
const sharedLayout = device.createBindGroupLayout({ entries: layoutEntries });
const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [sharedLayout],
});
// Pass pipelineLayout to every pipeline that shares these resources.
const bindGroup = device.createBindGroup({ layout: sharedLayout, entries });
```
