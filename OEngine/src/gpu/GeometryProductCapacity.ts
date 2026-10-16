import type { GeometryProductDescriptorV1 } from "../assets/geometry-product/GeometryProductV1.js";
import { geometryPagePayloadBytes } from "../assets/geometry-product/GeometryPagePayload.js";
import { OffsetAllocator } from "./OffsetAllocator.js";
import type {
  GeometryProductResidencyLimitsV1,
  GeometryProductResidencyProfileOptionsV1,
} from "./GeometryProductResidencyProfile.js";
import { selectGeometryProductResidencyProfileV1 } from "./GeometryProductResidencyProfile.js";

export const GEOMETRY_METADATA_SECTIONS = [
  "asset",
  "root",
  "hierarchy",
  "group",
  "page",
  "vertexFormat",
] as const;
export type GeometryMetadataSection = (typeof GEOMETRY_METADATA_SECTIONS)[number];
export type GeometryMetadataCapacities = Readonly<Record<GeometryMetadataSection, number>>;

export function geometryMetadataCounts(descriptor: GeometryProductDescriptorV1): GeometryMetadataCapacities {
  return {
    asset: descriptor.assetRecords.byteLength / 128,
    root: descriptor.rootNodeIds.length,
    hierarchy: descriptor.hierarchyNodes.byteLength / 48,
    group: descriptor.groupDirectory.byteLength / 16,
    page: descriptor.pageRecords.byteLength / 32,
    vertexFormat: descriptor.vertexFormats.byteLength / 16,
  };
}

export interface GeometryMetadataLayout extends GeometryMetadataCapacities {
  readonly byteLength: number;
  readonly productTable: number;
  readonly assetReferences: number;
  readonly assetRecords: number;
  readonly rootNodeIds: number;
  readonly hierarchyNodes: number;
  readonly groupDirectory: number;
  readonly pageLocations: number;
  readonly vertexFormats: number;
}

export function geometryMetadataLayout(
  capacity: GeometryMetadataCapacities,
  products: number,
): GeometryMetadataLayout {
  if (!Number.isSafeInteger(products) || products < 1 || products >= 0xffffffff) {
    throw new RangeError("Geometry product table capacity is invalid");
  }
  for (const name of GEOMETRY_METADATA_SECTIONS) {
    if (!Number.isSafeInteger(capacity[name]) || capacity[name] < 1) {
      throw new RangeError(`Geometry ${name} capacity is invalid`);
    }
  }
  if (capacity.group > 0x1000000 || capacity.hierarchy > 0x8000000) {
    throw new RangeError("Geometry metadata exceeds packed hierarchy index limits");
  }
  let cursor = 64;
  const take = (bytes: number) => {
    const begin = cursor;
    cursor += Math.ceil(bytes / 16) * 16;
    return begin;
  };
  const productTable = take(products * 64);
  const assetReferences = take(capacity.asset * 16);
  const assetRecords = take(capacity.asset * 128);
  const rootNodeIds = take(capacity.root * 4);
  const hierarchyNodes = take(capacity.hierarchy * 48);
  const groupDirectory = take(capacity.group * 16);
  const pageLocations = take(capacity.page * 16);
  const vertexFormats = take(capacity.vertexFormat * 16);
  if (!Number.isSafeInteger(cursor) || cursor / 4 > 0xffffffff) {
    throw new RangeError("Geometry metadata heap address overflow");
  }
  return {
    ...capacity,
    byteLength: cursor,
    productTable,
    assetReferences,
    assetRecords,
    rootNodeIds,
    hierarchyNodes,
    groupDirectory,
    pageLocations,
    vertexFormats,
  };
}

/** Directory-only planning: no payload IO, hash skipping, or GPU work. */
export function planGeometryProductCapacity(
  descriptors: readonly GeometryProductDescriptorV1[],
  limits: GeometryProductResidencyLimitsV1,
  options: GeometryProductResidencyProfileOptionsV1 = {},
) {
  const maximum = selectGeometryProductResidencyProfileV1(limits, options);
  if (!maximum.enabled) {
    throw new RangeError(`Geometry capacity unavailable: ${maximum.reason}`);
  }
  const totals = Object.fromEntries(GEOMETRY_METADATA_SECTIONS.map((name) => [name, 0])) as Record<
    GeometryMetadataSection,
    number
  >;
  const largest = { ...totals };
  let payloadBytes = 0;
  let largestPage = 16;
  const pinned: number[] = [];
  for (const descriptor of descriptors) {
    const counts = geometryMetadataCounts(descriptor);
    for (const name of GEOMETRY_METADATA_SECTIONS) {
      totals[name] += counts[name];
      largest[name] = Math.max(largest[name], counts[name]);
    }
    for (let page = 0; page < counts.page; page++) {
      const bytes = Math.ceil(geometryPagePayloadBytes(descriptor, page) / 16) * 16;
      payloadBytes += bytes;
      largestPage = Math.max(largestPage, bytes);
    }
    for (const page of descriptor.activationPageIds) {
      pinned.push(Math.ceil(geometryPagePayloadBytes(descriptor, page) / 16) * 16);
    }
  }
  const metadata = Object.fromEntries(
    GEOMETRY_METADATA_SECTIONS.map((name) => [
      name,
      Math.max(1, Math.ceil(totals[name] * 1.25) + largest[name]),
    ]),
  ) as Record<GeometryMetadataSection, number>;
  const slotCapacity = Math.max(1, Math.ceil(descriptors.length * 1.25) + 1);
  const maxPageLeases = maximum.maxPageLeases;
  if (pinned.length > maxPageLeases) {
    throw new RangeError("Geometry pinned activation exceeds the page lease capacity");
  }
  let bankBytes = Math.min(
    maximum.bankBytes,
    Math.max(largestPage, Math.ceil((payloadBytes * 1.25) / 64) * 16),
  );
  if (descriptors.length === 0) {
    // Unknown incremental catalogs need a small rolling window before their first publication.
    bankBytes = Math.min(maximum.bankBytes, options.initialBankBytes ?? 1024 * 1024);
  }
  // Execute the real allocator admission, including bucket selection and per-bank fit.
  for (;;) {
    const allocators = Array.from(
      { length: 4 },
      () => new OffsetAllocator(bankBytes / 16, maxPageLeases * 2 + 1),
    );
    let cursor = 0;
    let admitted = pinned.length <= maxPageLeases;
    for (const bytes of pinned) {
      let allocated = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const bank = (cursor + attempt) % 4;
        if (allocators[bank]!.allocate(bytes / 16) !== undefined) {
          cursor = (bank + 1) % 4;
          allocated = true;
          break;
        }
      }
      if (!allocated) {
        admitted = false;
        break;
      }
    }
    if (admitted) {
      break;
    }
    if (bankBytes >= maximum.bankBytes || pinned.length > maxPageLeases) {
      throw new RangeError("Geometry pinned activation and lease capacity cannot fit the configured pool");
    }
    bankBytes = Math.min(maximum.bankBytes, Math.ceil((bankBytes * 1.5) / 16) * 16);
  }
  return Object.freeze({
    slotCapacity,
    metadata: Object.freeze(metadata),
    residency: Object.freeze({ ...options, initialBankBytes: bankBytes, maxPageLeases }),
    payloadBytes,
    pinnedPages: pinned.length,
  });
}
