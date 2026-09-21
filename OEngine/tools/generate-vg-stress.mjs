import { createHash } from "node:crypto";
import { access, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VG_STRESS_GENERATOR_VERSION = "web-100m-phase-a-v1";
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const U32_MAX = 0xffffffff;

/**
 * Writes a deterministic single-primitive grid GLB without ever materializing
 * the complete source in JS memory. Rows are the allocation unit, so generator
 * peak memory is independent of the requested triangle count.
 */
export async function generateVirtualGeometryStress(options) {
  const output = resolve(options.output ?? "");
  const manifestPath = resolve(options.manifest ?? `${output}.manifest.json`);
  const triangles = Number(options.triangles);
  const layout = options.layout ?? "single-giant-primitive";
  const seed = Number(options.seed ?? 1801);
  if (!output || !Number.isSafeInteger(triangles) || triangles < 2 || triangles % 2 !== 0) throw new RangeError("triangles must be a positive even safe integer");
  if (layout !== "single-giant-primitive") throw new RangeError("Phase A supports layout=single-giant-primitive");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > U32_MAX) throw new RangeError("seed must be a u32");
  await assertAbsent(output);
  await assertAbsent(manifestPath);
  assertLittleEndian();

  const cells = triangles / 2;
  const [cellsX, cellsY] = factorGrid(cells);
  const verticesX = cellsX + 1;
  const verticesY = cellsY + 1;
  const vertexCount = verticesX * verticesY;
  const indexCount = triangles * 3;
  if (vertexCount > U32_MAX || indexCount > U32_MAX) throw new RangeError("GLB accessor count exceeds u32");

  const positionBytes = checkedBytes(vertexCount, 12, "position bytes");
  const normalBytes = checkedBytes(vertexCount, 12, "normal bytes");
  const uvBytes = checkedBytes(vertexCount, 8, "uv bytes");
  const indexBytes = checkedBytes(indexCount, 4, "index bytes");
  const offsets = [0, positionBytes, positionBytes + normalBytes, positionBytes + normalBytes + uvBytes];
  const binaryBytes = positionBytes + normalBytes + uvBytes + indexBytes;
  const json = {
    asset: { version: "2.0", generator: `OEngine ${VG_STRESS_GENERATOR_VERSION}` },
    extras: { oengineStress: { version: 1, layout, seed, sourceTriangles: triangles, cellsX, cellsY } },
    buffers: [{ byteLength: binaryBytes }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positionBytes, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: normalBytes, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: uvBytes, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: indexBytes, target: 34963 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min: [0, 0, 0], max: [cellsX, cellsY, 1] },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: vertexCount, type: "VEC2" },
      { bufferView: 3, componentType: 5125, count: indexCount, type: "SCALAR" }
    ],
    materials: [{ name: "phase-a-opaque" }],
    meshes: [{ name: `phase-a-${triangles}`, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  const jsonSource = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = align4(jsonSource.byteLength);
  const totalBytes = 12 + 8 + jsonBytes + 8 + binaryBytes;
  if (totalBytes > U32_MAX) throw new RangeError(`GLB ${totalBytes} bytes exceeds the glTF u32 container limit`);

  const partial = `${output}.partial-${process.pid}`;
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(partial, "wx");
  const hash = createHash("sha256");
  let written = 0;
  let peakGeneratorBytes = 0;
  const write = async bytes => {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    await handle.write(view, 0, view.byteLength, written);
    hash.update(view);
    written += view.byteLength;
    peakGeneratorBytes = Math.max(peakGeneratorBytes, view.byteLength);
  };
  try {
    const header = new Uint8Array(20 + jsonBytes + 8);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, GLB_MAGIC, true);
    headerView.setUint32(4, 2, true);
    headerView.setUint32(8, totalBytes, true);
    headerView.setUint32(12, jsonBytes, true);
    headerView.setUint32(16, GLB_JSON, true);
    header.fill(0x20, 20, 20 + jsonBytes);
    header.set(jsonSource, 20);
    const binHeader = 20 + jsonBytes;
    headerView.setUint32(binHeader, binaryBytes, true);
    headerView.setUint32(binHeader + 4, GLB_BIN, true);
    await write(header);

    for (let y = 0; y < verticesY; y++) {
      const row = new Float32Array(verticesX * 3);
      for (let x = 0; x < verticesX; x++) {
        const at = x * 3;
        row[at] = x;
        row[at + 1] = y;
        row[at + 2] = (((x * 73856093) ^ (y * 19349663) ^ seed) & 1023) / 1023;
      }
      await write(new Uint8Array(row.buffer));
    }
    for (let y = 0; y < verticesY; y++) {
      const row = new Float32Array(verticesX * 3);
      for (let x = 0; x < verticesX; x++) row[x * 3 + 2] = 1;
      await write(new Uint8Array(row.buffer));
    }
    for (let y = 0; y < verticesY; y++) {
      const row = new Float32Array(verticesX * 2);
      for (let x = 0; x < verticesX; x++) {
        row[x * 2] = x / cellsX;
        row[x * 2 + 1] = y / cellsY;
      }
      await write(new Uint8Array(row.buffer));
    }
    for (let y = 0; y < cellsY; y++) {
      const row = new Uint32Array(cellsX * 6);
      for (let x = 0; x < cellsX; x++) {
        const a = y * verticesX + x;
        const b = a + 1;
        const c = a + verticesX;
        const d = c + 1;
        row.set([a, b, d, a, d, c], x * 6);
      }
      await write(new Uint8Array(row.buffer));
    }
    if (written !== totalBytes) throw new Error(`generated ${written} bytes, expected ${totalBytes}`);
    await handle.sync();
    await handle.close();
    await rename(partial, output);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }

  const manifest = Object.freeze({
    schema: "oengine-vg-stress-source-v1",
    generatorVersion: VG_STRESS_GENERATOR_VERSION,
    file: basename(output),
    sourceSha256: hash.digest("hex"),
    sourceBytes: totalBytes,
    glb: { jsonChunkBytes: jsonBytes, binaryChunkBytes: binaryBytes },
    workload: { layout, seed, sourceTriangles: triangles, vertices: vertexCount, indices: indexCount, cellsX, cellsY },
    generation: { strategy: "row-streamed", peakGeneratorBytes }
  });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function factorGrid(cells) {
  for (let y = Math.floor(Math.sqrt(cells)); y >= 1; y--) if (cells % y === 0) return [cells / y, y];
  throw new Error("unable to factor grid cells");
}
function checkedBytes(count, stride, label) {
  const bytes = count * stride;
  if (!Number.isSafeInteger(bytes) || bytes > U32_MAX) throw new RangeError(`${label} exceeds the GLB u32 range`);
  return bytes;
}
function align4(value) { return (value + 3) & ~3; }
function assertLittleEndian() { const bytes = new Uint8Array(new Uint32Array([1]).buffer); if (bytes[0] !== 1) throw new Error("stress generator requires a little-endian host"); }
async function assertAbsent(path) { try { await access(path); throw new Error(`refusing to overwrite existing path: ${path}`); } catch (error) { if (error?.code !== "ENOENT") throw error; } }

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--output") options.output = argv[++index];
    else if (name === "--manifest") options.manifest = argv[++index];
    else if (name === "--triangles") options.triangles = Number(argv[++index]);
    else if (name === "--layout") options.layout = argv[++index];
    else if (name === "--seed") options.seed = Number(argv[++index]);
    else throw new Error(`unknown option: ${name}`);
  }
  if (!options.output || options.triangles === undefined) throw new Error("Usage: node tools/generate-vg-stress.mjs --output <scene.glb> --triangles <even-count> [--layout single-giant-primitive] [--seed 1801] [--manifest <json>]");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await generateVirtualGeometryStress(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}
