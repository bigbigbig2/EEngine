import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Reads glTF metadata plus streaming hashes; geometry/image payloads are never materialized. */
export async function inspectGltfWorkload(options) {
  const source = resolve(options.source ?? "");
  const output = options.output === undefined ? undefined : resolve(options.output);
  const sourceStat = await stat(source);
  const handle = await open(source, "r");
  let jsonBytes, binaryChunkBytes = 0, json, format;
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead >= 4 && header.readUInt32LE(0) === 0x46546c67) {
      format = "glb";
      if (header.readUInt32LE(4) !== 2) throw new Error("source is not a glTF 2.0 GLB");
      const declaredBytes = header.readUInt32LE(8);
      if (declaredBytes !== sourceStat.size) throw new Error(`GLB declares ${declaredBytes} bytes but file has ${sourceStat.size}`);
      jsonBytes = header.readUInt32LE(12);
      if (header.readUInt32LE(16) !== 0x4e4f534a) throw new Error("GLB first chunk is not JSON");
      const encoded = Buffer.alloc(jsonBytes);
      await handle.read(encoded, 0, encoded.byteLength, 20);
      json = JSON.parse(encoded.toString("utf8").trim());
      const binHeader = Buffer.alloc(8);
      await handle.read(binHeader, 0, 8, 20 + jsonBytes);
      binaryChunkBytes = binHeader.readUInt32LE(0);
      if (binHeader.readUInt32LE(4) !== 0x004e4942) throw new Error("GLB second chunk is not BIN");
    }
  } finally { await handle.close(); }

  let sourceSha256, descriptorSha256, sourceBytes = sourceStat.size, externalBuffers = [];
  if (format === "glb") {
    sourceSha256 = descriptorSha256 = await hashFile(source);
  } else {
    format = "gltf";
    const encoded = await readFile(source);
    jsonBytes = encoded.byteLength;
    json = JSON.parse(encoded.toString("utf8"));
    descriptorSha256 = sha(encoded);
    const identity = createHash("sha256").update(`gltf:${descriptorSha256}\n`);
    for (const [index, buffer] of (json.buffers ?? []).entries()) {
      if (typeof buffer.uri !== "string" || buffer.uri.startsWith("data:")) continue;
      const path = resolve(dirname(source), decodeURIComponent(buffer.uri));
      const info = await stat(path);
      if (info.size !== buffer.byteLength) throw new Error(`buffer ${index} declares ${buffer.byteLength} bytes but file has ${info.size}`);
      const sha256 = options.hashExternalBuffers === false ? null : await hashFile(path);
      externalBuffers.push({ index, uri: buffer.uri, bytes: info.size, sha256 });
      sourceBytes += info.size;
      identity.update(`${index}:${buffer.uri}:${info.size}:${sha256 ?? "not-hashed"}\n`);
    }
    sourceSha256 = identity.digest("hex");
  }
  if (json.asset?.version !== "2.0") throw new Error(`source declares unsupported glTF version ${json.asset?.version ?? "missing"}`);

  const accessors = json.accessors ?? [], views = json.bufferViews ?? [], meshes = json.meshes ?? [], nodes = json.nodes ?? [];
  const primitiveTriangles = [], meshTriangles = [], modeCounts = {}, indexComponentTypes = {};
  let uniquePrimitivePositionVertices = 0;
  for (const mesh of meshes) {
    let total = 0;
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      const count = primitive.indices === undefined ? accessors[primitive.attributes?.POSITION]?.count ?? 0 : accessors[primitive.indices]?.count ?? 0;
      const triangles = mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      total += triangles;
      primitiveTriangles.push(triangles);
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
      uniquePrimitivePositionVertices += accessors[primitive.attributes?.POSITION]?.count ?? 0;
      if (primitive.indices !== undefined) {
        const component = accessors[primitive.indices]?.componentType ?? "unknown";
        indexComponentTypes[component] = (indexComponentTypes[component] ?? 0) + 1;
      }
    }
    meshTriangles.push(total);
  }

  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, index) => index);
  const meshUse = new Map();
  let reachableNodes = 0, meshInstances = 0, logicalInstancedTriangles = 0, logicalInstancedPositionVertices = 0, leafNodes = 0, maxDepth = 0;
  const visit = (index, ancestors, depth) => {
    if (ancestors.has(index)) throw new Error(`glTF node graph contains a cycle at ${index}`);
    const node = nodes[index];
    if (!node) throw new Error(`glTF scene references missing node ${index}`);
    const next = new Set(ancestors); next.add(index);
    reachableNodes++; maxDepth = Math.max(maxDepth, depth);
    if ((node.children ?? []).length === 0) leafNodes++;
    if (node.mesh !== undefined) {
      meshInstances++;
      meshUse.set(node.mesh, (meshUse.get(node.mesh) ?? 0) + 1);
      logicalInstancedTriangles += meshTriangles[node.mesh] ?? 0;
      for (const primitive of meshes[node.mesh]?.primitives ?? []) logicalInstancedPositionVertices += accessors[primitive.attributes?.POSITION]?.count ?? 0;
    }
    for (const child of node.children ?? []) visit(child, next, depth + 1);
  };
  for (const root of roots) visit(root, new Set(), 1);

  const geometryViews = new Set(), imageViews = new Set();
  for (const accessor of accessors) {
    if (Number.isInteger(accessor.bufferView)) geometryViews.add(accessor.bufferView);
    if (accessor.sparse) { geometryViews.add(accessor.sparse.indices.bufferView); geometryViews.add(accessor.sparse.values.bufferView); }
  }
  for (const image of json.images ?? []) if (Number.isInteger(image.bufferView)) imageViews.add(image.bufferView);
  const sumViews = set => [...set].reduce((sum, index) => sum + (views[index]?.byteLength ?? 0), 0);
  const referencedMeshes = [...meshUse.keys()];
  const sorted = [...primitiveTriangles].sort((left, right) => left - right);
  const meshoptViews = views.filter(view => view.extensions?.EXT_meshopt_compression);
  const virtualBuffers = format === "gltf" ? (json.buffers ?? []).flatMap((buffer, index) => {
    const references = views.filter(view => view.buffer === index);
    return buffer.uri === undefined && references.length > 0 && references.every(view => view.extensions?.EXT_meshopt_compression) ? [{ index, bytes: buffer.byteLength }] : [];
  }) : [];
  const manifest = {
    schema: format === "glb" ? "oengine-authored-glb-workload-v1" : "oengine-authored-gltf-workload-v1",
    file: basename(source),
    sourceSha256,
    sourceBytes,
    provenance: { kind: "local-file", label: options.label ?? basename(source), license: options.license ?? "unknown-not-for-redistribution", sourcePath: source },
    container: { format, descriptorBytes: sourceStat.size, descriptorSha256, jsonBytes, binaryChunkBytes, externalBuffers, virtualBuffers, generator: json.asset?.generator ?? null, extensionsUsed: json.extensionsUsed ?? [], extensionsRequired: json.extensionsRequired ?? [] },
    workload: {
      layout: "authored-multi-primitive",
      sourceTriangles: primitiveTriangles.reduce((sum, value) => sum + value, 0),
      logicalInstancedTriangles,
      uniquePrimitivePositionVertices,
      logicalInstancedPositionVertices,
      nodes: nodes.length,
      reachableNodes,
      leafNodes,
      maxNodeDepth: maxDepth,
      meshes: meshes.length,
      referencedMeshes: referencedMeshes.length,
      meshInstances,
      primitives: primitiveTriangles.length,
      materials: (json.materials ?? []).length,
      textures: (json.textures ?? []).length,
      images: (json.images ?? []).length,
      skins: (json.skins ?? []).length,
      animations: (json.animations ?? []).length,
      primitiveTriangleDistribution: {
        min: sorted[0] ?? 0,
        p50: percentile(sorted, 0.50),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.at(-1) ?? 0,
        over1M: sorted.filter(value => value >= 1_000_000).length,
        over10M: sorted.filter(value => value >= 10_000_000).length,
        top10: sorted.slice(-10).reverse()
      },
      modeCounts,
      indexComponentTypes
    },
    payload: {
      geometryAccessorViewBytes: sumViews(geometryViews),
      imageViewBytes: sumViews(imageViews),
      geometryBufferViews: geometryViews.size,
      imageBufferViews: imageViews.size,
      meshoptCompressedViewBytes: meshoptViews.reduce((sum, view) => sum + (view.extensions.EXT_meshopt_compression.byteLength ?? 0), 0),
      meshoptCompressedViews: meshoptViews.length
    }
  };
  if (format === "glb") manifest.glb = { jsonChunkBytes: jsonBytes, binaryChunkBytes, generator: json.asset?.generator ?? null, extensionsUsed: json.extensionsUsed ?? [], extensionsRequired: json.extensionsRequired ?? [] };
  if (output !== undefined) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }
  return manifest;
}

/** Compatibility entry point for callers that require a single-file GLB. */
export async function inspectGlbWorkload(options) {
  const manifest = await inspectGltfWorkload(options);
  if (manifest.container.format !== "glb") throw new Error("source is not a glTF 2.0 GLB");
  return manifest;
}

function percentile(sorted, fraction) { return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]; }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashFile(path) { return new Promise((resolvePromise, reject) => { const hash = createHash("sha256"), stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolvePromise(hash.digest("hex"))); }); }
function parseArgs(argv) { const options = {}; for (let index = 0; index < argv.length; index++) { const name = argv[index]; if (name === "--source") options.source = argv[++index]; else if (name === "--out") options.output = argv[++index]; else if (name === "--label") options.label = argv[++index]; else if (name === "--license") options.license = argv[++index]; else if (name === "--no-external-hash") options.hashExternalBuffers = false; else throw new Error(`unknown option: ${name}`); } if (!options.source) throw new Error("Usage: node tools/inspect-glb-workload.mjs --source <scene.glb|scene.gltf> [--out <manifest.json>] [--label <name>] [--license <SPDX-or-note>] [--no-external-hash]"); return options; }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await inspectGltfWorkload(parseArgs(process.argv.slice(2)))));
