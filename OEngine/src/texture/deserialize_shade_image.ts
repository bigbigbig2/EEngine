/**
 * deserialize_shade_image：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

import { BinaryReader } from "../loaders/BinaryReader.js";
import { ShadeImage } from "./ShadeImage.js";

export function deserialize_shade_image(
  buffer: ArrayBuffer,
  out: ShadeImage = new ShadeImage()
): ShadeImage {
  const e = BinaryReader.fromArrayBuffer(buffer);
  const n = e.readUint16();
  const r = e.readUint16();
  const s = e.readUint16();
  const a = e.readUint16();
  const i = e.readUTF8String() as string;
  const o = e.readUint32();
  const _ = new Uint8Array(o);
  e.readBytes(_, 0, o);
  out.width = n;
  out.height = r;
  out.depth = s;
  out.channel_count = a;
  out.data_type = i;
  out.source = _.buffer;
  return out;
}

export async function load_shade_image_from_url(url: string): Promise<ShadeImage> {
  const n = new ShadeImage();
  n.color_space = 0;
  const r = await fetch(url);
  const s = await r.arrayBuffer();
  try {
    deserialize_shade_image(s, n);
  } catch (t) {
    const err = new Error(`Failed to deserialize image "${url}"`);
    (err as Error & { cause?: unknown }).cause = t;
    throw err;
  }
  return n;
}
