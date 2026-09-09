/** Camera reprojection matrices shared by the unified Surface resolve. */
export type VelocityCameraMatrices = {
  projection_matrix: ArrayLike<number>;
  view_matrix: ArrayLike<number>;
};

export function prepareVelocityMatrices(
  reprojectionRotationOut: Float32Array,
  inverseCurrentViewProjectionOut: Float32Array,
  previousViewProjectionOut: Float32Array,
  currentCamera: VelocityCameraMatrices,
  previousCamera: VelocityCameraMatrices,
  width: number,
  height: number
): void {
  const currentViewProjection = multiplyMat4d(
    currentCamera.projection_matrix,
    currentCamera.view_matrix
  );
  inverseCurrentViewProjectionOut.set(invertMat4d(currentViewProjection));
  previousViewProjectionOut.set(multiplyMat4d(
    previousCamera.projection_matrix,
    previousCamera.view_matrix
  ));

  const currentRotationView = Float64Array.from(currentCamera.view_matrix);
  currentRotationView[12] = 0;
  currentRotationView[13] = 0;
  currentRotationView[14] = 0;
  const previousRotationView = Float64Array.from(previousCamera.view_matrix);
  previousRotationView[12] = 0;
  previousRotationView[13] = 0;
  previousRotationView[14] = 0;
  const ndcReprojection = multiplyMat4d(
    multiplyMat4d(previousCamera.projection_matrix, previousRotationView),
    invertMat4d(multiplyMat4d(currentCamera.projection_matrix, currentRotationView))
  );
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const pixelFromNdc = new Float64Array([
    halfWidth, 0, 0, 0,
    0, -halfHeight, 0, 0,
    0, 0, 1, 0,
    halfWidth, halfHeight, 0, 1
  ]);
  const ndcFromPixel = new Float64Array([
    2 / width, 0, 0, 0,
    0, -2 / height, 0, 0,
    0, 0, 1, 0,
    -1, 1, 0, 1
  ]);
  reprojectionRotationOut.set(
    multiplyMat4d(multiplyMat4d(pixelFromNdc, ndcReprojection), ndcFromPixel)
  );
}

function multiplyMat4d(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset] ?? 0;
    const b1 = b[offset + 1] ?? 0;
    const b2 = b[offset + 2] ?? 0;
    const b3 = b[offset + 3] ?? 0;
    out[offset] = b0 * (a[0] ?? 0) + b1 * (a[4] ?? 0) + b2 * (a[8] ?? 0) + b3 * (a[12] ?? 0);
    out[offset + 1] = b0 * (a[1] ?? 0) + b1 * (a[5] ?? 0) + b2 * (a[9] ?? 0) + b3 * (a[13] ?? 0);
    out[offset + 2] = b0 * (a[2] ?? 0) + b1 * (a[6] ?? 0) + b2 * (a[10] ?? 0) + b3 * (a[14] ?? 0);
    out[offset + 3] = b0 * (a[3] ?? 0) + b1 * (a[7] ?? 0) + b2 * (a[11] ?? 0) + b3 * (a[15] ?? 0);
  }
  return out;
}

function invertMat4d(a: ArrayLike<number>): Float64Array {
  const a00 = a[0] ?? 0, a01 = a[1] ?? 0, a02 = a[2] ?? 0, a03 = a[3] ?? 0;
  const a10 = a[4] ?? 0, a11 = a[5] ?? 0, a12 = a[6] ?? 0, a13 = a[7] ?? 0;
  const a20 = a[8] ?? 0, a21 = a[9] ?? 0, a22 = a[10] ?? 0, a23 = a[11] ?? 0;
  const a30 = a[12] ?? 0, a31 = a[13] ?? 0, a32 = a[14] ?? 0, a33 = a[15] ?? 0;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let determinant = b00 * b11 - b01 * b10 + b02 * b09 +
    b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(determinant) < 1e-15) {
    throw new Error("Velocity matrices: camera matrix is singular");
  }
  determinant = 1 / determinant;
  return new Float64Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * determinant,
    (a02 * b10 - a01 * b11 - a03 * b09) * determinant,
    (a31 * b05 - a32 * b04 + a33 * b03) * determinant,
    (a22 * b04 - a21 * b05 - a23 * b03) * determinant,
    (a12 * b08 - a10 * b11 - a13 * b07) * determinant,
    (a00 * b11 - a02 * b08 + a03 * b07) * determinant,
    (a32 * b02 - a30 * b05 - a33 * b01) * determinant,
    (a20 * b05 - a22 * b02 + a23 * b01) * determinant,
    (a10 * b10 - a11 * b08 + a13 * b06) * determinant,
    (a01 * b08 - a00 * b10 - a03 * b06) * determinant,
    (a30 * b04 - a31 * b02 + a33 * b00) * determinant,
    (a21 * b02 - a20 * b04 - a23 * b00) * determinant,
    (a11 * b07 - a10 * b09 - a12 * b06) * determinant,
    (a00 * b09 - a01 * b07 + a02 * b06) * determinant,
    (a31 * b01 - a30 * b03 - a32 * b00) * determinant,
    (a20 * b03 - a21 * b01 + a22 * b00) * determinant
  ]);
}
