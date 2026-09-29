import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVirtualGeometrySceneSourceV1 } from '../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js';
import { PerspectiveCamera } from '../../.test-dist/camera/PerspectiveCamera.js';
import { mat4Identity, mat4TransformPoint } from '../../.test-dist/core/math/Mat4.js';

function sceneSource() {
  const records = new Uint8Array(128);
  const view = new DataView(records.buffer);
  view.setFloat32(44, 1, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat32(48 + axis * 4, -0.5, true);
    view.setFloat32(60 + axis * 4, 0.5, true);
  }
  const transform = mat4Identity();
  transform[12] = 100;
  transform[14] = -20;
  return buildVirtualGeometrySceneSourceV1(records, [{}],
    [{ assetIndex: 0, materialIndex: 0, transform }], [{}], { scale: 0.1 }).source;
}

test('Virtual Geometry publishes object-space bounds alongside the fitted object-to-world transform', () => {
  const source = sceneSource();
  assert.deepEqual([...source.boundsSpheres], [0, 0, 0, 1]);
  assert.deepEqual([...source.boundsMin], [-0.5, -0.5, -0.5]);
  assert.deepEqual([...source.boundsMax], [0.5, 0.5, 0.5]);
  assert.equal(source.currentTransforms[12], 10);
  assert.equal(source.currentTransforms[14], -2);
});

test('fitted geometry remains in the frustum through close approach, orbit and top-down views', () => {
  const source = sceneSource(), matrix = source.currentTransforms;
  const center = { x: 0, y: 0, z: 0 };
  mat4TransformPoint(center, matrix, { x: 0, y: 0, z: 0 });
  const bound = { x: 0, y: 0, z: 0 };
  mat4TransformPoint(bound, matrix, { x: source.boundsSpheres[0], y: source.boundsSpheres[1], z: source.boundsSpheres[2] });
  const radius = source.boundsSpheres[3] * Math.max(
    Math.hypot(...matrix.slice(0, 3)), Math.hypot(...matrix.slice(4, 7)), Math.hypot(...matrix.slice(8, 11)));
  const camera = new PerspectiveCamera();
  camera.near = 0.01; camera.aspect = 16 / 9;
  let cases = 0;
  for (const distance of [0.02, 0.2, 2, 20]) {
    for (const [yaw, pitch] of [[0, 0], [1.4, 0], [-1.4, 0], [0, 1.55], [0, -1.55]]) {
      camera.transform.position.set(
        center.x + distance * Math.sin(yaw) * Math.cos(pitch),
        center.y + distance * Math.sin(pitch),
        center.z + distance * Math.cos(yaw) * Math.cos(pitch));
      camera.transform.lookAt(center);
      camera.update();
      assert.ok(camera.frustum.every(Number.isFinite), 'production PerspectiveCamera disables the infinite far plane');
      const ndc = { x: 0, y: 0, z: 0 };
      mat4TransformPoint(ndc, camera.view_projection_matrix, center);
      assert.ok(Math.abs(ndc.x) < 1e-3 && Math.abs(ndc.y) < 1e-3 && ndc.z > 0 && ndc.z < 1, 'rendered center is inside clip space');
      for (let plane = 0; plane < 6; plane++) {
        const [x, y, z, w] = camera.frustum.slice(plane * 4, plane * 4 + 4);
        assert.ok(x * bound.x + y * bound.y + z * bound.z + w >= -radius * Math.hypot(x, y, z),
          `visible geometry incorrectly rejected: distance=${distance}, yaw=${yaw}, pitch=${pitch}, plane=${plane}`);
      }
      cases++;
    }
  }
  assert.equal(cases, 20);
});
