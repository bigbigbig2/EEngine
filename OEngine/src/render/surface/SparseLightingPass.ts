import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const SPARSE_LIGHTING_WGSL = /* wgsl */ `
@group(0) @binding(0) var fields: texture_2d_array<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> settings: vec4u;

fn saturate(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn schlick(f0: vec3f, cosine: f32) -> vec3f {
  let f = pow(1.0 - saturate(cosine), 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}
fn field(pixel: vec2i, layer: u32) -> f32 { return textureLoad(fields, pixel, i32(layer), 0).x; }
fn field3(pixel: vec2i, layer: u32) -> vec3f {
  let v = textureLoad(fields, pixel, i32(layer), 0).x;
  return vec3f(v);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.x || id.y >= settings.y { return; }
  let p = vec2i(id.xy);
  let diffuseP = vec2i((id.xy / vec2u(2u)) * vec2u(2u));
  let albedo = field3(diffuseP, 0u);
  let metallic = saturate(field(p, 2u));
  let roughness = max(field(p, 3u), 0.045);
  let occlusion = saturate(field(p, 4u));
  let emissive = field3(p, 5u);
  let normalSample = field3(p, 6u) * 2.0 - vec3f(1.0);
  let n = normalize(select(vec3f(0.0, 0.0, 1.0), normalSample, dot(normalSample, normalSample) > 1e-5));
  let l = normalize(vec3f(-0.35, 0.8, 0.45));
  let v = normalize(vec3f(0.0, 0.0, 1.0));
  let h = normalize(l + v);
  let ndl = saturate(dot(n, l));
  let ndv = saturate(dot(n, v));
  let ndh = saturate(dot(n, h));
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let alpha = roughness * roughness;
  let d = alpha * alpha / max(3.14159265 * pow(ndh * ndh * (alpha * alpha - 1.0) + 1.0, 2.0), 1e-4);
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  let g = ndl / max(ndl * (1.0 - k) + k, 1e-4) * ndv / max(ndv * (1.0 - k) + k, 1e-4);
  let specular = schlick(f0, dot(h, v)) * (d * g / max(4.0 * ndl * ndv, 1e-4));
  let diffuse = albedo * (1.0 - metallic) * (ndl * 0.85 + 0.15) * occlusion;
  textureStore(output, p, vec4f(diffuse + specular * ndl + emissive, 1.0));
}
`;

export interface SparseLightingProducts { readonly radiance: ResourceId; }

/** Final opaque HDR producer for the rebuilt Surface chain. Diffuse is sampled
 * on a 2x2 signal footprint while view-dependent specular and material fields
 * remain full-rate; all work stays in the frame graph and one submit. */
export class SparseLightingPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: "Surface sparse lighting", code: SPARSE_LIGHTING_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Surface sparse lighting layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface sparse lighting", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "main" } });
  }
  addToGraph(graph: FrameGraph, input: { readonly fields: ResourceId; readonly depth: ResourceId; readonly width: number; readonly height: number }): SparseLightingProducts {
    let radiance = -1;
    const pass = graph.add("Surface sparse lighting and HDR", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = command.allocateTransientBufferAndLoad(new Uint32Array([data.width, data.height, 2, 1]).buffer, GPUBufferUsage.UNIFORM);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(data.fields), { dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 13 }) },
        { binding: 1, resource: resolveTextureView(resources.get(data.depth)) },
        { binding: 2, resource: resolveTextureView(resources.get(radiance)) },
        { binding: 3, resource: { buffer: settings } }
      ] });
      const compute = command.beginComputePass({ label: "Surface sparse lighting" });
      compute.setPipeline(this.pipeline); compute.setBindGroup(0, group);
      compute.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8)); compute.end();
    });
    pass.read(input.fields); pass.read(input.depth);
    radiance = pass.create("Surface pre-exposed HDR radiance", { kind: "transient_texture", width: input.width, height: input.height, format: "rgba16float", domain: "internal-full", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    return { radiance };
  }
  destroy(): void { /* device-owned pipeline is retired with the device */ }
}
