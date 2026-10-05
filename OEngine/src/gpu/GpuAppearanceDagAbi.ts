import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";
import type { AppearanceWgslProgram } from "../shaders/appearance_program.js";
import { compileExactAppearanceDag } from "../material/ExactAppearanceDag.js";

export const APPEARANCE_DAG_ENTRY_WORDS = 16;
export const APPEARANCE_DAG_PRODUCT_WORDS = 12;
export const APPEARANCE_DAG_MIP_WORDS = 4;
export const APPEARANCE_DAG_PRODUCT_BANKS = 2;

export interface AppearanceDagSource {
  readonly program: CompiledAppearanceGraph;
  readonly lowered: AppearanceWgslProgram;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly inputBase: number;
  readonly textureBindingSetId: number;
}
export interface AppearanceDagPublicationData {
  readonly code: Uint32Array;
  readonly products: readonly Uint32Array[];
  readonly productBankWords: number;
  readonly liveSlots: number;
}

/** Local publication ABI integration. Immutable cooked half payload is retained
 * bit-for-bit; formats, every mip and exact domain mapping remain data. Asset
 * count/identity never adds a binding or a PSO. Two negotiated storage banks
 * cover the existing 256 MiB static-residency profile at 128 MiB per binding. */
export function packAppearanceDagPublication(
  sources: readonly AppearanceDagSource[],
  maximumBindingBytes: number,
): AppearanceDagPublicationData {
  if (!Number.isSafeInteger(maximumBindingBytes) || maximumBindingBytes < 4) {
    throw new RangeError("Invalid Appearance DAG storage limit");
  }
  const bankWords = Math.floor(maximumBindingBytes / 4);
  const words = Array<number>(Math.max(1, sources.length) * APPEARANCE_DAG_ENTRY_WORDS).fill(0);
  const payloads: Uint8Array[] = [];
  const productFields = new Map<string, { offset: number; field: AppearanceAssetField }>();
  let productBytes = 0;
  let liveSlots = 1;
  const bits = (value: number): number => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  };
  for (let entry = 0; entry < sources.length; entry++) {
    const source = sources[entry]!;
    const dag = compileExactAppearanceDag(source.program, source.lowered);
    const instructions = words.length;
    for (const word of dag.instructions) {
      words.push(word);
    }
    const outputs = words.length;
    for (const word of dag.outputs) {
      words.push(word);
    }
    const reads = source.program.productReads ?? [];
    const products = words.length;
    for (let word = 0; word < reads.length * APPEARANCE_DAG_PRODUCT_WORDS; word++) {
      words.push(0);
    }
    for (let index = 0; index < reads.length; index++) {
      const read = reads[index]!;
      if (read.field.constant !== undefined) {
        continue;
      }
      const key = `${read.asset.runtime.manifest.assetId}:${read.field.name}:${read.field.contentKey}`;
      let resident = productFields.get(key);
      if (resident === undefined) {
        resident = { offset: productBytes, field: read.field };
        productFields.set(key, resident);
        for (const mip of read.field.mips) {
          const padded = new Uint8Array(Math.ceil(mip.payload.byteLength / 4) * 4);
          padded.set(mip.payload);
          payloads.push(padded);
          productBytes += padded.byteLength;
        }
      }
      const mipBase = words.length;
      let byteOffset = resident.offset;
      for (const mip of read.field.mips) {
        words.push(byteOffset / 4, mip.width, mip.height, 0);
        byteOffset += Math.ceil(mip.payload.byteLength / 4) * 4;
      }
      const channels = read.field.width === 3 ? 4 : read.field.width;
      const base = products + index * APPEARANCE_DAG_PRODUCT_WORDS;
      const data = [
        mipBase,
        read.field.mips.length,
        channels,
        0,
        bits(read.asset.domainMin[0]),
        bits(read.asset.domainMin[1]),
        bits(1 / (read.asset.domainMax[0] - read.asset.domainMin[0])),
        bits(1 / (read.asset.domainMax[1] - read.asset.domainMin[1])),
        read.field.width,
        0,
        0,
        0,
      ];
      for (let word = 0; word < data.length; word++) {
        words[base + word] = data[word]!;
      }
    }
    const header = [
      instructions,
      dag.instructions.length / 8,
      outputs,
      dag.outputs.length / 4,
      dag.liveSlots,
      source.constantBase,
      source.routeBase,
      source.inputBase,
      source.textureBindingSetId,
      products,
      dag.geometryMask,
      dag.neighborMask,
      dag.fieldMask,
      0,
      0,
      0,
    ];
    for (let word = 0; word < APPEARANCE_DAG_ENTRY_WORDS; word++) {
      words[entry * APPEARANCE_DAG_ENTRY_WORDS + word] = header[word]!;
    }
    liveSlots = Math.max(liveSlots, dag.liveSlots);
  }
  if (
    words.length * 4 > maximumBindingBytes ||
    productBytes > maximumBindingBytes * APPEARANCE_DAG_PRODUCT_BANKS
  ) {
    throw new RangeError("Complete Appearance DAG publication exceeds negotiated code/product storage");
  }
  const products = Array.from({ length: APPEARANCE_DAG_PRODUCT_BANKS }, (_, bank) => {
    const size = Math.max(4, Math.min(maximumBindingBytes, productBytes - bank * maximumBindingBytes));
    return new Uint32Array(Math.ceil(size / 4));
  });
  let byteOffset = 0;
  for (const payload of payloads) {
    let consumed = 0;
    while (consumed < payload.byteLength) {
      const bank = Math.floor(byteOffset / (bankWords * 4));
      const offset = byteOffset % (bankWords * 4);
      const bytes = Math.min(payload.byteLength - consumed, bankWords * 4 - offset);
      new Uint8Array(products[bank]!.buffer).set(payload.subarray(consumed, consumed + bytes), offset);
      consumed += bytes;
      byteOffset += bytes;
    }
  }
  return Object.freeze({
    code: Uint32Array.from(words),
    products: Object.freeze(products),
    productBankWords: bankWords,
    liveSlots,
  });
}
