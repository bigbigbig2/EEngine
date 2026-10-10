import { createReadStream } from "node:fs";
import { open, readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyTestBuild } from "../../tools/test-build.mjs";
import { nativeBcCalls } from "./offline-bc-calls.mjs";
import { cookPcTextureRgba } from "../.test-dist/assets/codec/PcTextureCook.js";
import { saveTextureProduct, openTextureProduct } from "../.test-dist/assets/TextureProduct.js";
import {
  MATERIAL_TEXTURE_PROPERTIES,
  materialTextureSemantic
} from "../.test-dist/assets/PcMaterialTextures.js";
import { parseGltfMaterial } from "../.test-dist/loaders/gltf/gltfMaterials.js";
import { textureFromGltf } from "../.test-dist/loaders/gltf/gltfTextures.js";
import { ShadeImage } from "../.test-dist/texture/ShadeImage.js";
import { ShadeTransparencyMode } from "../.test-dist/material/enums.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const executable = resolve(root, ".local/t4-1-codec-build/bc-reference.exe");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MiB = 1024 * 1024;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const run = (command, args, onLine = () => {}) =>
  new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      onLine(bytes.toString());
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? accept(stdout) : reject(new Error(`${command}: exit ${code}\n${stderr}`))
    );
  });
const log = (value) => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));

async function range(path, offset, length) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, offset + read);
      if (!result.bytesRead) throw new Error("Unexpected GLB EOF");
      read += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function textureTask(taskPath) {
  const task = await json(taskPath);
  const lockPath = task.output + ".lock";
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, "wx");
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(
        await readFile(lockPath, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      );
      if (owner) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          await unlink(lockPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
      await new Promise((accept) => setTimeout(accept, 1000));
    }
  }
  try {
    const started = performance.now();
    const encoded = await range(task.source, task.offset, task.length);
    const encodedHash = hash(encoded);
    const native = await json(executable + ".json");
    if (hash(await readFile(executable)) !== native.binaryHash)
      throw new Error("Native BC executable identity mismatch");
    if (
      native.revision !== "99f52d63aa6799cbdaecfe977111dc5ec3b31d47" ||
      native.recipe !== "bc7e-scalar-6-bc4-hq"
    ) {
      throw new Error("Native BC recipe mismatch");
    }
    try {
      const saved = await readFile(task.output);
      const product = await openTextureProduct(
        saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength)
      );
      const receipt = await json(task.output + ".json");
      if (
        receipt.encodedHash !== encodedHash ||
        receipt.binaryHash !== native.binaryHash ||
        product.metadata.semantic !== task.options.semantic ||
        product.metadata.exactAlpha !== task.options.exactAlpha ||
        product.metadata.channel !== task.options.channel ||
        product.metadata.sourceUri !== task.options.sourceUri
      ) {
        throw new Error("Saved Product does not match source/recipe/usage");
      }
      log({ phase: "texture", reused: true, image: task.imageIndex });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const require = createRequire(resolve(root, ".local/offline-cook-deps/package.json"));
    let decoded;
    if (task.mimeType === "image/png") {
      const { PNG } = require("pngjs");
      // pngjs returns straight RGBA; gamma adjustment is deliberately not requested.
      decoded = PNG.sync.read(encoded);
    } else if (task.mimeType === "image/webp") {
      const sharp = require("sharp");
      const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.channels !== 4) throw new Error("WebP decoder must produce straight RGBA");
      decoded = { data, width: info.width, height: info.height };
    } else {
      throw new Error(`Offline image producer cannot decode ${task.mimeType}`);
    }
    const decodeMs = performance.now() - started;
    const scratch = dirname(taskPath);
    const result = await cookPcTextureRgba(
      {
        basis: nativeBcCalls(executable, scratch),
        basisHash: native.binaryHash,
        ktx: { HEAPU8: new Uint8Array(0) },
        ktxHash: ""
      },
      decoded.data,
      decoded.width,
      decoded.height,
      { ...task.options, sourceBytes: encoded.length }
    );
    const bytes = await saveTextureProduct(result.product);
    await writeFile(task.output + ".partial", new Uint8Array(bytes));
    const receipt = {
      imageIndex: task.imageIndex,
      encodedHash,
      binaryHash: native.binaryHash,
      identity: result.product.identity,
      metadata: result.product.metadata,
      payloadBytes: result.product.evidence.ownedPayloadBytes,
      packageBytes: bytes.byteLength,
      decodeMs,
      prepareMs: result.evidence.prepareMs,
      encodeMs: result.evidence.encodeMs,
      wallMs: performance.now() - started
    };
    await writeJson(task.output + ".json", receipt);
    await rename(task.output + ".partial", task.output);
    log({ phase: "texture", image: task.imageIndex, wallMs: receipt.wallMs, encodeMs: receipt.encodeMs });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function cookScene(input, output, workers) {
  await verifyTestBuild(root);
  const started = performance.now();
  await mkdir(output, { recursive: true });
  const header = await range(input, 0, 20);
  if (
    header.readUInt32LE(0) !== 0x46546c67 ||
    header.readUInt32LE(4) !== 2 ||
    header.readUInt32LE(16) !== 0x4e4f534a
  ) {
    throw new Error("Expected GLB2 JSON chunk");
  }
  const sourceBytes = header.readUInt32LE(8);
  const jsonLength = header.readUInt32LE(12);
  const document = JSON.parse((await range(input, 20, jsonLength)).toString("utf8"));
  // Resolve the encoded WebP source before the ordinary material importer maps textures.
  for (const texture of document.textures ?? []) {
    const webpSource = texture.extensions?.EXT_texture_webp?.source;
    if (webpSource !== undefined) texture.source = webpSource;
  }
  const binHeader = await range(input, 20 + jsonLength, 8);
  if (binHeader.readUInt32LE(4) !== 0x004e4942 || document.buffers?.length !== 1)
    throw new Error("Expected one embedded GLB buffer");
  const binOffset = 28 + jsonLength;
  const sourceHash = await new Promise((accept, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(input);
    stream.on("data", (bytes) => digest.update(bytes));
    stream.once("error", reject);
    stream.once("end", () => accept(digest.digest("hex")));
  });
  log({ phase: "catalog", sourceBytes, sourceHash });

  const images = document.images.map(() => ShadeImage.fromEncodedImage(new ArrayBuffer(0), "image/png"));
  const textures = document.textures.map((value) => textureFromGltf(value, images, document.samplers));
  const materials = document.materials.map((value) => parseGltfMaterial(value, textures));
  const textureIndices = new Map(textures.map((texture, index) => [texture, index]));
  const multichannel = new Set();
  for (const material of materials) {
    for (const name of ["texture_orm", "texture_clearcoat_roughness", "texture_specular"]) {
      if (material[name]) multichannel.add(material[name].image);
    }
  }
  const tasks = new Map();
  const bindings = materials.map((material) => {
    const result = {};
    for (const property of MATERIAL_TEXTURE_PROPERTIES) {
      const texture = material[property];
      if (!texture) continue;
      const textureIndex = textureIndices.get(texture);
      const imageIndex = document.textures[textureIndex].source;
      const image = document.images[imageIndex];
      if (image.bufferView === undefined) throw new Error("Expected embedded image");
      const view = document.bufferViews[image.bufferView];
      let semantic = materialTextureSemantic(property);
      if (semantic === "occlusion-linear" && multichannel.has(texture.image)) semantic = "orm-linear";
      const options = {
        semantic,
        exactAlpha:
          property === "texture_albedo" && material.transparency_mode !== ShadeTransparencyMode.Opaque,
        channel: property === "texture_clearcoat_roughness" ? 1 : 0,
        sourceUri: `sha256:${sourceHash}/image/${imageIndex}`
      };
      const key = hash(JSON.stringify([imageIndex, options]));
      const uri = `textures/${key}.textureproduct`;
      tasks.set(key, {
        source: input,
        offset: binOffset + (view.byteOffset ?? 0),
        length: view.byteLength,
        imageIndex,
        mimeType: image.mimeType,
        options,
        output: join(output, uri)
      });
      result[property] = { textureIndex, uri };
    }
    return result;
  });
  const cookedImages = new Set([...tasks.values()].map((task) => task.imageIndex));
  if (cookedImages.size !== document.images.length)
    throw new Error(
      `Material importer uses ${cookedImages.size}/${document.images.length} images; cannot claim complete cook`
    );
  await mkdir(join(output, "textures"), { recursive: true });

  // Split material domains without copying vertex/image payloads or changing the GLB.
  const geometry = structuredClone(document);
  geometry.buffers = [{ uri: relative(output, input).replaceAll("\\", "/"), byteLength: sourceBytes }];
  for (const view of geometry.bufferViews) view.byteOffset = (view.byteOffset ?? 0) + binOffset;
  const meshParts = [];
  geometry.meshes = document.meshes.flatMap((mesh) => {
    const parts = [];
    const result = mesh.primitives.map((primitive) => {
      if ((primitive.mode ?? 4) !== 4) throw new Error("Offline scene supports triangle primitives only");
      parts.push(meshParts.reduce((sum, p) => sum + p.length, 0) + parts.length);
      return { name: mesh.name, primitives: [primitive] };
    });
    meshParts.push(parts);
    return result;
  });
  const instanceMaterials = [],
    instanceProfiles = [];
  geometry.nodes = document.nodes.map((node) => {
    if (node.skin !== undefined) throw new Error("Static offline scene does not support skinning");
    const result = structuredClone(node);
    delete result.mesh;
    return result;
  });
  for (const [nodeIndex, node] of document.nodes.entries()) {
    if (node.mesh === undefined) continue;
    for (const meshIndex of meshParts[node.mesh]) {
      const primitive = geometry.meshes[meshIndex].primitives[0];
      const a = primitive.attributes;
      const child = geometry.nodes.length;
      geometry.nodes.push({
        mesh: meshIndex,
        ...(node.extras === undefined ? {} : { extras: structuredClone(node.extras) })
      });
      (geometry.nodes[nodeIndex].children ??= []).push(child);
      instanceMaterials.push(primitive.material ?? 0);
      instanceProfiles.push({
        hasAuthoredVertexColor: a.COLOR_0 !== undefined,
        hasUv0: a.TEXCOORD_0 !== undefined,
        hasUv1: a.TEXCOORD_1 !== undefined,
        hasUv2: false,
        hasNormal: true,
        hasTangent: a.TANGENT !== undefined
      });
    }
  }
  const geometryInput = join(output, "geometry-input.gltf");
  await writeJson(geometryInput, geometry);
  const geometryKey = hash(
    JSON.stringify({
      sourceHash,
      input: geometry,
      cooker: hash(
        await readFile(resolve(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe"))
      ),
      shardBytes: Number(process.env.OENGINE_OFFLINE_SHARD_BYTES ?? 64 * MiB)
    })
  );
  let geometryReceipt;
  try {
    geometryReceipt = await json(join(output, "geometry-cook.json"));
    if (geometryReceipt.key !== geometryKey) throw new Error("Geometry output source/cooker mismatch");
  } catch (error) {
    if (
      error.code !== "ENOENT" &&
      !String(error.message).includes("Geometry output source/cooker mismatch")
    ) {
      throw error;
    }
    log({ phase: "geometry", state: "cooking", workers });
    const stdout = await run(
      resolve(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe"),
      [
        geometryInput,
        "--out",
        output,
        "--threads",
        String(workers),
        "--shard-bytes",
        String(Number(process.env.OENGINE_OFFLINE_SHARD_BYTES ?? 64 * MiB))
      ]
    );
    geometryReceipt = { key: geometryKey, ...JSON.parse(stdout) };
    await writeJson(join(output, "geometry-cook.json"), geometryReceipt);
  }
  const scene = await json(join(output, "scene.oescene"));
  if (scene.instances.length !== instanceMaterials.length)
    throw new Error("Offline geometry lost source instances");
  for (const pack of scene.packs) {
    await run(resolve(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe"), [
      "validate",
      join(output, pack.uri)
    ]);
  }
  log({ phase: "geometry", state: "ready", ...geometryReceipt });
  const list = [...tasks.entries()];
  let next = 0,
    completed = 0;
  log({ phase: "textures", state: "cooking", tasks: list.length, sourceImages: cookedImages.size, workers });
  await Promise.all(
    Array.from({ length: workers }, async (_, slot) => {
      const scratch = join(output, ".scratch", String(process.pid), String(slot));
      await mkdir(scratch, { recursive: true });
      while (next < list.length) {
        const [key, task] = list[next++];
        const path = join(scratch, "task.json");
        await writeJson(path, task);
        await run(process.execPath, [self, "--texture-task", path]);
        completed++;
        const receipt = await json(task.output + ".json");
        log({
          phase: "textures",
          completed,
          total: list.length,
          key,
          image: task.imageIndex,
          encodeMs: receipt.encodeMs,
          wallMs: receipt.wallMs
        });
        await writeJson(join(output, "cook-progress.json"), {
          phase: "textures",
          completed,
          total: list.length,
          elapsedMs: performance.now() - started
        });
      }
    })
  );
  const receipts = await Promise.all([...tasks.values()].map((task) => json(task.output + ".json")));
  const planeCount = (format) =>
    receipts.reduce(
      (sum, receipt) => sum + receipt.metadata.planes.filter((p) => p.format.startsWith(format)).length,
      0
    );
  const triangles = document.meshes.reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (n, p) => n + document.accessors[p.indices ?? p.attributes.POSITION].count / 3,
        0
      ),
    0
  );
  const result = {
    schema: "oengine-offline-scene-materials-v1",
    source: {
      path: input,
      bytes: sourceBytes,
      sha256: sourceHash,
      triangles,
      meshes: document.meshes.length,
      primitives: geometry.meshes.length,
      materials: materials.length,
      textures: document.textures.length,
      images: document.images.length
    },
    geometryManifest: "scene.oescene",
    geometryManifestHash: hash(await readFile(join(output, "scene.oescene"))),
    gltf: { materials: document.materials, textures: document.textures, samplers: document.samplers },
    bindings,
    instanceMaterials,
    instanceProfiles,
    products: receipts.map((receipt, index) => ({
      uri: `textures/${list[index][0]}.textureproduct`,
      identity: receipt.identity
    })),
    evidence: {
      products: receipts.length,
      bc7: planeCount("bc7"),
      bc4: planeCount("bc4"),
      r8: planeCount("r8unorm"),
      packageBytes: receipts.reduce((sum, r) => sum + r.packageBytes, 0),
      payloadBytes: receipts.reduce((sum, r) => sum + r.payloadBytes, 0),
      totalEncodeMs: receipts.reduce((sum, r) => sum + r.encodeMs, 0),
      wallMs: performance.now() - started,
      pngDecoder: "pngjs 7.0.0, straight RGBA, no gamma adjustment",
      ...(list.some(([, task]) => task.mimeType === "image/webp")
        ? { webpDecoder: "sharp 0.34.5, straight RGBA, no resize or gamma adjustment" }
        : {}),
      runtimeDecode: 0,
      runtimeEncode: 0,
      runtimeTranscode: 0,
      runtimeMipGeneration: 0,
      runtimeCodecWorkers: 0,
      runtimeGeometryCook: 0
    }
  };
  const pendingManifest = join(output, `scene.materials.json.${process.pid}.partial`);
  await writeJson(pendingManifest, result);
  await rename(pendingManifest, join(output, "scene.materials.json"));
  log({ phase: "complete", output, ...result.evidence });
}

try {
  if (process.argv[2] === "--texture-task") await textureTask(resolve(process.argv[3]));
  else {
    const input = resolve(
      process.argv[2] ?? resolve(root, ".local/models/BistroExterior_static_fixed_occlusion.glb")
    );
    const output = resolve(process.argv[3] ?? resolve(root, ".local/models/bistro-cooked"));
    const workers = Number(process.argv[4] ?? 4);
    if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error("Workers must be 1..8");
    await cookScene(input, output, workers);
  }
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
