import { createReadStream } from "node:fs";
import { open, readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyTestBuild } from "../../tools/test-build.mjs";
import { nativeBcCalls } from "./offline-bc-calls.mjs";
import { compressTiledTexturePage, tiledCompressionIdentity } from "./tiled-texture-compress.mjs";
import { cookPcTextureRgba, resamplePcTexture } from "../.test-dist/assets/codec/PcTextureCook.js";
import { TiledTextureCook } from "../.test-dist/assets/codec/TiledTextureCook.js";
import { openTiledTextureDirectory } from "../.test-dist/assets/TiledTextureProduct.js";
import { saveTextureProduct, openTextureProduct } from "../.test-dist/assets/TextureProduct.js";
import {
  MATERIAL_TEXTURE_PROPERTIES,
  materialTextureSemantic,
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
      code === 0 ? accept(stdout) : reject(new Error(`${command}: exit ${code}\n${stderr}`)),
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
        }),
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
    let reusableProduct, reusableReceipt;
    try {
      const saved = await readFile(task.output);
      const product = await openTextureProduct(
        saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength),
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
      reusableProduct = product;
      reusableReceipt = receipt;
      const matchingTiledProfile =
        !task.tiled ||
        (receipt.tiled &&
          receipt.tiled.schemaVersion === 2 &&
          JSON.stringify(receipt.tiled.compression) === JSON.stringify(tiledCompressionIdentity) &&
          JSON.stringify(receipt.tiled.addresses) === JSON.stringify(task.tiled.addresses) &&
          JSON.stringify(receipt.tiled.residentRoles) === JSON.stringify(task.tiled.residentRoles));
      if (matchingTiledProfile) {
        if (task.tiled) {
          const tiled = receipt.tiled;
          const bytes = await readFile(resolve(dirname(task.output), tiled.uri));
          const directory = await openTiledTextureDirectory(bytes, tiled.identity);
          if (
            directory.metadata.sourceIdentity !== product.identity ||
            directory.directoryBytes !== tiled.byteLength
          ) {
            throw new Error("Saved tiled Product does not match source/profile");
          }
          // Reuse validates every cold payload; this cost is offline only.
          const pack = await open(resolve(dirname(task.output), directory.metadata.pack.uri), "r");
          try {
            if ((await pack.stat()).size !== directory.metadata.pack.byteLength) {
              throw new Error("Saved tiled pack length mismatch");
            }
            for (const p of directory.metadata.payloads) {
              const data = await range(
                resolve(dirname(task.output), directory.metadata.pack.uri),
                p.offset,
                p.byteLength,
              );
              if (
                hash(data) !== p.hash ||
                hash(await readFile(resolve(dirname(task.output), p.shard))) !== p.hash
              ) {
                throw new Error("Saved tiled payload/shard hash mismatch");
              }
            }
          } finally {
            await pack.close();
          }
          if (
            tiled.payloadBytes !== directory.metadata.pack.byteLength ||
            tiled.nativePayloadBytes !==
              directory.metadata.payloads.reduce((sum, p) => sum + p.nativeByteLength, 0) ||
            tiled.payloads !== directory.metadata.payloads.length
          ) {
            receipt.tiled = {
              ...tiled,
              payloadBytes: directory.metadata.pack.byteLength,
              nativePayloadBytes: directory.metadata.payloads.reduce((sum, p) => sum + p.nativeByteLength, 0),
              payloads: directory.metadata.payloads.length,
            };
            await writeJson(task.output + ".json", receipt);
          }
        }
        log({ phase: "texture", reused: true, image: task.imageIndex });
        return;
      }
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
    const codecs = {
      basis: nativeBcCalls(executable, scratch),
      basisHash: native.binaryHash,
      ktx: { HEAPU8: new Uint8Array(0) },
      ktxHash: "",
    };
    const tiled = task.tiled ? await openTiledSink(task, codecs) : null;
    let result;
    try {
      if (reusableProduct && tiled) {
        const product = reusableProduct;
        const metadata = product.metadata;
        if (metadata.recipe.filter !== "linear" && metadata.recipe.filter !== "linear-normal") {
          throw new Error("Tiled upgrade requires the original offline mip recipe");
        }
        let rgba = decoded.data,
          width = decoded.width,
          height = decoded.height;
        const srgb = metadata.semantic === "base-color-srgb" || metadata.semantic === "emissive-srgb";
        for (const mip of metadata.planes[0].mips) {
          if (width !== mip.width || height !== mip.height) {
            rgba = resamplePcTexture(
              codecs.basis,
              rgba,
              width,
              height,
              mip.width,
              mip.height,
              srgb,
              metadata.semantic === "normal-linear",
            );
          }
          width = mip.width;
          height = mip.height;
          for (const plane of metadata.planes) {
            await tiled.cook.appendMip({
              level: mip.level,
              width,
              height,
              rgba,
              plane,
              payload: product.chunks.get(plane.mips[mip.level].chunkId),
            });
          }
        }
        await tiled.finish(product);
        await writeJson(task.output + ".json", {
          ...reusableReceipt,
          tiled: tiled.receipt,
          tiledUpgradeMs: performance.now() - started,
        });
        log({
          phase: "texture",
          upgraded: true,
          image: task.imageIndex,
          wallMs: performance.now() - started,
        });
        return;
      }
      result = await cookPcTextureRgba(
        codecs,
        decoded.data,
        decoded.width,
        decoded.height,
        { ...task.options, sourceBytes: encoded.length },
        undefined,
        tiled ? (mip) => tiled.cook.appendMip(mip) : undefined,
      );
      if (tiled) {
        await tiled.finish(result.product);
      }
    } finally {
      await tiled?.close();
    }
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
      ...(tiled ? { tiled: tiled.receipt } : {}),
      wallMs: performance.now() - started,
    };
    await writeJson(task.output + ".json", receipt);
    await rename(task.output + ".partial", task.output);
    log({ phase: "texture", image: task.imageIndex, wallMs: receipt.wallMs, encodeMs: receipt.encodeMs });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function openTiledSink(task, codecs) {
  const stem = task.output.replace(/\.textureproduct$/u, "");
  const packPath = stem + ".vtpack";
  const directoryPath = stem + ".vtdirectory";
  const shardDir = join(dirname(task.output), "vt-shards");
  await mkdir(shardDir, { recursive: true });
  const file = await open(packPath + ".partial", "w");
  let offset = 0;
  const writtenShards = new Set();
  const packHash = createHash("sha256");
  const sink = {
    receipt: null,
    cook: new TiledTextureCook(
      codecs,
      {
        packUri: relative(dirname(task.output), packPath).replaceAll("\\", "/"),
        ...task.tiled,
        compressFinePage: compressTiledTexturePage,
        async writePayload(bytes, digest) {
          const start = offset;
          let written = 0;
          while (written < bytes.byteLength) {
            const result = await file.write(bytes, written, bytes.byteLength - written, offset + written);
            if (!result.bytesWritten) throw new Error("Tiled pack write made no progress");
            written += result.bytesWritten;
          }
          offset += bytes.byteLength;
          packHash.update(bytes);
          const shard = join(shardDir, digest + ".bin");
          if (!writtenShards.has(digest)) {
            // Atomic content-addressed publication, including concurrent cook workers.
            const pending = shard + "." + process.pid + ".partial";
            await writeFile(pending, bytes);
            await rename(pending, shard);
            writtenShards.add(digest);
          }
          return { offset: start, shard: relative(dirname(task.output), shard).replaceAll("\\", "/") };
        },
      },
      task.options.channel,
    ),
    async finish(product) {
      // Tail payloads are emitted by finish before the immutable pack name is known.
      const provisional = await sink.cook.finish(product);
      const packName = packHash.digest("hex") + ".vtpack";
      const metadata = { ...provisional.directory.metadata, pack: { uri: packName, byteLength: offset } };
      const directoryBytes = new TextEncoder().encode(JSON.stringify(metadata));
      const directoryIdentity = hash(directoryBytes);
      const directoryName = directoryIdentity + ".vtdirectory";
      await openTiledTextureDirectory(directoryBytes, directoryIdentity);
      await file.sync();
      await file.close();
      closed = true;
      await rename(packPath + ".partial", join(dirname(task.output), packName));
      await writeFile(directoryPath + ".partial", directoryBytes);
      await rename(directoryPath + ".partial", join(dirname(task.output), directoryName));
      sink.receipt = {
        schemaVersion: 2,
        compression: tiledCompressionIdentity,
        uri: directoryName,
        identity: directoryIdentity,
        byteLength: directoryBytes.byteLength,
        payloadBytes: offset,
        nativePayloadBytes: metadata.payloads.reduce((sum, p) => sum + p.nativeByteLength, 0),
        payloads: metadata.payloads.length,
        addresses: task.tiled.addresses,
        residentRoles: task.tiled.residentRoles,
      };
    },
    async close() {
      if (!closed) await file.close();
    },
  };
  let closed = false;
  return sink;
}

async function cookScene(input, output, workers, tiled = false) {
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
        sourceUri: `sha256:${sourceHash}/image/${imageIndex}`,
      };
      const key = hash(JSON.stringify([imageIndex, options]));
      const uri = `textures/${key}.textureproduct`;
      if (!tasks.has(key)) {
        tasks.set(key, {
          source: input,
          offset: binOffset + (view.byteOffset ?? 0),
          length: view.byteLength,
          imageIndex,
          mimeType: image.mimeType,
          options,
          output: join(output, uri),
          ...(tiled ? { tiled: { addresses: [], residentRoles: [] } } : {}),
        });
      }
      if (tiled) {
        const address = ["clamp", "repeat", "mirror"][texture.wrapS];
        if (!address || texture.wrapS !== texture.wrapT) {
          throw new Error("Offline VT requires the existing same-axis sampler address profile");
        }
        const profiles = tasks.get(key).tiled.addresses;
        if (!profiles.includes(address)) {
          profiles.push(address);
          profiles.sort();
        }
      }
      result[property] = { textureIndex, uri };
    }
    return result;
  });
  const cookedImages = new Set([...tasks.values()].map((task) => task.imageIndex));
  // Canonical glTF alpha uses its exact R8 plane. Custom graphs must supply their
  // actual coverage closure to TiledTextureCook, rather than infer it from names.
  if (cookedImages.size !== document.images.length)
    throw new Error(
      `Material importer uses ${cookedImages.size}/${document.images.length} images; cannot claim complete cook`,
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
        ...(node.extras === undefined ? {} : { extras: structuredClone(node.extras) }),
      });
      (geometry.nodes[nodeIndex].children ??= []).push(child);
      instanceMaterials.push(primitive.material ?? 0);
      instanceProfiles.push({
        hasAuthoredVertexColor: a.COLOR_0 !== undefined,
        hasUv0: a.TEXCOORD_0 !== undefined,
        hasUv1: a.TEXCOORD_1 !== undefined,
        hasUv2: false,
        hasNormal: true,
        hasTangent: a.TANGENT !== undefined,
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
        await readFile(resolve(root, "OEngine/tools/oengine-asset-core/build/oengine-asset-cooker.exe")),
      ),
      shardBytes: Number(process.env.OENGINE_OFFLINE_SHARD_BYTES ?? 64 * MiB),
    }),
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
        String(Number(process.env.OENGINE_OFFLINE_SHARD_BYTES ?? 64 * MiB)),
      ],
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
      join(output, pack.uri),
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
          wallMs: receipt.wallMs,
        });
        await writeJson(join(output, "cook-progress.json"), {
          phase: "textures",
          completed,
          total: list.length,
          elapsedMs: performance.now() - started,
        });
      }
    }),
  );
  const receipts = await Promise.all([...tasks.values()].map((task) => json(task.output + ".json")));
  const planeCount = (format) =>
    receipts.reduce(
      (sum, receipt) => sum + receipt.metadata.planes.filter((p) => p.format.startsWith(format)).length,
      0,
    );
  const triangles = document.meshes.reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (n, p) => n + document.accessors[p.indices ?? p.attributes.POSITION].count / 3,
        0,
      ),
    0,
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
      images: document.images.length,
    },
    geometryManifest: "scene.oescene",
    geometryManifestHash: hash(await readFile(join(output, "scene.oescene"))),
    gltf: { materials: document.materials, textures: document.textures, samplers: document.samplers },
    bindings,
    instanceMaterials,
    instanceProfiles,
    products: receipts.map((receipt, index) => ({
      uri: `textures/${list[index][0]}.textureproduct`,
      identity: receipt.identity,
      ...(tiled
        ? {
            tiled: {
              ...receipt.tiled,
              uri: `textures/${receipt.tiled.uri}`,
            },
          }
        : {}),
    })),
    evidence: {
      products: receipts.length,
      bc7: planeCount("bc7"),
      bc4: planeCount("bc4"),
      r8: planeCount("r8unorm"),
      packageBytes: receipts.reduce((sum, r) => sum + r.packageBytes, 0),
      payloadBytes: receipts.reduce((sum, r) => sum + r.payloadBytes, 0),
      ...(tiled
        ? {
            tiled: {
              payloadBytes: receipts.reduce((sum, r) => sum + r.tiled.payloadBytes, 0),
              nativePayloadBytes: receipts.reduce((sum, r) => sum + r.tiled.nativePayloadBytes, 0),
              directoryBytes: receipts.reduce((sum, r) => sum + r.tiled.byteLength, 0),
              payloads: receipts.reduce((sum, r) => sum + r.tiled.payloads, 0),
            },
          }
        : {}),
      totalEncodeMs: receipts.reduce((sum, r) => sum + r.encodeMs, 0),
      wallMs: performance.now() - started,
      pngDecoder: "pngjs 7.0.0, straight RGBA, no gamma adjustment",
      ...(list.some(([, task]) => task.mimeType === "image/webp")
        ? { webpDecoder: "sharp 0.34.5, straight RGBA, no resize or gamma adjustment" }
        : {}),
      runtimeImageDecode: 0,
      runtimeFinePageDecompression: tiled ? "zstd-bc-v1" : "none",
      runtimeEncode: 0,
      runtimeTranscode: 0,
      runtimeMipGeneration: 0,
      runtimeTextureCodecWorkers: tiled ? "existing Cooked Worker pool for demanded fine pages" : 0,
      runtimeGeometryCook: 0,
    },
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
      process.argv[2] ?? resolve(root, ".local/models/BistroExterior_static_fixed_occlusion.glb"),
    );
    const output = resolve(process.argv[3] ?? resolve(root, ".local/models/bistro-cooked"));
    const workers = Number(process.argv[4] ?? 4);
    if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error("Workers must be 1..8");
    await cookScene(input, output, workers, process.argv.includes("--vt"));
  }
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
