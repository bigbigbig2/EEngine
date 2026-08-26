import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeapotGeometry } from "../../three.js/examples/jsm/geometries/TeapotGeometry.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptDirectory, "../benchmark-assets");
const segmentCounts = [10, 8, 6, 5, 4, 3, 2];

await mkdir(outputDirectory, { recursive: true });
for (const segments of segmentCounts) {
  const geometry = new TeapotGeometry(1, segments, true, true, true, true, true);
  const glb = encodeGlb(geometry, `Teapot LOD ${segments}`);
  const output = path.join(outputDirectory, `teapot-lod-${segments}.glb`);
  await writeFile(output, glb);
  console.log(`${path.basename(output)}: ${glb.byteLength} bytes`);
}

function encodeGlb(geometry, name) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const sourceIndex = geometry.getIndex();
  if (!position || !normal || !uv || !sourceIndex) {
    throw new Error("TeapotGeometry must contain position, normal, uv and index");
  }
  const IndexArray = position.count <= 0xffff ? Uint16Array : Uint32Array;
  const index = new IndexArray(sourceIndex.array);
  const chunks = [index, position.array, normal.array, uv.array];
  const offsets = [];
  let binaryLength = 0;
  for (const chunk of chunks) {
    binaryLength = align(binaryLength, 4);
    offsets.push(binaryLength);
    binaryLength += chunk.byteLength;
  }
  const binary = Buffer.alloc(align(binaryLength, 4));
  chunks.forEach((chunk, index) => {
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
      binary,
      offsets[index]
    );
  });
  const positionBounds = bounds(position.array, 3);
  const json = {
    asset: { version: "2.0", generator: "OEngine OBS-02 Teapot fixture generator" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{ attributes: { POSITION: 1, NORMAL: 2, TEXCOORD_0: 3 }, indices: 0 }]
    }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: chunks.map((chunk, chunkIndex) => ({
      buffer: 0,
      byteOffset: offsets[chunkIndex],
      byteLength: chunk.byteLength,
      target: chunkIndex === 0 ? 34963 : 34962
    })),
    accessors: [
      {
        bufferView: 0,
        componentType: IndexArray === Uint16Array ? 5123 : 5125,
        count: index.length,
        type: "SCALAR",
        min: [0],
        max: [position.count - 1]
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: position.count,
        type: "VEC3",
        min: positionBounds.min,
        max: positionBounds.max
      },
      { bufferView: 2, componentType: 5126, count: normal.count, type: "VEC3" },
      { bufferView: 3, componentType: 5126, count: uv.count, type: "VEC2" }
    ]
  };
  const jsonChunk = Buffer.from(JSON.stringify(json));
  const paddedJsonLength = align(jsonChunk.byteLength, 4);
  const totalLength = 12 + 8 + paddedJsonLength + 8 + binary.byteLength;
  const output = Buffer.alloc(totalLength, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(paddedJsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  const binaryHeader = 20 + paddedJsonLength;
  output.writeUInt32LE(binary.byteLength, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

function bounds(array, itemSize) {
  const min = Array(itemSize).fill(Number.POSITIVE_INFINITY);
  const max = Array(itemSize).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < array.length; index += itemSize) {
    for (let component = 0; component < itemSize; component++) {
      min[component] = Math.min(min[component], array[index + component]);
      max[component] = Math.max(max[component], array[index + component]);
    }
  }
  return { min, max };
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
