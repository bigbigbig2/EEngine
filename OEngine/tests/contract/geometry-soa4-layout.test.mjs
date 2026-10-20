import assert from "node:assert/strict";
import test from "node:test";
import { geometryVertexFormat, geometryVertexPayloadBytes, decodeVertexFormatV4,
  decodeMeshletHeaderV4, OEGPACK_V4_MESHLET_HEADER_BYTES } from "../../.test-dist/assets/GeometryAbiV4.js";
import { encodeVertexFormatsV4 } from "../../.test-dist/assets/geometry-product/GeometryProductV1.js";
import { surfaceGeometryCompletionWgsl } from "../../.test-dist/shaders/surface_geometry_completion.js";

test("SoA4 canonical optional streams and sign extents have no interleaved fallback", () => {
  for (let mask = 3; mask <= 63; mask += 4) {
    for (const sign of mask & 4 ? [1, 2] : [0]) {
      const format = geometryVertexFormat(mask, sign);
      const encoded = encodeVertexFormatsV4([format]);
      assert.deepEqual(decodeVertexFormatV4(new DataView(encoded.buffer), 0), format);
      for (const count of [1, 3, 7, 8, 9, 127, 128]) {
        const expected = count * format.streamBytesPerVertex + (sign === 1 ? Math.ceil(count / 8) : 0);
        assert.equal(geometryVertexPayloadBytes(count, format), Math.ceil(expected / 4) * 4);
      }
      for (const byte of [0, 4, 5, 6, 10, 11, 12, 15]) {
        const corrupt = encoded.slice();
        corrupt[byte] ^= 0x80;
        assert.throws(() => decodeVertexFormatV4(new DataView(corrupt.buffer), 0));
      }
    }
  }
  assert.throws(() => geometryVertexFormat(7, 0));
  assert.throws(() => geometryVertexFormat(3, 1));
});

test("44-byte meshlet header reads packed counts/flags and independent bounds", () => {
  assert.equal(OEGPACK_V4_MESHLET_HEADER_BYTES, 44);
  const view = new DataView(new ArrayBuffer(44));
  view.setUint8(0, 128);
  view.setUint8(1, 127);
  view.setUint16(2, 17, true);
  for (const [at, value] of [[4, 256], [8, 108], [12, 0xffffffff], [16, 57]]) view.setUint32(at, value, true);
  [-3, -2, -1, 1, 2, 3].forEach((value, i) => view.setFloat32(20 + i * 4, value, true));
  assert.deepEqual(decodeMeshletHeaderV4(view), { vertexCount: 128, triangleCount: 127, flags: 17,
    vertexByteOffset: 256, triangleByteOffset: 108, refineGroupId: 0xffffffff, materialId: 57,
    bboxMin: [-3, -2, -1], bboxMax: [1, 2, 3] });
});

test("Surface cached Product path restores both format and SoA vertex domain", () => {
  const shader = surfaceGeometryCompletionWgsl(true, true);
  assert.match(shader, /product_source_vertex_count = cached\.vertex_count;/);
  assert.match(shader, /product_frame_vertex_load_format\(cached\.vertex_indices\)/);
});
