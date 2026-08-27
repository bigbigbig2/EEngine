# Device Loss API Reference

All API names verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/) and MDN
(https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost).
Applies to WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## GPUDevice.lost

```
readonly attribute Promise<GPUDeviceLostInfo> lost;
```

- A read-only property on every `GPUDevice`.
- The promise stays **pending** for the entire lifetime of the device.
- It **resolves** exactly once, at the moment the device becomes lost.
- It **NEVER rejects**. There is no rejection path; all loss information arrives
  through the resolved `GPUDeviceLostInfo` value.
- Once resolved, the device is permanently unusable. ALWAYS treat the old
  `GPUDevice` and every object created from it as dead.

ALWAYS read it with `await device.lost` or `device.lost.then(handler)`. NEVER add
a `.catch()` and treat that as the loss path; the rejection path is never taken.

## GPUDeviceLostInfo

The object the `lost` promise resolves with. It has exactly two members:

```
interface GPUDeviceLostInfo {
  readonly attribute GPUDeviceLostReason reason;
  readonly attribute DOMString message;
}
```

### GPUDeviceLostInfo.reason

A `GPUDeviceLostReason` enum value:

| Value | Cause | Correct response |
|---|---|---|
| `"destroyed"` | The application called `device.destroy()` on purpose. | NEVER recover. The app shut the device down deliberately. |
| `"unknown"` | An external or implementation cause: GPU process crash, driver update or restart, hardware removed (GPU unplugged), the browser reclaiming GPU resources, or an unrecoverable out-of-memory / internal error. | Run the explicit recovery sequence below. |

`reason` is the single branch point for all device-loss handling. ALWAYS read it
before deciding whether to recover.

### GPUDeviceLostInfo.message

A human-readable `DOMString` describing the loss. Use it for logging and for the
message shown to the user. It is informational only; NEVER parse it to decide
whether to recover. ALWAYS branch on `reason`, never on `message`.

## GPUDevice.destroy()

```
undefined destroy();
```

- Destroys the device deliberately. After `destroy()`, all of the device's
  resources are released and any further use of the device is invalid.
- Calling `destroy()` resolves `device.lost` with `reason === "destroyed"`.
- This is the ONLY cause of a `"destroyed"` loss. Any loss with a different
  `reason` was not initiated by the application.

ALWAYS call `device.destroy()` when the app intentionally tears WebGPU down (page
unload, the user leaves the GPU view). Because the resulting loss carries
`reason: "destroyed"`, the loss handler in Pattern 2 correctly skips recovery.

## The Recovery Sequence

Recovery is a deliberate, root-cause-aware re-initialization. It runs ONLY when
`reason !== "destroyed"`. It is NOT a fallback and NOT a retry loop.

### Step 1: Discard all pre-loss GPU state

Drop every reference to the lost `GPUDevice` and to every resource it created
(buffers, textures, samplers, shader modules, pipelines, bind group layouts,
pipeline layouts, bind groups). They are bound to a dead device. NEVER reuse them.
Setting `device = null` makes accidental reuse fail fast.

### Step 2: Re-request the adapter

Call `navigator.gpu.requestAdapter()` again. NEVER reuse the pre-loss adapter: the
physical GPU it represented may have been unplugged, replaced, or restarted, which
makes the old adapter invalid. `requestAdapter()` returns `Promise<GPUAdapter | null>`;
a `null` result means no compatible GPU is now available. ALWAYS null-check it and
surface a failure to the user when it is `null`.

### Step 3: Request a fresh device

Call `adapter.requestDevice(descriptor)` on the new adapter. If the original device
required features or limits, re-negotiate them against the new adapter, because the
new adapter may expose different capabilities (see `webgpu-core-limits-features`).

### Step 4: Re-attach the loss handler

Attach a new `device.lost` handler to the new device immediately, before rendering
resumes. Each `GPUDevice` has its own `lost` promise; the handler from the dead
device does not carry over.

### Step 5: Recreate every GPU resource

Recreate all buffers, textures, samplers, shader modules, pipelines, bind group
layouts, pipeline layouts, and bind groups against the new device, and reconfigure
the `GPUCanvasContext` with `context.configure({ device, format })` using the new
device. Re-upload buffer and texture contents. WebGPU resources are owned by their
creating device; a resource from the lost device is invalid on the new one.

### Step 6: Bound the attempts

Count recovery attempts. When a bounded maximum (a small fixed number) is reached
without a working device, STOP and surface a persistent-failure message to the
user. NEVER continue retrying. A permanent hardware fault never recovers, so an
unbounded loop only spins and hides the root cause.

## Sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification: `GPUDevice.lost`,
  `GPUDeviceLostInfo`, `GPUDeviceLostReason`, `GPUDevice.destroy()`)
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/destroy
- docs/research/vooronderzoek-webgpu.md PART C section 9
