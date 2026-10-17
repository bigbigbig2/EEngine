import type { GeometryProductDescriptorV1 } from "../assets/geometry-product/GeometryProductV1.js";
import {
  GEOMETRY_QUERY_CLUSTER_BYTES,
  validateGeometryProductQuerySection,
} from "../assets/geometry-product/GeometryProductQuerySection.js";
import type { GeometryQueryPageLease } from "./VirtualGeometryResidency.js";

/** Immutable query address index; payload remains in retained Product banks.
 * Header: magic/version/count/total, generation/asset-count/reserved[2].
 * One record is 112B: original 80B cluster, 16B location, 16B vertex format.
 * Refinement slots +60/+64 are repurposed as original cluster/primitive prefix;
 * the source Product section, including its full remaps, stays authoritative.
 * A terminal prefix follows the records. All offsets are segment-local. */
export const GEOMETRY_QUERY_DIRECTORY_MAGIC = 0x31445147;
export const GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES = 32;
export const GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES = 112;

export interface GeometryQueryDirectorySegment {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly prefixWordOffset: number;
  readonly primitiveCount: number;
  readonly assets: readonly {
    readonly cutBegin: number;
    readonly cutCount: number;
    readonly primitiveBegin: number;
    readonly primitiveCount: number;
  }[];
}

/** Cold publication preparation, never a frame visibility walk. Splitting is
 * driven by the negotiated whole-binding limit, without omitting any cluster.
 * Global primitive addresses survive segmentation and still select hit data. */
export function geometryQueryDirectorySegments(
  descriptor: GeometryProductDescriptorV1,
  pages: GeometryQueryPageLease["pages"],
  generation: number,
  maximumBytes: number,
): readonly GeometryQueryDirectorySegment[] {
  const section = validateGeometryProductQuerySection(descriptor);
  const capacity = Math.floor((Math.floor(maximumBytes / 16) * 16 - 36) / 116);
  if (!Number.isSafeInteger(maximumBytes) || capacity < 1 ||
      !Number.isInteger(generation) || generation < 1 || generation >= 0xffffffff) {
    throw new RangeError("Query directory cannot represent one complete cluster in its binding limit");
  }
  const locations = new Map(pages.map((page) => [page.pageId, page.location]));
  const cutCount = section.view.getUint32(64, true);
  const groups = new DataView(descriptor.groupDirectory.buffer,
    descriptor.groupDirectory.byteOffset, descriptor.groupDirectory.byteLength);
  const segments: GeometryQueryDirectorySegment[] = [];
  let globalPrimitive = 0;
  for (let begin = 0; begin < cutCount; begin += capacity) {
    const count = Math.min(capacity, cutCount - begin);
    const prefixByte = GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES + count * GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES;
    const bytes = new Uint8Array(Math.ceil((prefixByte + (count + 1) * 4) / 16) * 16);
    const view = new DataView(bytes.buffer);
    const put = (at: number, value: number) => view.setUint32(at, value, true);
    put(0, GEOMETRY_QUERY_DIRECTORY_MAGIC);
    put(4, 1);
    put(8, count);
    put(12, bytes.byteLength);
    put(16, generation);
    put(20, section.assetCount);
    const assets = Array.from({ length: section.assetCount }, () => ({
      cutBegin: 0, cutCount: 0, primitiveBegin: 0, primitiveCount: 0,
    }));
    const firstPrimitive = globalPrimitive;
    for (let local = 0; local < count; local++) {
      const cluster = section.view.getUint32(section.minimumCut + (begin + local) * 4, true);
      const source = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
      const at = GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES + local * GEOMETRY_QUERY_DIRECTORY_CLUSTER_BYTES;
      bytes.set(section.bytes.subarray(source, source + GEOMETRY_QUERY_CLUSTER_BYTES), at);
      const pageId = section.view.getUint32(source, true);
      const groupId = section.view.getUint32(source + 4, true);
      const triangles = section.view.getUint32(source + 12, true);
      const asset = assets[section.view.getUint32(source + 28, true)]!;
      const location = locations.get(pageId);
      if (location === undefined || location.productGeneration !== generation) {
        throw new Error("Query segment lacks a retained page in its exact Product generation");
      }
      if (asset.cutCount === 0) {
        asset.cutBegin = local;
        asset.primitiveBegin = globalPrimitive;
      }
      asset.cutCount++;
      asset.primitiveCount += triangles;
      put(at + 60, cluster);
      put(at + 64, globalPrimitive);
      put(at + 80, location.bankIndex);
      const groupOffset = groups.getUint32(groupId * 16 + 4, true);
      const payloadBytes = groups.getUint32(groupId * 16 + 8, true);
      if (groupOffset + payloadBytes > location.payloadBytes ||
          location.bankIndex >= 4 || location.byteOffset + groupOffset >= 0x40000000) {
        throw new RangeError("Query segment group escapes its retained physical page");
      }
      put(at + 84, location.byteOffset + groupOffset);
      put(at + 88, payloadBytes);
      put(at + 92, location.productGeneration);
      const format = section.view.getUint32(source + 20, true) * 16;
      bytes.set(descriptor.vertexFormats.subarray(format, format + 16), at + 96);
      put(prefixByte + local * 4, globalPrimitive);
      globalPrimitive += triangles;
      if (!Number.isSafeInteger(globalPrimitive) || globalPrimitive >= 0xffffffff) {
        throw new RangeError("Complete query triangle identity exceeds u32 capacity");
      }
    }
    put(prefixByte + count * 4, globalPrimitive);
    segments.push(Object.freeze({ bytes, prefixWordOffset: prefixByte / 4,
      primitiveCount: globalPrimitive - firstPrimitive,
      assets: Object.freeze(assets.map((asset) => Object.freeze(asset))) }));
  }
  return Object.freeze(segments);
}
