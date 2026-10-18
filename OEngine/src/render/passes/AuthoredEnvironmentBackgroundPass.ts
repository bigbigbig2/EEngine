import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { PreparedRenderPipeline } from "../../gpu/PreparedPipeline.js";
import { GpuBindGroupResourceCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "../../shaders/native_environment_sample.js";

const WGSL = /* wgsl */ `
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
@group(0) @binding(0) var source_environment: texture_2d<f32>;
@group(0) @binding(1) var depth_texture: texture_depth_2d;
@group(0) @binding(2) var<uniform> camera: Camera;
@group(0) @binding(3) var<uniform> parameters: vec4f;
@group(0) @binding(4) var<storage, read> pre_exposure: array<f32>;
struct Camera {
  transform: mat4x4f,
  transform_inverse: mat4x4f,
  view_matrix: mat4x4f,
  view_matrix_inverse: mat4x4f,
  projection_matrix: mat4x4f,
  projection_matrix_inverse: mat4x4f,
  view_projection_matrix: mat4x4f,
  view_projection_matrix_inverse: mat4x4f,
  frustum: array<vec4f, 6>,
  device_depth_to_view_space: vec4f,
};
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(f32((index << 1u) & 2u) * 2.0 - 1.0, f32(index & 2u) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if (textureLoad(depth_texture, vec2i(position.xy), 0) > 0.0) { discard; }
  let ndc = vec2f(position.x / parameters.x * 2.0 - 1.0, 1.0 - position.y / parameters.y * 2.0);
  let view_direction = normalize((camera.projection_matrix_inverse * vec4f(ndc, 1.0, 1.0)).xyz);
  let world_direction = normalize((camera.transform * vec4f(view_direction, 0.0)).xyz);
  let roughness = clamp(parameters.z, 0.0, 1.0);
  let lod = (1.0 - (1.0 - roughness) * (1.0 - roughness)) *
    f32(textureNumLevels(source_environment) - 1u);
  let low = u32(floor(lod));
  let high = min(low + 1u, textureNumLevels(source_environment) - 1u);
  let radiance = mix(
    sample_native_environment_mip(source_environment, world_direction, low),
    sample_native_environment_mip(source_environment, world_direction, high),
    fract(lod)
  );
  return vec4f(radiance * parameters.w * pre_exposure[0], 1.0);
}
`;

/** Draws authored HDR only into background pixels, preserving native surfaces. */
export class AuthoredEnvironmentBackgroundPass {
  private readonly pipeline: PreparedRenderPipeline;
  private preparedPipeline: GPURenderPipeline | null = null;
  private readonly parameters: GPUBuffer;
  private exposure = 1;
  private blur = 0;
  private readonly bindings = new GpuBindGroupResourceCache();
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();

  constructor(private readonly graphics: GraphicsContext) {
    const module = graphics.device.createShaderModule({ label: "Authored HDR background", code: WGSL });
    this.pipeline = new PreparedRenderPipeline(graphics.device, {
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "equal" },
    });
    this.parameters = graphics.device.createBuffer({
      label: "Authored background parameters",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  async preparePipelines(): Promise<void> {
    await this.pipeline.prepare();
  }

  setSettings(settings: { exposure: number; blur: number }): void {
    this.exposure = settings.exposure;
    this.blur = settings.blur;
  }

  addToGraph(
    graph: FrameGraph,
    input: { hdr: ResourceId; depth: ResourceId; camera: ResourceId; source: ResourceId; preExposure: ResourceId; width: number; height: number; exposure: number; blur: number },
  ): ResourceId {
    this.preparedPipeline ??= this.pipeline.requirePrepared();
    const pass = graph.add("Environment/Authored HDR background", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const output = resources.get(data.hdr) as GPUTexture & { gpu_texture?: GPUTexture };
      const outputTexture = output.gpu_texture ?? output;
      const source = resolveTextureView(resources.get(data.source));
      const depth = resolveTextureView(resources.get(data.depth));
      const camera = resources.get(data.camera) as GPUBuffer;
      const preExposure = resources.get(data.preExposure) as GPUBuffer;
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: source },
        { binding: 1, resource: depth },
        { binding: 2, resource: { buffer: camera } },
        { binding: 3, resource: { buffer: this.parameters } },
        { binding: 4, resource: { buffer: preExposure } },
      ];
      const bindGroup = this.bindings.obtain(
        entries.map((entry) => entry.resource),
        () => this.graphics.device.createBindGroup({
          layout: this.preparedPipeline!.getBindGroupLayout(0),
          entries,
        }),
      );
      const parameters = new Float32Array([data.width, data.height, this.blur, this.exposure]);
      command.writeBuffer(this.parameters, 0, parameters.buffer, 0, parameters.byteLength);
      let outputView = this.views.get(outputTexture);
      if (!outputView) {
        outputView = outputTexture.createView();
        this.views.set(outputTexture, outputView);
      }
      const render = command.gpu_encoder.beginRenderPass({
        label: "Environment/Authored HDR background",
        colorAttachments: [{ view: outputView, loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: {
          view: resolveDepthAttachmentView(resources.get(data.depth)),
          depthReadOnly: true,
        },
      });
      render.setPipeline(this.preparedPipeline!);
      render.setBindGroup(0, bindGroup);
      render.draw(3);
      render.end();
    });
    const output = pass.write(input.hdr);
    pass.read(input.depth);
    pass.read(input.camera);
    pass.read(input.source);
    pass.read(input.preExposure);
    return output;
  }

  destroy(): void {
    this.parameters.destroy();
    this.bindings.clear();
    this.preparedPipeline = null;
  }
}
