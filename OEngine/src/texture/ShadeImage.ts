/**
 * ShadeImage：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

import { inferDataTypeFromArray, ShadeDataType } from "./ShadeDataType.js";

let nextShadeImageId = 0;

export interface Sampler2DLike {
  width: number;
  height: number;
  itemSize: number;
  data: ArrayLike<number> | ArrayBufferView;
}

export class ShadeImage {
  #id = nextShadeImageId++;

  get id(): number {
    return this.#id;
  }

  color_space = 2;

  #dataType: string = ShadeDataType.Uint8;

  get data_type(): string {
    return this.#dataType;
  }

  set data_type(e: string) {
    this.#dataType = e;
  }

  #channelCount = 4;

  get channel_count(): number {
    return this.#channelCount;
  }

  set channel_count(e: number) {
    this.#channelCount = e;
  }

  normalized = true;
  /** Cold import bytes. Parsing/decode belongs to the bounded codec Worker. */
  encoded_mime_type: string | undefined;

  #source: unknown;

  get source(): unknown {
    return this.#source;
  }

  set source(e: unknown) {
    this.#source = e;
  }

  #size = new Uint32Array(3);

  get width(): number {
    return this.#size[0]!;
  }

  set width(e: number) {
    this.#size[0] = e >>> 0;
  }

  get height(): number {
    return this.#size[1]!;
  }

  set height(e: number) {
    this.#size[1] = e >>> 0;
  }

  get depth(): number {
    return this.#size[2]!;
  }

  set depth(e: number) {
    this.#size[2] = e >>> 0;
  }

  hash(): number {
    return this.#id;
  }

  equals(other: { id: number }): boolean {
    return this.#id === other.id;
  }

  static fromImageBitmap(e: { width: number; height: number }): ShadeImage {
    const t = new ShadeImage();
    t.#source = e;
    t.#size[0] = e.width >>> 0;
    t.#size[1] = e.height >>> 0;
    t.#size[2] = 1;
    t.#dataType = ShadeDataType.Uint8;
    t.#channelCount = 4;
    t.normalized = true;
    return t;
  }

  static fromEncodedImage(bytes: ArrayBuffer, mimeType: string): ShadeImage {
    const image = ShadeImage.fromArrayBuffer(bytes, 4, ShadeDataType.Uint8, 0, 0, 1);
    image.encoded_mime_type = encodedImageMime(bytes, mimeType);
    return image;
  }

  static fromSampler2D(e: Sampler2DLike): ShadeImage {
    const t = new ShadeImage();
    t.#source = e;
    t.#size[0] = e.width >>> 0;
    t.#size[1] = e.height >>> 0;
    t.#size[2] = 1;
    t.#dataType = inferDataTypeFromArray(e.data);
    t.#channelCount = e.itemSize;
    t.normalized = true;
    return t;
  }

  static fromArrayBuffer(
    e: ArrayBuffer | ArrayBufferView,
    channelCount: number,
    dataType: string,
    width = 1,
    height = 1,
    depth = 1,
  ): ShadeImage {
    const i = new ShadeImage();
    i.#source = e;
    i.#size[0] = width >>> 0;
    i.#size[1] = height >>> 0;
    i.#size[2] = depth >>> 0;
    i.#dataType = dataType;
    i.#channelCount = channelCount;
    i.normalized = false;
    return i;
  }
}

// File maps and HTTP responses may omit MIME. This only selects the cold owner;
// browser/libktx still own container parsing and validation.
function encodedImageMime(bytes: ArrayBuffer, declared: string): string {
  if (declared && declared !== "application/octet-stream") {
    return declared;
  }
  const header = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  const matches = (magic: readonly number[]) => magic.every((byte, index) => header[index] === byte);
  if (matches([137, 80, 78, 71, 13, 10, 26, 10])) {
    return "image/png";
  }
  if (matches([255, 216, 255])) {
    return "image/jpeg";
  }
  if (
    matches([82, 73, 70, 70]) &&
    header[8] === 87 &&
    header[9] === 69 &&
    header[10] === 66 &&
    header[11] === 80
  ) {
    return "image/webp";
  }
  if (matches([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10])) {
    return "image/ktx2";
  }
  throw new Error("Encoded material image requires a supported MIME or image signature");
}

Object.defineProperty(ShadeImage.prototype, "isShadeImage", {
  get() {
    return true;
  },
  enumerable: false,
  configurable: true,
});

export { ShadeImage as ShadeImageStub };
