import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { TemporalGpuHistory } from "../TemporalGpuHistory.js";

const WGSL = /* wgsl */ `
@group(0) @binding(0) var current_color: texture_2d<f32>;
@group(0) @binding(1) var current_depth: texture_depth_2d;
@group(0) @binding(2) var current_motion: texture_2d<f32>;
@group(0) @binding(3) var previous_color: texture_2d<f32>;
@group(0) @binding(4) var previous_depth: texture_2d<f32>;
@group(0) @binding(5) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var output_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(7) var output_motion: texture_storage_2d<rg16float, write>;
@group(0) @binding(8) var<uniform> parameters: vec4u;
@compute @workgroup_size(8,8,1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let output_size = parameters.xy; if (any(id.xy >= output_size)) { return; }
  let current_size = textureDimensions(current_color);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(output_size);
  let current_pixel = min(vec2u(uv * vec2f(current_size)), current_size - vec2u(1u));
  let current = textureLoad(current_color, vec2i(current_pixel), 0);
  let depth = textureLoad(current_depth, vec2i(current_pixel), 0);
  let motion = textureLoad(current_motion, vec2i(current_pixel), 0).xy;
  let previous_uv = uv - motion;
  let previous_pixel = vec2i(clamp(previous_uv * vec2f(output_size), vec2f(0.0), vec2f(output_size - vec2u(1u))));
  var result = current.rgb;
  let history_valid = parameters.z != 0u;
  if (history_valid && all(previous_uv >= vec2f(0.0)) && all(previous_uv <= vec2f(1.0))) {
    let old_depth = textureLoad(previous_depth, previous_pixel, 0).r;
    let depth_consistent = depth <= 0.0001 || old_depth <= 0.0001 || abs(old_depth - depth) < 0.02;
    if (depth_consistent) { result = mix(current.rgb, textureLoad(previous_color, previous_pixel, 0).rgb, 0.9); }
  }
  textureStore(output_color, vec2i(id.xy), vec4f(result, current.a));
  textureStore(output_depth, vec2i(id.xy), vec4f(depth, 0.0, 0.0, 0.0));
  textureStore(output_motion, vec2i(id.xy), vec4f(motion, 0.0, 0.0));
}
`;

export class AnalyticTemporalBaselinePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: "EEngine Analytic Temporal Baseline", code: WGSL });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rg16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ] });
    this.pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "main" } });
  }
  addToGraph(graph: FrameGraph, input: {
    color: ResourceId; depth: ResourceId; motion: ResourceId; history: TemporalGpuHistory;
    valid: boolean; width: number; height: number;
  }): ResourceId {
    // The baseline consumes and writes the internal-resolution Surface products.
    // Upscaling remains a separate backend concern; labeling these as output-full
    // would make the FrameGraph accept incompatible dimensions.
    const previousColor = graph.import_resource("temporal-previous-color", { kind: "imported", label: "Temporal previous color", domain: "internal-full" }, input.history.getTexture("color", input.history.readIndex as 0 | 1));
    const previousDepth = graph.import_resource("temporal-previous-depth", { kind: "imported", label: "Temporal previous depth", domain: "internal-full" }, input.history.getTexture("depth", input.history.readIndex as 0 | 1));
    const outputColorHistory = graph.import_resource("temporal-current-color-history", { kind: "imported", label: "Temporal current color history", domain: "internal-full" }, input.history.getTexture("color", input.history.writeIndex as 0 | 1));
    const outputDepthHistory = graph.import_resource("temporal-current-depth-history", { kind: "imported", label: "Temporal current depth history", domain: "internal-full" }, input.history.getTexture("depth", input.history.writeIndex as 0 | 1));
    const outputMotionHistory = graph.import_resource("temporal-current-motion-history", { kind: "imported", label: "Temporal current motion history", domain: "internal-full" }, input.history.getTexture("motion", input.history.writeIndex as 0 | 1));
    const parameters = graph.import_resource("temporal-parameters", { kind: "imported", label: "Temporal frame parameters" }, input.history.parameters);
    const node = graph.add("EEngine Analytic Temporal Baseline", { ...input, previousColor, previousDepth, outputColorHistory, outputDepthHistory, outputMotionHistory, parameters }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(data.color)) }, { binding: 1, resource: resolveTextureView(resources.get(data.depth)) },
        { binding: 2, resource: resolveTextureView(resources.get(data.motion)) }, { binding: 3, resource: resolveTextureView(resources.get(data.previousColor)) },
        { binding: 4, resource: resolveTextureView(resources.get(data.previousDepth)) }, { binding: 5, resource: resolveTextureView(resources.get(output)) },
        { binding: 6, resource: resolveTextureView(resources.get(data.outputDepthHistory)) }, { binding: 7, resource: resolveTextureView(resources.get(data.outputMotionHistory)) },
        { binding: 8, resource: { buffer: resources.get(data.parameters) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "EEngine Analytic Temporal Baseline" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(input.history.width / 8), Math.ceil(input.history.height / 8)); pass.end();
    });
    const output = node.create("Temporal/reconstructed-color", { kind: "transient_texture", width: input.history.width, height: input.history.height, format: "rgba16float", domain: "internal-full", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    node.read(input.color); node.read(input.depth); node.read(input.motion); node.read(previousColor); node.read(previousDepth); node.read(parameters);
    node.write(outputColorHistory); node.write(outputDepthHistory); node.write(outputMotionHistory); return output;
  }
  destroy(): void {}
}
