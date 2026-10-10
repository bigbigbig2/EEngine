import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { cookRangeScene } from "../../tools/cook-range-gltf-scene.mjs";

const cooker = resolve("tools/oengine-asset-core/build/oengine-asset-cooker.exe");
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

async function fixture(directory, compressed) {
  const size = 16;
  const positions = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++)
      positions.set([x, y, Math.sin(x * 0.2) * Math.cos(y * 0.3)], (y * size + x) * 3);
  }
  const indices = new Uint32Array((size - 1) ** 2 * 6);
  let at = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = y * size + x;
      indices.set([a, a + 1, a + size + 1, a, a + size + 1, a + size], at);
      at += 6;
    }
  }
  const raw = [new Uint8Array(positions.buffer), new Uint8Array(indices.buffer)];
  const compressedBytes = [
    MeshoptEncoder.encodeVertexBuffer(raw[0], positions.length / 3, 12),
    MeshoptEncoder.encodeIndexBuffer(raw[1], indices.length, 4)
  ];
  const decodedIndices = new Uint32Array(indices.length);
  MeshoptDecoder.decodeGltfBuffer(
    new Uint8Array(decodedIndices.buffer),
    indices.length,
    4,
    compressedBytes[1],
    "TRIANGLES"
  );
  // The triangle codec may cyclically rotate corners; verify winding, then use
  // the independent decoder's exact corner order for the raw/native comparison.
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    assert.ok(
      [0, 1, 2].some((rotation) =>
        [0, 1, 2].every(
          (corner) => decodedIndices[triangle + corner] === indices[triangle + ((corner + rotation) % 3)]
        )
      )
    );
  }
  raw[1] = new Uint8Array(decodedIndices.buffer);
  const decodedPositions = new Uint8Array(raw[0].length);
  MeshoptDecoder.decodeGltfBuffer(
    decodedPositions,
    positions.length / 3,
    12,
    compressedBytes[0],
    "ATTRIBUTES"
  );
  assert.deepEqual(decodedPositions, raw[0]);
  const encoded = compressed ? compressedBytes : raw;
  const binName = compressed ? "compressed payload.bin" : "raw payload.bin";
  await writeFile(join(directory, binName), Buffer.concat(encoded));
  const views = raw.map((bytes, index) => ({
    buffer: compressed ? 1 : 0,
    byteOffset: index === 0 ? 0 : raw[0].length,
    byteLength: bytes.length,
    ...(index === 0 ? { byteStride: 12 } : {}),
    ...(compressed
      ? {
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: index === 0 ? 0 : encoded[0].length,
              byteLength: encoded[index].length,
              byteStride: index === 0 ? 12 : 4,
              count: index === 0 ? positions.length / 3 : indices.length,
              mode: index === 0 ? "ATTRIBUTES" : "TRIANGLES"
            }
          }
        }
      : {})
  }));
  const document = {
    asset: { version: "2.0" },
    buffers: [
      { uri: encodeURI(binName), byteLength: encoded[0].length + encoded[1].length },
      ...(compressed ? [{ byteLength: raw[0].length + raw[1].length }] : [])
    ],
    bufferViews: views,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
        min: [0, 0, -1],
        max: [15, 15, 1]
      },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" }
    ],
    materials: [{ doubleSided: false }, { doubleSided: true, alphaMode: "MASK", alphaCutoff: 0.3333 }],
    meshes: [
      { primitives: [0, 1].map((material) => ({ attributes: { POSITION: 0 }, indices: 1, material })) }
    ],
    nodes: [
      { translation: [7, 2, -4], children: [1, 2] },
      { mesh: 0 },
      { mesh: 0, scale: [-1, 2, 1], translation: [3, 0, 0] }
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...(compressed
      ? { extensionsUsed: ["EXT_meshopt_compression"], extensionsRequired: ["EXT_meshopt_compression"] }
      : {})
  };
  const path = join(directory, compressed ? "compressed.gltf" : "raw.gltf");
  await writeFile(path, JSON.stringify(document));
  return { path, document };
}

test("range native cook matches uncompressed geometry and preserves materials, instances and retry identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oengine-range-"));
  const raw = await fixture(directory, false),
    compressed = await fixture(directory, true);
  const rawOut = join(directory, "raw-out"),
    compressedOut = join(directory, "compressed-out");
  const a = await cookRangeScene({ input: raw.path, output: rawOut, cooker });
  const b = await cookRangeScene({ input: compressed.path, output: compressedOut, cooker });
  assert.equal(a.fullScene, true);
  assert.equal(b.source.triangles, 900);
  const scenes = await Promise.all(
    [rawOut, compressedOut].map(async (path) =>
      JSON.parse(await readFile(join(path, "scene.oescene"), "utf8"))
    )
  );
  assert.deepEqual(scenes[0], scenes[1], "compression must not change cooked asset or scene identity");
  const materials = JSON.parse(await readFile(join(compressedOut, "scene.materials.json"), "utf8"));
  assert.deepEqual(materials.instanceMaterials, [0, 1, 0, 1]);
  assert.deepEqual(
    scenes[1].instances.map((i) => i.transform.slice(12, 15)),
    [
      [7, 2, -4],
      [7, 2, -4],
      [10, 2, -4],
      [10, 2, -4]
    ]
  );
  assert.equal(scenes[1].instances[2].transform[0], -1);
  assert.equal(scenes[1].instances[2].transform[5], 2);
  for (const pack of scenes[1].packs) {
    const bytes = await readFile(join(compressedOut, pack.uri));
    assert.deepEqual(bytes, await readFile(join(rawOut, pack.uri)));
    const run = spawnSync(cooker, ["validate", join(compressedOut, pack.uri)], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(run.status, 0, run.stderr);
  }
  const repeated = await cookRangeScene({ input: compressed.path, output: compressedOut, cooker });
  assert.equal(repeated.packageBytes, b.packageBytes);
  const corrupt = await open(join(compressedOut, scenes[1].packs[0].uri), "r+");
  await corrupt.write(Buffer.from([255]), 0, 1, 255);
  await corrupt.close();
  await assert.rejects(
    cookRangeScene({ input: compressed.path, output: compressedOut, cooker }),
    /checksum mismatch/
  );
});

test("invalid compressed ranges fail before reading outside the source file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oengine-range-invalid-"));
  const { path, document } = await fixture(directory, true);
  document.bufferViews[0].extensions.EXT_meshopt_compression.byteOffset = document.buffers[0].byteLength;
  await writeFile(path, JSON.stringify(document));
  const run = spawnSync(cooker, [path, "--out", join(directory, "out"), "--threads", "1"], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cgltf_validate failed: 1/);
});

test("corrupt compressed payload is rejected by the native decoder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oengine-range-corrupt-"));
  const { path } = await fixture(directory, true);
  const payload = await open(join(directory, "compressed payload.bin"), "r+");
  await payload.write(Buffer.from([0]), 0, 1, 0);
  await payload.close();
  const run = spawnSync(cooker, [path, "--out", join(directory, "out"), "--threads", "1"], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /meshopt buffer decode failed/);
});
