import { GPU_COMPUTE_MATERIAL_ABI_WGSL } from "../gpu/GpuComputeMaterialAbi.js";

/**
 * OEngine reflection replacement resolve.
 *
 * The incoming SSR has already been evaluated in the receiver's BRDF domain.
 * This pass therefore applies only confidence-weighted replacement and never
 * repeats split-sum, Fresnel, AO, or bent-normal occlusion.
 */
export const SPECULAR_CORRECTION_WGSL = /* wgsl */ `
${GPU_COMPUTE_MATERIAL_ABI_WGSL}

@group(0) @binding(0) var surface_metadata: texture_2d<u32>;
@group(0) @binding(1) var baseline_specular_source: texture_2d<f32>;
@group(0) @binding(2) var resolved_specular_source: texture_2d<f32>;

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);

struct VertexOutput { @builtin(position) position: vec4f };

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(FULLSCREEN_POSITIONS[index], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  if (oengine_surface_has_flag(textureLoad(surface_metadata, pixel, 0).r, OENGINE_SURFACE_FLAG_UNLIT)) {
    return vec4f(0.0);
  }
  let baseline = textureLoad(baseline_specular_source, pixel, 0).rgb;
  let resolved = textureLoad(resolved_specular_source, pixel, 0);
  let confidence = clamp(resolved.a, 0.0, 1.0);
  let correction = (resolved.rgb - baseline) * confidence;
  let finite = all(correction == correction) && all(abs(correction) < vec3f(65504.0));
  return vec4f(select(vec3f(0.0), correction, finite), 0.0);
}
`;
