import type { GeometryProductDescriptorV1 } from "../geometry-product/GeometryProductV1.js";
import type { ProductResidentPage } from "../geometry-product/GeometryProductResidentAttributes.js";
import type {
  GeometryGroupDirectoryV3,
  GeometryPageDirectoryV3,
  VertexFormatRecordV3,
} from "../GeometryAbiV3.js";
import type { TextureProduct } from "../TextureProduct.js";
import type { TiledTextureDirectory } from "../TiledTextureProduct.js";
import type {
  TiledTextureRegistration,
  TiledTextureSpan,
  TiledTexturePreparedPayload,
} from "./TiledTextureTransport.js";

export interface CookedGeometryRegistration {
  readonly descriptor: GeometryProductDescriptorV1;
  readonly pages: readonly GeometryPageDirectoryV3[];
  readonly groups: readonly GeometryGroupDirectoryV3[];
  readonly formats: readonly VertexFormatRecordV3[];
  readonly url: string;
  readonly init: Omit<RequestInit, "headers" | "signal">;
  readonly verifyPageSha256: boolean;
}

export interface CookedRangeSpan {
  readonly offset: bigint;
  readonly bytes: number;
  readonly pageIds: readonly number[];
}

export interface CookedTaskHeader {
  readonly version: 3;
  readonly session: string;
  readonly epoch: number;
  readonly task: number;
}

export type CookedAssetTask = CookedTaskHeader &
  (
    | {
        readonly kind: "geometry";
        readonly span: CookedRangeSpan;
        readonly registration?: CookedGeometryRegistration;
      }
    | {
        readonly kind: "texture";
        readonly url: string;
        readonly expectedIdentity: string;
        readonly maxBytes: number;
      }
    | {
        readonly kind: "tiled-directory";
        readonly url: string;
        readonly expectedHash: string;
        readonly byteLength: number;
      }
    | {
        readonly kind: "tiled-payload";
        readonly registrationKey: string;
        readonly span: TiledTextureSpan;
        readonly registration?: TiledTextureRegistration;
      }
  );

export interface CookedPreparedPage {
  readonly pageId: number;
  readonly bytes: ArrayBuffer;
  readonly integrity: "encoded-crc32" | "decoded-sha256";
  readonly decodedPageHash128?: string;
  readonly prepared: ProductResidentPage;
}

export type CookedAssetResult = CookedTaskHeader & { readonly decoderMemoryBytes: number } & (
    | { readonly ok: false; readonly message: string }
    | {
        readonly ok: true;
        readonly kind: "geometry";
        readonly pages: readonly CookedPreparedPage[];
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
      }
    | {
        readonly ok: true;
        readonly kind: "tiled-directory";
        readonly directory: TiledTextureDirectory;
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
      }
    | {
        readonly ok: true;
        readonly kind: "tiled-payload";
        readonly registrationKey: string;
        readonly payloads: readonly TiledTexturePreparedPayload[];
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
        readonly decodeMs: number;
        readonly decoderInitMs: number;
        readonly usefulEncodedBytes: number;
        readonly nativeBytes: number;
      }
    | {
        readonly ok: true;
        readonly kind: "texture";
        readonly product: TextureProduct;
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
      }
  );

/** Priority is decided before this offset sort; callers pass one urgency class only. */
export function cookedGeometrySpans(
  pages: readonly GeometryPageDirectoryV3[],
  pageIds: ArrayLike<number>,
  maxBytes = 16 * 1024 * 1024,
): readonly CookedRangeSpan[] {
  const ids = [...new Set(Array.from(pageIds))];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0 || id >= pages.length) {
      throw new RangeError("Cooked pageId is outside its registered directory");
    }
  }
  ids.sort((a, b) =>
    pages[a]!.compressedFileOffset < pages[b]!.compressedFileOffset
      ? -1
      : pages[a]!.compressedFileOffset > pages[b]!.compressedFileOffset
        ? 1
        : a - b,
  );
  const spans: { offset: bigint; bytes: number; pageIds: number[] }[] = [];
  for (const id of ids) {
    const page = pages[id]!;
    const last = spans.at(-1);
    const mergedBytes = last
      ? Number(page.compressedFileOffset + BigInt(page.compressedBytes) - last.offset)
      : 0;
    if (
      last &&
      page.compressedFileOffset <= last.offset + BigInt(last.bytes + 64 * 1024) &&
      mergedBytes <= maxBytes
    ) {
      last.bytes = Math.max(last.bytes, mergedBytes);
      last.pageIds.push(id);
    } else {
      if (page.compressedBytes > maxBytes) {
        throw new RangeError("Cooked encoded page exceeds range credit");
      }
      spans.push({ offset: page.compressedFileOffset, bytes: page.compressedBytes, pageIds: [id] });
    }
  }
  return spans;
}
