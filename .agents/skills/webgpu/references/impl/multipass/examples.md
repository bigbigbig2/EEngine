# Multi-Pass Rendering Examples

Working code verified against WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+),
the W3C WebGPU specification, and the official WebGPU Samples. Initialization
(`requestAdapter`, `requestDevice`, `context.configure`) is assumed complete.

## Example 1: Post-processing chain (scene to offscreen, tone-map to canvas)

Renders the scene to an HDR offscreen texture, then runs a full-screen tone-mapping pass
that samples it and presents to the canvas.

```js
const format = navigator.gpu.getPreferredCanvasFormat();

// Offscreen HDR scene texture. RENDER_ATTACHMENT + TEXTURE_BINDING is mandatory.
const sceneTexture = device.createTexture({
  label: "scene-hdr",
  size: [canvas.width, canvas.height],
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const linearSampler = device.createSampler({
  label: "post-sampler",
  magFilter: "linear",
  minFilter: "linear",
});

// Full-screen tone-mapping pipeline. No vertex buffer: 3-vertex triangle in the shader.
const postModule = device.createShaderModule({
  label: "tonemap",
  code: `
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
      let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[i], 0, 1);
    }
    @group(0) @binding(0) var src : texture_2d<f32>;
    @group(0) @binding(1) var samp : sampler;
    @fragment fn fs(@builtin(position) fragCoord : vec4f) -> @location(0) vec4f {
      let dims = vec2f(textureDimensions(src));
      let uv = fragCoord.xy / dims;
      let hdr = textureSample(src, samp, uv).rgb;
      let mapped = hdr / (hdr + vec3f(1.0));   // Reinhard tone mapping
      return vec4f(mapped, 1.0);
    }
  `,
});

const postPipeline = device.createRenderPipeline({
  label: "tonemap-pipeline",
  layout: "auto",
  vertex: { module: postModule, entryPoint: "vs" },
  fragment: { module: postModule, entryPoint: "fs", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
});

const postBindGroup = device.createBindGroup({
  label: "tonemap-bind-group",
  layout: postPipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: sceneTexture.createView() },
    { binding: 1, resource: linearSampler },
  ],
});

function frame() {
  const encoder = device.createCommandEncoder({ label: "frame" });

  // Pass 1: render the scene into the offscreen HDR texture.
  const scenePass = encoder.beginRenderPass({
    label: "scene-pass",
    colorAttachments: [{
      view: sceneTexture.createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
    }],
  });
  // ... scenePass.setPipeline(...), draw scene geometry ...
  scenePass.end();                               // end before sampling sceneTexture

  // Pass 2: full-screen tone-map, sample sceneTexture, present to the canvas.
  const postPass = encoder.beginRenderPass({
    label: "post-pass",
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),  // fresh every frame
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
    }],
  });
  postPass.setPipeline(postPipeline);
  postPass.setBindGroup(0, postBindGroup);
  postPass.draw(3);                              // 3-vertex full-screen triangle
  postPass.end();

  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## Example 2: Shadow-map pass plus main pass

A first pass renders scene depth from the light's view into a depth-only texture. The
main pass samples that depth with a comparison sampler.

```js
// Depth-only shadow map. RENDER_ATTACHMENT + TEXTURE_BINDING is mandatory.
const shadowDepth = device.createTexture({
  label: "shadow-map",
  size: [2048, 2048],
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

// Comparison sampler: a compare function makes it a comparison sampler.
const shadowSampler = device.createSampler({
  label: "shadow-comparison-sampler",
  compare: "less",
});

// Shadow pipeline: depth-only, so fragment is omitted. @invariant on position.
const shadowModule = device.createShaderModule({
  label: "shadow-depth",
  code: `
    @group(0) @binding(0) var<uniform> lightViewProj : mat4x4f;
    @vertex fn vs(@location(0) position : vec3f)
      -> @builtin(position) @invariant vec4f {
      return lightViewProj * vec4f(position, 1.0);
    }
  `,
});

const shadowPipeline = device.createRenderPipeline({
  label: "shadow-pipeline",
  layout: "auto",
  vertex: {
    module: shadowModule, entryPoint: "vs",
    buffers: [{ arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
  },
  // No fragment stage: a depth-only pass needs no color output.
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "less",
  },
  primitive: { topology: "triangle-list", cullMode: "back" },
});

function renderShadowPass(encoder, lightBindGroup, geometry) {
  const shadowPass = encoder.beginRenderPass({
    label: "shadow-pass",
    colorAttachments: [],                        // depth-only: no color attachments
    depthStencilAttachment: {
      view: shadowDepth.createView(),
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",                     // store so the main pass can sample
    },
  });
  shadowPass.setPipeline(shadowPipeline);
  shadowPass.setBindGroup(0, lightBindGroup);
  shadowPass.setVertexBuffer(0, geometry.vertexBuffer);
  shadowPass.draw(geometry.vertexCount);
  shadowPass.end();
}
```

The main pass binds the shadow map with a `sampleType: "depth"` texture entry and a
`type: "comparison"` sampler entry, then samples in WGSL:

```js
const mainBindGroupLayout = device.createBindGroupLayout({
  label: "main-shadow-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "comparison" } },
  ],
});

const mainBindGroup = device.createBindGroup({
  label: "main-shadow-bind-group",
  layout: mainBindGroupLayout,
  entries: [
    { binding: 0, resource: shadowDepth.createView() },
    { binding: 1, resource: shadowSampler },
  ],
});
```

WGSL fragment code in the main pass samples the shadow map with `textureSampleCompare`:

```wgsl
@group(1) @binding(0) var shadowMap : texture_depth_2d;
@group(1) @binding(1) var shadowSampler : sampler_comparison;

// shadowUV in [0,1], currentDepth is this fragment's depth in light space.
fn computeVisibility(shadowUV : vec2f, currentDepth : f32) -> f32 {
  // Returns 1.0 when lit, 0.0 when in shadow (hardware comparison).
  return textureSampleCompare(shadowMap, shadowSampler, shadowUV, currentDepth);
}
```

## Example 3: Ping-pong separable blur

A two-texture ping-pong runs a horizontal then a vertical blur pass. Each pass samples
one texture and renders into the other.

```js
function makePingPongTexture(label) {
  return device.createTexture({
    label,
    size: [canvas.width, canvas.height],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}
const texA = makePingPongTexture("pingpong-a");
const texB = makePingPongTexture("pingpong-b");

const blurSampler = device.createSampler({
  label: "blur-sampler", magFilter: "linear", minFilter: "linear",
});

// Full-screen blur pipeline. A uniform u32 selects horizontal vs vertical direction.
const blurModule = device.createShaderModule({
  label: "blur",
  code: `
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
      let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[i], 0, 1);
    }
    @group(0) @binding(0) var src : texture_2d<f32>;
    @group(0) @binding(1) var samp : sampler;
    @group(0) @binding(2) var<uniform> direction : vec2f;  // (1,0) or (0,1)
    @fragment fn fs(@builtin(position) fragCoord : vec4f) -> @location(0) vec4f {
      let dims = vec2f(textureDimensions(src));
      let uv = fragCoord.xy / dims;
      let texel = direction / dims;
      var sum = textureSample(src, samp, uv).rgb * 0.4;
      sum += textureSample(src, samp, uv + texel).rgb * 0.3;
      sum += textureSample(src, samp, uv - texel).rgb * 0.3;
      return vec4f(sum, 1.0);
    }
  `,
});

const blurPipeline = device.createRenderPipeline({
  label: "blur-pipeline",
  layout: "auto",
  vertex: { module: blurModule, entryPoint: "vs" },
  fragment: { module: blurModule, entryPoint: "fs",
    targets: [{ format: "rgba16float" }] },
  primitive: { topology: "triangle-list" },
});

// Direction uniform buffers.
function makeDirBuffer(x, y) {
  const buf = device.createBuffer({
    label: "blur-direction", size: 8, usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  new Float32Array(buf.getMappedRange()).set([x, y]);
  buf.unmap();
  return buf;
}
const horizontalDir = makeDirBuffer(1, 0);
const verticalDir = makeDirBuffer(0, 1);

// One bind group per (input texture, direction) pair. Bind groups are immutable.
function makeBlurBindGroup(srcTexture, dirBuffer) {
  return device.createBindGroup({
    layout: blurPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTexture.createView() },
      { binding: 1, resource: blurSampler },
      { binding: 2, resource: { buffer: dirBuffer } },
    ],
  });
}

function runBlur(encoder, sceneTextureView) {
  // Step 1: horizontal blur, sample texA, render into texB.
  // (texA is assumed to already hold the scene image.)
  let read = texA;
  let write = texB;

  const hPass = encoder.beginRenderPass({
    label: "blur-horizontal",
    colorAttachments: [{ view: write.createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  hPass.setPipeline(blurPipeline);
  hPass.setBindGroup(0, makeBlurBindGroup(read, horizontalDir));
  hPass.draw(3);
  hPass.end();
  [read, write] = [write, read];                 // swap roles

  // Step 2: vertical blur, sample the horizontal result, render into the other texture.
  const vPass = encoder.beginRenderPass({
    label: "blur-vertical",
    colorAttachments: [{ view: write.createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  vPass.setPipeline(blurPipeline);
  vPass.setBindGroup(0, makeBlurBindGroup(read, verticalDir));
  vPass.draw(3);
  vPass.end();
  [read, write] = [write, read];

  // The blurred result is now in `read`. A later pass samples read.createView().
  return read;
}
```

Each pass samples a different texture than it writes, so the read-write hazard never
occurs. The final blurred texture is whichever texture `read` points to after the last
swap.
