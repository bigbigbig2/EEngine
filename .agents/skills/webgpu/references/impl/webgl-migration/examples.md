# WebGL to WebGPU: Verified Examples

All code targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). API names verified against the W3C WebGPU specification and Chrome's "From WebGL to WebGPU" guide.

## Example 1: a WebGL textured-quad pattern ported to WebGPU

### The WebGL2 original

```js
// WebGL2: draw one textured quad. Global state, name-based uniforms,
// immediate execution, automatic mipmaps.
const program = createProgram(gl, vsGLSL, fsGLSL);
gl.useProgram(program);

const uMatrix = gl.getUniformLocation(program, "u_matrix");   // by name
const uTexture = gl.getUniformLocation(program, "u_texture");

gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

gl.bindTexture(gl.TEXTURE_2D, texture);
gl.generateMipmap(gl.TEXTURE_2D);                             // automatic

gl.uniformMatrix4fv(uMatrix, false, projectionMatrix);
gl.uniform1i(uTexture, 0);
gl.enable(gl.DEPTH_TEST);                                     // global state
gl.drawArrays(gl.TRIANGLES, 0, 6);                            // immediate
```

### The WebGPU port

```js
// WebGPU: same quad. Pipeline captures state, positional bind group,
// recorded commands, manual mipmaps, [0, 1] clip-space projection.
const format = navigator.gpu.getPreferredCanvasFormat();
const context = canvas.getContext("webgpu");
context.configure({ device, format });

const module = device.createShaderModule({ label: "quad", code: wgsl });

// Pipeline captures what WebGL kept as global state (depth test, topology).
const pipeline = device.createRenderPipeline({
  label: "quad-pipeline",
  layout: "auto",
  vertex: {
    module,
    entryPoint: "vs",
    buffers: [{
      arrayStride: 16,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" },   // position
        { shaderLocation: 1, offset: 8, format: "float32x2" },   // uv
      ],
    }],
  },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
  depthStencil: {                                                // was gl.enable(DEPTH_TEST)
    format: "depth24plus",
    depthWriteEnabled: true,
    depthCompare: "less",
  },
});

// Uniforms WebGL set by name now live in one buffer bound by index.
const uniformBuffer = device.createBuffer({
  label: "quad-uniforms",
  size: 64,                                          // one mat4x4<f32>
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, projectionMatrixZeroToOne);

// Texture with mipmaps: generation is explicit (see Example 2).
const texture = device.createTexture({
  label: "quad-texture",
  size: [texWidth, texHeight],
  format: "rgba8unorm",
  mipLevelCount: 1 + Math.floor(Math.log2(Math.max(texWidth, texHeight))),
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
       | GPUTextureUsage.RENDER_ATTACHMENT,
});
device.queue.writeTexture(
  { texture }, basePixels,
  { bytesPerRow: texWidth * 4 }, [texWidth, texHeight],
);
generateMipmaps(device, texture, texWidth, texHeight);          // Example 2

const sampler = device.createSampler({
  magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
});

// Bind group: positional, @binding index matches the WGSL declaration.
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 1, resource: sampler },
    { binding: 2, resource: texture.createView() },
  ],
});

const depthTexture = device.createTexture({
  size: [canvas.width, canvas.height],
  format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

// Per frame: record, then submit. Nothing runs before queue.submit.
function frame() {
  const encoder = device.createCommandEncoder({ label: "frame" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),    // fresh each frame
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
    }],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
    },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(6);
  pass.end();                                            // close the pass
  device.queue.submit([encoder.finish()]);
}
```

### The WGSL for the port (GLSL replaced by WGSL)

```wgsl
struct Uniforms { matrix : mat4x4<f32>, }

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs(@location(0) pos : vec2<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var out : VSOut;
  out.clip_pos = u.matrix * vec4<f32>(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
```

The port keeps the same six vertices and the same texture, but: GLSL became WGSL, three `gl.uniform*` name lookups became one positional bind group, `gl.enable(DEPTH_TEST)` became `depthStencil` pipeline state, `gl.generateMipmap` became an explicit pass, and the projection matrix MUST be the `[0, 1]` Z variant.

## Example 2: a complete manual mipmap generation pass

A reusable render-pass downsample chain. Each smaller mip is rendered by sampling the previous mip with a linear sampler.

```js
// Module-level: build the mipmap pipeline once, reuse for every texture.
let mipPipeline = null;
let mipSampler = null;

function getMipPipeline(device, format) {
  if (mipPipeline) return mipPipeline;
  const module = device.createShaderModule({
    label: "mipmap-shader",
    code: `
      struct VSOut {
        @builtin(position) pos : vec4<f32>,
        @location(0) uv : vec2<f32>,
      }
      @vertex
      fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
        // Oversized triangle covering the viewport, no vertex buffer.
        let p = array<vec2<f32>, 3>(
          vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
        var out : VSOut;
        out.pos = vec4<f32>(p[vi], 0.0, 1.0);
        out.uv = (p[vi] + vec2<f32>(1.0)) * 0.5;
        out.uv.y = 1.0 - out.uv.y;          // framebuffer Y-down
        return out;
      }
      @group(0) @binding(0) var samp : sampler;
      @group(0) @binding(1) var src : texture_2d<f32>;
      @fragment
      fn fs(in : VSOut) -> @location(0) vec4<f32> {
        return textureSample(src, samp, in.uv);
      }
    `,
  });
  mipPipeline = device.createRenderPipeline({
    label: "mipmap-pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  mipSampler = device.createSampler({
    label: "mipmap-sampler",
    magFilter: "linear", minFilter: "linear",
  });
  return mipPipeline;
}

// Generate the full mip chain for one texture.
// The texture MUST have RENDER_ATTACHMENT usage and mipLevelCount > 1.
function generateMipmaps(device, texture, width, height) {
  const pipeline = getMipPipeline(device, texture.format);
  const mipCount = 1 + Math.floor(Math.log2(Math.max(width, height)));
  const encoder = device.createCommandEncoder({ label: "generate-mipmaps" });

  for (let level = 1; level < mipCount; level++) {
    const srcView = texture.createView({
      label: `mip-src-${level - 1}`,
      baseMipLevel: level - 1, mipLevelCount: 1,
    });
    const dstView = texture.createView({
      label: `mip-dst-${level}`,
      baseMipLevel: level, mipLevelCount: 1,
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: mipSampler },
        { binding: 1, resource: srcView },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: `mip-pass-${level}`,
      colorAttachments: [{
        view: dstView, loadOp: "clear", storeOp: "store",
        clearValue: [0, 0, 0, 1],
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);                            // full-screen triangle
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
```

Key points:
- `texture.createView({ baseMipLevel, mipLevelCount: 1 })` selects exactly one mip level. The source view is level `i - 1`; the destination view is level `i`.
- Each level is its own render pass because a texture mip cannot be both sampled and written in the same pass.
- The sampler is linear so each `textureSample` averages four texels of the larger level.
- Build the pipeline and sampler once and reuse; recreating them per texture is wasteful.

## Reference URLs

- https://developer.chrome.com/blog/from-webgl-to-webgpu
- https://www.w3.org/TR/webgpu/
- https://webgpu.github.io/webgpu-samples/
- https://developer.mozilla.org/en-US/docs/Web/API/GPUTexture/createView
