/** Local WebGPU integration: visit every texel in the projected min-depth footprint. */
export const HZB_FOOTPRINT_WGSL = /* wgsl */ `
fn hzb_footprint_min_depth(hzb: texture_2d<f32>, uv_min: vec2f, uv_max: vec2f) -> f32 {
  let base = textureDimensions(hzb, 0);
  let extent = (uv_max - uv_min) * vec2f(base);
  let mip = min(u32(ceil(log2(max(max(extent.x, extent.y), 1.0)))), textureNumLevels(hzb) - 1u);
  let size = textureDimensions(hzb, i32(mip));
  let last = vec2i(size - vec2u(1u));
  let lo = clamp(vec2i(floor(uv_min * vec2f(size))), vec2i(0), last);
  let hi = clamp(vec2i(floor(uv_max * vec2f(size))), vec2i(0), last);
  // Normally at most 2x2. Include endpoints and tolerate FP/NPOT boundaries;
  // fail open if an unexpected footprint would exceed the bounded 4x4 query.
  if (any(hi - lo > vec2i(3)) || any(hi < lo)) { return 0.0; }
  var farthest = 1.0;
  for (var y = lo.y; y <= hi.y; y++) {
    for (var x = lo.x; x <= hi.x; x++) {
      let z = textureLoad(hzb, vec2i(x, y), i32(mip)).x;
      if (!(z >= 0.0 && z <= 1.0)) { return 0.0; }
      farthest = min(farthest, z);
    }
  }
  return farthest;
}
`;
