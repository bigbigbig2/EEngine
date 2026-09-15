import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "");
const size = Number(process.argv[3] ?? 1025);
if (!process.argv[2] || !Number.isSafeInteger(size) || size < 33 || size > 2049) throw new Error("Usage: node tools/generate-oegpack-stress-glb.mjs <output.glb> [grid-size 33..2049]");
const vertexCount = size * size;
const cellCount = (size - 1) * (size - 1);
const positions = new Float32Array(vertexCount * 3);
const normals = new Float32Array(vertexCount * 3);
const uv0 = new Float32Array(vertexCount * 2);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const vertex = y * size + x;
  const px = x * 0.125, py = y * 0.125;
  positions.set([px, py, Math.sin(px * 0.31) * Math.cos(py * 0.27) * 2 + Math.sin((px + py) * 0.07)], vertex * 3);
  normals.set([0, 0, 1], vertex * 3); uv0.set([x / (size - 1), y / (size - 1)], vertex * 2);
}
const indices = new Uint32Array(cellCount * 6);
let index = 0;
for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
  const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
  indices.set([a, b, d, a, d, c], index); index += 6;
}
const chunks = [positions, normals, uv0, indices]; const offsets = []; let binaryBytes = 0;
for (const chunk of chunks) { binaryBytes = (binaryBytes + 3) & ~3; offsets.push(binaryBytes); binaryBytes += chunk.byteLength; }
const binary = new Uint8Array((binaryBytes + 3) & ~3); chunks.forEach((chunk, i) => binary.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offsets[i]));
const json = {
  asset: { version: "2.0", generator: "OEngine deterministic virtual-geometry stress v1" }, buffers: [{ byteLength: binary.byteLength }],
  bufferViews: chunks.map((chunk, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: chunk.byteLength })),
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, -3], max: [(size - 1) * 0.125, (size - 1) * 0.125, 3] },
    { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
    { bufferView: 2, componentType: 5126, count: vertexCount, type: "VEC2" },
    { bufferView: 3, componentType: 5125, count: indices.length, type: "SCALAR" }
  ], materials: [{ name: "stress-opaque" }], meshes: [{ name: `stress-${size}`, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
};
const jsonSource = new TextEncoder().encode(JSON.stringify(json)); const jsonBytes = (jsonSource.byteLength + 3) & ~3;
const total = 12 + 8 + jsonBytes + 8 + binary.byteLength; const glb = new Uint8Array(total); const view = new DataView(glb.buffer);
view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true); view.setUint32(12, jsonBytes, true); view.setUint32(16, 0x4e4f534a, true);
glb.fill(0x20, 20, 20 + jsonBytes); glb.set(jsonSource, 20); const binHeader = 20 + jsonBytes; view.setUint32(binHeader, binary.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); glb.set(binary, binHeader + 8);
await mkdir(dirname(output), { recursive: true }); await writeFile(output, glb);
console.log(JSON.stringify({ output, gridSize: size, vertices: vertexCount, triangles: cellCount * 2, bytes: glb.byteLength }));
