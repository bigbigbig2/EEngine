# Examples: WebGPU Validation and Errors

Verified working code for capturing and diagnosing WebGPU errors. WebGPU
1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). All code verified against the
vooronderzoek research base and the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/).

## Example 1: Bracketing a suspect call with an error scope

The core diagnostic pattern. Push a scope, perform the suspect operation, pop and
await the result. The scope localises any failure to exactly this one call.

```javascript
async function createPipelineChecked(device, descriptor) {
  device.pushErrorScope("validation");
  const pipeline = device.createRenderPipeline(descriptor);
  const error = await device.popErrorScope();

  if (error) {
    console.error("Render pipeline is invalid:", error.message);
    return null;
  }
  return pipeline;
}
```

`popErrorScope()` returns a `Promise<GPUError | null>`. ALWAYS `await` it. A
`null` result means the operation passed validation.

## Example 2: An uncapturederror handler registered at init

Register exactly one listener when the device is created. It catches every error
not inside an active scope. It is a telemetry net, not a call-site locator.

```javascript
async function initDevice() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter available.");
  const device = await adapter.requestDevice();

  device.addEventListener("uncapturederror", (event) => {
    const err = event.error;
    console.error(
      "Uncaptured WebGPU error:",
      err.constructor.name,
      "-",
      err.message,
    );
  });

  return device;
}
```

`event.error.constructor.name` is `"GPUValidationError"`,
`"GPUOutOfMemoryError"`, or `"GPUInternalError"`.

## Example 3: Distinguishing the three error subtypes

After popping a scope, branch on the concrete subtype to react correctly.

```javascript
async function diagnose(device, operation) {
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");

  operation();

  const internalError = await device.popErrorScope();
  const oomError = await device.popErrorScope();
  const validationError = await device.popErrorScope();

  if (validationError) {
    console.error("App bug, fix the API usage:", validationError.message);
  }
  if (oomError) {
    console.error("Reduce the allocation size:", oomError.message);
  }
  if (internalError) {
    console.error("Driver or platform failure:", internalError.message);
  }
}
```

Scopes are popped in strict LIFO order: last pushed, first popped. Each filter
captures only its own error type.

## Example 4: Capturing an out-of-memory error around an allocation

A `"validation"` scope ignores allocation failures. Push `"out-of-memory"` to
probe a large `createBuffer` or `createTexture`.

```javascript
async function tryAllocate(device, size, usage) {
  device.pushErrorScope("out-of-memory");
  const buffer = device.createBuffer({ label: "large-buffer", size, usage });
  const error = await device.popErrorScope();

  if (error) {
    console.error("Allocation of", size, "bytes failed:", error.message);
    return null;
  }
  return buffer;
}
```

## Example 5: Reading the first error in a contagious cascade

An invalid bind group layout produces an invalid bind group: a cascade from one
root cause. The scope keeps only the FIRST error, which is the root.

```javascript
async function buildBindGroup(device, layoutDescriptor, entries) {
  device.pushErrorScope("validation");

  const layout = device.createBindGroupLayout(layoutDescriptor);
  const bindGroup = device.createBindGroup({
    label: "material-bind-group",
    layout,
    entries,
  });

  const error = await device.popErrorScope();
  if (error) {
    // This is the FIRST error: the bad layout descriptor, the root cause.
    // The dependent bind group failure is NOT reported separately.
    console.error("Root cause (first error):", error.message);
    return null;
  }
  return bindGroup;
}
```

ALWAYS fix the first reported error. Once the root object is valid, the dependent
errors disappear.

## Example 6: A reusable scoped helper

Wrap any synchronous WebGPU operation in a scope without repeating the boilerplate.

```javascript
async function withValidationScope(device, label, fn) {
  device.pushErrorScope("validation");
  const result = fn();
  const error = await device.popErrorScope();
  if (error) {
    console.error(`Validation failed in "${label}":`, error.message);
  }
  return { result, error };
}

// Usage:
const { result: shaderModule, error } = await withValidationScope(
  device,
  "create shader module",
  () => device.createShaderModule({ label: "main-shader", code: wgslSource }),
);
```

Note: WGSL syntax and type errors are NOT `GPUError`s. They surface through
`shaderModule.getCompilationInfo()`, a separate channel. See
`webgpu-errors-debugging`.
