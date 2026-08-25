/**
 * decodeAvif：负责资源读取、解码或场景装载。
 */

import { Sampler2D, type SamplerData } from "../texture/Sampler2D.js";
import { createAvifDecoderModule } from "./avifDecoderModule.js";

interface AvifDecodedImage {
  data: SamplerData;
  width: number;
  height: number;
}

interface AvifDecoderModule {
  decode(
    source: ArrayBuffer,
    bitDepth: number,
    outputFloat16: boolean,
    outputColorSpace: number,
    chromaUpsampling: number
  ): AvifDecodedImage | null;
}

let decoderModule: Promise<AvifDecoderModule> | undefined;

function obtainDecoderModule(): Promise<AvifDecoderModule> {
  if (decoderModule === undefined) {
    decoderModule = createAvifDecoderModule({
      noInitialRun: true
    }) as Promise<AvifDecoderModule>;
  }
  return decoderModule;
}

export function isAvifFile(source: ArrayBuffer): boolean {
  if (source.byteLength < 12) return false;
  const brand = new Uint8Array(source, 4, 8);
  const value = String.fromCharCode.apply(null, Array.from(brand));
  return value === "ftypavif" || value === "ftypavis";
}

export async function decodeAvifOo(source: ArrayBuffer): Promise<Sampler2D> {
  if (!isAvifFile(source)) {
    throw new Error("Not an AVIF file");
  }

  const module = await obtainDecoderModule();
  const decoded = module.decode(source, 8, true, 1, 2);
  if (!decoded) {
    throw new Error("Decoding error");
  }

  console.warn("decode");
  return new Sampler2D(decoded.data, 4, decoded.width, decoded.height);
}
