import {
  imageMipCount,
  checkedImageHash,
  checkedImageInteger,
  imageTarget,
  imageTextureHash,
  writeImageTextureDirectory,
  type ImageTextureDirectory,
  type ImageTextureItem,
  type ImageTexturePlane,
  type ImageTextureSemantic
} from "../ImageTextureProduct.js";

export interface CanonicalImageMip {
  readonly width: number;
  readonly height: number;
  /** Already oriented, straight alpha, sRGB color or unchanged linear data UNORM8. */
  readonly rgba: Uint8Array;
}

export interface ImageTextureCookRequest {
  readonly semantic: Exclude<ImageTextureSemantic, "exact-r">;
  readonly quality: "high" | "extreme";
  readonly mode: "resident" | "virtual";
  readonly mips: "runtime" | "provided";
  readonly inputs: readonly CanonicalImageMip[];
  readonly toolHash: string;
  readonly scalarChannel?: 0 | 1 | 2 | 3;
  readonly exactCoverage?: readonly CanonicalImageMip[];
  readonly cellSize?: 128 | 256 | 512;
  readonly addressU?: ImageTexturePlane["addressU"];
  readonly addressV?: ImageTexturePlane["addressV"];
  readonly alphaScales?: readonly number[];
}

export interface ImageTextureCookSink {
  /** Complete pinned native encoder; no BC intermediate, no internal image resize. */
  encodeAvif(
    input: CanonicalImageMip,
    semantic: ImageTextureSemantic,
    quality: "high" | "extreme"
  ): Promise<Uint8Array>;
  /** Persist content-addressed immutable bytes before the directory can be published. */
  put(hash: string, bytes: Uint8Array, kind: "image" | "exact"): Promise<string>;
}

/** Cold-only canonical producer. The caller applies source ICC/orientation first; this function
 * never strips arbitrary metadata or derives special/VT mips from independent cells. */
export async function cookImageTexture(
  request: ImageTextureCookRequest,
  sink: ImageTextureCookSink
): Promise<{ directory: ImageTextureDirectory; bytes: Uint8Array }> {
  const base = request.inputs[0];
  if (!base) {
    throw new Error("Canonical base image is missing");
  }
  checkedImageInteger(base.width, 1, 65536);
  checkedImageInteger(base.height, 1, 65536);
  checkedImageHash(request.toolHash);
  imageTarget(request.semantic);
  if (
    !["runtime", "provided"].includes(request.mips) ||
    !["resident", "virtual"].includes(request.mode) ||
    !["high", "extreme"].includes(request.quality)
  ) {
    throw new Error("Unsupported canonical image profile");
  }
  const mipCount = imageMipCount(base.width, base.height);
  if (
    request.inputs.length !== (request.mips === "runtime" ? 1 : mipCount) ||
    ((request.mode === "virtual" || request.semantic === "moment-xyz") && request.mips !== "provided")
  ) {
    throw new Error("Canonical producer requires the complete selected mip domain");
  }
  const validateInput = (input: CanonicalImageMip, level: number) => {
    const width = Math.max(1, Math.floor(base.width / 2 ** level));
    const height = Math.max(1, Math.floor(base.height / 2 ** level));
    if (
      !Number.isSafeInteger(width * height * 4) ||
      width < 1 ||
      height < 1 ||
      width > 65536 ||
      height > 65536 ||
      input.width !== width ||
      input.height !== height ||
      input.rgba.length !== width * height * 4
    ) {
      throw new Error("Canonical mip dimensions/bytes differ from logical domain");
    }
  };
  request.inputs.forEach(validateInput);
  if (request.exactCoverage) {
    if (request.exactCoverage.length !== mipCount) {
      throw new Error("Exact coverage requires all canonical mip levels");
    }
    request.exactCoverage.forEach(validateInput);
  }
  const sourceHashes = await Promise.all(request.inputs.map((input) => imageTextureHash(input.rgba)));
  const coverageHashes = request.exactCoverage
    ? await Promise.all(request.exactCoverage.map((input) => imageTextureHash(input.rgba)))
    : [];
  const sourceRevision = await imageTextureHash(
    new TextEncoder().encode(
      JSON.stringify({
        width: base.width,
        height: base.height,
        sourceHashes,
        coverageHashes
      })
    )
  );
  const recipe = await imageTextureHash(
    new TextEncoder().encode(
      JSON.stringify({
        version: 4,
        canonical: "unorm8-oriented-straight-v1",
        sourceRevision,
        ...Object.fromEntries(
          Object.entries(request).filter(([key]) => key !== "inputs" && key !== "exactCoverage")
        )
      })
    )
  );
  let semantic = request.semantic;
  // Remove alpha only when it is exactly opaque at every supplied level.
  if (
    semantic === "color-rgba" &&
    request.inputs.every((input) => {
      for (let index = 3; index < input.rgba.length; index += 4) {
        if (input.rgba[index] !== 255) {
          return false;
        }
      }
      return true;
    })
  ) {
    semantic = "color-rgb";
  }
  const canonical = request.inputs.map((input) =>
    canonicalize(input, semantic, request.scalarChannel ?? 0, request.mips === "runtime")
  );
  const constants = exactConstants(canonical);
  const plane: ImageTexturePlane = {
    semantic,
    target: imageTarget(semantic),
    mode: request.mode,
    mips: request.mips,
    addressU: request.addressU ?? "clamp-to-edge",
    addressV: request.addressV ?? "clamp-to-edge",
    alphaScales: request.alphaScales ?? [],
    constants
  };
  const planes: ImageTexturePlane[] = [plane];
  const items: ImageTextureItem[] = [];
  const emit = async (inputs: readonly CanonicalImageMip[], planeIndex: number, exact: boolean) => {
    const cell = request.mode === "virtual" ? (request.cellSize ?? 512) : 2048;
    if (![128, 256, 512, 2048].includes(cell)) {
      throw new Error("Unsupported canonical owner grid");
    }
    for (let mip = 0; mip < inputs.length; mip++) {
      const input = inputs[mip]!;
      if (request.mips === "runtime" && (input.width > cell || input.height > cell)) {
        throw new Error("Large runtime base requires explicit large-input capability or provided mips");
      }
      for (let y = 0; y < input.height; y += cell) {
        for (let x = 0; x < input.width; x += cell) {
          const width = Math.min(cell, input.width - x);
          const height = Math.min(cell, input.height - y);
          const rgba = new Uint8Array(width * height * 4);
          for (let row = 0; row < height; row++) {
            const offset = ((y + row) * input.width + x) * 4;
            rgba.set(input.rgba.subarray(offset, offset + width * 4), row * width * 4);
          }
          let payload: Uint8Array;
          if (exact) {
            payload = new Uint8Array(width * height);
            for (let index = 0; index < payload.length; index++) {
              payload[index] = rgba[index * 4 + 3]!;
            }
          } else {
            payload = await sink.encodeAvif({ width, height, rgba }, semantic, request.quality);
          }
          if (payload.byteLength < 1 || payload.byteLength > 4 * 1024 * 1024 || items.length >= 65536) {
            throw new RangeError("Cooked image item exceeds the selected encoded/item capacity");
          }
          const sha256 = await imageTextureHash(payload);
          const uri = await sink.put(sha256, payload, exact ? "exact" : "image");
          items.push({
            id: items.length,
            plane: planeIndex,
            mip,
            x,
            y,
            width,
            height,
            kind: exact ? "exact" : "image",
            codec: exact ? "raw" : "avif",
            bytes: payload.byteLength,
            decodedBytes: width * height * (exact ? 1 : 4),
            sha256,
            uri,
            offset: null,
            objectBytes: String(payload.byteLength)
          });
        }
      }
    }
  };
  await emit(canonical, 0, false);
  if (request.exactCoverage) {
    planes.push({
      ...plane,
      semantic: "exact-r",
      target: "r8",
      mips: "provided",
      constants: [null, 0, 0, 255]
    });
    await emit(request.exactCoverage, 1, true);
  }
  const directory: ImageTextureDirectory = {
    schemaVersion: 4,
    sourceRevision,
    recipe,
    width: base.width,
    height: base.height,
    mipCount,
    quality: request.quality,
    planes,
    items
  };
  return { directory, bytes: writeImageTextureDirectory(directory) };
}

function canonicalize(
  input: CanonicalImageMip,
  semantic: ImageTextureSemantic,
  channel: number,
  normalizeNormal: boolean
): CanonicalImageMip {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) {
    throw new Error("Invalid scalar source channel");
  }
  const rgba = input.rgba.slice();
  for (let index = 0; index < rgba.length; index += 4) {
    if (semantic === "scalar-r") {
      const scalar = input.rgba[index + channel]!;
      rgba[index] = scalar;
      rgba[index + 1] = scalar;
      rgba[index + 2] = scalar;
    } else if (semantic === "normal-xy") {
      const x = input.rgba[index]! * (2 / 255) - 1;
      const y = input.rgba[index + 1]! * (2 / 255) - 1;
      const z = input.rgba[index + 2]! * (2 / 255) - 1;
      const length = Math.hypot(x, y, z);
      if (z < 0 || length < 1e-12) {
        throw new Error("Unit tangent normal cannot discard negative hemisphere or zero direction");
      }
      // Read original XYZ together; do not repeat donor's sequential channel mutation.
      if (normalizeNormal) {
        rgba[index] = Math.round(((x / length) * 0.5 + 0.5) * 255);
        rgba[index + 1] = Math.round(((y / length) * 0.5 + 0.5) * 255);
      }
      rgba[index + 2] = 0;
    }
    if (semantic !== "color-rgba") {
      rgba[index + 3] = 255;
    }
  }
  return { width: input.width, height: input.height, rgba };
}

function exactConstants(inputs: readonly CanonicalImageMip[]): (number | null)[] {
  const result: (number | null)[] = Array.from(inputs[0]!.rgba.subarray(0, 4));
  for (const input of inputs) {
    for (let index = 0; index < input.rgba.length; index++) {
      const channel = index % 4;
      if (input.rgba[index] !== result[channel]) {
        result[channel] = null;
      }
    }
  }
  return result;
}
