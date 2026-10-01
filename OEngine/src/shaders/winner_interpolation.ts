import { WINNER_COEFFICIENT_WGSL } from "../gpu/GpuWinnerInterpolationAbi.js";

/** HomogeneousWinnerInterpolation, local extension of DAIS Appendix A / Forge
 * CalcFullBary. No reciprocal vertex W: original near-clipped vertices may have
 * zero/negative W. See docs/porting/next-renderer.md for the pinned source profile.
 * Coordinates are centered NDC to avoid viewport-sized cross products. */
export const WINNER_INTERPOLATION_WGSL = /* wgsl */ `
${WINNER_COEFFICIENT_WGSL}
fn winner_finite3(v: vec3f) -> bool {
  return all(v == v) && all(abs(v) <= vec3f(3.402823466e+38));
}
fn winner_max_abs(v: vec3f) -> f32 { return max(abs(v.x), max(abs(v.y), abs(v.z))); }
fn winner_empty_coefficients() -> WinnerCoefficients {
  return WinnerCoefficients(vec4f(0.0), vec4f(0.0), vec4f(0.0));
}
fn winner_build_coefficients(a: vec4f, b: vec4f, c: vec4f) -> WinnerCoefficients {
  let ha = vec3f(a.x, a.y, a.w);
  let hb = vec3f(b.x, b.y, b.w);
  let hc = vec3f(c.x, c.y, c.w);
  if !winner_finite3(ha) || !winner_finite3(hb) || !winner_finite3(hc) {
    return winner_empty_coefficients();
  }
  let scale = max(winner_max_abs(ha), max(winner_max_abs(hb), winner_max_abs(hc)));
  if scale == 0.0 { return winner_empty_coefficients(); }
  let x = ha / scale; let y = hb / scale; let z = hc / scale;
  let r0 = cross(y, z); let r1 = cross(z, x); let r2 = cross(x, y);
  let determinant = dot(x, r0);
  let norm = max(winner_max_abs(r0), max(winner_max_abs(r1), winner_max_abs(r2)));
  if determinant == 0.0 || norm == 0.0 {
    return winner_empty_coefficients();
  }
  // All rows use one normalization, preserving relative vertex weights.
  return WinnerCoefficients(vec4f(r0 / norm, 1.0), vec4f(r1 / norm, 0.0), vec4f(r2 / norm, 0.0));
}
fn winner_interpolate(coeff: WinnerCoefficients, pixel: vec2f, viewport: vec2f) -> WinnerInterpolation {
  var result = WinnerInterpolation(vec3f(0.0), vec3f(0.0), vec3f(0.0), 0u);
  if coeff.row0.w == 0.0 { return result; }
  let p = vec3f(pixel / viewport * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 1.0);
  let q = vec3f(dot(coeff.row0.xyz, p), dot(coeff.row1.xyz, p), dot(coeff.row2.xyz, p));
  let sum = q.x + q.y + q.z;
  if sum == 0.0 { return result; }
  let weights = q / sum;
  if !winner_finite3(weights) { return result; }
  result.weights = weights; result.flags = WINNER_VALUE_VALID;
  let qx = q + vec3f(coeff.row0.x, coeff.row1.x, coeff.row2.x) * (2.0 / viewport.x);
  let qy = q - vec3f(coeff.row0.y, coeff.row1.y, coeff.row2.y) * (2.0 / viewport.y);
  let sx = qx.x + qx.y + qx.z; let sy = qy.x + qy.y + qy.z;
  // Finite one-pixel projected differences, not the quotient-rule derivative.
  // A footprint singularity never invalidates the current visible value.
  if sx != 0.0 {
    let dx = qx / sx - weights;
    if winner_finite3(dx) { result.dx = dx; result.flags |= WINNER_DX_VALID; }
  }
  if sy != 0.0 {
    let dy = qy / sy - weights;
    if winner_finite3(dy) { result.dy = dy; result.flags |= WINNER_DY_VALID; }
  }
  return result;
}
`;
