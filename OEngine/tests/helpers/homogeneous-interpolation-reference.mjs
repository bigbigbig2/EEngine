// Independent double-precision Gaussian solve. Deliberately does not implement
// the production cross-product coefficients or projected-triangle division by W.
export function homogeneousWeights(clips, pixel, viewport) {
  const ndc = [(pixel[0] / viewport[0]) * 2 - 1, 1 - (pixel[1] / viewport[1]) * 2];
  const matrix = [
    clips.map((c) => c[0] - ndc[0] * c[3]),
    clips.map((c) => c[1] - ndc[1] * c[3]),
    [1, 1, 1],
  ].map((row, i) => [...row, i === 2 ? 1 : 0]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    [matrix[pivot], matrix[col]] = [matrix[col], matrix[pivot]];
    const denominator = matrix[col][col];
    if (denominator === 0 || !Number.isFinite(denominator)) return null;
    for (let entry = col; entry < 4; entry++) matrix[col][entry] /= denominator;
    for (let row = 0; row < 3; row++)
      if (row !== col) {
        const factor = matrix[row][col];
        for (let entry = col; entry < 4; entry++) matrix[row][entry] -= factor * matrix[col][entry];
      }
  }
  const weights = matrix.map((row) => row[3]);
  return weights.every(Number.isFinite) ? weights : null;
}
export function homogeneousInterpolationReference(clips, pixel, viewport) {
  const weights = homogeneousWeights(clips, pixel, viewport);
  if (!weights) return { flags: 0, weights: [0, 0, 0], dx: [0, 0, 0], dy: [0, 0, 0] };
  const x = homogeneousWeights(clips, [pixel[0] + 1, pixel[1]], viewport);
  const y = homogeneousWeights(clips, [pixel[0], pixel[1] + 1], viewport);
  return {
    weights,
    dx: x ? x.map((v, i) => v - weights[i]) : [0, 0, 0],
    dy: y ? y.map((v, i) => v - weights[i]) : [0, 0, 0],
    flags: 1 | (x ? 2 : 0) | (y ? 4 : 0),
  };
}
export function transformPosition(matrix, position) {
  return [0, 1, 2, 3].map((row) =>
    Math.fround(position.reduce((sum, value, col) => sum + value * matrix[col * 4 + row], 0)),
  );
}
export function winnerHash(key) {
  let v = key ^ (key >>> 16);
  v = Math.imul(v, 0x7feb352d);
  v ^= v >>> 15;
  v = Math.imul(v, 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}
