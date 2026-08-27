# Cross-Browser WebGPU Examples

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Every example is
verified against the W3C WebGPU specification, MDN, and the vooronderzoek
research base.

## Example 1: Guard the entry point on every browser

WebGPU requires a secure context. On an insecure origin, or in a browser without
WebGPU, `navigator.gpu` is `undefined`. ALWAYS guard before any WebGPU call.

```js
async function getWebGPU() {
  if (!("gpu" in navigator)) {
    throw new Error(
      "WebGPU unavailable. Needs Chrome 113+, Safari 26+, or Firefox 141+, " +
        "served over HTTPS or localhost."
    );
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    // requestAdapter resolves to null when no compatible GPU exists.
    throw new Error("No WebGPU adapter on this device.");
  }
  return adapter;
}
```

## Example 2: Negotiate features that degrade across browsers

Chrome ships `shader-f16` (120) and `subgroups` (134) before Safari and Firefox.
Filter the wanted feature list against `adapter.features` so `requestDevice`
never rejects. After creation, read `device.features` for the real set.

```js
async function createDevice(adapter) {
  const wanted = [
    "timestamp-query",
    "shader-f16",
    "texture-compression-bc",
    "subgroups",
  ];
  // adapter.features.has gates whether a feature may go in requiredFeatures.
  const requiredFeatures = wanted.filter((f) => adapter.features.has(f));

  const device = await adapter.requestDevice({
    label: "main-device",
    requiredFeatures,
  });

  // device.features is the negotiated set: what the device actually enabled.
  return {
    device,
    caps: {
      timestamps: device.features.has("timestamp-query"),
      f16: device.features.has("shader-f16"),
      bcTextures: device.features.has("texture-compression-bc"),
      subgroups: device.features.has("subgroups"),
    },
  };
}
```

## Example 3: Portable canvas configuration

`getPreferredCanvasFormat()` returns `"bgra8unorm"` or `"rgba8unorm"` depending
on the platform. The render pipeline's fragment target format must equal this
value. Never hard-code the format.

```js
function configureCanvas(canvas, device) {
  const context = canvas.getContext("webgpu");
  // Platform-dependent: differs between Chrome and Safari on some devices.
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
  });
  // Return the format so the render pipeline target uses the same value.
  return { context, format };
}
```

## Example 4: Detect an optional WGSL language feature

`navigator.gpu.wgslLanguageFeatures` is a set-like object. An `enable` or
`requires` directive for a feature the browser lacks is a shader-creation error.
Pick the shader variant that matches what the browser supports.

```js
function pickShader() {
  const wgsl = navigator.gpu.wgslLanguageFeatures;
  const hasRWStorageTex = wgsl.has(
    "readonly_and_readwrite_storage_textures"
  );
  return hasRWStorageTex ? readWriteStorageShader : copyThroughShader;
}
```

## Example 5: Graceful degradation with shader-f16

Couple the host-side `shader-f16` feature with the WGSL-side `enable f16;`
directive. Both sides must agree. The device feature decides which shader source
is compiled.

```js
const shaderF16 = /* wgsl */ `
  enable f16;
  @group(0) @binding(0) var<storage, read_write> data : array<f16>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id : vec3u) {
    data[id.x] = data[id.x] * 2.0h;
  }
`;

const shaderF32 = /* wgsl */ `
  @group(0) @binding(0) var<storage, read_write> data : array<f32>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id : vec3u) {
    data[id.x] = data[id.x] * 2.0;
  }
`;

function buildComputeShader(device) {
  // device.features.has gates which shader source is even valid here.
  const code = device.features.has("shader-f16") ? shaderF16 : shaderF32;
  return device.createShaderModule({ label: "scale-compute", code });
}
```

## Example 6: Request only the limits the workload needs

Default limits differ by browser and adapter. Read `adapter.limits` first,
request only what is needed, and size resources against `device.limits`.

```js
async function createDeviceForWorkload(adapter, neededStorageBytes) {
  const requiredLimits = {};
  if (adapter.limits.maxStorageBufferBindingSize >= neededStorageBytes) {
    requiredLimits.maxStorageBufferBindingSize = neededStorageBytes;
  } else {
    throw new Error(
      "Adapter cannot grant a " + neededStorageBytes + "-byte storage binding."
    );
  }
  const device = await adapter.requestDevice({ requiredLimits });
  // Size buffers against the negotiated device.limits, never adapter.limits.
  const buffer = device.createBuffer({
    label: "workload-storage",
    size: Math.min(neededStorageBytes, device.limits.maxStorageBufferBindingSize),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  return { device, buffer };
}
```

## Example 7: Explicit synchronization instead of timeline assumptions

Chrome, Safari, and Firefox batch and flush GPU work at different points. Never
assume work completed because a later call seemed to see its result. Synchronize
with `onSubmittedWorkDone()`.

```js
async function readbackResult(device, sourceBuffer, byteSize) {
  const staging = device.createBuffer({
    label: "readback-staging",
    size: byteSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(sourceBuffer, 0, staging, 0, byteSize);
  device.queue.submit([encoder.finish()]);

  // Explicit, portable synchronization. Never rely on browser batching timing.
  await device.queue.onSubmittedWorkDone();
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  return copy;
}
```

## Example 8: Full cross-browser initialization with capability report

A single initialization path that runs on Chrome, Safari, and Firefox and
returns the capabilities the current browser actually granted.

```js
async function initWebGPU(canvas) {
  if (!("gpu" in navigator)) {
    return { ok: false, reason: "no-webgpu" };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    return { ok: false, reason: "no-adapter" };
  }

  const wanted = ["timestamp-query", "shader-f16"];
  const requiredFeatures = wanted.filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures });

  const format = navigator.gpu.getPreferredCanvasFormat();
  const context = canvas.getContext("webgpu");
  context.configure({ device, format, alphaMode: "opaque" });

  return {
    ok: true,
    device,
    context,
    format,
    caps: {
      timestamps: device.features.has("timestamp-query"),
      f16: device.features.has("shader-f16"),
      maxStorageBuffer: device.limits.maxStorageBufferBindingSize,
    },
  };
}
```
