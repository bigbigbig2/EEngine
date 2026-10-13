import type { Renderer, Scene } from "../../../../OEngine/src/index.ts";
import {
  load_oegpack_product,
  type OegPackProductAsset
} from "../../../../OEngine/src/assets/geometry-product/OegPackProductAsset.ts";
import { parseOegPackSceneManifestV3 } from "../../../../OEngine/src/assets/geometry-product/OegPackSceneManifestV3.ts";
import {
  buildVirtualGeometrySceneSourceV1,
  mergeVirtualGeometryProductSceneSourcesV1,
  type VirtualGeometryProductScenePartV1,
  type VirtualGeometrySceneInstanceV1
} from "../../../../OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts";
import {
  geometryProductMeshletWorkCapacity,
  validateGeometryProductSceneWorkLimits
} from "../../../../OEngine/src/assets/geometry-product/GeometryProductWorkload.ts";
import { GeometryProductMultiRuntimeV1 } from "../../../../OEngine/src/gpu/GeometryProductMultiRuntime.ts";
import { GeometryPageStreamingRuntimeV1 } from "../../../../OEngine/src/gpu/GeometryPageStreamingRuntime.ts";
import type {
  VirtualGeometryGeometryProfile,
  VirtualGeometrySceneSource
} from "../../../../OEngine/src/gpu/GpuRenderWorld.ts";
import { parseGltfMaterial } from "../../../../OEngine/src/loaders/gltf/gltfMaterials.ts";
import type { GltfMaterial } from "../../../../OEngine/src/loaders/gltf/GltfLoader.ts";
import { textureProductHash } from "../../../../OEngine/src/assets/TextureProduct.ts";
import {
  frameGeometryArenaBudgetForWork,
  frameGeometryArenaLayout
} from "../../../../OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts";

export interface LoadOptions {
  packStart: number;
  packCount: number;
  geometryMiB: number;
  metadataMiB: number;
  frameMiB: number;
  frameOwnerMiB: number;
  workMi: number;
  reads: number;
  inFlightMiB: number;
  uploadMiB: number;
}

interface MaterialManifest {
  schema: string;
  source: {
    triangles: number;
    bytes: number;
    textures: number;
    images: number;
    materials: number;
    sha256: string;
  };
  geometryManifest: string;
  geometryManifestHash: string;
  gltf: { materials: GltfMaterial[]; textures: unknown[] };
  instanceMaterials: number[];
  instanceProfiles: VirtualGeometryGeometryProfile[];
  products: unknown[];
}

export interface LoadProgress {
  phase: string;
  opened: number;
  admitted: number;
  total: number;
  totalPacks: number;
  totalInstances: number;
  selectedInstances: number;
  fileBytes: number;
  pages: number;
  activationPages: number;
  source?: MaterialManifest["source"];
  work?: {
    hierarchyTraversalCapacity: number;
    hierarchyVisibleClusterCapacity: number;
    hierarchyRasterWorkCapacity: number;
  };
  frameArenaBytes?: number;
  meshletWorkCapacity?: number;
}

export async function loadZorahScene(
  renderer: Renderer,
  scene: Scene,
  base: string,
  options: LoadOptions,
  signal: AbortSignal,
  progress: LoadProgress,
  notify: () => void
) {
  const assets: OegPackProductAsset[] = [];
  let runtime: GeometryProductMultiRuntimeV1 | undefined;
  let streaming: GeometryPageStreamingRuntimeV1 | undefined;
  let published = false;
  const phase = (value: string) => {
    signal.throwIfAborted();
    progress.phase = value;
    notify();
  };
  const fetchBytes = async (uri: string) => {
    const response = await fetch(new URL(uri, base), { signal });
    if (!response.ok) {
      throw new Error(`${uri}: HTTP ${response.status}，请确认本地 cooked 目录存在`);
    }
    return response.arrayBuffer();
  };
  try {
    phase("读取场景 / 材质目录");
    const manifest = JSON.parse(
      new TextDecoder().decode(await fetchBytes("scene.materials.json"))
    ) as MaterialManifest;
    if (
      manifest.schema !== "oengine-offline-scene-materials-v1" ||
      manifest.products.length ||
      manifest.gltf.textures.length
    ) {
      throw new Error("此 Zorah 示例要求当前无纹理的离线材质目录");
    }
    const sceneBytes = await fetchBytes(manifest.geometryManifest);
    if ((await textureProductHash(new Uint8Array(sceneBytes))) !== manifest.geometryManifestHash) {
      throw new Error("Geometry / material manifest hash 不匹配");
    }
    const geometry = parseOegPackSceneManifestV3(sceneBytes);
    if (
      geometry.instances.length !== manifest.instanceMaterials.length ||
      geometry.instances.length !== manifest.instanceProfiles.length
    ) {
      throw new Error("实例 / 材质 / geometry profile 数量不匹配");
    }
    const end = options.packCount === 0 ? geometry.packs.length : options.packStart + options.packCount;
    if (options.packStart >= geometry.packs.length || end > geometry.packs.length) {
      throw new RangeError(
        `包范围越界：起点 ${options.packStart}，结束 ${end}，总计 ${geometry.packs.length}`
      );
    }
    progress.total = end - options.packStart;
    progress.totalPacks = geometry.packs.length;
    progress.totalInstances = geometry.instances.length;
    progress.source = manifest.source;
    const instancesByPack: VirtualGeometrySceneInstanceV1[][] = Array.from(
      { length: progress.total },
      () => []
    );
    const profilesByPack: VirtualGeometryGeometryProfile[][] = Array.from(
      { length: progress.total },
      () => []
    );
    const assetsByPack: { assetId: string; pack: number; assetRecordIndex: number }[][] = Array.from(
      { length: progress.total },
      () => []
    );
    const manifestInstancesByPack: {
      asset: number;
      materialBindingTable: number;
      flags: number;
      transform: number[];
    }[][] = Array.from({ length: progress.total }, () => []);
    const localAssetIndices = new Int32Array(geometry.assets.length).fill(-1);
    for (let index = 0; index < geometry.assets.length; index++) {
      const reference = geometry.assets[index]!;
      if (reference.pack >= options.packStart && reference.pack < end) {
        const localAssets = assetsByPack[reference.pack - options.packStart]!;
        localAssetIndices[index] = localAssets.length;
        localAssets.push({ ...reference, pack: 0 });
      }
    }
    // Group the original instances once; retain every instance in the explicit pack range.
    for (let index = 0; index < geometry.instances.length; index++) {
      const instance = geometry.instances[index]!;
      const reference = geometry.assets[instance.asset]!;
      if (reference.pack < options.packStart || reference.pack >= end) {
        continue;
      }
      const local = reference.pack - options.packStart;
      instancesByPack[local]!.push({
        assetIndex: reference.assetRecordIndex,
        materialIndex: manifest.instanceMaterials[index]!,
        transform: instance.transform,
        flags: instance.flags
      });
      profilesByPack[local]![reference.assetRecordIndex] = manifest.instanceProfiles[index]!;
      manifestInstancesByPack[local]!.push({
        asset: localAssetIndices[instance.asset]!,
        materialBindingTable: instance.materialBindingTable,
        flags: instance.flags,
        transform: Array.from(instance.transform)
      });
      progress.selectedInstances++;
    }
    const materials = manifest.gltf.materials.map((material) => parseGltfMaterial(material, []));
    const mapped: VirtualGeometrySceneSource[] = [];
    const preflightParts: VirtualGeometryProductScenePartV1[] = [];
    let preflightAssetBegin = 0;
    for (let packIndex = options.packStart; packIndex < end; packIndex++) {
      const local = packIndex - options.packStart;
      const pack = geometry.packs[packIndex]!;
      phase(`CPU 准入检查 · 包 ${packIndex + 1}/${geometry.packs.length}`);
      // Project the validated current manifest, preserving its explicit flags. The
      // cooker scratch manifests predate current instance semantics and are not authority.
      const shardManifest = JSON.stringify({
        schema: geometry.schema,
        instanceSemantics: geometry.instanceSemantics,
        packs: [pack],
        assets: assetsByPack[local],
        instances: manifestInstancesByPack[local]
      });
      const asset = await load_oegpack_product(
        { kind: "http-range", url: new URL(pack.uri, base).href, init: { signal } },
        { signal, manifest: shardManifest }
      );
      assets.push(asset);
      const evidence = asset.evidence();
      if (evidence.productId !== pack.packId) {
        throw new Error(`包 ${packIndex} 的 Product identity 不匹配`);
      }
      progress.opened++;
      progress.fileBytes += evidence.fileBytes;
      progress.pages += evidence.pageCount;
      progress.activationPages += evidence.activationPageCount;
      const source = buildVirtualGeometrySceneSourceV1(
        asset.descriptor,
        profilesByPack[local]!,
        instancesByPack[local]!,
        materials
      ).source;
      mapped.push(source);
      preflightParts.push({
        source,
        productTableSlot: local,
        productGeneration: local + 1,
        assetReferenceBegin: preflightAssetBegin
      });
      preflightAssetBegin += source.assetCount;
    }
    // Validate all scene work before admitting any payload into GPU residency.
    const preflight = mergeVirtualGeometryProductSceneSourcesV1(preflightParts);
    progress.work = {
      hierarchyTraversalCapacity: preflight.hierarchyTraversalCapacity,
      hierarchyVisibleClusterCapacity: preflight.hierarchyVisibleClusterCapacity,
      hierarchyRasterWorkCapacity: preflight.hierarchyRasterWorkCapacity
    };
    validateGeometryProductSceneWorkLimits(preflight, preflight.count, renderer.device.limits);
    progress.meshletWorkCapacity = Math.min(
      geometryProductMeshletWorkCapacity(preflight.hierarchyRasterWorkCapacity, renderer.packed_meshlet_work_candidate_capacity),
      renderer.packed_geometry_work_budget.maxMeshletWork,
    );
    const frameBudget = {
      ...frameGeometryArenaBudgetForWork(progress.meshletWorkCapacity, 0),
      maxBytes: options.frameMiB * 1024 ** 2
    };
    progress.frameArenaBytes = frameGeometryArenaLayout(
      renderer.graphics.assets.bindings().sparseShading.assetMetadataBytes,
      frameBudget,
      renderer.device.limits
    ).byteLength;
    phase("创建共享几何驻留与元数据目录");
    runtime = new GeometryProductMultiRuntimeV1(renderer.device, {
      slotCapacity: Math.max(64, progress.total),
      metadataBytes: options.metadataMiB * 1024 ** 2,
      residency: {
        requestedProfile: "HighEnd",
        configuredCapacityBytes: options.geometryMiB * 1024 ** 2,
        configuredBankBytes: (options.geometryMiB * 1024 ** 2) / 4
      }
    });
    const parts: VirtualGeometryProductScenePartV1[] = [];
    let first: Awaited<ReturnType<typeof runtime.load>> | undefined;
    for (let local = 0; local < assets.length; local++) {
      phase(`GPU bootstrap 准入 · ${local + 1}/${assets.length}`);
      for await (const source of assets[local]!.revisions(signal)) {
        const shard = await runtime.load(source);
        first ??= shard;
        signal.throwIfAborted();
        streaming ??= new GeometryPageStreamingRuntimeV1(renderer.device, shard.residency, {
          schedulerOptions: {
            maxConcurrentReads: options.reads,
            maxInFlightBytes: options.inFlightMiB * 1024 ** 2,
            maxUploadBytesPerFrame: options.uploadMiB * 1024 ** 2
          }
        });
        streaming.registerProduct(source, shard.residency);
        parts.push({
          source: mapped[local]!,
          productTableSlot: shard.productTableSlot,
          productGeneration: shard.productGeneration,
          assetReferenceBegin: shard.assetReferenceBegin
        });
        progress.admitted++;
      }
    }
    if (!first || !streaming) {
      throw new Error("所选范围没有可发布几何");
    }
    const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
    phase("发布完整所选场景");
    await renderer.uploadVirtualGeometryScene(
      scene,
      combined,
      first.residency,
      streaming,
      () => signal.throwIfAborted(),
      {
        bindings: runtime.bindings(),
        assetCount: combined.assetCount,
        registerStreaming: false,
        multiRuntime: runtime,
        releaseWithScene: true
      }
    );
    published = true;
    phase("运行中 · Geometry streaming active");
    return {
      source: combined,
      framing: sceneFraming(combined),
      runtime,
      ioEvidence: () => assets.map((asset) => asset.evidence()),
      disposeSources: () => {
        for (const asset of assets) {
          asset.release();
        }
      }
    };
  } catch (error) {
    if (published) {
      await renderer.releaseScene(scene);
    }
    streaming?.destroy();
    runtime?.destroy();
    for (const asset of assets) {
      asset.release();
    }
    throw error;
  }
}

function sceneFraming(source: VirtualGeometrySceneSource) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let instance = 0; instance < source.count; instance++) {
    const offset = instance * 16;
    for (let corner = 0; corner < 8; corner++) {
      const x = (corner & 1 ? source.boundsMax! : source.boundsMin!)[instance * 3]!;
      const y = (corner & 2 ? source.boundsMax! : source.boundsMin!)[instance * 3 + 1]!;
      const z = (corner & 4 ? source.boundsMax! : source.boundsMin!)[instance * 3 + 2]!;
      for (let axis = 0; axis < 3; axis++) {
        const m = source.currentTransforms;
        const value =
          m[offset + axis]! * x +
          m[offset + 4 + axis]! * y +
          m[offset + 8 + axis]! * z +
          m[offset + 12 + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  const center = min.map((value, axis) => (value + max[axis]!) / 2) as [number, number, number];
  const radius = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error("场景边界无效");
  }
  return { center, radius };
}
