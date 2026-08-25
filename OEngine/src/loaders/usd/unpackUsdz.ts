/**
 * unpackUsdz：解析 USD 数据并转换为引擎运行时对象。
 */

import { BinaryReader } from "../BinaryReader.js";
import { UsdParseError } from "./UsdErrors.js";

const ZIP_LOCAL_SIG = 0x04034b50;

export function unpackUsdz(buffer: ArrayBuffer): {
  files: Map<string, Uint8Array>;
  rootFileName: string;
} {
  const t = BinaryReader.fromArrayBuffer(buffer);
  const n = new Map<string, Uint8Array>();
  let r = "";
  while (
    t.position < t.capacity &&
    !(t.position + 4 > t.capacity) &&
    t.readUint32() === ZIP_LOCAL_SIG
  ) {
    t.skip(4);
    const s = t.readUint16();
    t.skip(8);
    const a = t.readUint32();
    const i = t.readUint32();
    const o = t.readUint16();
    const _ = t.readUint16();
    const c = t.readASCIICharacters(o);
    t.skip(_);
    if (s !== 0) {
      throw new UsdParseError(
        `USDZ requires uncompressed entries, but "${c}" uses method ${s}`,
        { section: "unpack_usdz", offset: t.position }
      );
    }
    const d = t.position;
    const u = new Uint8Array(buffer, d, i);
    n.set(c, u);
    if (r === "") r = c;
    t.position = d + a;
  }
  if (r === "") {
    throw new UsdParseError("Empty USDZ archive — no files found", {
      section: "unpack_usdz"
    });
  }
  return { files: n, rootFileName: r };
}
