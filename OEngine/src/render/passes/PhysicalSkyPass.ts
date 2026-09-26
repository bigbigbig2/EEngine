import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";
import { ENVIRONMENT_BACKGROUND_FORMAT } from "../../shaders/environment_ibl.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "../../shaders/atmosphere/runtime.js";

const SKY_WGSL = `${PACKED_CAMERA_TYPE.wgsl_declaration}
${ATMOSPHERE_RUNTIME_WGSL}
@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var transmittance: texture_2d<f32>;
@group(0) @binding(3) var scattering: texture_3d<f32>;
@group(0) @binding(4) var higher_order: texture_3d<f32>;
@group(0) @binding(5) var<uniform> environment: PhysicalEnvironmentParameters;
@group(0) @binding(6) var lut_sampler: sampler;
struct SkyVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> SkyVertex {
  let p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0))[index];
  return SkyVertex(vec4f(p, 0.0, 1.0), p * vec2f(0.5,-0.5) + vec2f(0.5));
}
@fragment fn fs_main(@builtin(position) position: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  if (textureLoad(depth, pixel, 0) > 0.0001) { discard; }
  let clip = vec4f(uv * vec2f(2.0,-2.0) + vec2f(-1.0,1.0), 0.0, 1.0);
  let world = camera.view_projection_matrix_inverse * clip;
  let camera_position = camera.transform[3].xyz * environment.world_to_unit;
  let direction = normalize(world.xyz / max(world.w, 1e-5) - camera.transform[3].xyz);
  return vec4f(atmosphere_sky(camera_position, direction, normalize(-environment.sun_direction_world),
    transmittance, scattering, higher_order, lut_sampler), 1.0);
}
`;

const PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Physical Sky",
  layout: { label: "Renderer/Physical Sky layout", bindGroupLayouts: [{ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
  ] }] },
  vertex: { module: { code: SKY_WGSL }, entryPoint: "vs_main" },
  fragment: { module: { code: SKY_WGSL }, entryPoint: "fs_main", targets: [{ format: ENVIRONMENT_BACKGROUND_FORMAT }] },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "equal" }
};

export class PhysicalSkyPass {
  private pipeline: GPURenderPipeline | null = null;
  constructor(private readonly graphics: GraphicsContext) {}
  addToGraph(graph: FrameGraph, input: {
    hdr: ResourceId; depth: ResourceId; camera: ResourceId; transmittance: ResourceId;
    scattering: ResourceId; higherOrder: ResourceId; environment: ResourceId;
  }): ResourceId {
    this.pipeline ??= this.graphics.render_pipelines.obtain(PIPELINE);
    const pass = graph.add("Environment/Physical Sky radiance", input, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (!encoder || !this.pipeline) throw new Error("PhysicalSkyPass is not initialized");
      const render = encoder.beginRenderPass({ label: "Environment/Physical Sky radiance",
        colorAttachments: [{ view: resolveTextureView(resources.get(output)), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: resolveDepthAttachmentView(resources.get(data.depth)), depthReadOnly: true } });
      render.setPipeline(this.pipeline);
      this.graphics.setPipelineBindings(render, PIPELINE, [[
        { buffer: resources.get(data.camera) as GPUBuffer },
        resolveTextureView(resources.get(data.depth)),
        resolveTextureView(resources.get(data.transmittance)),
        resolveTextureView(resources.get(data.scattering)),
        resolveTextureView(resources.get(data.higherOrder)),
        { buffer: resources.get(data.environment) as GPUBuffer },
        this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR)
      ]]);
      render.draw(3); render.end();
    });
    const output = pass.write(input.hdr);
    pass.read(input.depth); pass.read(input.camera); pass.read(input.transmittance);
    pass.read(input.scattering); pass.read(input.higherOrder); pass.read(input.environment);
    return output;
  }
  destroy(): void { this.pipeline = null; }
}
