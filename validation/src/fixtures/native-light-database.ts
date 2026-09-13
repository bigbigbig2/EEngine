import { writeWgslToBuffer } from "../../../OEngine/src/core/WgslBufferIO.js";
import {
  DIRECTIONAL_LIGHT_DESCRIPTOR,
  LIGHT_DATABASE_DEFINITION,
  POINT_LIGHT_DESCRIPTOR,
  SHADOW_DIRECTIONAL_DESCRIPTOR,
  SHADOW_POINT_DESCRIPTOR,
  SHADOW_SPOT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR,
  type DirectionalLightRecord,
  type PointLightRecord,
  type ShadowSpotRecord,
  type SpotLightRecord
} from "../../../OEngine/src/gpu/LightDatabase.js";
import {
  GPU_DATABASE_INVALID_PAGE,
  GPU_DATABASE_WORD_BYTES,
  type GPUTypedTableDescriptor
} from "../../../OEngine/src/gpu/GPUDatabase.js";

export interface NativeLightDatabaseFixture {
  readonly point?: readonly PointLightRecord[];
  readonly directional?: readonly DirectionalLightRecord[];
  readonly spot?: readonly SpotLightRecord[];
  readonly shadowPoint?: readonly ArrayLike<number>[];
  readonly shadowSpot?: readonly ShadowSpotRecord[];
  readonly shadowDirectional?: readonly (readonly ShadowSpotRecord[])[];
}

/** Builds the real paged GPUDatabase byte layout for deterministic browser fixtures. */
export function packNativeLightDatabaseFixture(
  input: Readonly<NativeLightDatabaseFixture>
): ArrayBuffer {
  const tables = [
    [POINT_LIGHT_DESCRIPTOR, input.point ?? []],
    [DIRECTIONAL_LIGHT_DESCRIPTOR, input.directional ?? []],
    [SPOT_LIGHT_DESCRIPTOR, input.spot ?? []],
    [SHADOW_POINT_DESCRIPTOR, input.shadowPoint ?? []],
    [SHADOW_SPOT_DESCRIPTOR, input.shadowSpot ?? []],
    [SHADOW_DIRECTIONAL_DESCRIPTOR, input.shadowDirectional ?? []]
  ] as const;
  const lookupWords = LIGHT_DATABASE_DEFINITION.descriptors.reduce(
    (sum, descriptor) => sum + descriptor.page_limit,
    0
  );
  const pageWords = LIGHT_DATABASE_DEFINITION.page_size_bytes / GPU_DATABASE_WORD_BYTES;
  const pageCount = tables.reduce(
    (sum, [descriptor, values]) => sum + Math.ceil(values.length / descriptor.elements_per_page),
    0
  );
  const buffer = new ArrayBuffer((lookupWords + pageCount * pageWords) * GPU_DATABASE_WORD_BYTES);
  const words = new Uint32Array(buffer);
  words.subarray(0, lookupWords).fill(GPU_DATABASE_INVALID_PAGE);
  let nextPageAddress = lookupWords;
  for (const [descriptor, values] of tables) {
    nextPageAddress = packTable(buffer, words, descriptor, values, nextPageAddress, pageWords);
  }
  return buffer;
}

function packTable(
  buffer: ArrayBuffer,
  words: Uint32Array,
  descriptor: GPUTypedTableDescriptor,
  values: readonly unknown[],
  firstPageAddress: number,
  pageWords: number
): number {
  let nextPageAddress = firstPageAddress;
  const pageCount = Math.ceil(values.length / descriptor.elements_per_page);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const pageAddress = nextPageAddress;
    nextPageAddress += pageWords;
    words[descriptor.page_lookup_address + pageIndex] = pageAddress;
    const first = pageIndex * descriptor.elements_per_page;
    const count = Math.min(descriptor.elements_per_page, values.length - first);
    words[pageAddress] = count;
    for (let slot = 0; slot < count; slot++) {
      words[pageAddress + 1 + (slot >>> 5)]! |= 1 << (slot & 31);
      const byteOffset = (
        pageAddress + descriptor.page_header_words +
        slot * (descriptor.packed_element_size_bytes / GPU_DATABASE_WORD_BYTES)
      ) * GPU_DATABASE_WORD_BYTES;
      writeWgslToBuffer(values[first + slot], descriptor.type, buffer, byteOffset);
    }
  }
  return nextPageAddress;
}
