import { scgiInteger, type ScgiBufferLimits } from "./ScgiCapacity.js";

/** Screen gather owns its statistics; no byte aliases a world seed/history.
 * Residual: twelve signed half coefficients, f32 power-of-two scale, f32 confidence.
 * Probe: f32 SH (48), position/depth (16), normal/confidence (16), identity (64),
 * variance/count/anchor/source (16). Direction records are frame scratch only. */
export const SCGI_GATHER = Object.freeze({
  residualStride: 32,
  probeStride: 160,
  directionStride: 32,
  sourceStride: 16,
  hitStride: 96
});

export function planScgiGather(
  limits: ScgiBufferLimits,
  width: number,
  height: number,
  tile: number,
  directions: number,
  batch: number
) {
  for (const [name, value] of Object.entries({ width, height, tile, directions, batch })) {
    scgiInteger(value, `gather ${name}`);
  }
  if (tile < 4 || tile % 2 !== 0 || directions > 256) {
    throw new RangeError("SCGI gather requires even tiles >=4 and at most 256 directions");
  }
  if (batch < directions) {
    throw new RangeError("SCGI gather batch must contain one complete probe");
  }
  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const probes = scgiInteger(columns * rows, "screen probes");
  const maximum = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const probeBytes = probes * SCGI_GATHER.probeStride;
  const probeBatch = Math.max(1, Math.floor(batch / directions));
  const directionBytes = probeBatch * directions * SCGI_GATHER.directionStride;
  if (probeBytes > maximum || directionBytes > maximum || batch * 176 > maximum) {
    throw new RangeError("SCGI gather complete probe/direction domain exceeds negotiated binding capacity");
  }
  return Object.freeze({
    width,
    height,
    halfWidth,
    halfHeight,
    columns,
    rows,
    probes,
    tile,
    directions,
    batch,
    probeBatch,
    probeBytes,
    directionBytes,
    sourceBytes: halfWidth * halfHeight * SCGI_GATHER.sourceStride,
    historyBytes: probeBytes * 2,
    queryBytes: batch * 176,
    raysPerFrame: probes * directions
  });
}

/** Analytic inverse of the hemisphere SH Gram matrix. Inputs are cosine-convolved
 * irradiance coefficients, output is a signed directional radiance prediction.
 * This is deliberately independent of exposure, L0 and accepted sample count. */
export function scgiGatherPrediction(
  irradiance: ArrayLike<number>,
  normal: ArrayLike<number>,
  direction: ArrayLike<number>
): readonly number[] {
  const result = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const l0 = irradiance[channel]! / Math.PI;
    const vector = [0, 1, 2].map((axis) => irradiance[3 + axis * 3 + channel]! / ((2 * Math.PI) / 3));
    const u = vector.reduce((sum, value, axis) => sum + value * normal[axis]!, 0);
    const a0 = 8 * l0 - 4 * Math.sqrt(3) * u;
    let prediction = a0 * 0.28209479177387814;
    for (let axis = 0; axis < 3; axis++) {
      prediction +=
        (2 * vector[axis]! + (6 * u - 4 * Math.sqrt(3) * l0) * normal[axis]!) *
        0.4886025119029199 *
        direction[axis]!;
    }
    result[channel] = prediction;
  }
  return result;
}

export const SCGI_GATHER_MATH_WGSL = /* wgsl */ `
const GATHER_Y0: f32 = 0.28209479177387814;
const GATHER_Y1: f32 = 0.4886025119029199;
const GATHER_PI: f32 = 3.141592653589793;
fn gather_prediction(c: array<vec3f, 4>, n: vec3f, direction: vec3f) -> vec3f {
  let l0 = c[0] / GATHER_PI;
  let lx = c[1] / (2.0 * GATHER_PI / 3.0);
  let ly = c[2] / (2.0 * GATHER_PI / 3.0);
  let lz = c[3] / (2.0 * GATHER_PI / 3.0);
  let u = n.x * lx + n.y * ly + n.z * lz;
  let correction = 6.0 * u - 4.0 * sqrt(3.0) * l0;
  return (8.0 * l0 - 4.0 * sqrt(3.0) * u) * GATHER_Y0 +
    GATHER_Y1 * (direction.x * (2.0 * lx + correction * n.x) +
      direction.y * (2.0 * ly + correction * n.y) +
      direction.z * (2.0 * lz + correction * n.z));
}
`;
