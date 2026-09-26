import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "../../shaders/atmosphere/runtime.js";

const WGSL = `${PACKED_CAMERA_TYPE.wgsl_declaration}
${ATMOSPHERE_RUNTIME_WGSL}
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var transmittance: texture_2d<f32>;
@group(0) @binding(3) var scattering: texture_3d<f32>;
@group(0) @binding(4) var higher_order: texture_3d<f32>;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
@group(0) @binding(6) var<uniform> environment: PhysicalEnvironmentParameters;
@group(0) @binding(7) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var lut_sampler: sampler;
@compute @workgroup_size(8,8,1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(scene); if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let scene_color = textureLoad(scene, pixel, 0); let d = textureLoad(depth, pixel, 0);
  let camera_position_m = camera.transform[3].xyz;
  let camera_position = atmosphere_world_to_planet(camera_position_m, environment.world_to_unit);
  let sun = normalize(-environment.sun_direction_world);
  if (d <= 0.0001) {
    textureStore(output, pixel, scene_color);
    return;
  }
  let clip = vec4f(uv * vec2f(2.0,-2.0) + vec2f(-1.0,1.0), d, 1.0);
  let world = camera.view_projection_matrix_inverse * clip;
  let point = atmosphere_world_to_planet(world.xyz / max(world.w, 1e-5), environment.world_to_unit);
  let transport = atmosphere_to_point(camera_position, point, sun, transmittance, scattering, higher_order, lut_sampler);
  textureStore(output, pixel, vec4f(scene_color.rgb * transport.transmittance +
    transport.inscattering * environment.sky_luminance_scale, scene_color.a));
}
`;

export class AerialPerspectivePass {
  private readonly pipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: "Environment/Aerial Perspective", code: WGSL });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
    ] });
    this.pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "main" } });
  }
  addToGraph(graph: FrameGraph, input: {
    scene: ResourceId; depth: ResourceId; camera: ResourceId; environment: ResourceId;
    transmittance: ResourceId; scattering: ResourceId; higherOrder: ResourceId; width: number; height: number;
  }): ResourceId {
    const node = graph.add("Environment/Aerial Perspective", input, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input.scene)) },
        { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
        { binding: 2, resource: resolveTextureView(resources.get(input.transmittance)) },
        { binding: 3, resource: resolveTextureView(resources.get(input.scattering)) },
        { binding: 4, resource: resolveTextureView(resources.get(input.higherOrder)) },
        { binding: 5, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
        { binding: 6, resource: { buffer: resources.get(input.environment) as GPUBuffer } },
        { binding: 7, resource: resolveTextureView(resources.get(output)) },
        { binding: 8, resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear" }) }
      ] });
      const pass = command.beginComputePass({ label: "Environment/Aerial Perspective" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8)); pass.end();
    });
    const output = node.create("Environment/aerial-composited-radiance", {
      kind: "transient_texture", width: input.width, height: input.height, format: "rgba16float",
      domain: "internal-full", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    node.read(input.scene); node.read(input.depth); node.read(input.camera); node.read(input.environment);
    node.read(input.transmittance); node.read(input.scattering); node.read(input.higherOrder);
    return node.write(output);
  }
  destroy(): void {}
}
