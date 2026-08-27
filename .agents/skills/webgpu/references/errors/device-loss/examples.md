# Device Loss Recovery: Verified Examples

All code applies to WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).
API names verified against https://www.w3.org/TR/webgpu/ and
https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost.

## Example 1: The correct recovery pattern

A single `initWebGPU()` function builds every GPU resource. The `device.lost`
handler is reason-checked and re-runs `initWebGPU()` only for a transient loss.
`initWebGPU()` is also the recovery path, because recovery IS a full
re-initialization, not a separate retry routine.

```js
let device = null;
let context = null;
let recoveryAttempts = 0;
const MAX_RECOVERY_ATTEMPTS = 3;

async function initWebGPU(canvas) {
  // Step 2: always re-request the adapter, never reuse a previous one.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    showUserError("No compatible GPU adapter available.");
    return;
  }

  // Step 3: fresh device from the fresh adapter.
  device = await adapter.requestDevice();

  // Step 4: attach the loss handler before any rendering starts.
  device.lost.then(handleDeviceLost);

  // Step 5: recreate every GPU resource against this device.
  context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  buildAllResources(device, format); // buffers, textures, pipelines, bind groups
  recoveryAttempts = 0;              // a working device resets the counter
  startRenderLoop();
}

function handleDeviceLost(info) {
  // device.lost RESOLVED here. It never rejects.
  console.error(`WebGPU device lost: ${info.reason} : ${info.message}`);

  // Step 1: discard all pre-loss state. The dead device and its resources
  // must never be touched again.
  device = null;
  context = null;

  // Pattern 2: branch on reason before doing anything.
  if (info.reason === "destroyed") {
    // The app called device.destroy() on purpose. Recovery would fight the
    // app's own shutdown, so stop here.
    return;
  }

  // info.reason === "unknown": transient. Run the explicit recovery sequence.
  recoverWebGPU();
}

async function recoverWebGPU() {
  // Step 6: bound the attempts. A permanent fault never recovers.
  recoveryAttempts += 1;
  if (recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    showUserError("WebGPU could not recover after several attempts. Reload the page.");
    return;
  }
  // Recovery is a full re-initialization, not a retry of one call.
  await initWebGPU(document.querySelector("canvas"));
}

function showUserError(text) {
  // Surface the failure visibly. Persistent device loss is a real, user-facing
  // condition, not something to swallow.
  document.querySelector("#status").textContent = text;
}
```

## Example 2: Intentional teardown with device.destroy()

When the app intentionally stops using WebGPU, call `device.destroy()`. The loss
that follows carries `reason: "destroyed"`, so the handler from Example 1 skips
recovery automatically. No extra teardown-only flag is needed.

```js
function teardownWebGPU() {
  stopRenderLoop();
  if (device) {
    device.destroy(); // resolves device.lost with reason "destroyed"
  }
}

// Tear WebGPU down when the user navigates away from the GPU view.
window.addEventListener("pagehide", teardownWebGPU);
```

## Example 3: Awaiting device.lost instead of using .then()

`device.lost` is a resolved-only promise, so `await` works directly. This form
suits a long-lived async setup function.

```js
async function runWebGPUSession(canvas) {
  await initWebGPU(canvas);

  // Suspends until the device is lost. NEVER rejects, so no try/catch is needed.
  const info = await device.lost;
  console.warn(`Device lost during session: ${info.reason}`);

  device = null;
  if (info.reason !== "destroyed") {
    await recoverWebGPU();
  }
}
```

## Example 4: Recreating bound resources on the new device

`buildAllResources()` from Example 1 builds every device-owned object fresh. After
a loss it runs again against the new device. The point: NEVER carry a
pre-loss `GPUBuffer`, `GPUTexture`, `GPUShaderModule`, pipeline, or `GPUBindGroup`
into post-loss code. They belong to a dead device and fail validation on use.

```js
function buildAllResources(device, format) {
  // Every object below is owned by THIS device. After a loss they are all dead
  // and this whole function must run again on the new device.
  const shaderModule = device.createShaderModule({
    label: "scene-shader",
    code: WGSL_SOURCE,
  });

  const vertexBuffer = device.createBuffer({
    label: "scene-vertices",
    size: VERTEX_BYTE_LENGTH,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData); // re-upload after loss

  const pipeline = device.createRenderPipeline({
    label: "scene-pipeline",
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vs", buffers: [VERTEX_LAYOUT] },
    fragment: { module: shaderModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const uniformBuffer = device.createBuffer({
    label: "scene-uniforms",
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    label: "scene-bind-group",
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  return { shaderModule, vertexBuffer, pipeline, uniformBuffer, bindGroup };
}
```

## Notes

- The recovery path and the first-run path are the SAME function (`initWebGPU`).
  Recovery is re-initialization, so there is no separate, untested retry routine.
- The attempt counter resets to `0` only after a device works. A failed attempt
  keeps the counter climbing toward `MAX_RECOVERY_ATTEMPTS`.
- `navigator.gpu.getPreferredCanvasFormat()` is re-read during recovery because
  the new adapter may sit on different hardware.

## Sources

- https://www.w3.org/TR/webgpu/
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/destroy
- docs/research/vooronderzoek-webgpu.md PART C section 9
