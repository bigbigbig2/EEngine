# WebGPU Validation and Errors

Capture and diagnose WebGPU validation failures with error scopes and the
uncapturederror event. WebGPU errors are asynchronous and contagious, not
synchronous like WebGL's `gl.getError()`.

## Quick Reference

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

### Error types: the three GPUError subtypes

| Subtype | Cause | Filter string |
|---------|-------|---------------|
| `GPUValidationError` | Invalid API usage (the most common). Mismatched bind group layout, bad alignment, wrong descriptor field. | `"validation"` |
| `GPUOutOfMemoryError` | An allocation failed (buffer or texture too large). | `"out-of-memory"` |
| `GPUInternalError` | A driver or implementation failure not attributable to the app. | `"internal"` |

Every `GPUError` subtype carries a human-readable `message` string. ALWAYS read
`error.message`. ALWAYS identify the concrete subtype with
`error.constructor.name`.

### Error scope API

| API | Signature | Behaviour |
|-----|-----------|-----------|
| `device.pushErrorScope(filter)` | `filter`: `"validation"` \| `"out-of-memory"` \| `"internal"` | Pushes a scope onto the device error-scope stack. |
| `device.popErrorScope()` | returns `Promise<GPUError \| null>` | Pops the top scope, resolves to the first captured error of that filter type, or `null`. |
| `uncapturederror` event | `GPUUncapturedErrorEvent` with `.error` (a `GPUError`) | Fires on the device for any error NOT captured by a scope. |

Error scopes form a LIFO stack. A scope captures ONLY errors matching its filter
type. Errors are captured on the device timeline, so `popErrorScope()` is
asynchronous.

## Decision Tree

### Error scope vs uncapturederror

```
Do I need to tie an error to a specific call site?
├─ YES (diagnosing a failing call)
│    -> Bracket the call with pushErrorScope / popErrorScope.
└─ NO (catch-all telemetry / last-resort logging)
     -> Add an uncapturederror event listener once at init.
```

ALWAYS use BOTH: error scopes for targeted diagnosis during development, plus a
single `uncapturederror` listener as a safety net for everything not bracketed.

### Which filter to push

```
What kind of failure am I investigating?
├─ A descriptor is rejected, alignment is wrong, layout mismatch
│    -> pushErrorScope("validation")
├─ createBuffer / createTexture for a large resource fails
│    -> pushErrorScope("out-of-memory")
└─ An operation fails with no app-level cause (driver fault)
     -> pushErrorScope("internal")
```

A `"validation"` scope NEVER captures an out-of-memory error and vice versa. To
catch any error type around one call, push all three scopes (nested LIFO) and pop
them in reverse order, or rely on `uncapturederror`.

### Validation error vs shader compilation error

```
Did createShaderModule succeed but the pipeline still fails?
├─ WGSL syntax / type error
│    -> NOT a GPUError. Use shaderModule.getCompilationInfo().
│       See webgpu-errors-debugging.
└─ Pipeline / resource API misuse
     -> A GPUValidationError. Use error scopes (this skill).
```

## Core Patterns

### Pattern 1: ALWAYS bracket a suspect call with a push and a pop

```javascript
device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(descriptor);
const error = await device.popErrorScope();
if (error) {
  console.error("Pipeline invalid:", error.message);
}
```

The scope localises the failure to exactly one operation. `popErrorScope()` is a
Promise: ALWAYS `await` it. NEVER read its result synchronously.

### Pattern 2: ALWAYS register one uncapturederror listener at init

```javascript
device.addEventListener("uncapturederror", (event) => {
  console.error(
    "Uncaptured WebGPU error:",
    event.error.constructor.name,
    event.error.message,
  );
});
```

This catches every error not inside an active scope. It is a telemetry net. It
CANNOT tell you which call site produced the error.

### Pattern 3: NEVER treat uncapturederror like gl.getError()

WebGL's `gl.getError()` is synchronous and returns the error of the last call.
WebGPU's `uncapturederror` event fires asynchronously and only reports the error
object, not the call that caused it. To attribute an error to a call, use Pattern
1. To diagnose, also set a `label` on every descriptor (see
webgpu-errors-debugging) so `error.message` names the object.

### Pattern 4: ALWAYS chase the FIRST error, not a downstream one

WebGPU errors are contagious. An object created from an invalid descriptor
becomes an invalid object. Operations that consume that invalid object also fail,
producing a cascade of validation errors. The FIRST reported error is the root
cause. NEVER fix a later error in the cascade first: once the root object is
valid, the dependent errors disappear.

```javascript
device.pushErrorScope("validation");
const layout = device.createBindGroupLayout(layoutDesc); // root failure here
const group = device.createBindGroup({ layout, entries }); // contagious failure
const error = await device.popErrorScope();
// error is the FIRST captured error: the bad bind group layout.
```

### Pattern 5: NEVER push a scope and forget to pop it

Every `pushErrorScope` MUST be paired with a `popErrorScope`. An unpopped scope
keeps capturing errors that should have surfaced via `uncapturederror`, hiding
them. Pop scopes in strict LIFO order: last pushed, first popped.

### Pattern 6: ALWAYS match the filter to the error type

A scope with filter `"validation"` resolves to `null` for an out-of-memory
failure, because that error was not its type and fell through to the next scope
or to `uncapturederror`. To probe an allocation, push `"out-of-memory"`:

```javascript
device.pushErrorScope("out-of-memory");
const huge = device.createBuffer({ size: 4_000_000_000, usage });
const oom = await device.popErrorScope();
if (oom) console.error("Allocation failed:", oom.message);
```

## Common Anti-Patterns

1. **Relying solely on `uncapturederror` and treating it like `gl.getError()`.**
   WHY it fails: the event fires asynchronously and carries only the error
   object. It CANNOT tie an error to a call site. Fix: bracket suspect calls with
   `pushErrorScope` / `popErrorScope`.

2. **Not bracketing a suspect call at all.** WHY it fails: the error surfaces
   later via `uncapturederror` (or not at all if a stale scope swallows it), so
   the failing operation is unknown. Fix: wrap the resource-creation block with a
   push and an awaited pop.

3. **Chasing a downstream contagious error instead of the first one.** WHY it
   fails: an invalid object produces a cascade of dependent validation errors;
   fixing a later one does nothing while the root object stays invalid. Fix: read
   and fix the FIRST captured error.

## Critical Warnings

- NEVER read `popErrorScope()` synchronously. It returns a `Promise<GPUError | null>`. ALWAYS `await` it.
- NEVER assume `uncapturederror` identifies a call site. It does not.
- NEVER leave a pushed scope unpopped. It silently swallows later errors.
- NEVER push the wrong filter. A `"validation"` scope ignores out-of-memory and internal errors.
- NEVER fix a downstream contagious error first. The first error is the root cause.
- NEVER expect a synchronous error API. WebGPU has no `getError()` equivalent.

## Reference Files

- `methods.md`: GPUError subtypes, pushErrorScope/popErrorScope, the uncapturederror event, error filters.
- `examples.md`: verified code for bracketing a suspect call and for an uncapturederror handler.
- `anti-patterns.md`: common validation-failure mistakes with WHY-it-fails explanations.

### Related skills

- `webgpu-errors-debugging`: shader compilation diagnostics via `getCompilationInfo()`, object labels, debug groups.
- `webgpu-errors-device-loss`: the `device.lost` promise and recovery after device loss.
- `webgpu-core-memory-model`: alignment rules whose violation produces most `GPUValidationError`s.
- `webgpu-core-architecture`: the device timeline and the WebGPU runtime model.
