import assert from "node:assert/strict";
import test from "node:test";

const { canonicalizeGlbPrimitiveV1 } = await import("../.test-dist/assets/web-cook/gltf/GlbPrimitiveCanonicalizer.js");

function accessor(accessorIndex, byteOffset, byteLength, byteStride, componentType, componentCount, count, normalized = false) { return { accessorIndex, bufferIndex: 0, byteOffset, byteLength, byteStride, componentType, componentCount, count, normalized }; }
function unit(overrides = {}) {
  const position = accessor(0, 0, 48, 16, 5126, 3, 3);
  const indices = accessor(1, 48, 6, 2, 5123, 1, 3);
  return { nodeIndex: 0, instanceNodeIndices: [0], meshIndex: 0, primitiveIndex: 0, materialIndex: 2, mode: 4, vertexCount: 3, triangleCount: 1, attributes: { POSITION: position }, indices, material: { materialIndex: 2, alphaMode: "MASK", doubleSided: true }, ranges: [position, indices], ...overrides };
}
function reader(ranges) { return { readRange: async range => ranges.get(`${range.byteOffset}:${range.byteLength}`).slice().buffer }; }

test("canonicalizer decodes interleaved and normalized accessors with material routing", async () => {
  const positionBytes = new ArrayBuffer(48), position = new DataView(positionBytes);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((value, vertex) => { value.forEach((component, index) => position.setFloat32(vertex * 16 + index * 4, component, true)); });
  const normalBytes = new Uint8Array([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, -128 & 255, 0]);
  const indicesBytes = new Uint8Array([0, 0, 1, 0, 2, 0]);
  const indices = accessor(1, 48, 6, 2, 5123, 1, 3);
  const normal = accessor(2, 54, 12, 4, 5120, 3, 3, true);
  const uvs = accessor(3, 66, 12, 4, 5123, 2, 3, true);
  const input = unit({ attributes: { POSITION: accessor(0, 0, 48, 16, 5126, 3, 3), NORMAL: normal, TEXCOORD_0: uvs }, indices, material: { materialIndex: 2, alphaMode: "BLEND", doubleSided: true } });
  const ranges = new Map([["0:48", new Uint8Array(positionBytes)], ["54:12", normalBytes], ["66:12", new Uint8Array([0, 0, 255, 255, 0, 0, 0, 0, 0, 128, 0, 0])], ["48:6", indicesBytes]]);
  const domain = await canonicalizeGlbPrimitiveV1(input, reader(ranges));
  assert.equal(domain.generateNormals, false);
  assert.equal(domain.attributeMask, 1 | 2 | 8);
  assert.deepEqual([...domain.indices], [0, 1, 2]);
  assert.deepEqual([...domain.vertices.slice(3, 6)], [0, 0, 1]);
  assert.deepEqual([...domain.vertices.slice(10, 12)], [0, 1]);
  assert.equal(domain.meshletFlags & 4, 4);
  assert.equal(domain.meshletFlags & 8, 8);
});

test("canonicalizer preserves native defaults and requests normal generation", async () => {
  const positionBytes = new ArrayBuffer(36), view = new DataView(positionBytes);
  for (let i = 0; i < 9; i++) view.setFloat32(i * 4, i < 3 ? 0 : i < 6 ? 1 : 2, true);
  const position = accessor(0, 0, 36, 12, 5126, 3, 3);
  const input = unit({ attributes: { POSITION: position }, indices: undefined });
  input.ranges = [position];
  input.triangleCount = 1;
  const domain = await canonicalizeGlbPrimitiveV1(input, reader(new Map([["0:36", new Uint8Array(positionBytes)]])));
  assert.equal(domain.generateNormals, true);
  assert.deepEqual([...domain.vertices.slice(3, 6)], [0, 0, 1]);
  assert.deepEqual([...domain.vertices.slice(6, 10)], [1, 0, 0, 1]);
  assert.deepEqual([...domain.vertices.slice(14, 18)], [1, 1, 1, 1]);
  assert.deepEqual([...domain.indices], [0, 1, 2]);
});

test("canonicalizer rejects non-finite and out-of-range indices", async () => {
  const positionBytes = new ArrayBuffer(36), view = new DataView(positionBytes); for (let i = 0; i < 9; i++) view.setFloat32(i * 4, i === 0 ? Number.NaN : 0, true);
  const position = accessor(0, 0, 36, 12, 5126, 3, 3);
  await assert.rejects(() => canonicalizeGlbPrimitiveV1(unit({ attributes: { POSITION: position }, indices: undefined, ranges: [position] }), reader(new Map([["0:36", new Uint8Array(positionBytes)]]))), /non-finite/i);
  const indices = accessor(1, 36, 6, 2, 5123, 1, 3), bytes = new Uint8Array([0, 0, 1, 0, 3, 0]);
  await assert.rejects(() => canonicalizeGlbPrimitiveV1(unit({ indices, ranges: [accessor(0, 0, 48, 16, 5126, 3, 3), indices] }), reader(new Map([["0:48", new Uint8Array(48)], ["36:6", bytes]]))), /exceeds vertex count/i);
});

test("canonicalizer applies sparse base-less accessor patches", async () => {
  const sparsePosition = accessor(0, 0, 0, 12, 5126, 3, 3);
  sparsePosition.sparse = {
    count: 2,
    indices: { bufferIndex: 0, byteOffset: 0, byteLength: 2, byteStride: 1, componentType: 5121 },
    values: { bufferIndex: 0, byteOffset: 2, byteLength: 24 }
  };
  const indices = accessor(1, 26, 3, 1, 5121, 1, 3);
  const indexBytes = new Uint8Array([0, 1, 2]);
  const values = new ArrayBuffer(24); const view = new DataView(values);
  [[0, 0, 0], [1, 0, 0]].forEach((point, row) => point.forEach((value, component) => view.setFloat32(row * 12 + component * 4, value, true)));
  const ranges = new Map([["0:2", new Uint8Array([0, 2])], ["2:24", new Uint8Array(values)], ["26:3", indexBytes]]);
  const input = unit({ vertexCount: 3, triangleCount: 1, attributes: { POSITION: sparsePosition }, indices, ranges: [sparsePosition.sparse.indices, sparsePosition.sparse.values, indices] });
  const domain = await canonicalizeGlbPrimitiveV1(input, reader(ranges));
  assert.deepEqual([...domain.vertices.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...domain.vertices.slice(36, 39)], [1, 0, 0]);
  assert.deepEqual([...domain.indices], [0, 1, 2]);
});
