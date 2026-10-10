import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultCooker = join(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe");
const GiB = 1024 ** 3;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const log = (value) => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));

async function atomicJson(path, value) {
  const pending = `${path}.${process.pid}.partial`;
  await writeFile(pending, JSON.stringify(value, null, 2) + "\n");
  await rename(pending, path);
}

async function hashFile(path, signal) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) {
    signal?.throwIfAborted();
    digest.update(bytes);
  }
  return digest.digest("hex");
}

async function acquireLock(path) {
  for (;;) {
    try {
      const lock = await open(path, "wx");
      await lock.writeFile(String(process.pid));
      await lock.sync();
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8");
      if (!/^[1-9][0-9]*$/u.test(owner)) throw new Error("Cook output has an incomplete lock");
      try {
        process.kill(Number(owner), 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        if ((await readFile(path, "utf8")) !== owner) throw new Error("Cook lock owner changed");
        await unlink(path);
        continue;
      }
      throw new Error(`Cook output is already owned by process ${owner}`);
    }
  }
}

function triangles(document, primitive) {
  if ((primitive.mode ?? 4) !== 4) throw new Error("Range cook requires triangle lists");
  if (primitive.targets || primitive.extensions)
    throw new Error("Morph/primitive extensions require a separate import profile");
  const accessor = document.accessors[primitive.indices ?? primitive.attributes.POSITION];
  if (!accessor || accessor.count % 3 !== 0) throw new Error("Invalid triangle accessor");
  return accessor.count / 3;
}

export function rangeSceneCatalog(document) {
  if (document.asset?.version !== "2.0") throw new Error("Expected glTF 2.0");
  if ((document.images?.length ?? 0) || (document.textures?.length ?? 0)) {
    throw new Error(
      "This range producer is geometry-only; texture-bearing scenes require the texture producer"
    );
  }
  if ((document.skins?.length ?? 0) || (document.animations?.length ?? 0)) {
    throw new Error("Range offline cook supports static scenes only");
  }
  if ((document.extensionsRequired ?? []).some((name) => name !== "EXT_meshopt_compression")) {
    throw new Error("Unsupported required glTF extension");
  }
  const meshes = document.meshes.map((mesh, index) => ({
    index,
    triangles: mesh.primitives.reduce((sum, primitive) => sum + triangles(document, primitive), 0),
    vertices: mesh.primitives.reduce((sum, p) => sum + document.accessors[p.attributes.POSITION].count, 0),
    primitives: mesh.primitives.length,
    nodes: []
  }));
  const parents = new Map();
  const visited = new Set();
  const visit = (index, parent) => {
    if (visited.has(index)) throw new Error(`Scene repeats/cycles node ${index}`);
    const node = document.nodes[index];
    if (!node) throw new Error(`Missing node ${index}`);
    visited.add(index);
    parents.set(index, parent);
    if (node.skin !== undefined || node.extensions) throw new Error("Unsupported node skin/extension");
    if (node.mesh !== undefined) {
      if (!meshes[node.mesh]) throw new Error(`Missing mesh ${node.mesh}`);
      meshes[node.mesh].nodes.push(index);
    }
    for (const child of node.children ?? []) visit(child, index);
  };
  const scene = document.scenes?.[document.scene ?? 0];
  if (!scene) throw new Error("Missing default scene");
  for (const index of scene.nodes) visit(index, undefined);
  return { meshes, parents, roots: scene.nodes, reachableNodes: visited.size };
}

export function meshRangeDocument(document, catalog, meshIndex, input) {
  const mesh = document.meshes[meshIndex];
  if (!mesh || !catalog.meshes[meshIndex].nodes.length)
    throw new Error("Mesh has no default-scene instances");
  const neededNodes = new Set();
  for (const node of catalog.meshes[meshIndex].nodes) {
    for (let current = node; current !== undefined; current = catalog.parents.get(current))
      neededNodes.add(current);
  }
  const nodeIndices = [...neededNodes].sort((a, b) => a - b);
  const nodeMap = new Map(nodeIndices.map((index, local) => [index, local]));
  const accessorMap = new Map(),
    viewMap = new Map();
  const addView = (index) => {
    if (index === undefined) return undefined;
    if (!document.bufferViews[index]) throw new Error(`Missing bufferView ${index}`);
    if (!viewMap.has(index)) viewMap.set(index, viewMap.size);
    return viewMap.get(index);
  };
  const addAccessor = (index) => {
    if (index === undefined) return undefined;
    const accessor = document.accessors[index];
    if (!accessor) throw new Error(`Missing accessor ${index}`);
    if (!accessorMap.has(index)) {
      accessorMap.set(index, accessorMap.size);
      addView(accessor.bufferView);
      if (accessor.sparse) {
        addView(accessor.sparse.indices.bufferView);
        addView(accessor.sparse.values.bufferView);
      }
    }
    return accessorMap.get(index);
  };
  // Match the existing offline material route: one asset per original primitive.
  // Whole primitives retain their topology and shared compressed view ranges.
  const meshes = mesh.primitives.map((primitive) => ({
    primitives: [
      {
        ...primitive,
        attributes: Object.fromEntries(
          Object.entries(primitive.attributes).map(([name, index]) => [name, addAccessor(index)])
        ),
        ...(primitive.indices === undefined ? {} : { indices: addAccessor(primitive.indices) })
      }
    ]
  }));
  const accessors = [...accessorMap.keys()].map((index) => {
    const accessor = structuredClone(document.accessors[index]);
    if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = viewMap.get(accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = viewMap.get(accessor.sparse.values.bufferView);
    }
    return accessor;
  });
  const nodes = nodeIndices.map((index) => {
    const node = structuredClone(document.nodes[index]);
    delete node.mesh;
    node.children = (node.children ?? [])
      .filter((child) => neededNodes.has(child))
      .map((child) => nodeMap.get(child));
    return node;
  });
  const instanceMaterials = [],
    instanceProfiles = [],
    sourceInstances = [];
  for (const nodeIndex of catalog.meshes[meshIndex].nodes) {
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      nodes[nodeMap.get(nodeIndex)].children.push(nodes.length);
      nodes.push({ mesh: primitiveIndex, extras: document.nodes[nodeIndex].extras });
      instanceMaterials.push(primitive.material ?? document.materials?.length ?? 0);
      const attributes = primitive.attributes;
      instanceProfiles.push({
        hasAuthoredVertexColor: attributes.COLOR_0 !== undefined,
        hasUv0: attributes.TEXCOORD_0 !== undefined,
        hasUv1: attributes.TEXCOORD_1 !== undefined,
        hasUv2: false,
        hasNormal: true,
        hasTangent: attributes.TANGENT !== undefined
      });
      if (attributes.TEXCOORD_2 !== undefined) throw new Error("UV2 requires a separate cook profile");
      sourceInstances.push({ node: nodeIndex, mesh: meshIndex, primitive: primitiveIndex });
    }
  }
  return {
    document: {
      asset: document.asset,
      extensionsUsed: document.extensionsUsed,
      extensionsRequired: document.extensionsRequired,
      buffers: document.buffers.map((buffer) => {
        if (!buffer.uri) return buffer;
        if (buffer.uri.startsWith("data:") || buffer.uri.includes("://"))
          throw new Error("Expected local external buffer");
        return {
          ...buffer,
          uri: encodeURI(resolve(dirname(input), decodeURIComponent(buffer.uri)).replaceAll("\\", "/"))
        };
      }),
      bufferViews: [...viewMap.keys()].map((index) => document.bufferViews[index]),
      accessors,
      materials: document.materials ?? [],
      meshes,
      nodes,
      scenes: [
        { nodes: catalog.roots.filter((index) => neededNodes.has(index)).map((index) => nodeMap.get(index)) }
      ],
      scene: 0
    },
    instanceMaterials,
    instanceProfiles,
    sourceInstances
  };
}

async function nativeRun(executable, args, logPath, signal) {
  signal?.throwIfAborted();
  const output = await open(logPath, "w");
  try {
    return await new Promise((accept, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", output.fd],
        signal
      });
      let stdout = "";
      let failure;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) =>
        failure
          ? reject(failure)
          : code === 0
            ? accept(stdout)
            : reject(new Error(`Native cooker exited ${code}; see ${logPath}`))
      );
    });
  } finally {
    await output.close();
  }
}

async function packHeader(path) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(256);
    const read = await file.read(bytes, 0, 256, 0);
    if (read.bytesRead !== 256) throw new Error("Incomplete pack header");
    if (bytes.subarray(0, 8).toString("ascii") !== "OEGPACK\0" || bytes.readUInt32LE(8) !== 3)
      throw new Error("Invalid pack header");
    const length = (await file.stat()).size;
    if (Number(bytes.readBigUInt64LE(136)) !== length) throw new Error("Pack length mismatch");
    // OegPackFormat.h: header offsets 40/72, 128-byte asset, source triangles at 104.
    const count = bytes.readUInt32LE(40),
      offset = Number(bytes.readBigUInt64LE(72));
    if (!Number.isSafeInteger(offset) || offset + count * 128 > length)
      throw new Error("Invalid asset table extent");
    const records = Buffer.alloc(count * 128);
    if ((await file.read(records, 0, records.length, offset)).bytesRead !== records.length)
      throw new Error("Short asset table");
    const sourceTriangles = Array.from({ length: count }, (_, index) =>
      records.readUInt32LE(index * 128 + 104)
    );
    return {
      bytes: length,
      sha256: await hashFile(path),
      sourceTriangles,
      metadataBytes: Number(bytes.readBigUInt64LE(128))
    };
  } finally {
    await file.close();
  }
}

export async function cookRangeScene(options) {
  const input = resolve(options.input),
    output = resolve(options.output);
  const cooker = resolve(options.cooker ?? defaultCooker);
  const memoryLimit = options.memoryLimit ?? 24 * GiB;
  if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 256 * 1024 ** 2)
    throw new Error("Invalid process memory limit");
  await mkdir(output, { recursive: true });
  const lockPath = join(output, ".cook.lock");
  const lock = await acquireLock(lockPath);
  try {
    const started = performance.now();
    const encoded = await readFile(input);
    const document = JSON.parse(encoded.toString("utf8"));
    const catalog = rangeSceneCatalog(document);
    const identity = { descriptor: hash(encoded), buffers: [] };
    for (const buffer of document.buffers) {
      if (!buffer.uri) continue;
      const path = resolve(dirname(input), decodeURIComponent(buffer.uri));
      const info = await stat(path);
      if (info.size !== buffer.byteLength) throw new Error("External buffer size mismatch");
      log({ phase: "source-hash", path, bytes: info.size });
      identity.buffers.push({
        uri: buffer.uri,
        bytes: info.size,
        sha256: await hashFile(path, options.signal)
      });
    }
    const sourceHash = hash(JSON.stringify(identity));
    const cookerHash = await hashFile(cooker);
    const sourceBytes = encoded.length + identity.buffers.reduce((sum, b) => sum + b.bytes, 0);
    const selection =
      options.mesh === undefined
        ? catalog.meshes.map((m) => m.index)
        : [
            options.mesh === "largest"
              ? [...catalog.meshes].sort((a, b) => b.triangles - a.triangles)[0].index
              : Number(options.mesh)
          ];
    const jobs = [];
    for (const meshIndex of selection) {
      options.signal?.throwIfAborted();
      const mesh = catalog.meshes[meshIndex];
      if (!mesh) throw new Error("Invalid mesh selection");
      const directory = join(output, "meshes", String(meshIndex).padStart(5, "0"));
      await mkdir(directory, { recursive: true });
      const selected = meshRangeDocument(document, catalog, meshIndex, input);
      const key = hash(
        JSON.stringify({
          sourceHash,
          cookerHash,
          meshIndex,
          profile: "range-mesh-static-v1",
          shardBytes: 64 * 1024 ** 2
        })
      );
      const receiptPath = join(directory, "receipt.json");
      let receipt;
      try {
        receipt = await readJson(receiptPath);
        if (receipt.key !== key)
          throw new Error(
            "Existing mesh receipt does not match source/cooker; choose a fresh output directory"
          );
        for (const pack of receipt.packs) {
          const actual = await packHeader(join(directory, pack.uri));
          if (actual.sha256 !== pack.sha256 || actual.bytes !== pack.bytes)
            throw new Error("Saved mesh pack checksum mismatch");
        }
        if (hash(await readFile(join(directory, "scene.oescene"))) !== receipt.manifestHash)
          throw new Error("Saved mesh manifest checksum mismatch");
        log({ phase: "mesh", mesh: meshIndex, reused: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const descriptor = join(directory, "input.gltf");
        await atomicJson(descriptor, selected.document);
        log({
          phase: "mesh-start",
          mesh: meshIndex,
          triangles: mesh.triangles,
          vertices: mesh.vertices,
          memoryLimit
        });
        const logPath = join(directory, `native-${Date.now()}.log`);
        if ((await hashFile(cooker)) !== cookerHash)
          throw new Error("Native cooker changed during this scene cook");
        const result = JSON.parse(
          await nativeRun(
            cooker,
            [
              descriptor,
              "--out",
              directory,
              "--threads",
              "1",
              "--shard-bytes",
              String(64 * 1024 ** 2),
              "--memory-limit",
              String(memoryLimit)
            ],
            logPath,
            options.signal
          )
        );
        const scene = await readJson(join(directory, "scene.oescene"));
        if (scene.instances.length !== selected.sourceInstances.length)
          throw new Error("Native cook lost primitive instances");
        const packs = [];
        for (const pack of scene.packs)
          packs.push({ ...pack, ...(await packHeader(join(directory, pack.uri))) });
        receipt = {
          key,
          mesh: meshIndex,
          sourceTriangles: mesh.triangles,
          result,
          packs,
          manifestHash: hash(await readFile(join(directory, "scene.oescene")))
        };
        await atomicJson(receiptPath, receipt);
        log({ phase: "mesh-complete", mesh: meshIndex, ...result });
      }
      const scene = await readJson(join(directory, "scene.oescene"));
      if (scene.instances.length !== selected.sourceInstances.length)
        throw new Error("Incomplete mesh instance coverage");
      scene.instances.forEach((instance, index) => {
        const asset = scene.assets[instance.asset];
        const actual = receipt.packs[asset.pack].sourceTriangles[asset.assetRecordIndex];
        const expected = triangles(
          document,
          document.meshes[meshIndex].primitives[selected.sourceInstances[index].primitive]
        );
        if (actual !== expected)
          throw new Error("Cooked asset source triangle coverage differs from original primitive");
      });
      jobs.push({ directory, selected, receipt, scene });
      await atomicJson(join(output, "cook-progress.json"), {
        sourceHash,
        cookerHash,
        selection,
        completed: jobs.map((j) => j.receipt.mesh),
        total: selection.length,
        elapsedMs: performance.now() - started
      });
    }
    const scene = {
      schema: "oengine-scene-v3",
      instanceSemantics: "cast-receive-explicit-v1",
      packs: [],
      assets: [],
      instances: []
    };
    const instanceMaterials = [],
      instanceProfiles = [],
      sourceInstances = [];
    const packIds = new Map(),
      assetIds = new Map();
    let packageBytes = 0;
    let metadataBytes = 0;
    for (const job of jobs) {
      const packMap = job.scene.packs.map((pack, index) => {
        if (!packIds.has(pack.packId)) {
          packIds.set(pack.packId, scene.packs.length);
          scene.packs.push({
            ...pack,
            uri: relative(output, join(job.directory, pack.uri)).replaceAll("\\", "/")
          });
          packageBytes += job.receipt.packs[index].bytes;
          metadataBytes += job.receipt.packs[index].metadataBytes;
        }
        return packIds.get(pack.packId);
      });
      const assetMap = job.scene.assets.map((asset) => {
        if (!assetIds.has(asset.assetId)) {
          assetIds.set(asset.assetId, scene.assets.length);
          scene.assets.push({ ...asset, pack: packMap[asset.pack] });
        }
        return assetIds.get(asset.assetId);
      });
      job.scene.instances.forEach((instance, index) => {
        scene.instances.push({ ...instance, asset: assetMap[instance.asset] });
        instanceMaterials.push(job.selected.instanceMaterials[index]);
        instanceProfiles.push(job.selected.instanceProfiles[index]);
        sourceInstances.push(job.selected.sourceInstances[index]);
      });
    }
    const fullScene = options.mesh === undefined;
    const coveredTriangles = selection.reduce((sum, index) => sum + catalog.meshes[index].triangles, 0);
    const coveredPrimitiveInstances = selection.reduce(
      (sum, index) => sum + catalog.meshes[index].nodes.length * catalog.meshes[index].primitives,
      0
    );
    if (
      scene.instances.length !== coveredPrimitiveInstances ||
      (fullScene && jobs.length !== document.meshes.length)
    )
      throw new Error("Incomplete source coverage");
    const geometryName = fullScene ? "scene.oescene" : "probe.oescene";
    await atomicJson(join(output, geometryName), scene);
    const report = {
      source: {
        path: input,
        bytes: sourceBytes,
        sha256: sourceHash,
        triangles: coveredTriangles,
        meshes: selection.length,
        primitives: selection.reduce((sum, index) => sum + catalog.meshes[index].primitives, 0),
        materials: document.materials?.length ?? 0,
        textures: 0,
        images: 0
      },
      fullScene,
      selection,
      packageBytes,
      metadataBytes,
      instances: scene.instances.length,
      hierarchyBytes: jobs.reduce((sum, j) => sum + j.receipt.result.hierarchyBytes, 0),
      bootstrapPayloadBytes: jobs.reduce((sum, j) => sum + j.receipt.result.bootstrapGeometryBytes, 0),
      bootstrapPhysicalBytes: jobs.reduce(
        (sum, j) => sum + j.receipt.result.bootstrapPageCount * 256 * 1024,
        0
      ),
      processPeakWorkingBytes: Math.max(...jobs.map((j) => j.receipt.result.peakWorkingBytes)),
      memoryLimit,
      wallMs: performance.now() - started,
      jobs: jobs.map((j) => ({
        mesh: j.receipt.mesh,
        triangles: j.receipt.sourceTriangles,
        ...j.receipt.result
      }))
    };
    const materials = [...(document.materials ?? [])];
    if (document.meshes.some((mesh) => mesh.primitives.some((primitive) => primitive.material === undefined)))
      materials.push({});
    const materialManifest = {
      schema: "oengine-offline-scene-materials-v1",
      source: report.source,
      geometryManifest: geometryName,
      geometryManifestHash: hash(await readFile(join(output, geometryName))),
      gltf: { materials, textures: [], samplers: [] },
      bindings: Array.from({ length: materials.length }, () => ({})),
      instanceMaterials,
      instanceProfiles,
      products: [],
      evidence: {
        products: 0,
        runtimeGeometryCook: 0,
        runtimeDecode: 0,
        runtimeEncode: 0,
        wallMs: report.wallMs
      }
    };
    await atomicJson(
      join(output, fullScene ? "scene.materials.json" : "probe.materials.json"),
      materialManifest
    );
    await atomicJson(join(output, "source-map.json"), { fullScene, sourceHash, instances: sourceInstances });
    await atomicJson(join(output, "cook-report.json"), report);
    log({
      phase: "complete",
      fullScene,
      meshes: selection.length,
      triangles: coveredTriangles,
      packageBytes,
      peakWorkingBytes: report.processPeakWorkingBytes
    });
    return report;
  } catch (error) {
    await atomicJson(join(output, `failure-${Date.now()}.json`), {
      state: options.signal?.aborted ? "cancelled" : "failed",
      input,
      mesh: options.mesh ?? "all",
      memoryLimit,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...args] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      "Usage: node cook-range-gltf-scene.mjs <scene.gltf> <output> [--mesh largest|index] [--memory-gib N]"
    );
  const options = { input, output };
  for (let index = 0; index < args.length; index++) {
    const option = args[index],
      value = args[++index];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === "--mesh") options.mesh = value;
    else if (option === "--memory-gib") options.memoryLimit = Number(value) * GiB;
    else throw new Error(`Unknown option ${option}`);
  }
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  try {
    await cookRangeScene({ ...options, signal: abort.signal });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
