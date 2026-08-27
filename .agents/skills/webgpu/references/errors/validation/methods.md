# Methods: WebGPU Validation and Errors

API reference for WebGPU error handling. WebGPU 1.0-stable (Chrome 113+, Safari
26+, Firefox 141+). Verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/) and MDN
(https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/pushErrorScope).

## The GPUError hierarchy

`GPUError` is the abstract base type. It has exactly three concrete subtypes.
Every subtype carries a single read-only `message` property of type `string`.

### GPUValidationError

The most common error. Signals invalid API usage: a malformed descriptor, a
mismatched bind group layout, a misaligned buffer offset, an unsupported
combination of usage flags, a missing `passEncoder.end()`, and similar
programmer errors.

```javascript
if (error instanceof GPUValidationError) {
  console.error("Invalid API usage:", error.message);
}
```

A `GPUValidationError` is non-fatal to the device: the device stays usable, the
single offending operation is dropped, and dependent objects become invalid (the
contagious-error model).

### GPUOutOfMemoryError

Signals that an allocation failed. Produced when `createBuffer` or
`createTexture` (or another allocating operation) cannot acquire the requested
memory.

```javascript
if (error instanceof GPUOutOfMemoryError) {
  console.error("Allocation failed:", error.message);
}
```

An out-of-memory error makes the specific resource invalid. Repeated or severe
allocation failure can also lead to device loss; see `webgpu-errors-device-loss`.

### GPUInternalError

Signals a driver or implementation-level failure that the application did NOT
cause through invalid usage. The operation was valid per the WebGPU rules but the
underlying implementation could not complete it (for example a pipeline that is
valid by the spec but rejected by the platform driver).

```javascript
if (error instanceof GPUInternalError) {
  console.error("Implementation failure:", error.message);
}
```

A `GPUInternalError` is informational. The same code may run on another machine.
It is NOT a sign of an app bug.

### Identifying the subtype

ALWAYS distinguish the subtype before acting on an error:

```javascript
const error = await device.popErrorScope();
if (error) {
  console.error(error.constructor.name, "-", error.message);
}
```

`error.constructor.name` yields `"GPUValidationError"`,
`"GPUOutOfMemoryError"`, or `"GPUInternalError"`.

## device.pushErrorScope(filter)

```
device.pushErrorScope(filter: GPUErrorFilter): undefined
```

Pushes a new error scope onto the device's error-scope stack. From this point,
errors whose type matches `filter` are captured by the scope instead of firing
the `uncapturederror` event.

`filter` is a `GPUErrorFilter` enum with exactly three values:

| Filter | Captures |
|--------|----------|
| `"validation"` | `GPUValidationError` |
| `"out-of-memory"` | `GPUOutOfMemoryError` |
| `"internal"` | `GPUInternalError` |

`pushErrorScope` returns `undefined` synchronously. It captures only errors of
its own filter type; an error of any other type passes through to the next
matching scope lower in the stack, or to `uncapturederror`.

## device.popErrorScope()

```
device.popErrorScope(): Promise<GPUError | null>
```

Pops the topmost error scope from the device's error-scope stack and returns a
`Promise`. The promise resolves to:

- The FIRST `GPUError` captured by that scope, if any error was captured.
- `null`, if the scope captured no error of its filter type.

`popErrorScope()` is asynchronous because errors are reported on the device
timeline, which runs ahead of the content timeline. ALWAYS `await` the result.
The promise rejects with an `OperationError` if the error-scope stack is empty
(no matching `pushErrorScope` was made).

### LIFO stacking

The error-scope stack is last-in-first-out. Scopes can nest:

```javascript
device.pushErrorScope("out-of-memory");   // scope A (outer)
device.pushErrorScope("validation");      // scope B (inner)
// ... operations ...
const validationError = await device.popErrorScope(); // pops B first
const oomError = await device.popErrorScope();        // then pops A
```

Each `pushErrorScope` MUST be paired with exactly one `popErrorScope`, popped in
reverse order. An inner scope only captures errors of ITS filter type; errors of
other types fall through to enclosing scopes.

## The uncapturederror event

Any error not captured by an active error scope fires the `uncapturederror` event
on the `GPUDevice`. The event object is a `GPUUncapturedErrorEvent` whose `error`
property is the `GPUError` (one of the three subtypes).

```
device.addEventListener("uncapturederror", (event: GPUUncapturedErrorEvent) => {
  event.error;            // a GPUError subtype
  event.error.message;    // human-readable string
});
```

The event also supports `device.onuncapturederror` as a property handler. It
exists for telemetry and last-resort logging. It does NOT identify the call site
that produced the error and is NOT a synchronous query API. Register exactly one
listener at device-initialisation time.

## Error filters and routing summary

The routing of any single error:

1. WebGPU detects an error of some type during an operation.
2. It walks the error-scope stack from the top down, looking for the FIRST scope
   whose filter matches the error type.
3. If a matching scope is found, the error is recorded in that scope (only the
   first error per scope is kept) and stops there.
4. If no matching scope is found, the `uncapturederror` event fires on the
   device.

This means: a `"validation"` scope is transparent to out-of-memory and internal
errors. To capture every error type around one operation, push all three
filters.

## The contagious-error model

WebGPU objects can be valid or invalid. When a descriptor is invalid, the object
created from it is created as an invalid object rather than throwing. Operations
that consume an invalid object also fail validation and may produce further
invalid objects. The result is a cascade of `GPUValidationError`s all stemming
from one root cause.

The FIRST error reported (and the first error captured by a scope) is the root
cause. Fixing it removes the entire cascade. This is why error scopes keep only
the first error per scope.

## Reference URLs

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification: errors, error scopes, device timeline)
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/pushErrorScope
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/popErrorScope
- https://gpuweb.github.io/gpuweb/explainer/ (WebGPU Explainer: error scopes, contagious-error model)
