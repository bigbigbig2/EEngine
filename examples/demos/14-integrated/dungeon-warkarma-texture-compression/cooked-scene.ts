import type { Renderer, Scene } from "../../../../OEngine/src/index.ts";
import {
  load_oegpack_product,
  type OegPackProductAsset
} from "../../../../OEngine/src/assets/geometry-product/OegPackProductAsset.ts";
import { parseOegPackSceneManifestV3 } from "../../../../OEngine/src/assets/geometry-product/OegPackSceneManifestV3.ts";
import {
  buildVirtualGeometrySceneSourceV1,
  mergeVirtualGeometryProductSceneSourcesV1,
  type VirtualGeometryProductScenePartV1
} from "../../../../OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts";
import {
  GeometryProductMultiRuntimeV1,
  type GeometryProductShardHandleV1
} from "../../../../OEngine/src/gpu/GeometryProductMultiRuntime.ts";
import { GeometryPageStreamingRuntimeV1 } from "../../../../OEngine/src/gpu/GeometryPageStreamingRuntime.ts";
import type {
  VirtualGeometryGeometryProfile,
  VirtualGeometrySceneSource
} from "../../../../OEngine/src/gpu/GpuRenderWorld.ts";
import { MATERIAL_TEXTURE_PROPERTIES } from "../../../../OEngine/src/assets/PcMaterialTextures.ts";
import { openTextureProduct, textureProductHash } from "../../../../OEngine/src/assets/TextureProduct.ts";
import { parseGltfMaterial } from "../../../../OEngine/src/loaders/gltf/gltfMaterials.ts";
import {
  textureFromGltf,
  type GltfTextureDef,
  type GltfSamplerDef
} from "../../../../OEngine/src/loaders/gltf/gltfTextures.ts";
import type { GltfMaterial } from "../../../../OEngine/src/loaders/gltf/GltfLoader.ts";
import { ShadeImage } from "../../../../OEngine/src/texture/ShadeImage.ts";
import { ShadeTexture } from "../../../../OEngine/src/texture/ShadeTexture.ts";

type Property = (typeof MATERIAL_TEXTURE_PROPERTIES)[number];
interface CookedManifest {
  schema: "oengine-offline-scene-materials-v1";
  source: {
    path: string;
    bytes: number;
    sha256: string;
    triangles: number;
    primitives: number;
    meshes: number;
    materials: number;
    textures: number;
    images: number;
  };
  geometryManifest: string;
  geometryManifestHash: string;
  gltf: { materials: GltfMaterial[]; textures: GltfTextureDef[]; samplers?: GltfSamplerDef[] };
  bindings: Partial<Record<Property, { textureIndex: number; uri: string }>>[];
  instanceMaterials: number[];
  instanceProfiles: VirtualGeometryGeometryProfile[];
  products: { uri: string; identity: string }[];
  evidence: Record<string, number | string>;
  framing?: { center: [number, number, number]; radius: number };
  playground?: { counts: Record<string, number>; groundSize: number; floor: number; seed: string };
}

export async function loadCookedScene(
  renderer: Renderer,
  scene: Scene,
  base: string,
  signal: AbortSignal,
  phase: (value: string) => void,
  geometryCapacityBytes = 1024 * 1024 ** 2
) {
  const fetchBytes = async (uri: string) => {
    const response = await fetch(new URL(uri, base), { signal });
    if (!response.ok) throw new Error(`Cooked asset ${uri}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
  phase("Reading offline scene/material catalog");
  const manifest = JSON.parse(
    new TextDecoder().decode(await fetchBytes("scene.materials.json"))
  ) as CookedManifest;
  if (manifest.schema !== "oengine-offline-scene-materials-v1")
    throw new Error("Offline material schema mismatch");
  const sceneBytes = await fetchBytes(manifest.geometryManifest);
  if ((await textureProductHash(new Uint8Array(sceneBytes))) !== manifest.geometryManifestHash) {
    throw new Error("Offline geometry/material manifest identity mismatch");
  }
  const geometryManifest = parseOegPackSceneManifestV3(sceneBytes);
  if (
    geometryManifest.instances.length !== manifest.instanceMaterials.length ||
    manifest.instanceProfiles.length !== manifest.instanceMaterials.length ||
    manifest.bindings.length !== manifest.gltf.materials.length
  )
    throw new Error("Offline material/instance dictionary mismatch");

  // Importer-only image identities. No pixel payload is decoded or published.
  const images = Array.from({ length: manifest.source.images }, () =>
    ShadeImage.fromEncodedImage(new ArrayBuffer(0), "image/png")
  );
  const textures = manifest.gltf.textures.map((t) => textureFromGltf(t, images, manifest.gltf.samplers));
  const materials = manifest.gltf.materials.map((m) => parseGltfMaterial(m, textures));
  const entries = new Map(manifest.products.map((product) => [product.uri, product.identity]));
  const products = new Map<string, Awaited<ReturnType<typeof openTextureProduct>>>();
  phase("Reading validated BC Texture Products (no codec)");
  for (const entry of manifest.products) {
    signal.throwIfAborted();
    const product = await openTextureProduct(await fetchBytes(entry.uri));
    if (product.identity !== entry.identity)
      throw new Error(`Cooked Product identity mismatch: ${entry.uri}`);
    products.set(entry.uri, product);
  }
  for (const [index, material] of materials.entries()) {
    const bindings = manifest.bindings[index]!;
    for (const property of MATERIAL_TEXTURE_PROPERTIES) {
      const binding = bindings[property];
      if (!binding) {
        if (material[property]) throw new Error(`Offline material ${index} missing ${property}`);
        continue;
      }
      const product = products.get(binding.uri);
      const sampler = textures[binding.textureIndex];
      if (!product || !sampler || !entries.has(binding.uri) || material[property] !== sampler) {
        throw new Error(`Offline material ${index} invalid ${property} binding`);
      }
      const texture = ShadeTexture.fromProduct(product);
      for (const name of [
        "minFilter",
        "magFilter",
        "mipmapFilter",
        "wrapS",
        "wrapT",
        "wrapR",
        "dimensions"
      ] as const) {
        texture[name] = sampler[name];
      }
      material[property] = texture;
    }
  }
  const assets: OegPackProductAsset[] = [];
  let runtime: GeometryProductMultiRuntimeV1 | undefined;
  let streaming: GeometryPageStreamingRuntimeV1 | null = null;
  let published = false;
  const dispose = () => {
    for (const asset of assets) asset.release();
  };
  try {
    phase("Opening offline Geometry Products (no geometry cook)");
    runtime = new GeometryProductMultiRuntimeV1(renderer.device, {
      residency: {
        requestedProfile: "HighEnd",
        configuredCapacityBytes: geometryCapacityBytes,
        configuredBankBytes: geometryCapacityBytes / 4
      },
      metadataBytes: 128 * 1024 ** 2
    });
    const parts: VirtualGeometryProductScenePartV1[] = [];
    let first: GeometryProductShardHandleV1 | undefined;
    for (const [packIndex, pack] of geometryManifest.packs.entries()) {
      signal.throwIfAborted();
      const asset = await load_oegpack_product(
        { kind: "http-range", url: new URL(pack.uri, base).href },
        { signal, manifest: sceneBytes }
      );
      assets.push(asset);
      if (
        Array.from(asset.descriptor.productId, (b) => b.toString(16).padStart(2, "0")).join("") !==
        pack.packId
      ) {
        throw new Error("Offline pack does not match scene manifest");
      }
      const profiles: VirtualGeometryGeometryProfile[] = new Array(
        asset.descriptor.assetRecords.length / 128
      );
      const instances = geometryManifest.instances.flatMap((instance, index) => {
        const reference = geometryManifest.assets[instance.asset]!;
        if (reference.pack !== packIndex) return [];
        profiles[reference.assetRecordIndex] = manifest.instanceProfiles[index]!;
        return [
          {
            assetIndex: reference.assetRecordIndex,
            materialIndex: manifest.instanceMaterials[index]!,
            transform: instance.transform,
            flags: instance.flags
          }
        ];
      });
      if (profiles.some((profile) => !profile) || profiles.filter(Boolean).length !== profiles.length) {
        throw new Error("Offline Product has an uninstantiated geometry profile");
      }
      const mapped = buildVirtualGeometrySceneSourceV1(asset.descriptor, profiles, instances, materials);
      for await (const source of asset.revisions(signal)) {
        const shard = await runtime.load(source);
        first ??= shard;
        signal.throwIfAborted();
        streaming ??= new GeometryPageStreamingRuntimeV1(renderer.device, shard.residency);
        streaming.registerProduct(source, shard.residency);
        parts.push({
          source: mapped.source,
          productTableSlot: shard.productTableSlot,
          productGeneration: shard.productGeneration,
          assetReferenceBegin: shard.assetReferenceBegin
        });
      }
    }
    const combined = mergeVirtualGeometryProductSceneSourcesV1(parts);
    if (!first) throw new Error("Offline scene has no admitted geometry");
    phase("Publishing GPU Render World / tail residency");
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
    return {
      manifest,
      source: combined,
      framing: manifest.framing ?? sceneFraming(combined),
      dispose,
      settled: async () => {},
      runtime
    };
  } catch (error) {
    if (published) await renderer.releaseScene(scene);
    streaming?.destroy();
    runtime?.destroy();
    dispose();
    throw error;
  }
}

function sceneFraming(source: VirtualGeometrySceneSource) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let instance = 0; instance < source.count; instance++) {
    const m = source.currentTransforms.subarray(instance * 16, instance * 16 + 16);
    for (let corner = 0; corner < 8; corner++) {
      const v = [0, 1, 2].map(
        (axis) => (corner & (1 << axis) ? source.boundsMax! : source.boundsMin!)[instance * 3 + axis]!
      );
      for (let axis = 0; axis < 3; axis++) {
        const value = m[axis]! * v[0]! + m[4 + axis]! * v[1]! + m[8 + axis]! * v[2]! + m[12 + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  const center = min.map((value, axis) => (value + max[axis]!) / 2) as [number, number, number];
  return { center, radius: Math.hypot(...max.map((value, axis) => (value - min[axis]!) / 2)) };
}
