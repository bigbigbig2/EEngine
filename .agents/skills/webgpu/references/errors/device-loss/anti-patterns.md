# Device Loss Anti-Patterns

Each entry states the mistake, WHY it fails, and the correct rule. Applies to
WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Anti-Pattern 1: Silent retry loop on requestDevice()

```js
// WRONG: unbounded loop, no reason check.
async function getDevice(adapter) {
  while (true) {
    try {
      return await adapter.requestDevice();
    } catch {
      // keep trying...
    }
  }
}
```

WHY it fails:
- `requestDevice()` does not throw for runtime GPU failures, so the `catch` rarely
  fires anyway; the loop is built on a wrong assumption about the API.
- On a permanent fault (GPU removed, driver broken) the loop spins forever,
  burning CPU and never reaching a working state.
- It never inspects `reason`, so it also retries after a `"destroyed"` loss and
  fights the application's own shutdown.
- It masks the root cause: the user sees a frozen tab instead of a clear error.

CORRECT: Recovery is a deliberate, reason-checked re-initialization with a bounded
attempt count. After the bound is reached, surface a persistent-failure message to
the user. NEVER loop until success.

## Anti-Pattern 2: Recovering after an intentional device.destroy()

```js
// WRONG: re-initializes regardless of reason.
device.lost.then(() => {
  initWebGPU(); // runs even when the app called device.destroy()
});
```

WHY it fails:
- The application called `device.destroy()` on purpose (page teardown, leaving the
  GPU view). The loss arrives with `reason === "destroyed"`.
- Re-initializing resurrects a device the app deliberately tore down. It reverses
  an intentional decision, restarts the render loop, and leaks GPU work and
  memory the teardown was meant to release.

CORRECT: ALWAYS check `info.reason` first. `if (info.reason === "destroyed") return;`
before any recovery call.

## Anti-Pattern 3: Reusing the old adapter

```js
// WRONG: keeps the pre-loss adapter and only re-requests the device.
async function recover(oldAdapter) {
  device = await oldAdapter.requestDevice(); // old adapter may be invalid
}
```

WHY it fails:
- A `GPUAdapter` represents a specific physical GPU. When the loss cause is a
  removed, replaced, or restarted GPU, that adapter no longer maps to live
  hardware and `requestDevice()` on it produces an unusable device.
- The adapter the app needs after a loss may be a different physical device
  entirely (for example, the integrated GPU after the discrete GPU was unplugged).

CORRECT: ALWAYS call `navigator.gpu.requestAdapter()` again during recovery and
null-check the result. NEVER reuse the pre-loss adapter.

## Anti-Pattern 4: Reusing GPU resources created by the lost device

```js
// WRONG: keeps pre-loss buffers and pipelines, only swaps the device.
async function recover() {
  device = await (await navigator.gpu.requestAdapter()).requestDevice();
  // vertexBuffer, pipeline, bindGroup were created by the DEAD device.
  render(device, vertexBuffer, pipeline, bindGroup);
}
```

WHY it fails:
- Every WebGPU resource (`GPUBuffer`, `GPUTexture`, `GPUSampler`,
  `GPUShaderModule`, `GPURenderPipeline`, `GPUComputePipeline`,
  `GPUBindGroupLayout`, `GPUPipelineLayout`, `GPUBindGroup`) is owned by the device
  that created it.
- When that device is lost, all of its child objects die with it.
- Passing a pre-loss resource to a command encoder built from the new device fails
  validation: the resource belongs to a different (dead) device.

CORRECT: ALWAYS recreate every GPU resource against the new device and re-upload
buffer and texture contents. Reconfigure the canvas context with the new device.
NEVER carry a pre-loss resource into post-loss code.

## Anti-Pattern 5: Treating device.lost as a rejected promise

```js
// WRONG: expects device.lost to reject.
try {
  await device.lost;
} catch (err) {
  handleDeviceLost(err); // never runs: device.lost does not reject
}
```

WHY it fails:
- `device.lost` is a resolved-only promise. It stays pending for the device's
  lifetime and **resolves** with a `GPUDeviceLostInfo`. It NEVER rejects.
- The `catch` block never executes, so the loss handler is dead code and the loss
  goes completely unhandled.

CORRECT: Consume the resolution. Use `device.lost.then((info) => ...)` or
`const info = await device.lost;` and branch on `info.reason`. NEVER attach loss
logic to a `.catch()` or a `try/catch`.

## Anti-Pattern 6: Using try/catch-and-retry as device-loss handling

```js
// WRONG: treats a frame failure as device loss and retries blindly.
function frame() {
  try {
    renderFrame();
  } catch {
    renderFrame(); // retry "for the case it failed"
  }
}
```

WHY it fails:
- Device loss is not a thrown JavaScript exception; it is a resolved
  `device.lost` promise. A `try/catch` around the render call never catches it.
- A blind retry is a fallback that hides whatever actually failed (a validation
  error, a lost device, a logic bug). It produces an untested code path and an
  unclear failure state.

CORRECT: Handle loss through the `device.lost` promise with the explicit,
reason-checked recovery sequence. Handle validation and out-of-memory errors with
error scopes (see `webgpu-errors-validation`). NEVER use a catch-and-retry wrapper
as a substitute for either.

## Sources

- https://www.w3.org/TR/webgpu/
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/destroy
- docs/research/vooronderzoek-webgpu.md PART C section 9
