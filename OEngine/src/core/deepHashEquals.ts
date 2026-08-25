/**
 * deepHashEquals：提供渲染器共享的基础数据结构与通用工具。
 */

import { hashFloat } from "./hashMix.js";
import { hashString } from "./memoryUtils.js";

export function deepHash(e: unknown, t = 3): number {
  if (e === undefined) return 1;
  if (e === null) return 2;
  let n = 0;
  const r = typeof e;
  if (r === "string") n = hashString(e as string);
  else if (r === "number") n = hashFloat(e as number);
  else if (r === "boolean") n = e ? 1 : 0;
  else if (r === "object") {
    if (t <= 0) n = 3;
    else {
      for (const key in e as object) {
        n =
          ((n << 5) -
            n +
            (hashString(key) ^
              deepHash((e as Record<string, unknown>)[key], t - 1))) |
          0;
      }
    }
  }
  return n;
}

export const Zo = deepHash;

function arrayDeepEqualsWith(
  e: unknown[],
  t: unknown[],
  n: (a: unknown, b: unknown) => boolean,
  r: unknown
): boolean {
  if (e === t) return true;
  if (e === null || t === null || e === undefined || t === undefined)
    return false;
  const s = e.length;
  if (s !== t.length) return false;
  for (let a = 0; a < s; a++) {
    if (!n.call(r, e[a], t[a])) return false;
  }
  return true;
}

function stringKeysEqual(e: string[], t: string[]): boolean {
  if (e === t) return true;
  if (e.length !== t.length) return false;
  for (let i = 0; i < e.length; i++) if (e[i] !== t[i]) return false;
  return true;
}

export function deepEquals(
  t: unknown,
  n: unknown,
  r: (a: unknown, b: unknown) => boolean = deepEquals,
  s: unknown = null
): boolean {
  if (t === n) return true;
  const a = typeof t;
  if (a !== typeof n) return false;
  if (a !== "object") return false;
  if (t === null || n === null) return false;
  if (Array.isArray(t)) {
    return (
      Array.isArray(n) &&
      arrayDeepEqualsWith(t as unknown[], n as unknown[], r, s)
    );
  }
  const tObj = t as { equals?: (o: unknown) => boolean };
  const nObj = n as { equals?: (o: unknown) => boolean };
  if (
    typeof tObj.equals === "function" &&
    typeof nObj.equals === "function"
  ) {
    return tObj.equals(n);
  }
  const i = Object.keys(t as object);
  const o = Object.keys(n as object);
  i.sort();
  o.sort();
  if (!stringKeysEqual(i, o)) return false;
  const _ = i.length;
  for (let e = 0; e < _; e++) {
    const aKey = i[e]!;
    if (
      !r.call(
        s,
        (t as Record<string, unknown>)[aKey],
        (n as Record<string, unknown>)[aKey]
      )
    ) {
      return false;
    }
  }
  return true;
}

export const e_ = deepEquals;
