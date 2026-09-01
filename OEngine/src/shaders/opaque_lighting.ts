import { LIGHTING_DIRECT_WGSL } from "./lighting_direct.js";

const FILAMENT_IBL_COMPOSITION = /* wgsl */ `
@group(3) @binding(0) var oengine_diffuse_irradiance: texture_2d<f32>;
@group(3) @binding(1) var oengine_split_sum: texture_2d<f32>;
@group(3) @binding(2) var oengine_ibl_sampler: sampler;
@group(3) @binding(3) var oengine_bent_normal: texture_2d<u32>;

fn oengine_oct_sign(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn oengine_oct_encode(direction: vec3f) -> vec2f {
  let denominator = max(abs(direction.x) + abs(direction.y) + abs(direction.z), 1e-6);
  var projected = direction.xy / denominator;
  if direction.z < 0.0 {
    projected = (1.0 - abs(projected.yx)) * oengine_oct_sign(projected);
  }
  return 0.5 + 0.5 * projected;
}

fn oengine_oct_wrap(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings_x = abs(position.x / resolution) + i32(position.x < 0);
  let crossings_y = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((crossings_x ^ crossings_y) & 1) != 0;
  return select(vec2u(wrapped), vec2u(resolution - (wrapped + vec2i(1))), flip);
}

fn oengine_sample_oct_lod(source: texture_2d<f32>, direction: vec3f, lod: u32) -> vec3f {
  let resolution = textureDimensions(source, i32(lod)).x;
  let texel = oengine_oct_encode(direction) * f32(resolution) - 0.5;
  let base = vec2i(floor(texel));
  let fraction = fract(texel);
  let c00 = textureLoad(source, vec2i(oengine_oct_wrap(base, i32(resolution))), i32(lod)).rgb;
  let c10 = textureLoad(source, vec2i(oengine_oct_wrap(base + vec2i(1, 0), i32(resolution))), i32(lod)).rgb;
  let c01 = textureLoad(source, vec2i(oengine_oct_wrap(base + vec2i(0, 1), i32(resolution))), i32(lod)).rgb;
  let c11 = textureLoad(source, vec2i(oengine_oct_wrap(base + vec2i(1, 1), i32(resolution))), i32(lod)).rgb;
  return mix(mix(c00, c10, fraction.x), mix(c01, c11, fraction.x), fraction.y);
}

fn oengine_sample_oct_roughness(source: texture_2d<f32>, direction: vec3f, roughness: f32) -> vec3f {
  let max_mip = textureNumLevels(source) - 1u;
  let lod = clamp(roughness, 0.0, 1.0) * f32(max_mip);
  let lower = u32(floor(lod));
  let upper = min(lower + 1u, max_mip);
  return mix(
    oengine_sample_oct_lod(source, direction, lower),
    oengine_sample_oct_lod(source, direction, upper),
    fract(lod)
  );
}

fn oengine_ibl_contribution(
  material: StandardMaterial,
  geometry: SurfaceGeometry,
  pixel: vec2u
) -> vec3f {
  let no_v = saturate(dot(geometry.shading_normal, geometry.view_direction));
  let dfg = textureSampleLevel(
    oengine_split_sum, oengine_ibl_sampler,
    vec2f(no_v, material.roughness), 0.0
  ).rg;
  let f0 = material.specularF0;
  let single = f0 * dfg.x + vec3f(material.specularF90 * dfg.y);
  let multi = single * (f0 * ((1.0 - dfg.x - dfg.y) / max(dfg.x + dfg.y, 1e-4)));
  let directional_albedo = single + multi;
  let reflected = reflect(-geometry.view_direction, geometry.shading_normal);
  let specular_direction = normalize(mix(
    reflected, geometry.shading_normal, material.roughness * material.roughness
  ));
  let radiance = oengine_sample_oct_roughness(
    sec_radix_passes, specular_direction, material.roughness
  );
  let bent = decode_g_buffer_normal(textureLoad(oengine_bent_normal, vec2i(pixel), 0).xy);
  let irradiance = oengine_sample_oct_lod(oengine_diffuse_irradiance, bent, 0u);
  let diffuse_energy = clamp(vec3f(1.0) - directional_albedo, vec3f(0.0), vec3f(1.0));
  let diffuse = material.diffuse * diffuse_energy * irradiance * RECIPROCAL_PI;
  let specular_occlusion = saturate(pow(
    saturate(dot(specular_direction, bent)) + material.occlusion,
    exp2(-16.0 * material.roughness - 1.0)
  ) - 1.0 + material.occlusion);
  return diffuse * material.occlusion + radiance * directional_albedo * specular_occlusion;
}

fn oengine_background(uv: vec2f) -> vec3f {
  let world = camera.view_projection_matrix_inverse * vec4f(uv_to_ndc(uv), 0.0, 1.0);
  return oengine_sample_oct_lod(sec_radix_passes, normalize(world.xyz), 0u);
}
`;

/**
 * Filament-style opaque composition: all direct/shadow/IBL/emissive/background
 * terms are evaluated into the final HDR target in one full-screen pass.
 */
export const OPAQUE_LIGHTING_WGSL = LIGHTING_DIRECT_WGSL
  .replace("@fragment\nfn fs_main", `${FILAMENT_IBL_COMPOSITION}\n@fragment\nfn fs_main`)
  .replace(
    "return vec4f(0.0);",
    "return vec4f(oengine_background(input.uv), 1.0);"
  )
  .replace(
    `return vec4f(shade_standard_material_direct(
    material, geometry, input.position.xy, view_depth
  ), 1.0);`,
    `let direct = shade_standard_material_direct(
    material, geometry, input.position.xy, view_depth
  );
  let indirect = oengine_ibl_contribution(material, geometry, i_coord);
  return vec4f(direct + indirect, 1.0);`
  );
