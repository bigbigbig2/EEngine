# WebGPU Debugging: Examples

Working, verified code for debugging WebGPU. Every API name is verified against the
WebGPU specification and MDN. Applies to WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+).

## 1. Label Every Object

ALWAYS set a descriptive `label` on every descriptor. The `label` appears in `GPUError`
messages and in GPU frame captures and turns a generic message into an actionable one.

```javascript
// Buffer: labeled.
const vertexBuffer = device.createBuffer({
  label: "terrain-vertex-buffer",
  size: vertexData.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

// Texture: labeled.
const colorTexture = device.createTexture({
  label: "g-buffer-albedo",
  size: [canvas.width, canvas.height],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

// Texture view: labeled.
const colorView = colorTexture.createView({ label: "g-buffer-albedo-view" });

// Sampler: labeled.
const linearSampler = device.createSampler({
  label: "linear-clamp-sampler",
  magFilter: "linear",
  minFilter: "linear",
});

// Bind group layout: labeled.
const sceneLayout = device.createBindGroupLayout({
  label: "scene-bind-group-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
  ],
});

// Bind group: labeled.
const sceneBindGroup = device.createBindGroup({
  label: "scene-bind-group",
  layout: sceneLayout,
  entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
});

// Command encoder: labeled.
const encoder = device.createCommandEncoder({ label: "frame-encoder" });
```

When `vertexBuffer` is used with a wrong usage flag, the validation message reads
`Buffer "terrain-vertex-buffer" ...`. Without the label it would read `a buffer ...`,
which is not actionable when a frame creates many buffers.

## 2. Check getCompilationInfo After createShaderModule

`createShaderModule` does NOT throw on a WGSL error. ALWAYS call `getCompilationInfo()`
immediately after creating the module and print `lineNum` and `linePos` for each
`GPUCompilationMessage`.

```javascript
async function createCheckedShaderModule(device, label, code) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();

  let hasError = false;
  for (const msg of info.messages) {
    const where = msg.lineNum > 0 ? `${msg.lineNum}:${msg.linePos}` : "no-location";
    const text = `[${label}] ${msg.type} at ${where} - ${msg.message}`;
    if (msg.type === "error") {
      hasError = true;
      console.error(text);
    } else if (msg.type === "warning") {
      console.warn(text);
    } else {
      console.info(text);
    }
  }

  if (hasError) {
    throw new Error(`Shader module "${label}" failed WGSL compilation.`);
  }
  return module;
}

// Usage: a pipeline is built ONLY from a module that passed compilation.
const module = await createCheckedShaderModule(device, "main-shader", wgslSource);
const pipeline = device.createRenderPipeline({
  label: "main-render-pipeline",
  layout: "auto",
  vertex: { module, entryPoint: "vs_main", buffers: vertexBufferLayout },
  fragment: { module, entryPoint: "fs_main", targets: [{ format: presetFormat }] },
  primitive: { topology: "triangle-list" },
});
```

`info.messages` is a frozen array of `GPUCompilationMessage`. Each message has `type`
(`"error"`, `"warning"`, or `"info"`), `message`, `lineNum`, `linePos`, `offset`, and
`length`. `lineNum` and `linePos` are 1-based; a value of `0` means there is no source
location. NEVER build a pipeline from a module that produced a `type === "error"`
message.

## 3. Highlight the Exact Substring With offset and length

`offset` and `length` index into the original `code` string in UTF-16 code units. They
let you extract the exact substring a message refers to.

```javascript
function logCompileMessage(code, msg) {
  const snippet = code.substring(msg.offset, msg.offset + msg.length);
  console.error(
    `${msg.type} at line ${msg.lineNum}, column ${msg.linePos}: ${msg.message}\n` +
      `  source: "${snippet}"`,
  );
}

const info = await module.getCompilationInfo();
for (const msg of info.messages) {
  logCompileMessage(wgslSource, msg);
}
```

## 4. Bracket a Suspect Call With an Error Scope

To tie an error to one call site, push a `"validation"` error scope before the suspect
operation and pop it after. The promise from `popErrorScope()` resolves to the first
captured `GPUError` or `null`.

```javascript
device.pushErrorScope("validation");
const pipeline = device.createRenderPipeline(pipelineDescriptor);
const error = await device.popErrorScope();
if (error) {
  console.error(`Pipeline "${pipelineDescriptor.label}" invalid:`, error.message);
}
```

To find the FIRST error in a cascade, bracket each creation call with its own scope.

```javascript
async function createWithScope(device, label, createFn) {
  device.pushErrorScope("validation");
  const result = createFn();
  const error = await device.popErrorScope();
  if (error) {
    console.error(`Creation of "${label}" failed: ${error.message}`);
  }
  return result;
}

const layout = await createWithScope(device, "scene-layout", () =>
  device.createBindGroupLayout(layoutDescriptor),
);
const bindGroup = await createWithScope(device, "scene-bind-group", () =>
  device.createBindGroup({ ...bindGroupDescriptor, layout }),
);
```

The earliest scope that returns a non-null error is the root cause. See
webgpu-errors-validation for the full error-scope and `uncapturederror` model.

## 5. Annotate Passes With Debug Groups

`pushDebugGroup` / `popDebugGroup` wrap a named, nestable region. `insertDebugMarker`
inserts a single named point. The names appear in GPU frame captures. ALWAYS wrap each
pass or phase in a debug group.

```javascript
const encoder = device.createCommandEncoder({ label: "frame-encoder" });

// Shadow pass inside a named group.
encoder.pushDebugGroup("shadow-pass");
const shadowPass = encoder.beginRenderPass(shadowPassDescriptor);
shadowPass.setPipeline(shadowPipeline);
shadowPass.setBindGroup(0, shadowBindGroup);
shadowPass.draw(vertexCount);
shadowPass.end();
encoder.popDebugGroup();

// Main color pass with a nested group and a one-off marker.
encoder.pushDebugGroup("color-pass");
const colorPass = encoder.beginRenderPass(colorPassDescriptor);
colorPass.setPipeline(mainPipeline);

colorPass.pushDebugGroup("opaque-geometry");
colorPass.insertDebugMarker("begin-opaque-draws");
colorPass.setBindGroup(0, sceneBindGroup);
colorPass.draw(opaqueVertexCount);
colorPass.popDebugGroup();

colorPass.pushDebugGroup("transparent-geometry");
colorPass.setBindGroup(0, transparentBindGroup);
colorPass.draw(transparentVertexCount);
colorPass.popDebugGroup();

colorPass.end();
encoder.popDebugGroup();

device.queue.submit([encoder.finish()]);
```

Every `pushDebugGroup` MUST be matched by exactly one `popDebugGroup` on the SAME encoder
before `end()` or `finish()`. Groups nest; a `popDebugGroup` closes the innermost open
group. `insertDebugMarker` needs no matching call.

## 6. Detect Adapter and Secure-Context Problems

When WebGPU is entirely unavailable, the problem is environmental. ALWAYS confirm
`navigator.gpu` exists and an adapter is available before instrumenting code.

```javascript
async function getDevice() {
  if (!navigator.gpu) {
    throw new Error(
      "navigator.gpu is undefined. Serve the page over https or localhost, and " +
        "check chrome://gpu for adapter status.",
    );
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error(
      "requestAdapter() returned null. Check chrome://gpu for driver blocklisting.",
    );
  }
  return adapter.requestDevice({ label: "primary-device" });
}
```

## Reference Sources

- https://developer.mozilla.org/en-US/docs/Web/API/GPUShaderModule/getCompilationInfo
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://developer.chrome.com/docs/web-platform/webgpu
- https://www.w3.org/TR/webgpu/
- vooronderzoek-webgpu.md PART C sections 10 and 11, PART A section 3
