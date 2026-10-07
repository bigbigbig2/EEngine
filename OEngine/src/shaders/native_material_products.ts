/** Pure cooked-half clamp/bilinear/trilinear mathematics. No graph/opcode VM,
 * old Product ABI, runtime work protocol, or material/geometry intermediate. */
export const NATIVE_PACKED_PRODUCT_WGSL = /* wgsl */ `
fn native_product_quad(payload: texture_2d_array<f32>, texel: u32) -> vec4f {
  let dimensions = textureDimensions(payload);
  let page_texels = dimensions.x * dimensions.y;
  let pixel = texel % page_texels;
  return textureLoad(payload, vec2i(i32(pixel % dimensions.x), i32(pixel / dimensions.x)), i32(texel / page_texels), 0);
}
fn native_product_texel(payload: texture_2d_array<f32>, offset: u32, extent: vec2u, channels: u32, pixel: vec2i) -> vec4f {
  let coordinate = vec2u(clamp(pixel, vec2i(0), vec2i(extent) - vec2i(1)));
  let first = offset + (coordinate.y * extent.x + coordinate.x) * channels;
  // Mips are RGBA-texel aligned and channels are 1/2/4: a source texel
  // never straddles a packed texel, including NPOT rows and page boundaries.
  let packed = native_product_quad(payload, first / 4u);
  var value = vec4f(0.0, 0.0, 0.0, 1.0);
  for (var channel = 0u; channel < channels; channel++) {
    value[channel] = packed[(first & 3u) + channel];
  }
  return value;
}
fn native_product_bilinear(payload: texture_2d_array<f32>, material_base: u32, metadata: u32, level: u32, channels: u32, uv: vec2f) -> vec4f {
  let at = metadata + level * 4u;
  let offset = u32(native_material_constant(material_base, at)) | (u32(native_material_constant(material_base, at + 1u)) << 16u);
  let extent = vec2u(u32(native_material_constant(material_base, at + 2u)), u32(native_material_constant(material_base, at + 3u)));
  let position = clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(extent) - vec2f(0.5);
  let base = vec2i(floor(position));
  let fraction = fract(position);
  let a = native_product_texel(payload, offset, extent, channels, base);
  let b = native_product_texel(payload, offset, extent, channels, base + vec2i(1, 0));
  let c = native_product_texel(payload, offset, extent, channels, base + vec2i(0, 1));
  let d = native_product_texel(payload, offset, extent, channels, base + vec2i(1, 1));
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}
fn native_product_sample(payload: texture_2d_array<f32>, material_base: u32, metadata: u32, levels: u32, channels: u32, origin: vec2f, scale: vec2f, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let extent = vec2f(native_material_constant(material_base, metadata + 2u), native_material_constant(material_base, metadata + 3u));
  let footprint = max(length(dx * scale * extent), length(dy * scale * extent));
  let lod = clamp(log2(max(footprint, 1e-20)), 0.0, f32(levels - 1u));
  let low = u32(floor(lod));
  let high = min(low + 1u, levels - 1u);
  let coordinate = (uv - origin) * scale;
  let a = native_product_bilinear(payload, material_base, metadata, low, channels, coordinate);
  let b = native_product_bilinear(payload, material_base, metadata, high, channels, coordinate);
  return mix(a, b, fract(lod));
}
`;
