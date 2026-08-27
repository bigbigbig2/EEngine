# Render Pipeline: Working Examples

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Every example is
verified against the W3C WebGPU specification and
`docs/research/vooronderzoek-webgpu.md` PART A section 3.

## Example 1: Minimal triangle pipeline (no vertex buffer)

The three vertices are generated entirely in WGSL from `@builtin(vertex_index)`,
so no `GPUVertexBufferLayout` is declared. This is the smallest correct render
pipeline.

```js
async function createTrianglePipeline(device) {
  const format = navigator.gpu.getPreferredCanvasFormat();

  const module = device.createShaderModule({
    label: "triangle-shader",
    code: `
      @vertex
      fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(
          vec2f( 0.0,  0.5),
          vec2f(-0.5, -0.5),
          vec2f( 0.5, -0.5),
        );
        return vec4f(p[vi], 0.0, 1.0);
      }

      @fragment
      fn fs() -> @location(0) vec4f {
        return vec4f(1.0, 0.4, 0.1, 1.0);
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    label: "triangle-pipeline",
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  return pipeline;
}
```

The `fragment.targets[0].format` equals the canvas configuration `format`, and
WGSL `@location(0)` matches `targets[0]`.

## Example 2: Pipeline with vertex buffers, blend, and depth

This pipeline reads interleaved per-vertex data (position and color) from one
vertex buffer, alpha-blends its output, and writes depth into a `"depth24plus"`
attachment.

```js
function createMeshPipeline(device, colorFormat) {
  const module = device.createShaderModule({
    label: "mesh-shader",
    code: `
      struct VSOut {
        @builtin(position) clip_pos : vec4f,
        @location(0) color : vec4f,
      }

      @vertex
      fn vs(@location(0) pos : vec3f,
            @location(1) color : vec4f) -> VSOut {
        var out : VSOut;
        out.clip_pos = vec4f(pos, 1.0);
        out.color = color;
        return out;
      }

      @fragment
      fn fs(in : VSOut) -> @location(0) vec4f {
        return in.color;
      }
    `,
  });

  return device.createRenderPipeline({
    label: "mesh-pipeline",
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [{
        // 3 floats position + 4 floats color = 28 bytes per vertex
        arrayStride: 28,
        stepMode: "vertex",
        attributes: [
          { shaderLocation: 0, offset: 0,  format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x4" },
        ],
      }],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{
        format: colorFormat,
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one-minus-src-alpha",
            operation: "add",
          },
        },
        writeMask: GPUColorWrite.ALL,
      }],
    },
    primitive: {
      topology: "triangle-list",
      frontFace: "ccw",
      cullMode: "back",
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    multisample: { count: 1 },
  });
}
```

Field correspondence in this example:

- `arrayStride` 28 equals the sum of `float32x3` (12 bytes) and `float32x4`
  (16 bytes).
- `attributes[1].offset` 12 places the color directly after the 12-byte position.
- `shaderLocation` 0 and 1 match WGSL `@location(0)` and `@location(1)`.
- `fragment.targets[0].format` is the caller-supplied `colorFormat`, which MUST
  equal the render-pass color attachment view format.
- `depthStencil.format` `"depth24plus"` MUST equal the depth attachment texture
  format.
- `multisample.count` 1 MUST equal the `sampleCount` of every attachment texture.

## Example 3: Indexed triangle-strip pipeline

A strip topology used with `drawIndexed` requires `stripIndexFormat`, and it MUST
equal the format passed to `setIndexBuffer`.

```js
const stripPipeline = device.createRenderPipeline({
  label: "strip-pipeline",
  layout: "auto",
  vertex: {
    module,
    entryPoint: "vs",
    buffers: [{
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
    }],
  },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
  primitive: {
    topology: "triangle-strip",
    stripIndexFormat: "uint16",
  },
});

// The index buffer format MUST match stripIndexFormat:
pass.setIndexBuffer(indexBuffer, "uint16");
```

## Example 4: Async pipeline creation during loading

`createRenderPipelineAsync` compiles off the content timeline. Use it for heavy
shaders during a loading phase so the frame loop is not blocked.

```js
async function loadPipelines(device, format) {
  const [opaque, transparent] = await Promise.all([
    device.createRenderPipelineAsync({
      label: "opaque-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
    }),
    device.createRenderPipelineAsync({
      label: "transparent-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module, entryPoint: "fs",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
    }),
  ]);
  return { opaque, transparent };
}
```

`createRenderPipelineAsync` rejects with a `GPUPipelineError` if the descriptor is
invalid. Both pipelines are created once and reused for every frame.

## Reference sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification)
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipeline
- https://webgpu.github.io/webgpu-samples/ (official WebGPU samples)
- `docs/research/vooronderzoek-webgpu.md` PART A section 3, PART C section 1
