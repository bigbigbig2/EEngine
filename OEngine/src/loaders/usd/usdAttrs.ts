/**
 * usdAttrs：解析 USD 数据并转换为引擎运行时对象。
 */

import type { UsdSpecsByPath } from "./UsdExtensionRegistry.js";

export function getAttrDefault(
  specs: UsdSpecsByPath,
  primPath: string,
  attrName: string
): unknown {
  const r = specs[`${primPath}.${attrName}`];
  if (!r?.fields) return undefined;
  if (r.fields.default !== undefined) return r.fields.default;
  const ts = r.fields.timeSamples as
    | { times?: number[]; values?: unknown[] }
    | undefined;
  if (ts?.values && ts.values.length > 0) return ts.values[0];
  return undefined;
}

export function getXformOpValue(
  fields: Record<string, unknown>,
  specs: UsdSpecsByPath,
  primPath: string,
  opName: string
): unknown {
  if (fields[opName] !== undefined) return fields[opName];
  const spec = specs[`${primPath}.${opName}`];
  if (spec?.fields) {
    const timeSamples = spec.fields.timeSamples as
      | { values?: unknown[] }
      | undefined;
    if (timeSamples?.values && timeSamples.values.length > 0) {
      return timeSamples.values[0];
    }
    if (spec.fields.default !== undefined) return spec.fields.default;
  }
  return null;
}

export function getAttrInterpolation(
  specs: UsdSpecsByPath,
  primPath: string,
  attrName: string
): string {
  const r = specs[`${primPath}.${attrName}`];
  return r?.fields?.interpolation
    ? (r.fields.interpolation as string)
    : "vertex";
}

export function parseUsdValue(typeName: string, raw: unknown): unknown {
  if (raw == null) return undefined;
  const n = String(raw).trim();
  if (typeName.endsWith("[]")) {
    try {
      let e = n.replace(/\(/g, "[").replace(/\)/g, "]");
      if (e.endsWith(",")) e = e.slice(0, -1);
      const parsed = JSON.parse(e) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        Array.isArray(parsed[0])
      ) {
        return (parsed as unknown[][]).flat();
      }
      return parsed;
    } catch {
      return n
        .replace(/[\[\]]/g, "")
        .split(",")
        .map((e) => {
          const t = e.trim();
          const f = parseFloat(t);
          return Number.isNaN(f) ? stripQuotes(t) : f;
        });
    }
  }
  if (
    typeName.startsWith("quat") ||
    (/\d/.test(typeName) &&
      (typeName.includes("float") ||
        typeName.includes("double") ||
        typeName.includes("int") ||
        typeName.startsWith("point") ||
        typeName.startsWith("color") ||
        typeName.startsWith("normal") ||
        typeName.startsWith("texCoord") ||
        typeName.startsWith("vec"))) ||
    typeName.includes("matrix")
  ) {
    return n
      .replace(/[()]/g, "")
      .split(",")
      .map((e) => parseFloat(e.trim()));
  }
  if (typeName === "float" || typeName === "double" || typeName === "half") {
    return parseFloat(n);
  }
  if (typeName === "int") return parseInt(n, 10);
  if (typeName === "bool") return n === "true" || n === "1";
  if (typeName === "asset") return n.replace(/@/g, "").replace(/"/g, "");
  return stripQuotes(n);
}

export function parseXformOpOrder(raw: unknown): string[] {
  return String(raw)
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((e) => e.trim().replace(/"/g, ""))
    .filter((e) => e.length > 0);
}

export function stripQuotes(e: string): string {
  if (
    (e.startsWith('"') && e.endsWith('"')) ||
    (e.startsWith("'") && e.endsWith("'"))
  ) {
    return e.slice(1, -1);
  }
  return e;
}

export function toFloat32Array(e: unknown): Float32Array {
  if (e instanceof Float32Array) return e;
  return new Float32Array(e as ArrayLike<number>);
}

export function toNumberArray(e: unknown): number[] {
  return e as number[];
}
