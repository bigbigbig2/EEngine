import { WEB_GEOMETRY_ATTRIBUTE_COLOR, WEB_GEOMETRY_ATTRIBUTE_NORMAL, WEB_GEOMETRY_ATTRIBUTE_TANGENT, WEB_GEOMETRY_ATTRIBUTE_UV0, WEB_GEOMETRY_ATTRIBUTE_UV1 } from "../web-cook/wasm/WebGeometryCookerAbi.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { VirtualGeometryGeometryProfile } from "../../gpu/GpuRenderWorld.js";
import type { OegPackProductAsset } from "./OegPackProductAsset.js";
import {
  buildVirtualGeometrySceneSourceV1,
  type VirtualGeometrySceneInstanceV1,
  type VirtualGeometrySceneSourceOptionsV1,
  type VirtualGeometrySceneSourceResultV1
} from "./VirtualGeometrySceneSourceV1.js";

/**
 * Native Offline producer adapter: maps one OEGPACK Product plus the scene
 * manifest onto the producer-neutral Scene source builder.
 *
 * The manifest carries pack/asset level indices only, so the adapter resolves
 * each instance through `assets[instance.asset]` into the Product asset record
 * index and refuses to mix assets from another pack. That keeps the rule that
 * Web and Offline artifacts never combine partial Group/Page/asset identities.
 */
export function createOegPackSceneSource(
  asset: OegPackProductAsset,
  options: VirtualGeometrySceneSourceOptionsV1 = {}
): VirtualGeometrySceneSourceResultV1 {
  const manifest = asset.manifest;
  if (manifest === undefined) throw new Error("Offline Product scene publication requires a scene.oescene manifest");
  const packId = hex(asset.descriptor.productId);
  const packIndex = manifest.packs.findIndex(pack => pack.packId === packId);
  if (packIndex < 0) throw new Error("scene manifest does not reference this Product pack");
  const assetCount = asset.descriptor.assetRecords.byteLength / 128;
  const formats = asset.pack.vertexFormats;
  if (formats.length !== assetCount) throw new Error("OEGPACK vertex format count must match the Product asset dictionary");
  const profiles: VirtualGeometryGeometryProfile[] = [];
  for (let index = 0; index < assetCount; index++) {
    const mask = formats[index]!.attributeMask;
    if ((mask & WEB_GEOMETRY_ATTRIBUTE_NORMAL) === 0) throw new Error(`OEGPACK asset ${index} has no normal attribute`);
    profiles.push({
      hasAuthoredVertexColor: (mask & WEB_GEOMETRY_ATTRIBUTE_COLOR) !== 0,
      hasUv0: (mask & WEB_GEOMETRY_ATTRIBUTE_UV0) !== 0,
      hasUv1: (mask & WEB_GEOMETRY_ATTRIBUTE_UV1) !== 0,
      hasUv2: false,
      hasNormal: true,
      hasTangent: (mask & WEB_GEOMETRY_ATTRIBUTE_TANGENT) !== 0
    });
  }
  const instances: VirtualGeometrySceneInstanceV1[] = [];
  for (const [index, instance] of manifest.instances.entries()) {
    const reference = manifest.assets[instance.asset]!;
    if (reference.pack !== packIndex) throw new Error(`scene manifest instance ${index} references another pack; one Scene publishes one Product at a time`);
    if (instance.materialBindingTable !== 0) throw new Error(`scene manifest instance ${index} uses material binding table ${instance.materialBindingTable}, which this manifest version does not define`);
    if (reference.assetRecordIndex >= assetCount) throw new Error(`scene manifest instance ${index} asset record is outside the Product dictionary`);
    instances.push({ assetIndex: reference.assetRecordIndex, materialIndex: 0, transform: instance.transform, flags: instance.flags });
  }
  // Offline material binding tables arrive with the material manifest; until
  // then every instance uses the single default material.
  const materials = [new StandardShadeMaterial()];
  return buildVirtualGeometrySceneSourceV1(asset.descriptor.assetRecords, profiles, instances, materials, options);
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
