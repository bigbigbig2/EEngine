import test from "node:test";
import assert from "node:assert/strict";
import { mat4, vec3 } from "gl-matrix";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage ??= {
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  UNIFORM: 1 << 6,
  STORAGE: 1 << 7,
  INDIRECT: 1 << 8
};

const {
  computePreviousFromCurrent,
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_OFFSETS,
  packGpuInstanceRecord
} = await import("../.test-dist/gpu/GpuInstanceAbi.js");
const {
  GEOMETRY_VERTEX_DATA_TYPE_CODE,
  decodeGeometryVertexComponent,
  decodeGeometryVertexDataType,
  encodeGeometryVertexDataType
} = await import("../.test-dist/assets/GeometryAssetPackage.js");
const { PACKED_MATERIAL_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/packed_material_resolve.js"
);

test("R2-D motion ABI maps current world positions to previous for translation, rotation and scale", () => {
  const current = mat4.create();
  const previous = mat4.create();
  mat4.fromRotationTranslationScale(
    current,
    [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
    [7, -2, 4],
    [2, 3, 0.5]
  );
  mat4.fromRotationTranslationScale(
    previous,
    [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
    [-3, 5, 1],
    [0.75, 4, 2]
  );
  const motion = new Float32Array(16);
  assert.equal(computePreviousFromCurrent(motion, current, previous), true);
  const local = [0.3, -0.2, 0.9];
  const currentWorld = vec3.transformMat4(vec3.create(), local, current);
  const reconstructedPrevious = vec3.transformMat4(vec3.create(), currentWorld, motion);
  const expectedPrevious = vec3.transformMat4(vec3.create(), local, previous);
  assertVectorClose(reconstructedPrevious, expectedPrevious, 2e-5);
});

test("R2-D singular motion is explicitly flagged and Packed Velocity cannot execute a per-pixel inverse", () => {
  const current = new Float32Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    2, 3, 4, 1
  ]);
  const bytes = packGpuInstanceRecord({
    geometryRecordIndex: 1,
    materialHandle: 2,
    flags: GPU_INSTANCE_FLAGS.Active,
    debugId: 3,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    currentObjectToWorld: current,
    previousObjectToWorld: mat4.create()
  });
  const view = new DataView(bytes.buffer);
  assert.notEqual(
    view.getUint32(GPU_INSTANCE_RECORD_OFFSETS.flags, true) & GPU_INSTANCE_FLAGS.MotionInvalid,
    0
  );
  assert.deepEqual(
    readMatrix(view, GPU_INSTANCE_RECORD_OFFSETS.previous_from_current),
    [...mat4.create()]
  );
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /mat4_inverse|inverse\s*\(/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /oengine_instance_motion_valid/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /instance\.previous_from_current/);

  const nearSingular = new Float32Array([
    1, 0, 0, 0,
    1, 1e-10, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
  const motion = new Float32Array(16);
  assert.equal(computePreviousFromCurrent(motion, nearSingular, mat4.create()), false);
  const smallButConditioned = mat4.fromScaling(mat4.create(), [1e-6, 1e-6, 1e-6]);
  assert.equal(computePreviousFromCurrent(motion, smallButConditioned, mat4.create()), true);
});

test("R2-D Packed Material uses canonical direct descriptors and analytic gradients", () => {
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /find_stream/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.normal_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.tangent_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.color_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.uv0_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.uv1_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.uv2_byte_offset/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /\bdpdx\b|\bdpdy\b/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /perspective_barycentric_with_derivatives/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /return projected\.xy \/ projected\.w/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /frame\.tangent_matrix \* local_tangent4\.xyz/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /frame\.orientation/);
});

test("R2-D Packed Material covers glTF 8/16-bit and OEngine 32-bit normalized boundaries", () => {
  const boundaryCases = [
    ["int8", true, -128, -1],
    ["int8", true, -127, -1],
    ["int8", true, -1, -1 / 127],
    ["int8", true, 0, 0],
    ["int8", true, 1, 1 / 127],
    ["int8", true, 127, 1],
    ["uint8", true, 0, 0],
    ["uint8", true, 1, 1 / 255],
    ["uint8", true, 254, 254 / 255],
    ["uint8", true, 255, 1],
    ["int16", true, -32768, -1],
    ["int16", true, -32767, -1],
    ["int16", true, -1, -1 / 32767],
    ["int16", true, 0, 0],
    ["int16", true, 1, 1 / 32767],
    ["int16", true, 32767, 1],
    ["uint16", true, 0, 0],
    ["uint16", true, 1, 1 / 65535],
    ["uint16", true, 65534, 65534 / 65535],
    ["uint16", true, 65535, 1],
    ["int32", true, -2147483648, -1],
    ["int32", true, -2147483647, -1],
    ["int32", true, 0, 0],
    ["int32", true, 2147483647, 1],
    ["uint32", true, 0, 0],
    ["uint32", true, 4294967295, 1],
    ["int16", false, -32768, -32768],
    ["uint16", false, 65535, 65535]
  ];
  for (const [type, normalized, input, expected] of boundaryCases) {
    assertClose(decodeGeometryVertexComponent(input, type, normalized), expected, 1e-12);
    const code = encodeGeometryVertexDataType(type);
    assert.equal(code, GEOMETRY_VERTEX_DATA_TYPE_CODE[type]);
    assert.equal(decodeGeometryVertexDataType(code), type);
  }

  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /max\(f32\(value\) \/ 127\.0, -1\.0\)/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /f32\(value\) \/ 255\.0/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /max\(f32\(value\) \/ 32767\.0, -1\.0\)/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /f32\(value\) \/ 65535\.0/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /max\(f32\(value\) \/ 2147483647\.0, -1\.0\)/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /f32\(word\) \/ 4294967295\.0/);
});

test("three.js analytic perspective UV gradients agree with finite differences", () => {
  const projected = [
    [100, 100, 0, 1],
    [1_000, 200, 0, 2],
    [300, 900, 0, 3]
  ];
  const uv = [[0.1, 0.2], [0.9, 0.1], [0.3, 0.95]];
  const sample = perspectiveBarycentric([220, 160], projected);
  assertClose(sum(sample.weights), 1, 1e-12);
  assertClose(sum(sample.ddx), 0, 1e-12);
  assertClose(sum(sample.ddy), 0, 1e-12);
  const analyticDx = interpolate2(uv, sample.ddx);
  const analyticDy = interpolate2(uv, sample.ddy);
  const epsilon = 1e-3;
  const finiteDx = scale2(sub2(
    interpolatedUv([220 + epsilon, 160], projected, uv),
    interpolatedUv([220 - epsilon, 160], projected, uv)
  ), 0.5 / epsilon);
  const finiteDy = scale2(sub2(
    interpolatedUv([220, 160 + epsilon], projected, uv),
    interpolatedUv([220, 160 - epsilon], projected, uv)
  ), 0.5 / epsilon);
  assertVectorClose(analyticDx, finiteDx, 2e-8);
  assertVectorClose(analyticDy, finiteDy, 2e-8);
  assertVectorClose(perspectiveBarycentric([100, 100], projected).weights, [1, 0, 0], 1e-12);
});

test("mirrored non-uniform transforms preserve inverse-transpose normals and tangent handedness", () => {
  const linear = [[-2, 0, 0], [0, 3, 0], [0, 0, 4]];
  const frame = objectTransformFrame(linear);
  assert.equal(frame.orientation, -1);
  const normal = normalize3(multiplyMat3(frame.normalMatrix, normalize3([1, 1, 0])));
  assertVectorClose(normal, normalize3([-0.5, 1 / 3, 0]), 1e-12);
  const tangent = normalize3(multiplyMat3(linear, [1, 0, 0]));
  const bitangent = scale3(normalize3(cross3([0, 0, 1], tangent)), frame.orientation);
  assertVectorClose(tangent, [-1, 0, 0], 1e-12);
  assertVectorClose(bitangent, [0, 1, 0], 1e-12);
});

test("Packed sphere-frustum reference covers inside, intersect and outside", () => {
  const planes = [
    [1, 0, 0, 1], [-1, 0, 0, 1],
    [0, 1, 0, 1], [0, -1, 0, 1],
    [0, 0, 1, 1], [0, 0, -1, 1]
  ];
  assert.equal(sphereIntersectsFrustum([0, 0, 0, 0.25], planes), true);
  assert.equal(sphereIntersectsFrustum([1.2, 0, 0, 0.25], planes), true);
  assert.equal(sphereIntersectsFrustum([1.3, 0, 0, 0.25], planes), false);
});

function readMatrix(view, offset) {
  return Array.from({ length: 16 }, (_, index) => view.getFloat32(offset + index * 4, true));
}

function perspectiveBarycentric(pixel, projected) {
  const p = projected.map((value) => [value[0] / value[3], value[1] / value[3]]);
  const denominator = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0])
    + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
  const l0 = ((p[1][1] - p[2][1]) * (pixel[0] - p[2][0])
    + (p[2][0] - p[1][0]) * (pixel[1] - p[2][1])) / denominator;
  const l1 = ((p[2][1] - p[0][1]) * (pixel[0] - p[2][0])
    + (p[0][0] - p[2][0]) * (pixel[1] - p[2][1])) / denominator;
  const screen = [l0, l1, 1 - l0 - l1];
  const screenDx = [p[1][1] - p[2][1], p[2][1] - p[0][1], p[0][1] - p[1][1]].map((v) => v / denominator);
  const screenDy = [p[2][0] - p[1][0], p[0][0] - p[2][0], p[1][0] - p[0][0]].map((v) => v / denominator);
  const reciprocalW = projected.map((value) => 1 / value[3]);
  const weighted = screen.map((value, index) => value * reciprocalW[index]);
  const weightedDx = screenDx.map((value, index) => value * reciprocalW[index]);
  const weightedDy = screenDy.map((value, index) => value * reciprocalW[index]);
  const denominatorW = sum(weighted);
  return {
    weights: weighted.map((value) => value / denominatorW),
    ddx: weightedDx.map((value, index) => (value * denominatorW - weighted[index] * sum(weightedDx)) / (denominatorW ** 2)),
    ddy: weightedDy.map((value, index) => (value * denominatorW - weighted[index] * sum(weightedDy)) / (denominatorW ** 2))
  };
}

function interpolatedUv(pixel, projected, uv) {
  return interpolate2(uv, perspectiveBarycentric(pixel, projected).weights);
}

function interpolate2(values, weights) {
  return [0, 1].map((component) => values.reduce(
    (result, value, index) => result + value[component] * weights[index],
    0
  ));
}

function objectTransformFrame(matrix) {
  const determinant = dot3(matrix[0], cross3(matrix[1], matrix[2]));
  const orientation = determinant < 0 ? -1 : 1;
  const cofactor = [
    cross3(matrix[1], matrix[2]),
    cross3(matrix[2], matrix[0]),
    cross3(matrix[0], matrix[1])
  ];
  return { orientation, normalMatrix: cofactor.map((column) => scale3(column, orientation)) };
}

function multiplyMat3(matrix, vector) {
  return [0, 1, 2].map((row) => matrix[0][row] * vector[0] + matrix[1][row] * vector[1] + matrix[2][row] * vector[2]);
}

function sphereIntersectsFrustum(sphere, planes) {
  return planes.every((plane) => sphere[0] * plane[0] + sphere[1] * plane[1]
    + sphere[2] * plane[2] + plane[3] >= -sphere[3]);
}

function sum(values) { return values.reduce((result, value) => result + value, 0); }
function sub2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function scale2(value, scale) { return [value[0] * scale, value[1] * scale]; }
function scale3(value, scale) { return value.map((component) => component * scale); }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize3(value) { return scale3(value, 1 / Math.hypot(...value)); }

function assertClose(actual, expected, epsilon) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} ± ${epsilon}`);
}

function assertVectorClose(actual, expected, epsilon) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) assertClose(actual[index], expected[index], epsilon);
}
