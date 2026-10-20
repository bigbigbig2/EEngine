import { cookImageTexture, type CanonicalImageMip } from "./ImageTextureCook.js";
import { imageTextureHash, type ImageTextureDirectory, type ImageTexturePlane, type ImageTextureSemantic } from "../ImageTextureProduct.js";

export interface ImageTextureImportTask {
  readonly version: 5;
  readonly session: string;
  readonly task: number;
  readonly input: ArrayBuffer;
  readonly mime?: string;
  readonly width: number;
  readonly height: number;
  readonly semantic: Exclude<ImageTextureSemantic, "exact-r">;
  readonly exactAlpha: boolean;
  readonly addressU: ImageTexturePlane["addressU"];
  readonly addressV: ImageTexturePlane["addressV"];
}

export type ImageTextureImportResult = Pick<ImageTextureImportTask, "version" | "session" | "task"> & {
  readonly decoderMemoryBytes: number;
} & ({ readonly ok: false; readonly message: string } | {
  readonly ok: true;
  readonly directory: ImageTextureDirectory;
  readonly payloads: ReadonlyMap<string, ArrayBuffer>;
  readonly decodeMs: number;
});

/** Local Web inputs become lossless PNG image items, not CPU-generated BC.
 * The ordinary source then uses exactly the shared image receipt/GPU path.
 * Offline deployment uses native AVIF; no browser AVIF encoder is assumed. */
export async function importImageTexture(task: ImageTextureImportTask): Promise<ImageTextureImportResult> {
  const header = { version: task.version, session: task.session, task: task.task, decoderMemoryBytes: 0 as const };
  let bitmap: ImageBitmap | undefined;
  try {
    const started = performance.now();
    let width = task.width;
    let height = task.height;
    let imported: CanonicalImageMip[] | undefined;
    if (task.input.byteLength < 1 || task.input.byteLength > 16 * 1024 * 1024) {
      throw new RangeError("Web image encoded/raw input exceeds import capacity");
    }
    if (task.mime === "image/ktx2") {
      const { importCanonicalKtx } = await import("./ImageTextureKtxImport.js");
      imported = await importCanonicalKtx(task.input, task.semantic.startsWith("color-"));
      width = imported[0]!.width;
      height = imported[0]!.height;
    } else if (task.mime) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(task.mime)) {
        throw new Error("Unsupported Web image container; canonical offline recook is required");
      }
      [width, height] = webImageDimensions(new Uint8Array(task.input), task.mime);
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > 2048 || height > 2048) {
      throw new RangeError("Web image import requires a bounded 1..2048 source; larger inputs need offline provided mips");
    }
    let rgba: Uint8Array;
    if (imported) {
      rgba = imported[0]!.rgba;
    } else if (task.mime) {
      bitmap = await createImageBitmap(new Blob([task.input], { type: task.mime }), {
        imageOrientation: "from-image", premultiplyAlpha: "none",
        colorSpaceConversion: task.semantic.startsWith("color-") ? "default" : "none"
      });
      if (bitmap.width !== width || bitmap.height !== height) {
        // Orientation may exchange dimensions, but never increase the admitted pixel count.
        if (bitmap.width !== height || bitmap.height !== width) throw new Error("Web image decode dimension mismatch");
        [width, height] = [height, width];
      }
      // A 2D canvas round trip quantizes low-alpha RGB through premultiplication.
      // VideoFrame's explicit RGBA copy retains the straight image representation.
      const frame = new VideoFrame(bitmap, { timestamp: 0 });
      try {
        rgba = new Uint8Array(width * height * 4);
        const layout = await frame.copyTo(rgba, { format: "RGBA", layout: [{ offset: 0, stride: width * 4 }] });
        if (layout.length !== 1 || layout[0]!.offset !== 0 || layout[0]!.stride !== width * 4) {
          throw new Error("Canonical Web image copy differs from its admitted RGBA layout");
        }
      } finally {
        frame.close();
      }
    } else {
      rgba = new Uint8Array(task.input);
      if (rgba.length !== width * height * 4) throw new Error("Web raw RGBA domain mismatch");
    }
    const decodeMs = performance.now() - started;
    const inputs: CanonicalImageMip[] = imported ?? [{ width, height, rgba }];
    let semantic = task.semantic;
    if (semantic === "normal-xy") {
      for (let at = 2; at < rgba.length; at += 4) {
        if (rgba[at]! < 128) {
          semantic = "moment-xyz";
          break;
        }
      }
    }
    const provided = task.exactAlpha || semantic === "moment-xyz" || inputs.length > 1;
    let coverage: CanonicalImageMip[] | undefined;
    if (provided) {
      // Preserve the existing pinned full-resolution-to-1x1 canonical resampler.
      const { resampleCanonicalMip } = await import("./ImageTextureResample.js");
      while (Math.max(inputs.at(-1)!.width, inputs.at(-1)!.height) > 1) {
        inputs.push(await resampleCanonicalMip(inputs.at(-1)!, semantic.startsWith("color-"), semantic === "normal-xy"));
      }
      if (task.exactAlpha) coverage = inputs;
    }
    if (provided && semantic === "normal-xy") {
      for (const input of inputs) {
        for (let at = 0; at < input.rgba.length; at += 4) {
          const x = input.rgba[at]! * 2 / 255 - 1;
          const y = input.rgba[at + 1]! * 2 / 255 - 1;
          const z = input.rgba[at + 2]! * 2 / 255 - 1;
          const length = Math.hypot(x, y, z);
          if (z < 0 || length === 0) throw new Error("Normal XY cannot discard this hemisphere/direction");
          input.rgba[at] = Math.round((x / length * 0.5 + 0.5) * 255);
          input.rgba[at + 1] = Math.round((y / length * 0.5 + 0.5) * 255);
          input.rgba[at + 2] = 0;
        }
      }
    }
    const payloads = new Map<string, ArrayBuffer>();
    const result = await cookImageTexture({
      inputs, semantic, mode: "resident", mips: provided ? "provided" : "runtime", quality: "high",
      addressU: task.addressU, addressV: task.addressV, exactCoverage: coverage,
      toolHash: await imageTextureHash(new TextEncoder().encode("web-canonical-png-v1"))
    }, {
      imageCodec: "png",
      async encodeAvif(input) {
        return encodeCanonicalPng(input);
      },
      async put(hash, bytes) {
        payloads.set(hash, bytes.slice().buffer);
        return hash;
      }
    });
    const directory: ImageTextureDirectory = { ...result.directory,
      items: result.directory.items.map((item) => item.kind === "image" ? { ...item, codec: "png" } : item) };
    return { ...header, ok: true, directory, payloads, decodeMs };
  } catch (error) {
    return { ...header, ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    bitmap?.close();
  }
}

/** PNG framing only; compression uses the browser's complete DEFLATE codec.
 * Avoid a canvas round trip that would quantize RGB through premultiplied alpha. */
export async function encodeCanonicalPng(input: CanonicalImageMip): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, input.width);
  view.setUint32(4, input.height);
  header[8] = 8;
  header[9] = 6;
  const stride = input.width * 4;
  const rows = new Uint8Array((stride + 1) * input.height);
  for (let row = 0; row < input.height; row++) {
    rows.set(input.rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const compressed = new Uint8Array(await new Response(
    new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))
  ).arrayBuffer());
  const chunk = (name: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
    const output = new Uint8Array(payload.length + 12);
    const fields = new DataView(output.buffer);
    fields.setUint32(0, payload.length);
    output.set(new TextEncoder().encode(name), 4);
    output.set(payload, 8);
    let crc = 0xffffffff;
    for (let index = 4; index < output.length - 4; index++) {
      crc ^= output[index]!;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    fields.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
    return output;
  };
  return new Uint8Array(await new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array())
  ]).arrayBuffer());
}

/** Container headers are inspected before browser pixel allocation. Full decode
 * remains the platform decoder's responsibility; malformed/truncated data rejects. */
function webImageDimensions(bytes: Uint8Array, mime: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  if (mime === "image/webp" && bytes.length >= 30 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X") {
      if (bytes[20]! & 2) throw new Error("Animated WebP is not a material image");
      return [1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
        1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)];
    }
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  throw new Error("Web image container header is malformed or unsupported");
}
