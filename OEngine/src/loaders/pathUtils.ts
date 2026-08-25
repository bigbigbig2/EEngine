/**
 * pathUtils：负责资源读取、解码或场景装载。
 */

export function pathBasename(e: string): string {
  if (typeof e !== "string") throw new Error("path is not a string");
  const t = e.lastIndexOf("/");
  return t !== -1 ? e.substring(t + 1) : e;
}

export const h_ = pathBasename;

export function pathExtension(e: string): string | null {
  const t = typeof e;
  if (t !== "string") {
    throw new Error(`path must be a string, instead was '${t}'`);
  }
  const n = pathBasename(e.split(/[?#]/, 1)[0]!);
  const r = n.lastIndexOf(".");
  return r !== -1 ? n.substring(r + 1) : null;
}

export const m_ = pathExtension;

const dataUriPattern = /^data:/;
const absoluteUriPattern = /^[a-z][a-z\d+.-]*:/i;

export function resolveRelativeUri(e: string, t: string): string {
  if (dataUriPattern.test(e) || absoluteUriPattern.test(e) || e.startsWith("//")) {
    return e;
  }
  try {
    return new URL(e, t).href;
  } catch {
    return t + e;
  }
}

export const y_ = resolveRelativeUri;

export function baseUrlOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0]!;
  const t = clean.lastIndexOf("/");
  return t !== 0 ? clean.substring(0, t + 1) : "./";
}
