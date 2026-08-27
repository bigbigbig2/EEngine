# WebGPU Device Loss and Recovery

Handle the `GPUDevice.lost` promise correctly and rebuild GPU state after a loss
with an explicit, reason-checked re-initialization, never a silent retry loop.

## Quick Reference

`GPUDevice.lost` is a read-only `Promise<GPUDeviceLostInfo>` that stays pending for
the device's whole lifetime and **resolves** once when the device becomes unusable.
It NEVER rejects. The resolved `GPUDeviceLostInfo` carries `reason` and `message`.

Applies to WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

| `GPUDeviceLostInfo.reason` | Meaning | Recover? |
|---|---|---|
| `"destroyed"` | The app called `device.destroy()` deliberately. | NEVER |
| `"unknown"` | Transient external cause: GPU process crash, driver update, hardware removed, browser reclaiming resources. | YES, reason-checked |

Device loss also happens implicitly on an unrecoverable out-of-memory or internal
error. Such a loss surfaces with `reason === "unknown"`.

| Fact | Rule |
|---|---|
| `device.lost` | Read-only property, resolves once, never rejects. |
| Old `GPUDevice` after loss | Permanently dead. NEVER reuse it. |
| Old `GPUAdapter` after loss | May be invalid (GPU unplugged). ALWAYS re-request. |
| Old buffers/textures/pipelines/bind groups | Bound to the dead device. NEVER reuse. Recreate every one. |

## Decision Tree

```
device.lost resolves with info
│
├── info.reason === "destroyed"
│      └── The app shut the device down on purpose.
│          ACTION: stop. Do NOT recover. Recovery would fight the app's own teardown.
│
└── info.reason === "unknown"  (transient or implicit OOM/internal)
       └── ACTION: run the explicit recovery sequence.
              1. Re-request a fresh GPUAdapter (the old one may be invalid).
              2. Request a fresh GPUDevice from that adapter.
              3. Recreate EVERY GPU resource against the new device.
              4. Re-attach a new device.lost handler to the new device.
              │
              ├── recovery succeeded → resume rendering.
              └── recovery failed after a bounded number of attempts
                     → surface a persistent-failure message to the user. STOP.
```

## Core Patterns

### Pattern 1: ALWAYS attach the handler immediately after requestDevice

ALWAYS register the `device.lost` handler in the same async step that creates the
device, before any rendering starts. A loss that happens before the handler is
attached still resolves the promise, so the handler runs as soon as it is added.

```js
const device = await adapter.requestDevice();
device.lost.then(handleDeviceLost); // attached before the first frame
```

### Pattern 2: ALWAYS branch on reason before recovering

ALWAYS check `info.reason` first. NEVER call `requestDevice()` after a
`"destroyed"` loss.

```js
function handleDeviceLost(info) {
  console.error(`WebGPU device lost: ${info.reason} : ${info.message}`);
  if (info.reason === "destroyed") return;   // intentional teardown: do nothing
  recoverWebGPU();                           // transient: explicit re-init
}
```

### Pattern 3: ALWAYS re-request the adapter, never reuse the old one

ALWAYS call `navigator.gpu.requestAdapter()` again during recovery. The old
adapter may be invalid because the physical GPU was unplugged or replaced.
NEVER hold the pre-loss adapter and call `requestDevice()` on it.

### Pattern 4: ALWAYS recreate every GPU resource against the new device

Every `GPUBuffer`, `GPUTexture`, `GPUSampler`, `GPUShaderModule`,
`GPURenderPipeline`, `GPUComputePipeline`, `GPUBindGroupLayout`,
`GPUPipelineLayout`, and `GPUBindGroup` is owned by the device that created it.
After loss those objects are dead. ALWAYS rebuild all of them and reconfigure the
canvas context on the new device. NEVER pass a pre-loss resource to a post-loss
command encoder.

### Pattern 5: ALWAYS bound the recovery attempts and surface persistent failure

NEVER loop `requestDevice()` until it succeeds. A permanent hardware fault makes
that loop spin forever. ALWAYS cap recovery to a fixed small number of attempts
and, when the cap is reached, surface an explicit error to the user.

```js
let recoveryAttempts = 0;
const MAX_RECOVERY_ATTEMPTS = 3;

async function recoverWebGPU() {
  recoveryAttempts += 1;
  if (recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    showUserError("WebGPU could not recover. Reload the page.");
    return;
  }
  await initWebGPU(); // re-request adapter + device, recreate all resources
}
```

### Pattern 6: ALWAYS treat device.lost as a resolved promise

`device.lost` resolves; it does not reject. ALWAYS consume it with `await` or
`.then()`. NEVER wrap it in `try/catch` expecting a rejection, and NEVER add a
`.catch()` and treat that path as the loss handler.

## Common Anti-Patterns

1. Calling `requestDevice()` in a loop without checking `reason` or bounding
   attempts. On a `"destroyed"` loss it fights the app's own shutdown; on a
   permanent hardware fault it busy-loops. Either way it masks the root cause.
2. Recreating the device after a `"destroyed"` loss. The app destroyed the device
   on purpose; resurrecting it reverses an intentional decision and leaks GPU work.
3. Reusing the pre-loss adapter, or reusing buffers, textures, pipelines, or bind
   groups created by the lost device. They belong to a dead device and every
   command that touches them fails validation.

See anti-patterns.md for the WHY behind each failure.

## Critical Warnings

- NEVER recover when `info.reason === "destroyed"`.
- NEVER reuse the lost `GPUDevice`, its `GPUAdapter`, or any resource it created.
- NEVER run an unbounded `requestDevice()` retry loop; it spins forever on a
  permanent fault and hides the real problem.
- NEVER treat `device.lost` as a rejecting promise; it always resolves.
- NEVER use a `try/catch`-and-retry wrapper as device-loss handling; loss is not a
  thrown exception, it is a resolved promise.
- ALWAYS surface a persistent failure to the user after a bounded attempt count
  instead of retrying silently.

## Reference Files

- `methods.md`: `device.lost`, `GPUDeviceLostInfo`, `device.destroy()`,
  and the recovery sequence step by step.
- `examples.md`: verified working code for the correct recovery
  pattern and reason-checked re-initialization.
- `anti-patterns.md`: device-loss mistakes with WHY-it-fails analysis.

Related skills: `webgpu-core-architecture` (adapter and device lifecycle),
`webgpu-errors-validation` (GPUValidationError and error scopes),
`webgpu-core-limits-features` (re-negotiating features on the new device).
