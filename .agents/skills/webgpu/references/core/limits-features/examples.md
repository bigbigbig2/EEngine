# WebGPU Limits and Features: Examples

All examples verified against the WebGPU 1.0-stable specification and the
vooronderzoek research base. Baseline: Chrome 113+, Safari 26+, Firefox 141+.

## Example 1: Safe initialization with feature detection

The complete adapter-to-device chain with a null-check and feature detection.

```js
async function initWebGPU() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available (insecure context or no support)");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found");
  }

  // Detect which optional features the app would like and the adapter supports.
  const optional = ["timestamp-query", "shader-f16", "texture-compression-bc"];
  const requiredFeatures = optional.filter((f) => adapter.features.has(f));

  const device = await adapter.requestDevice({
    label: "main-device",
    requiredFeatures,
  });

  // device.features holds exactly what was negotiated.
  return { adapter, device, hasF16: device.features.has("shader-f16") };
}
```

## Example 2: The canonical feature-detection one-liner

ALWAYS gate every optional feature on `adapter.features.has`. This pattern
produces an empty array on adapters that lack the feature, so `requestDevice`
succeeds everywhere.

```js
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("shader-f16") ? ["shader-f16"] : [],
});
```

For several features at once, filter the wishlist:

```js
const wishlist = ["timestamp-query", "shader-f16", "float32-filterable"];
const device = await adapter.requestDevice({
  requiredFeatures: wishlist.filter((f) => adapter.features.has(f)),
});
```

## Example 3: Negotiating a higher limit safely

Read `adapter.limits` first. Request the higher limit only when the adapter can
provide it; otherwise reduce the workload or fail with a clear message.

```js
async function deviceForLargeBuffer(adapter, neededBytes) {
  if (adapter.limits.maxBufferSize < neededBytes) {
    throw new Error(
      `Adapter maxBufferSize is ${adapter.limits.maxBufferSize}, ` +
      `need ${neededBytes}`
    );
  }
  return adapter.requestDevice({
    label: "large-buffer-device",
    requiredLimits: { maxBufferSize: neededBytes },
  });
}
```

## Example 4: Requesting only the limits the app needs

`requiredLimits` starts from the spec defaults; each entry raises one limit.
Request exactly what the code uses. Every limit not listed stays at its default,
which keeps the app portable and catches accidental over-use.

```js
const device = await adapter.requestDevice({
  label: "compute-device",
  requiredLimits: {
    // Raise only the two limits this compute workload needs.
    maxStorageBufferBindingSize: 256 * 1024 * 1024,
    maxComputeWorkgroupStorageSize: 32768,
  },
});

// Everything else is the default:
console.log(device.limits.maxComputeWorkgroupSizeX);   // 256
console.log(device.limits.maxBindGroups);              // 4
```

## Example 5: Sizing resources against device.limits

After `requestDevice`, ALWAYS size buffers and dispatch grids against
`device.limits` (the negotiated set), NEVER against `adapter.limits`.

```js
function makeUniformBuffer(device, requestedSize) {
  const cap = device.limits.maxUniformBufferBindingSize; // negotiated value
  const size = Math.min(requestedSize, cap);
  return device.createBuffer({
    label: "frame-uniforms",
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function safeDispatch(device, pass, wantX) {
  const maxX = device.limits.maxComputeWorkgroupsPerDimension; // 65535 default
  pass.dispatchWorkgroups(Math.min(wantX, maxX));
}
```

## Example 6: Aligning dynamic offsets to a negotiated limit

`minUniformBufferOffsetAlignment` is an `alignment`-class limit. Dynamic buffer
binding offsets MUST be a multiple of it. Read the negotiated value and round up.

```js
function alignedStride(device, structSize) {
  const align = device.limits.minUniformBufferOffsetAlignment; // 256 default
  return Math.ceil(structSize / align) * align;
}

// A 192-byte uniform struct becomes a 256-byte stride.
const stride = alignedStride(device, 192); // 256
```

## Example 7: Targeting the compatibility tier

`featureLevel: "compatibility"` selects an adapter for OpenGL ES 3.1 /
D3D11-class hardware with reduced limits and a smaller feature set. Use it ONLY
when deliberately targeting that tier; the default `featureLevel` is `"core"`.

```js
async function initCompatibilityTier() {
  const adapter = await navigator.gpu.requestAdapter({
    featureLevel: "compatibility",
  });
  if (!adapter) {
    throw new Error("No compatibility-tier adapter");
  }

  // adapter.limits here reflect the reduced compatibility tier.
  const device = await adapter.requestDevice({
    label: "compat-device",
    // Feature-detect: the compatibility tier exposes fewer optional features.
    requiredFeatures: adapter.features.has("timestamp-query")
      ? ["timestamp-query"]
      : [],
  });
  return device;
}
```

## Example 8: Inspecting the negotiated capability set

After `requestDevice`, log the negotiated features and a few key limits to
confirm what the device actually has.

```js
function reportCapabilities(adapter, device) {
  console.log("adapter features:", [...adapter.features]);
  console.log("device  features:", [...device.features]);
  console.log("maxBufferSize:", device.limits.maxBufferSize);
  console.log(
    "maxStorageBufferBindingSize:",
    device.limits.maxStorageBufferBindingSize
  );
  console.log(
    "maxComputeInvocationsPerWorkgroup:",
    device.limits.maxComputeInvocationsPerWorkgroup
  );
}
```

## Example 9: shader-f16 needs both the feature and the enable directive

`shader-f16` requires the device feature AND the WGSL `enable f16;` directive
together. Requesting one without the other fails.

```js
const hasF16 = adapter.features.has("shader-f16");
const device = await adapter.requestDevice({
  requiredFeatures: hasF16 ? ["shader-f16"] : [],
});

const code = hasF16
  ? `enable f16;
     @compute @workgroup_size(64) fn main() { var x: f16 = 1.0h; }`
  : `@compute @workgroup_size(64) fn main() { var x: f32 = 1.0; }`;

const shaderModule = device.createShaderModule({ label: "f16-aware", code });
```
