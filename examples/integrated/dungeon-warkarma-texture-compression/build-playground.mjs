import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(demo, "../../../..");
const require = createRequire(resolve(root, "OEngine/package.json"));
const { mat4, vec3 } = require("gl-matrix");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sourceBytes = await readFile(resolve(demo, "assets/dungeon_warkarma.glb"));
const source = JSON.parse(sourceBytes.subarray(20, 20 + sourceBytes.readUInt32LE(12)));
const min = [Infinity, Infinity, Infinity],
  max = [-Infinity, -Infinity, -Infinity];
function measureNode(index, parent) {
  const node = source.nodes[index];
  const local =
    node.matrix ??
    mat4.fromRotationTranslationScale(
      mat4.create(),
      node.rotation ?? [0, 0, 0, 1],
      node.translation ?? [0, 0, 0],
      node.scale ?? [1, 1, 1]
    );
  const world = mat4.multiply(mat4.create(), parent, local);
  for (const primitive of source.meshes[node.mesh]?.primitives ?? []) {
    const bounds = source.accessors[primitive.attributes.POSITION];
    if (!bounds.min || !bounds.max)
      throw new Error("Dungeon position bounds required for playground placement");
    for (let corner = 0; corner < 8; corner++) {
      const point = vec3.transformMat4(
        vec3.create(),
        [0, 1, 2].map((axis) => (corner & (1 << axis) ? bounds.max : bounds.min)[axis]),
        world
      );
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
  }
  for (const child of node.children ?? []) measureNode(child, world);
}
for (const node of source.scenes[source.scene ?? 0].nodes) measureNode(node, mat4.create());
const center = min.map((value, axis) => (value + max[axis]) / 2);
const floor = min[1] - 0.08;
const span = Math.max(max[0] - min[0], max[2] - min[2]);
const unit = span / 22;
const planeSize = span * 5;

const document = {
  asset: { version: "2.0", generator: "EEngine Dungeon Playground" },
  buffers: [],
  bufferViews: [],
  accessors: [],
  meshes: [],
  nodes: [],
  scenes: [{ nodes: [] }],
  scene: 0,
  images: [],
  textures: [],
  materials: []
};
const chunks = [];
let byteLength = 0;
function accessor(values, components, integer = false) {
  const array = integer ? Uint32Array.from(values) : Float32Array.from(values);
  const bytes = Buffer.from(array.buffer);
  const view = document.bufferViews.length;
  document.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
  chunks.push(bytes);
  byteLength += bytes.length;
  const minimum = Array(components).fill(Infinity),
    maximum = Array(components).fill(-Infinity);
  values.forEach((value, index) => {
    const axis = index % components;
    minimum[axis] = Math.min(minimum[axis], value);
    maximum[axis] = Math.max(maximum[axis], value);
  });
  const index = document.accessors.length;
  document.accessors.push({
    bufferView: view,
    componentType: integer ? 5125 : 5126,
    count: values.length / components,
    type: components === 1 ? "SCALAR" : `VEC${components}`,
    min: minimum,
    max: maximum
  });
  return index;
}
function geometry(position, normal, indices) {
  return {
    attributes: { POSITION: accessor(position, 3), NORMAL: accessor(normal, 3) },
    indices: accessor(indices, 1, true),
    mode: 4
  };
}
const boxPositions = [],
  boxNormals = [],
  boxIndices = [];
for (const [n, u, v] of [
  [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0]
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0]
  ],
  [
    [0, 1, 0],
    [1, 0, 0],
    [0, 0, -1]
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1]
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0]
  ],
  [
    [0, 0, -1],
    [-1, 0, 0],
    [0, 1, 0]
  ]
]) {
  const base = boxPositions.length / 3;
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ]) {
    boxPositions.push(...n.map((value, axis) => (value + a * u[axis] + b * v[axis]) / 2));
    boxNormals.push(...n);
  }
  boxIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
const box = geometry(boxPositions, boxNormals, boxIndices);
const ground = geometry(
  [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5],
  [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  [0, 2, 1, 0, 3, 2]
);
const spherePositions = [],
  sphereIndices = [],
  rings = 16,
  segments = 32;
for (let row = 0; row <= rings; row++)
  for (let column = 0; column <= segments; column++) {
    const theta = (row * Math.PI) / rings,
      phi = (column * Math.PI * 2) / segments;
    spherePositions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
  }
for (let row = 0; row < rings; row++)
  for (let column = 0; column < segments; column++) {
    const a = row * (segments + 1) + column,
      b = a + segments + 1;
    if (row !== rings - 1) sphereIndices.push(a, b + 1, b);
    if (row !== 0) sphereIndices.push(a, a + 1, b + 1);
  }
const sphere = geometry(spherePositions, spherePositions, sphereIndices);
for (const [name, color, metallic, roughness] of [
  ["Matte slate ground", [0.19, 0.23, 0.25], 0, 0.92],
  ["Warm concrete", [0.62, 0.57, 0.48], 0, 0.85],
  ["Terracotta", [0.58, 0.16, 0.07], 0, 0.72],
  ["Blue lacquer", [0.025, 0.16, 0.48], 0, 0.2],
  ["Brushed steel", [0.5, 0.56, 0.62], 1, 0.32],
  ["Gold metal", [0.83, 0.57, 0.19], 1, 0.2],
  ["Teal rubber", [0.035, 0.38, 0.3], 0, 0.68],
  ["White ceramic", [0.83, 0.85, 0.8], 0, 0.16]
])
  document.materials.push({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [...color, 1],
      metallicFactor: metallic,
      roughnessFactor: roughness
    }
  });

const counts = { ground: 0, walls: 0, cubes: 0, spheres: 0, steps: 0 };
const focusMin = [...min],
  focusMax = [...max];
function object(kind, primitive, material, position, scale, yaw = 0) {
  const mesh = document.meshes.length;
  document.meshes.push({ name: `${kind}-${counts[kind]}`, primitives: [{ ...primitive, material }] });
  const node = document.nodes.length;
  document.nodes.push({
    name: `${kind}-${counts[kind]++}`,
    mesh,
    translation: position,
    scale,
    rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
  });
  document.scenes[0].nodes.push(node);
  if (kind !== "ground") {
    const halfX =
      primitive === sphere
        ? scale[0]
        : (Math.abs(Math.cos(yaw)) * scale[0] + Math.abs(Math.sin(yaw)) * scale[2]) / 2;
    const halfZ =
      primitive === sphere
        ? scale[2]
        : (Math.abs(Math.sin(yaw)) * scale[0] + Math.abs(Math.cos(yaw)) * scale[2]) / 2;
    const halfY = primitive === sphere ? scale[1] : scale[1] / 2;
    for (const [axis, extent] of [halfX, halfY, halfZ].entries()) {
      focusMin[axis] = Math.min(focusMin[axis], position[axis] - extent);
      focusMax[axis] = Math.max(focusMax[axis], position[axis] + extent);
    }
  }
}
object("ground", ground, 0, [center[0], floor, center[2]], [planeSize, 1, planeSize]);
let seed = 0x5741524b;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const occupied = [];
for (let i = 0; i < 30; i++) {
  const isSphere = i % 2 === 0;
  const size = unit * (0.65 + random() * 0.85);
  const reach = isSphere ? size : size * 0.8;
  let x, z;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 2000) throw new Error("Playground placement capacity exhausted");
    x = center[0] + (random() - 0.5) * span * 2.15;
    z = center[2] + (random() - 0.5) * span * 2.15;
    const insideDungeon =
      x > min[0] - reach - 3 * unit &&
      x < max[0] + reach + 3 * unit &&
      z > min[2] - reach - 3 * unit &&
      z < max[2] + reach + 3 * unit;
    if (!insideDungeon && occupied.every((p) => Math.hypot(x - p.x, z - p.z) > reach + p.reach + unit)) break;
  }
  occupied.push({ x, z, reach });
  const height = isSphere ? size * 2 : size * (1 + random() * 1.4);
  object(
    isSphere ? "spheres" : "cubes",
    isSphere ? sphere : box,
    2 + (i % 6),
    [x, floor + height / 2, z],
    [size, isSphere ? size : height, size],
    random() * Math.PI
  );
}
// A staggered back wall and two side walls leave the front open for the camera.
for (let i = 0; i < 6; i++)
  object(
    "walls",
    box,
    i % 2 ? 2 : 1,
    [center[0] + (i - 2.5) * span * 0.24, floor + unit * (1.7 + (i % 2)), min[2] - span * 0.64],
    [span * 0.2, unit * (3.4 + 2 * (i % 2)), unit * 0.6]
  );
for (const side of [-1, 1])
  object(
    "walls",
    box,
    1,
    [center[0] + side * span * 1.1, floor + unit * 2, center[2]],
    [unit * 0.6, unit * 4, span * 0.55]
  );
for (let i = 0; i < 5; i++)
  object(
    "steps",
    box,
    1,
    [max[0] + span * 0.18, floor + unit * (i + 1) * 0.22, max[2] - i * unit],
    [unit * 3, unit * (i + 1) * 0.44, unit]
  );

const binary = Buffer.concat(chunks);
document.buffers = [{ byteLength: binary.length }];
const json = Buffer.from(JSON.stringify(document));
const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)]);
const header = Buffer.alloc(20),
  binHeader = Buffer.alloc(8);
[0x46546c67, 2, 28 + jsonChunk.length + binary.length, jsonChunk.length, 0x4e4f534a].forEach((value, i) =>
  header.writeUInt32LE(value, i * 4)
);
binHeader.writeUInt32LE(binary.length);
binHeader.writeUInt32LE(0x004e4942, 4);
const input = resolve(demo, "assets/playground.glb"),
  output = resolve(root, ".local/models/dungeon-playground-cooked");
await writeFile(input, Buffer.concat([header, jsonChunk, binHeader, binary]));
const cook = spawnSync(
  process.execPath,
  [resolve(root, "OEngine/tools/cook-offline-scene.mjs"), input, output, "4"],
  { cwd: root, stdio: "inherit", windowsHide: true }
);
if (cook.status !== 0) throw new Error(`Playground cook failed: ${cook.status}`);

const dungeonRoot = resolve(demo, "assets/cooked"),
  destination = resolve(demo, "assets/playground-cooked");
await mkdir(destination, { recursive: true });
const dungeon = await readJson(resolve(dungeonRoot, "scene.materials.json"));
const playground = await readJson(resolve(output, "scene.materials.json"));
const dungeonScene = await readJson(resolve(dungeonRoot, dungeon.geometryManifest));
const playgroundScene = await readJson(resolve(output, playground.geometryManifest));
if (dungeonScene.instanceSemantics !== playgroundScene.instanceSemantics)
  throw new Error("Scene semantics mismatch");
for (const pack of playgroundScene.packs)
  await copyFile(resolve(output, pack.uri), resolve(destination, pack.uri));
const scene = {
  schema: dungeonScene.schema,
  instanceSemantics: dungeonScene.instanceSemantics,
  packs: [...dungeonScene.packs.map((p) => ({ ...p, uri: `../cooked/${p.uri}` })), ...playgroundScene.packs],
  assets: [
    ...dungeonScene.assets,
    ...playgroundScene.assets.map((a) => ({ ...a, pack: a.pack + dungeonScene.packs.length }))
  ],
  instances: [
    ...dungeonScene.instances,
    ...playgroundScene.instances.map((i) => ({ ...i, asset: i.asset + dungeonScene.assets.length }))
  ]
};
const sceneBytes = Buffer.from(JSON.stringify(scene, null, 2) + "\n");
const frameCenter = focusMin.map((value, axis) => (value + focusMax[axis]) / 2);
const frameRadius = Math.hypot(...focusMax.map((value, axis) => (value - focusMin[axis]) / 2));
const manifest = {
  ...dungeon,
  source: {
    ...dungeon.source,
    path: "dungeon_warkarma.glb + playground.glb",
    bytes: dungeon.source.bytes + playground.source.bytes,
    sha256: hash(Buffer.concat([sourceBytes, await readFile(input)])),
    triangles: dungeon.source.triangles + playground.source.triangles,
    meshes: dungeon.source.meshes + playground.source.meshes,
    primitives: dungeon.source.primitives + playground.source.primitives,
    materials: dungeon.source.materials + playground.source.materials
  },
  geometryManifestHash: hash(sceneBytes),
  gltf: { ...dungeon.gltf, materials: [...dungeon.gltf.materials, ...playground.gltf.materials] },
  bindings: [
    ...dungeon.bindings.map((b) =>
      Object.fromEntries(
        Object.entries(b).map(([key, value]) => [key, { ...value, uri: `../cooked/${value.uri}` }])
      )
    ),
    ...playground.bindings
  ],
  products: dungeon.products.map((p) => ({ ...p, uri: `../cooked/${p.uri}` })),
  instanceMaterials: [
    ...dungeon.instanceMaterials,
    ...playground.instanceMaterials.map((i) => i + dungeon.gltf.materials.length)
  ],
  instanceProfiles: [...dungeon.instanceProfiles, ...playground.instanceProfiles],
  framing: { center: frameCenter, radius: frameRadius },
  playground: { seed: "0x5741524b", counts, groundSize: planeSize, floor, dungeonBounds: { min, max } }
};
await writeFile(resolve(destination, "scene.oescene"), sceneBytes);
await writeFile(resolve(destination, "scene.materials.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      playground: manifest.playground,
      framing: manifest.framing,
      triangles: manifest.source.triangles,
      materials: manifest.source.materials
    },
    null,
    2
  )
);
