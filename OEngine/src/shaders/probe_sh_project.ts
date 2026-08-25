/**
 * probe_sh_project：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const PROBE_SH_PROJECT_SETTINGS_BYTES = 20;
export const PROBE_SH_PROJECT_WORKGROUP_SIZE = 16;
export const PROBE_SH_COEFFICIENT_FLOATS = 12;

export function probeShProjectBufferBytes(
  probeUpdateCount: number,
  probeResolution: number
): number {
  return (
    probeResolution *
    probeResolution *
    probeUpdateCount *
    PROBE_SH_COEFFICIENT_FLOATS *
    Float32Array.BYTES_PER_ELEMENT
  );
}

export const PROBE_SH_PROJECT_WGSL = /* wgsl */ `
const PI: f32 = 3.1415926535897932384626433832795;

struct ProbeShProjectSettings {
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_resolution: u32,
  probe_count: u32,
  probes_per_row: u32,
};

@group(0) @binding(0) var<uniform> settings: ProbeShProjectSettings;
@group(1) @binding(0) var<storage, read_write> coefficients: array<f32>;
@group(1) @binding(1) var attenuation: texture_2d<u32>;

fn grid2d_to_index(position: vec2u, width: u32) -> u32 {
  return position.y * width + position.x;
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn rgbe9995_decode(packed: u32) -> vec3f {
  let fields = vec4f(
    (vec4u(packed) >> vec4u(0u, 9u, 18u, 27u)) &
      vec4u(0x1ffu, 0x1ffu, 0x1ffu, 0x1fu)
  );
  return fields.rgb * exp2(fields.a - 15.0 - 9.0);
}

fn spherical_triangle_area(a: vec3f, b: vec3f, c: vec3f) -> f32 {
  let dot_ab = dot(a, b);
  let dot_bc = dot(b, c);
  let dot_ca = dot(c, a);
  let sin_ab_squared = 1.0 - dot_ab * dot_ab;
  let sin_bc_squared = 1.0 - dot_bc * dot_bc;
  let mixed = dot_ca - dot_ab * dot_bc;
  let determinant = sqrt(
    sin_ab_squared * sin_bc_squared - mixed * mixed
  );
  let denominator_factor = (1.0 - dot_ab) * (1.0 - dot_bc);
  return 2.0 * atan2(
    determinant,
    sqrt(
      (
        sin_ab_squared *
        sin_bc_squared *
        (1.0 + dot_bc) *
        (1.0 + dot_ab)
      ) / denominator_factor
    ) + mixed
  );
}

fn octahedral_texel_solid_angle(uv: vec2f, texel_size: f32) -> f32 {
  let bottom_right = uv_octahedral_unit_decode(
    uv + vec2f(0.5, -0.5) * texel_size
  );
  let top_left = uv_octahedral_unit_decode(
    uv + vec2f(-0.5, 0.5) * texel_size
  );
  let first = spherical_triangle_area(
    uv_octahedral_unit_decode(uv + vec2f(-0.5, -0.5) * texel_size),
    bottom_right,
    top_left
  );
  let second = spherical_triangle_area(
    uv_octahedral_unit_decode(uv + vec2f(0.5, 0.5) * texel_size),
    top_left,
    bottom_right
  );
  return first + second;
}

fn sh2_basis(direction: vec3f) -> array<f32, 4> {
  return array<f32, 4>(
    0.28209479177387814,
    0.4886025119029199 * direction.y,
    0.4886025119029199 * direction.z,
    0.4886025119029199 * direction.x
  );
}

fn read_probe_radiance(probe: u32, texel: vec2u) -> vec3f {
  let padded_resolution = settings.probe_resolution + 2u;
  let atlas_patches = textureDimensions(attenuation) / padded_resolution;
  let atlas_patch = index_to_grid2d(probe, atlas_patches.x);
  let atlas_texel = texel + vec2u(1u) + atlas_patch * padded_resolution;
  return rgbe9995_decode(textureLoad(attenuation, vec2i(atlas_texel), 0).r);
}

fn coefficient_word_offset(local_probe: u32, texel: vec2u) -> u32 {
  let resolution = settings.probe_resolution;
  let texel_index = grid2d_to_index(texel, resolution);
  return (
    local_probe * resolution * resolution + texel_index
  ) * ${PROBE_SH_COEFFICIENT_FLOATS}u;
}

@compute @workgroup_size(${PROBE_SH_PROJECT_WORKGROUP_SIZE}, ${PROBE_SH_PROJECT_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let pixel = global_id.xy;
  let resolution = settings.probe_resolution;
  let probe_texel = pixel % resolution;
  let local_probe = grid2d_to_index(
    pixel / resolution,
    settings.probes_per_row
  );
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;
  let radiance = read_probe_radiance(probe_index, probe_texel);
  let uv = texel_coordinate_to_uv(vec2f(probe_texel), vec2u(resolution));
  let direction = uv_octahedral_unit_decode(uv);
  let basis = sh2_basis(direction);
  let solid_angle = octahedral_texel_solid_angle(uv, 1.0 / f32(resolution));
  let output_offset = coefficient_word_offset(local_probe, probe_texel);

  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    let value = radiance * (basis[coefficient] * solid_angle);
    let coefficient_offset = output_offset + coefficient * 3u;
    coefficients[coefficient_offset] = value.r;
    coefficients[coefficient_offset + 1u] = value.g;
    coefficients[coefficient_offset + 2u] = value.b;
  }
}
`;
