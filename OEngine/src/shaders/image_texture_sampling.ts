/** Logical-domain filtering for padded BC allocations. Cost is bounded to eight
 * anisotropic taps, two mip levels and four texel loads per level. Aligned sources
 * retain hardware filtering; no source rescale or per-frame metadata scan. */
export const IMAGE_TEXTURE_SAMPLE_WGSL = /* wgsl */ `
fn image_texture_address(value: i32, size: i32, mode: u32) -> i32 {
  if mode == 0u {
    return clamp(value, 0, size - 1);
  }
  let period = select(size, size * 2, mode == 2u);
  let wrapped = ((value % period) + period) % period;
  return select(wrapped, period - wrapped - 1, mode == 2u && wrapped >= size);
}

fn image_texture_texel(image: texture_2d_array<f32>, layer: i32, at: vec2i,
  size: vec2i, mip: i32, address: u32) -> vec4f {
  let coordinate = vec2i(image_texture_address(at.x, size.x, address & 3u),
    image_texture_address(at.y, size.y, (address >> 2u) & 3u));
  return textureLoad(image, coordinate, layer, mip);
}

fn image_texture_level(image: texture_2d_array<f32>, layer: i32, uv: vec2f,
  logical: vec2f, mip: i32, address: u32, linear: bool) -> vec4f {
  let size = vec2i(max(floor(logical / exp2(f32(mip))), vec2f(1.0)));
  if !linear {
    return image_texture_texel(image, layer, vec2i(floor(uv * vec2f(size))), size, mip, address);
  }
  let pixel = uv * vec2f(size) - 0.5;
  let base = vec2i(floor(pixel));
  let weight = fract(pixel);
  let a = image_texture_texel(image, layer, base, size, mip, address);
  let b = image_texture_texel(image, layer, base + vec2i(1, 0), size, mip, address);
  let c = image_texture_texel(image, layer, base + vec2i(0, 1), size, mip, address);
  let d = image_texture_texel(image, layer, base + vec2i(1, 1), size, mip, address);
  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}

fn image_texture_sample(image: texture_2d_array<f32>, image_sampler: sampler,
  reference: u32, sampler_class: u32, uv: vec2f, layer: i32, dx: vec2f, dy: vec2f,
  logical: vec2f, anisotropy: f32) -> vec4f {
  if all(vec2f(textureDimensions(image, 0)) == logical) {
    return oengine_sample_texture_clamped(image, image_sampler, reference, sampler_class, uv, layer, dx, dy);
  }
  let max_mip = f32(textureNumLevels(image) - 1u);
  let address = sampler_class & 15u;
  let linear = (sampler_class & OENGINE_MATERIAL_SAMPLER_LINEAR) != 0u;
  let x = dx * logical;
  let y = dy * logical;
  // Eigenvalues of J*transpose(J): screen-rotation independent footprint axes.
  let a = x.x * x.x + y.x * y.x;
  let b = x.x * x.y + y.x * y.y;
  let c = x.y * x.y + y.y * y.y;
  let radius = sqrt(max(0.0, (a - c) * (a - c) + 4.0 * b * b));
  let major_squared = max(0.0, (a + c + radius) * 0.5);
  let major = sqrt(major_squared);
  let minor = max(1.0, sqrt(max(0.0, (a + c - radius) * 0.5)));
  let minor_clamped = max(minor, major / max(anisotropy, 1.0));
  let lod = clamp(log2(minor_clamped), 0.0, max_mip);
  if !linear {
    return image_texture_level(image, layer, uv, logical,
      i32(clamp(round(log2(max(1.0, major))), 0.0, max_mip)), address, false);
  }
  var direction = vec2f(1.0, 0.0);
  if abs(b) > 1e-12 {
    direction = normalize(vec2f(b, major_squared - a));
  } else if c > a {
    direction = vec2f(0.0, 1.0);
  }
  let taps = u32(clamp(ceil(major / minor_clamped), 1.0, min(8.0, anisotropy)));
  let low = i32(floor(lod));
  let high = min(low + 1, i32(max_mip));
  var value = vec4f(0.0);
  for (var tap = 0u; tap < taps; tap++) {
    let offset = ((f32(tap) + 0.5) / f32(taps) - 0.5) * major * direction / logical;
    let first = image_texture_level(image, layer, uv + offset, logical, low, address, true);
    let second = image_texture_level(image, layer, uv + offset, logical, high, address, true);
    value += mix(first, second, fract(lod));
  }
  return value / f32(taps);
}
`;
