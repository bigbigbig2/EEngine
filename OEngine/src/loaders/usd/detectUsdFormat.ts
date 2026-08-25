/**
 * detectUsdFormat：解析 USD 数据并转换为引擎运行时对象。
 */

import { pathExtension } from "../pathUtils.js";

export const USDC_MAGIC = new Uint8Array([80, 88, 82, 45, 85, 83, 68, 67]);
export const ZIP_LOCAL_MAGIC = new Uint8Array([80, 75, 3, 4]);

export type UsdFormat = "usda" | "usdc" | "usdz";

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export function detectUsdFormat(
  buffer: ArrayBuffer,
  fileName?: string
): UsdFormat | null {
  const n = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));
  if (startsWith(n, ZIP_LOCAL_MAGIC)) return "usdz";
  if (startsWith(n, USDC_MAGIC)) return "usdc";
  if (n.length >= 6) {
    let s = "";
    for (let t = 0; t < 6; t++) s += String.fromCharCode(n[t]!);
    if (s === "#usda ") return "usda";
  }
  if (fileName) {
    switch (pathExtension(fileName)) {
      case "usda":
      case "usd":
        return "usda";
      case "usdc":
        return "usdc";
      case "usdz":
        return "usdz";
    }
  }
  return null;
}
