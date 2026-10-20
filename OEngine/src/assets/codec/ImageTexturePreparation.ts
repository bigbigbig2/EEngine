import type { ImageTextureDirectory, ImageTextureItem, ImageTexturePlane } from "../ImageTextureProduct.js";
import { checkedImageU64, imageTextureHash, validateImageTextureDirectory } from "../ImageTextureProduct.js";
import { validateImageAvif } from "./ImageTextureAvif.js";
import { assertAssetWorkerResult } from "./AssetWorkerPool.js";
const validatedDirectories = new WeakSet<ImageTextureDirectory>();

export interface ImageTextureTask {
  readonly version: 4;
  readonly kind: "image-item";
  readonly session: string;
  readonly epoch: number;
  readonly task: number;
  readonly sourceRevision: string;
  readonly recipe: string;
  readonly baseUrl: string;
  /** Bounded per-item records avoid transferring the complete product directory. */
  readonly item: ImageTextureItem;
  readonly plane: ImageTexturePlane;
}

export type ImageTextureResult = Omit<ImageTextureTask, "baseUrl" | "item" | "plane" | "kind"> & {
  readonly itemId: number;
  readonly decoderMemoryBytes: number;
} & (
    | { readonly ok: false; readonly message: string }
    | {
        readonly ok: true;
        readonly representation: "decoded-image";
        readonly image: ImageBitmap;
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
      }
    | {
        readonly ok: true;
        readonly representation: "exact-bytes";
        readonly bytes: ArrayBuffer;
        readonly encodedBytes: number;
        readonly ioMs: number;
        readonly busyMs: number;
      }
  );

const liveLeases = new WeakSet<ImageTextureLease>();
const importedResults = new WeakSet<object>();
export type ImageTextureLeaseDirectory = Pick<
  ImageTextureDirectory,
  "planes" | "mipCount" | "recipe" | "sourceRevision"
>;

/** Exclusive CPU ready backing. close is idempotent; a released lease cannot be recorded again. */
export class ImageTextureLease {
  private constructor(
    readonly directory: ImageTextureLeaseDirectory,
    readonly item: ImageTextureItem,
    readonly result: Extract<ImageTextureResult, { ok: true }>,
    private readonly releaseCredit: () => void
  ) {
    liveLeases.add(this);
  }

  static import(
    directory: ImageTextureLeaseDirectory,
    item: ImageTextureItem,
    result: Extract<ImageTextureResult, { ok: true }>,
    releaseCredit: () => void
  ): ImageTextureLease {
    assertAssetWorkerResult(result);
    if (importedResults.has(result)) {
      throw new Error("Image receipt has already been consumed");
    }
    importedResults.add(result);
    Object.freeze(item);
    Object.freeze(result);
    return new ImageTextureLease(directory, item, result, releaseCredit);
  }

  close(): void {
    if (!liveLeases.delete(this)) {
      return;
    }
    try {
      if (this.result.representation === "decoded-image") {
        this.result.image.close();
      } else {
        structuredClone(this.result.bytes, { transfer: [this.result.bytes] });
      }
    } finally {
      this.releaseCredit();
    }
  }
}

export function assertImageTextureLease(lease: ImageTextureLease): void {
  if (!liveLeases.has(lease)) {
    throw new Error("Image texture ready lease was released or forged");
  }
}

export function closeImageTextureResult(result: ImageTextureResult): void {
  if (result.ok && result.representation === "decoded-image") {
    result.image.close();
  }
}

export function imageTaskPeak(item: ImageTextureItem): number {
  // Encoded fetch + Blob ownership, decoder/backing + VideoFrame/Bitmap overlap + ready.
  return item.bytes * 2 + item.decodedBytes * 4;
}

/** Called only by the existing pool owner; validates before issuing a Worker task. */
export function imageTextureTask(
  directory: ImageTextureDirectory,
  itemId: number,
  baseUrl: string,
  session: string,
  task: number
): ImageTextureTask {
  if (!validatedDirectories.has(directory) || !Object.isFrozen(directory)) {
    validateImageTextureDirectory(directory);
    if (Object.isFrozen(directory)) {
      validatedDirectories.add(directory);
    }
  }
  const item = directory.items[itemId];
  if (!item) {
    throw new RangeError("Image item is outside its product");
  }
  return {
    version: 4,
    kind: "image-item",
    session,
    epoch: 1,
    task,
    sourceRevision: directory.sourceRevision,
    recipe: directory.recipe,
    baseUrl,
    item: structuredClone(item),
    plane: structuredClone(directory.planes[item.plane]!)
  };
}

export async function prepareImageTextureTask(task: ImageTextureTask): Promise<ImageTextureResult> {
  const header = {
    version: task.version,
    session: task.session,
    epoch: task.epoch,
    task: task.task,
    sourceRevision: task.sourceRevision,
    recipe: task.recipe,
    itemId: task.item.id,
    decoderMemoryBytes: 0 as const
  };
  let image: ImageBitmap | undefined;
  try {
    if (task.version !== 4) {
      throw new Error("Unsupported image preparation protocol");
    }
    const started = performance.now();
    const item = task.item;
    const offset = item.offset === null ? null : checkedImageU64(item.offset);
    const headers =
      offset === null ? undefined : { Range: `bytes=${offset}-${offset + BigInt(item.bytes) - 1n}` };
    const url = new URL(item.uri, task.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Image item requires bounded HTTP transport");
    }
    const response = await fetch(url, { headers });
    if (
      response.status !== (offset === null ? 200 : 206) ||
      (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
      (response.headers.has("content-length") &&
        response.headers.get("content-length") !== String(item.bytes)) ||
      (offset !== null &&
        response.headers.get("content-range") !==
          `bytes ${offset}-${offset + BigInt(item.bytes) - 1n}/${item.objectBytes}`)
    ) {
      await response.body?.cancel();
      throw new Error("Image item transport range/length/encoding mismatch");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Image item body is missing");
    }
    const encoded = new Uint8Array(item.bytes);
    let used = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        if (part.value.byteLength > encoded.length - used) {
          throw new RangeError("Image item response exceeds reservation");
        }
        encoded.set(part.value, used);
        used += part.value.byteLength;
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    if (used !== item.bytes || (await imageTextureHash(encoded)) !== item.sha256) {
      throw new Error("Image item length/SHA256 mismatch");
    }
    const ioMs = performance.now() - started;
    const busy = performance.now();
    if (item.kind === "exact") {
      return {
        ...header,
        ok: true,
        representation: "exact-bytes",
        bytes: encoded.buffer,
        encodedBytes: used,
        ioMs,
        busyMs: performance.now() - busy
      };
    }
    validateImageAvif(encoded, item, task.plane.semantic);
    const blob = new Blob([encoded], { type: "image/avif" });
    // ImageDecoder is absent from older DOM declarations. Its surface stays local and checked.
    const Decoder = (
      globalThis as unknown as {
        ImageDecoder?: {
          isTypeSupported(type: string): Promise<boolean>;
          new (options: {
            data: ArrayBuffer;
            type: string;
            colorSpaceConversion: "none";
            preferAnimation: false;
          }): {
            decode(options: { frameIndex: number; completeFramesOnly: true }): Promise<{ image: VideoFrame }>;
            close(): void;
          };
        };
      }
    ).ImageDecoder;
    if (Decoder && (await Decoder.isTypeSupported("image/avif"))) {
      const decoder = new Decoder({
        data: encoded.buffer,
        type: "image/avif",
        colorSpaceConversion: "none",
        preferAnimation: false
      });
      let frame: VideoFrame | undefined;
      try {
        frame = (await decoder.decode({ frameIndex: 0, completeFramesOnly: true })).image;
        if (frame.displayWidth !== item.width || frame.displayHeight !== item.height) {
          throw new Error("Decoded AVIF frame exceeds admitted owner dimensions");
        }
        image = await createImageBitmap(frame, {
          imageOrientation: "none",
          colorSpaceConversion: "none",
          premultiplyAlpha: "none"
        });
      } finally {
        frame?.close();
        decoder.close();
      }
    } else {
      image = await createImageBitmap(blob, {
        imageOrientation: "none",
        colorSpaceConversion: "none",
        premultiplyAlpha: "none"
      });
    }
    if (image.width !== item.width || image.height !== item.height) {
      throw new Error("Decoded AVIF bitmap differs from admitted owner");
    }
    return {
      ...header,
      ok: true,
      representation: "decoded-image",
      image,
      encodedBytes: used,
      ioMs,
      busyMs: performance.now() - busy
    };
  } catch (error) {
    image?.close();
    return { ...header, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
