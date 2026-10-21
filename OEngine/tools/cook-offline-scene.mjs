import { createReadStream } from "node:fs";
import { open, readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyTestBuild } from "../../tools/test-build.mjs";
import { resampleOfflineImage } from "./offline-image-resample.mjs";
import { optimizeImage } from "./extreme-web-asset/optimize.mjs";
import { nativeCook } from "./extreme-web-asset/cook.mjs";
import { qualityAnchors } from "./extreme-web-asset/native-profiles.mjs";
import { createOfflineEvaluator } from "./extreme-web-asset/evaluation-host.mjs";
import { imageMipCount } from "../.test-dist/assets/ImageTextureProduct.js";
import {
  MATERIAL_TEXTURE_PROPERTIES,
  materialTextureSemantic,
  materialTextureLeaves
} from "../.test-dist/assets/PcMaterialTextures.js";
import { parseGltfMaterial } from "../.test-dist/loaders/gltf/gltfMaterials.js";
import { textureFromGltf } from "../.test-dist/loaders/gltf/gltfTextures.js";
import { ShadeImage } from "../.test-dist/texture/ShadeImage.js";
import { compileCanonicalMaterial } from "../.test-dist/material/CanonicalMaterial.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const executable = resolve(root, ".local/image-resample-build/image-resample.exe");
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
  const started = performance.now();
  const encoded = await range(task.source, task.offset, task.length);
  const require = createRequire(resolve(root, ".local/offline-cook-deps/package.json"));
  const sharp = require("sharp");
  const color = task.options.semantic.startsWith("color-");
  // Source orientation is applied before canonical extraction. Color ICC is
  // converted to sRGB; linear material channels are not gamma-adjusted.
  let decoder = sharp(encoded).rotate();
  if (color) decoder = decoder.toColourspace("srgb");
  const { data, info } = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("Canonical image must have straight RGBA");
  const base = { width: info.width, height: info.height, rgba: new Uint8Array(data) };
  let semantic = task.options.semantic;
  if (semantic === "normal-xy") {
    for (let at = 2; at < base.rgba.length; at += 4) {
      if (base.rgba[at] < 128) {
        semantic = "moment-xyz";
        break;
      }
    }
  }
  const provided =
    task.virtual ||
    task.options.exactAlpha ||
    semantic === "moment-xyz" ||
    Math.max(base.width, base.height) > 2048;
  const inputs = [base];
  let canonicalToolHash;
  if (provided) {
    const scratch = dirname(taskPath);
    const filterBuild = await json(executable + ".json");
    if (filterBuild.binaryHash !== hash(await readFile(executable))) {
      throw new Error("Offline canonical resampler build identity mismatch");
    }
    canonicalToolHash = hash(
      JSON.stringify({
        filterBuild,
        wrapper: hash(await readFile(new URL("./offline-image-resample.mjs", import.meta.url)))
      })
    );
    for (let level = 1; level < imageMipCount(base.width, base.height); level++) {
      const previous = inputs.at(-1);
      inputs.push(resampleOfflineImage(executable, scratch, previous, color, semantic === "normal-xy"));
    }
  }
  // Provided XY chains retain the canonical normal direction at each level.
  if (provided && semantic === "normal-xy") {
    for (const input of inputs) {
      for (let i = 0; i < input.rgba.length; i += 4) {
        const x = (input.rgba[i] * 2) / 255 - 1;
        const y = (input.rgba[i + 1] * 2) / 255 - 1;
        const z = (input.rgba[i + 2] * 2) / 255 - 1;
        const length = Math.hypot(x, y, z);
        if (z < 0 || length === 0) throw new Error("Normal XY cannot discard this hemisphere/direction");
        input.rgba[i] = Math.round(((x / length) * 0.5 + 0.5) * 255);
        input.rgba[i + 1] = Math.round(((y / length) * 0.5 + 0.5) * 255);
        input.rgba[i + 2] = 0;
      }
    }
  }
  const request = {
    semantic,
    quality: task.quality,
    mode: task.virtual ? "virtual" : "resident",
    mips: provided ? "provided" : "runtime",
    inputs,
    addressU: task.options.addressU,
    addressV: task.options.addressV,
    canonicalToolHash,
    ...(task.options.exactAlpha ? { exactCoverage: inputs } : {}),
    cellSize: 512
  };
  const fixed = task.cookMode === "fixed";
  const evaluator = fixed ? null : await createOfflineEvaluator({
    moduleInventory: process.env.EENGINE_IMAGE_MODULE_INVENTORY
      ? await json(resolve(process.env.EENGINE_IMAGE_MODULE_INVENTORY))
      : null
  });
  let result;
  try {
    result = fixed ? await nativeCook(request, dirname(task.output)) : await optimizeImage(request, dirname(task.output), evaluator, {
      trace: task.trace ?? null,
      onCandidate: (value) => log({ phase: "candidate", image: task.imageIndex, ...value })
    });
  } finally {
    await evaluator?.close();
  }
  const identity = hash(result.bytes);
  const receipt = {
    imageIndex: task.imageIndex,
    encodedHash: hash(encoded),
    identity,
    directory: result.directory,
    byteLength: result.bytes.length,
    payloadBytes: result.directory.items.reduce((sum, item) => sum + item.bytes, 0),
    wallMs: performance.now() - started,
    ...(fixed ? {
      cookMode: "fixed",
      candidate: { quality: qualityAnchors[task.quality], speed: 4, cellSize: request.cellSize },
      qualityEvaluated: false,
      commands: "commands.json",
      commandsHash: hash(await readFile(join(dirname(task.output), "commands.json")))
    } : {
      searchIdentity: result.report.identity,
      searchReport: result.reportName,
      searchReportHash: hash(await readFile(join(dirname(task.output), result.reportName)))
    })
  };
  // Scene manifests reference immutable product directories. The local search
  // checkpoint may change during a recook without invalidating a live scene.
  const directoryName = `directory-${identity}.json`;
  await writeFile(join(dirname(task.output), directoryName), result.bytes);
  await writeJson(task.output + ".receipt.json", receipt);
  log({ phase: "image", image: task.imageIndex, bytes: result.bytes.length });
}

async function cookScene(input, output, workers, tiled = false, publishOnly = false, cookMode = "search") {
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
  // The standard appearance graph always exposes an alpha output, so a readMask
  // bit alone does not mean the material needs exact coverage. Only masked
  // coverage consumes it; opaque/transparent materials would otherwise ship a
  // constant opaque R8 plane and full provided color mips.
  const compiledMaterials = materials.map((material) => compileCanonicalMaterial(material));
  const textureIndices = new Map(textures.map((texture, index) => [texture, index]));
  const tasks = new Map();
  const demandTraces = process.env.EENGINE_IMAGE_DEMAND_TRACES
    ? await json(resolve(process.env.EENGINE_IMAGE_DEMAND_TRACES))
    : {};
  const bindings = materials.map((material, materialIndex) => {
    const result = {};
    const live = new Set(materialTextureLeaves(material));
    for (const property of MATERIAL_TEXTURE_PROPERTIES) {
      const texture = material[property];
      if (!texture || !live.has(texture)) continue;
      const textureIndex = textureIndices.get(texture);
      const imageIndex = document.textures[textureIndex].source;
      const image = document.images[imageIndex];
      if (image.bufferView === undefined) throw new Error("Expected embedded image");
      const view = document.bufferViews[image.bufferView];
      const semantic = materialTextureSemantic(property);
      const compiled = compiledMaterials[materialIndex];

      const options = {
        semantic,
        exactAlpha:
          compiled.coverage === "masked" &&
          compiled.appearance.samples.some(
            (sample) => sample.binding.texture === texture && (sample.readMask & 8) !== 0
          ),
        addressU: ["clamp-to-edge", "repeat", "mirror-repeat"][texture.wrapS],
        addressV: ["clamp-to-edge", "repeat", "mirror-repeat"][texture.wrapT]
      };
      const key = hash(JSON.stringify([imageIndex, options]));
      const uri = `textures/${key}/directory.json`;
      if (!tasks.has(key)) {
        tasks.set(key, {
          source: input,
          offset: binOffset + (view.byteOffset ?? 0),
          length: view.byteLength,
          imageIndex,
          mimeType: image.mimeType,
          options,
          output: join(output, uri),
          // The canonical glTF graph reads alpha independently: RGB may be
          // virtual while its exact alpha plane remains fully resident.
          virtual: tiled,
          quality: process.env.EENGINE_IMAGE_QUALITY ?? "high",
          cookMode,
          trace: demandTraces[key] ?? null
        });
      }
      result[property] = { textureIndex, uri };
    }
    return result;
  });
  const cookedImages = new Set([...tasks.values()].map((task) => task.imageIndex));
  // Canonical glTF alpha uses its exact R8 plane. Custom graphs must supply their
  // actual coverage closure to ImageTextureCook, rather than infer it from names.
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
  let textureFailure;
  if (!publishOnly) await Promise.all(
    Array.from({ length: workers }, async (_, slot) => {
      const scratch = join(output, ".scratch", String(process.pid), String(slot));
      await mkdir(scratch, { recursive: true });
      while (!textureFailure && next < list.length) {
        const [key, task] = list[next++];
        const path = join(scratch, "task.json");
        await mkdir(dirname(task.output), { recursive: true });
        await writeJson(path, task);
        try {
          await run(process.execPath, [self, "--texture-task", path], (line) => process.stdout.write(line));
        } catch (error) {
          textureFailure ??= error;
          return;
        }
        completed++;
        const receipt = await json(task.output + ".receipt.json");
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
  if (textureFailure) throw textureFailure;
  const receipts = await Promise.all([...tasks.values()].map((task) => json(task.output + ".receipt.json")));
  for (let index = 0; index < list.length; index++) {
    const task = list[index][1], receipt = receipts[index];
    if (receipt.encodedHash !== hash(await range(input, task.offset, task.length)) ||
        receipt.directory.quality !== task.quality || receipt.directory.planes[0].mode !== (task.virtual ? "virtual" : "resident")) {
      throw new Error("Completed image checkpoint differs from the requested source/profile");
    }
    if (cookMode === "fixed") {
      if (receipt.cookMode !== "fixed" || receipt.qualityEvaluated !== false ||
          receipt.candidate.quality !== qualityAnchors[task.quality] || receipt.candidate.speed !== 4 ||
          hash(await readFile(join(dirname(task.output), receipt.commands))) !== receipt.commandsHash) {
        throw new Error("Fixed cook checkpoint differs from its actual encoder receipt");
      }
      continue;
    }
    const reportBytes = await readFile(join(dirname(task.output), receipt.searchReport));
    const report = JSON.parse(reportBytes);
    if (hash(reportBytes) !== receipt.searchReportHash || report.identity !== receipt.searchIdentity ||
        report.report.rows.length !== (tiled ? 60 : 20) || !report.report.selected.accepted ||
        !report.report.selected.evaluation.hardSemantics || report.report.selected.evaluation.inputHash !== receipt.identity) {
      throw new Error("Completed image checkpoint lacks the complete qualified search");
    }
  }
  const triangles = document.meshes.reduce(
    (sum, mesh) =>
      sum +
      mesh.primitives.reduce(
        (n, p) => n + document.accessors[p.indices ?? p.attributes.POSITION].count / 3,
        0
      ),
    0
  );
  const geometryManifestBytes = await readFile(join(output, "scene.oescene"));
  const geometryManifestHash = hash(geometryManifestBytes);
  const geometryManifest = `scene-${geometryManifestHash}.oescene`;
  await writeFile(join(output, geometryManifest), geometryManifestBytes);
  const productUris = receipts.map((receipt, index) =>
    `textures/${list[index][0]}/directory-${receipt.identity}.json`
  );
  const receiptUris = await Promise.all(receipts.map(async (receipt, index) => {
    const bytes = JSON.stringify(receipt, null, 2) + "\n";
    const uri = `textures/${list[index][0]}/receipt-${hash(bytes)}.json`;
    await writeFile(join(output, uri), bytes);
    // Revalidate every completed checkpoint before publishing the scene root.
    const directory = await readFile(join(output, `textures/${list[index][0]}/directory.json`));
    if (hash(directory) !== receipt.identity) throw new Error("Completed image directory changed before scene publication");
    await writeFile(join(output, productUris[index]), directory);
    return uri;
  }));
  const publishedBindings = bindings.map((material) => Object.fromEntries(
    Object.entries(material).map(([property, binding]) => {
      const index = list.findIndex(([, task]) => relative(output, task.output).replaceAll("\\", "/") === binding.uri);
      if (index < 0) throw new Error("Material binding has no completed image product");
      return [property, { ...binding, uri: productUris[index] }];
    })
  ));
  const result = {
    schema: "oengine-image-scene-materials-v2",
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
      cookedImages: cookedImages.size
    },
    geometryManifest,
    geometryManifestHash,
    gltf: { materials: document.materials, textures: document.textures, samplers: document.samplers },
    bindings: publishedBindings,
    instanceMaterials,
    instanceProfiles,
    products: receipts.map((receipt, index) => ({
      uri: productUris[index],
      identity: receipt.identity,
      byteLength: receipt.byteLength,
      receipt: receiptUris[index],
      ...(cookMode === "fixed" ? {} : {
        searchReport: `textures/${list[index][0]}/${receipt.searchReport}`,
        searchReportHash: receipt.searchReportHash
      })
    })),
    evidence: {
      cookMode,
      qualityEvaluated: cookMode === "search",
      products: receipts.length,
      directoryBytes: receipts.reduce((sum, value) => sum + value.byteLength, 0),
      payloadBytes: receipts.reduce((sum, value) => sum + value.payloadBytes, 0),
      imageCodec: `native-avif-10bit-444-${process.env.EENGINE_IMAGE_QUALITY ?? "high"}`,
      runtimeTextureEncoding: "Spark BC7/BC5/BC4, exact R8",
      runtimeMipGeneration: "GPU for runtime profile, canonical provided otherwise",
      wallMs: performance.now() - started
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
    await cookScene(input, output, workers, process.argv.includes("--vt"), process.argv.includes("--publish-only"),
      process.argv.includes("--fixed") ? "fixed" : "search");
  }
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
