import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GltfLoader } from "../../.test-dist/loaders/gltf/GltfLoader.js";
import { buildGltfTextures } from "../../.test-dist/loaders/gltf/gltfTextures.js";
import { parseGltfMaterial } from "../../.test-dist/loaders/gltf/gltfMaterials.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import {
  createKtx2AssetCodecService,
  createKtx2TranscodeTask,
  encodedTextureVariantFromKtx2Result,
} from "../../.test-dist/assets/codec/Ktx2BasisCodec.js";
import {
  openTextureAssetPackageV2,
  writeEncodedTextureAssetPackageV2,
} from "../../.test-dist/assets/TextureAssetPackage.js";

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function distribution(values) {
  check(values.length > 0 && values.every(Number.isFinite), "Invalid timing samples");
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1), n: sorted.length };
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function submit(command) {
  const start = performance.now();
  command.finish();
  const synchronousMs = performance.now() - start;
  await command.gpuDone;
  return { synchronousMs, completionWallMs: performance.now() - start };
}

async function authoredBaseline(device) {
  const url = "/examples/assets/three/rendering-lab/dungeon_warkarma.glb";
  const readStart = performance.now();
  const bytes = await (await fetch(url)).arrayBuffer();
  const readMs = performance.now() - readStart;
  const sourceSha256 = await sha256(bytes);
  check(
    sourceSha256 === "cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1",
    "Authored dungeon source changed",
  );
  const header = new DataView(bytes);
  const metadata = JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, 20, header.getUint32(12, true))),
  );
  const sourceImageBytes = metadata.images.reduce(
    (sum, image) => sum + metadata.bufferViews[image.bufferView].byteLength,
    0,
  );
  const decodeStart = performance.now();
  const doc = await new GltfLoader().loadFromBinary(bytes, `${location.origin}/`);
  const loadDecodeMs = performance.now() - decodeStart;
  const textures = buildGltfTextures(doc);
  const materials = doc.materials.map((material) => parseGltfMaterial(material, textures));
  check(textures.length === 25 && materials.length === 25, "Authored catalog was reduced");
  const decoded = doc.images.map((bitmap, index) => ({
    index,
    width: bitmap.width,
    height: bitmap.height,
    rgbaEquivalentBytes: bitmap.width * bitmap.height * 4,
  }));
  const graphics = new GraphicsContext(device, new FrameProfiler({ enabled: false }));
  const residency = graphics.texture_residency;
  const sourceContexts = new Set();
  let command;
  try {
    command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
    const stageStart = performance.now();
    const staged = residency.stage(materials, command);
    const stageCpuMs = performance.now() - stageStart;
    const submission = await submit(command);
    for (const texture of textures) sourceContexts.add(graphics.textures.obtain(texture));
    const observationStart = performance.now();
    const ledger = residency.evidence();
    const evidenceCpuMs = performance.now() - observationStart;
    check(
      ledger.residentTextureCount === 25 && ledger.compressedResidentTextureCount === 0,
      "Unexpected current authored path",
    );
    check(staged.textureRefs.size === 25, "Not all authored textures entered Residency");
    const stableTimes = [];
    const warmBindings = residency.bindings();
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      residency.bindings();
      stableTimes.push(performance.now() - start);
    }
    const pendingBeforeRelease = ledger.retiringTextureCount;
    command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/release-transaction");
    residency.release(materials, command);
    await submit(command);
    await Promise.resolve();
    const afterRelease = residency.evidence();
    check(
      afterRelease.residentTextureCount === 0 && afterRelease.retiringTextureCount === 0,
      "Authored references did not retire",
    );
    const sourceGpuBytes = graphics.textures.gpu_memory_usage;
    graphics.destroy();
    const sourceOwnerSurvivesGraphicsDestroy = [...sourceContexts].filter(
      (context) => !context.isDestroyed,
    ).length;
    return {
      scope:
        "real authored images/materials -> production raw upload/mip/Residency; not a renderer frame or large-scene result",
      source: {
        url,
        sourceSha256,
        bytes: bytes.byteLength,
        primitives: metadata.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0),
        textures: textures.length,
        materials: materials.length,
        sourceImageBytes,
      },
      decoded,
      decodedRgbaEquivalentBytes: decoded.reduce((sum, image) => sum + image.rgbaEquivalentBytes, 0),
      actualBrowserDecodedPeakBytes: null,
      readMs,
      loadDecodeMs,
      stageCpuMs,
      submission,
      evidenceCpuMs,
      stableBindingsCpuMs: distribution(stableTimes),
      bindingSetCount: warmBindings.bindingSets.length,
      sourceGpuBytes,
      ledger,
      afterRelease,
      pendingBeforeRelease,
      lifecycle: {
        sourceOwnerSurvivesGraphicsDestroy,
        accountingAfterGraphicsDestroy: graphics.resource_accounting.snapshot(),
        probeExplicitSourceCleanup: true,
      },
      limitations: [
        "No full renderer CPU/GPU frame measured",
        "Browser native decode peak and driver VRAM unavailable",
        "Raw upload/copy bytes are not comprehensively counted by current Residency evidence",
        "GPUTextureManager source cache is not destroyed by GraphicsContext; probe cleans it explicitly",
      ],
    };
  } finally {
    if (command && !command.closed) command.abort();
    graphics.destroy();
    // Baseline exposes the current owner gap; explicit probe cleanup is not a production fix.
    for (const context of sourceContexts) context.destroy();
    graphics.textures.mipmaps.destroy();
    for (const bitmap of doc.images) bitmap.close();
  }
}

async function codecBaseline(device) {
  const service = createKtx2AssetCodecService({
    maxWorkers: 1,
    workerUrl: new URL("../../.test-dist/assets/codec/workers/asset-codec-worker.js", import.meta.url),
    createWorker: (url) => new Worker(url, { type: "module" }),
  });
  const graphics = new GraphicsContext(device, new FrameProfiler({ enabled: false }));
  const residency = graphics.texture_residency;
  const fixtures = [];
  let taskId = 0;
  let command;
  try {
    for (const [file, encoding] of [
      ["luminance-alpha-32x32-uastc.ktx2", "ktx2-uastc"],
      ["rgba-64x64-mipmap-etc1s.ktx2", "ktx2-etc1s"],
    ]) {
      const source = await (await fetch(`/OEngine/tests/fixtures/texture-codec/${file}`)).arrayBuffer();
      const times = [];
      let result;
      let cold;
      for (let i = 0; i < 23; i++) {
        const start = performance.now();
        result = await service.submit(
          createKtx2TranscodeTask({
            taskId: ++taskId,
            kind: "ktx2-transcode",
            priority: 0,
            sourceEncoding: encoding,
            semantic: "base-color-srgb",
            targetFormat: "bc7-rgba-unorm-srgb",
            input: source.slice(0),
          }),
        );
        const wallMs = performance.now() - start;
        if (i === 0) cold = { wallMs, evidence: result.evidence };
        if (i >= 3) times.push(wallMs);
      }
      const first = result.mips[0];
      if (
        result.mips.length !==
        Math.floor(Math.log2(Math.max(first.logicalWidth, first.logicalHeight))) + 1
      ) {
        fixtures.push({
          file,
          sourceSha256: await sha256(source),
          sourceBytes: source.byteLength,
          cold,
          warmWallMs: distribution(times),
          finalTaskEvidence: result.evidence,
          packageStatus: "rejected-incomplete-mip-chain",
          packageUpload: "not-run",
          actualWasmPeakBytes: null,
        });
        continue;
      }
      const writeStart = performance.now();
      const packageBytes = await writeEncodedTextureAssetPackageV2(
        {
          width: first.logicalWidth,
          height: first.logicalHeight,
          semantic: "base-color-srgb",
          sourceUri: `fixture://${file}`,
          sourceByteLength: source.byteLength,
          sourceContentHash: await sha256(source),
        },
        [encodedTextureVariantFromKtx2Result(result, "base-color-srgb")],
      );
      const serializeMs = performance.now() - writeStart;
      const parseStart = performance.now();
      const asset = await openTextureAssetPackageV2(packageBytes);
      const parseMs = performance.now() - parseStart;
      const texture = ShadeTexture.fromAssetPackageV2(asset);
      const material = new StandardShadeMaterial();
      material.texture_albedo = texture;
      command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      const publicationStart = performance.now();
      const publication = residency.stage([material], command).surfacePublications.get(texture);
      const publicationCpuMs = performance.now() - publicationStart;
      const uploadSubmission = await submit(command);
      const initial = {
        minimumMip: publication.currentMinimumMip,
        revision: publication.currentRevision,
        uploadBytes: residency.evidence().uploadBytes,
      };
      command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.promote([texture], command, 0);
      command.abort();
      check(
        publication.currentMinimumMip === initial.minimumMip &&
          publication.currentRevision === initial.revision,
        "Aborted promotion was published",
      );
      command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      const promotionStart = performance.now();
      residency.promote([texture], command, 0);
      const promotionCpuMs = performance.now() - promotionStart;
      const promotionSubmission = await submit(command);
      check(
        publication.currentMinimumMip === 0 && publication.currentRevision !== initial.revision,
        "Full-quality promotion did not publish",
      );
      const live = residency.evidence();
      check(
        live.textureLedger.some((entry) => entry.format === "bc7-rgba-unorm-srgb"),
        "BC blocks did not reside as BC",
      );
      fixtures.push({
        file,
        sourceSha256: await sha256(source),
        sourceBytes: source.byteLength,
        cold,
        warmWallMs: distribution(times),
        finalTaskEvidence: result.evidence,
        packageBytes: packageBytes.byteLength,
        serializeMs,
        parseMs,
        publicationCpuMs,
        uploadSubmission,
        progressive: {
          initial,
          abortedPromotionUnpublished: true,
          promotionCpuMs,
          promotionSubmission,
          finalMinimumMip: publication.currentMinimumMip,
        },
        live,
        decodedPeakIsRgbaEquivalent: asset.evidence.decodedPeakBytes,
        actualWasmPeakBytes: null,
      });
      command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/release-transaction");
      residency.release([material], command);
      await submit(command);
      await Promise.resolve();
    }
    const afterRelease = residency.evidence();
    check(
      afterRelease.residentTextureCount === 0 && afterRelease.retiringTextureCount === 0,
      "BC references did not retire",
    );
    service.destroy();
    return {
      fixtures,
      serviceAfterDestroy: service.evidence(),
      afterRelease,
      rawWasmBcEncode: {
        status: "not-available",
        reason:
          "Pinned upstream WASM C API outputs Basis, not direct BC7/BC4 chunks; the thin direct-block bridge is T4.1",
      },
      zstd: {
        status: "unsupported-current-local-parser",
        reason:
          "readKtx2Header rejects supercompression 2 before upstream parse; do not silently reinterpret",
      },
    };
  } finally {
    if (command && !command.closed) command.abort();
    service.destroy();
    graphics.destroy();
    graphics.textures.mipmaps.destroy();
  }
}

export async function runTextureBaselineGpuOracle(device) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  check(adapter && adapter.features.has("texture-compression-bc"), "BC-required profile unavailable");
  const capacity = {
    adapterSampled: adapter.limits.maxSampledTexturesPerShaderStage,
    deviceSampled: device.limits.maxSampledTexturesPerShaderStage,
    arrayLayers: device.limits.maxTextureArrayLayers,
    textureDimension: device.limits.maxTextureDimension2D,
    adapterFeatures: [...adapter.features].sort(),
    bcEnabled: device.features.has("texture-compression-bc"),
    conservativeTenMapDemand: 19,
    minimum: 16,
  };
  const capacityDevice = await adapter.requestDevice({
    requiredFeatures: ["texture-compression-bc"],
    requiredLimits: { maxSampledTexturesPerShaderStage: 19 },
  });
  try {
    const entries = (count) =>
      Array.from({ length: count }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      }));
    capacityDevice.pushErrorScope("validation");
    capacityDevice.createBindGroupLayout({ entries: entries(19) });
    check((await capacityDevice.popErrorScope()) === null, "19 sampled bindings were not admitted");
    capacityDevice.pushErrorScope("validation");
    capacityDevice.createBindGroupLayout({ entries: entries(20) });
    const rejected = await capacityDevice.popErrorScope();
    check(rejected !== null, "Over-limit descriptor was not rejected");
    capacity.negotiated19 = {
      enabledLimit: capacityDevice.limits.maxSampledTexturesPerShaderStage,
      legal19: true,
      rejected20: rejected.message,
      scope: "layout capability, not future full native material closure",
    };
  } finally {
    capacityDevice.destroy();
  }
  device.pushErrorScope("validation");
  const invalidNpot = device.createTexture({
    size: [257, 129],
    format: "bc7-rgba-unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const npotError = await device.popErrorScope();
  invalidNpot.destroy();
  check(npotError !== null, "Unaligned compressed extent unexpectedly admitted without feature");
  capacity.npotWithoutOptionalFeature = {
    width: 257,
    height: 129,
    rejected: npotError.message,
    futureStorageWidth: 260,
    futureStorageHeight: 132,
  };
  const scene = await authoredBaseline(device);
  const codecs = await codecBaseline(device);
  return {
    schemaVersion: 1,
    stage: "T4.0",
    capacity,
    scene,
    codecs,
    excludedLargeScene: {
      sourceBytes: 477591060,
      status: "not-run-user-excluded",
      replacementIsNotEquivalentScale: true,
    },
  };
}
