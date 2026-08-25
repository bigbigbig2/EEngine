/**
 * rgbe：负责资源读取、解码或场景装载。
 */

import { floatToHalf } from "./float16.js";

export interface RgbeHeader {
  valid: number;
  string: string;
  comments: string;
  programtype: string;
  format: string;
  gamma: number;
  exposure: number;
  width: number;
  height: number;
}

export interface RgbeDecodeResult {
  width: number;
  height: number;
  data: Float32Array;
  header: string;
  gamma: number;
  exposure: number;
  type: "float32";
}

export interface RgbeDecodeHalfResult {
  width: number;
  height: number;
  data: Uint16Array;
  header: string;
  gamma: number;
  exposure: number;
  type: "float16";
}

const HALF_ONE = floatToHalf(1);

type PosBuf = Uint8Array & { pos: number };

function rgbeError(code: number, msg?: string): never {
  switch (code) {
    case 1:
      throw new Error("Read Error: " + (msg || ""));
    case 2:
      throw new Error("Write Error: " + (msg || ""));
    case 3:
      throw new Error("Bad File Format: " + (msg || ""));
    default:
      throw new Error("Memory Error: " + (msg || ""));
  }
}

function readLine(buf: PosBuf, maxLen = 1024, advance = true): string | false {
  let r = buf.pos;
  let s = -1;
  let a = 0;
  let i = "";
  let o = String.fromCharCode(...new Uint16Array(buf.subarray(r, r + 128)));
  while ((s = o.indexOf("\n")) < 0 && a < maxLen && r < buf.byteLength) {
    i += o;
    a += o.length;
    r += 128;
    o += String.fromCharCode(...new Uint16Array(buf.subarray(r, r + 128)));
  }
  if (s < 0) return false;
  if (advance !== false) buf.pos += a + s + 1;
  return i + o.slice(0, s);
}

function parseHeader(buf: PosBuf): RgbeHeader {
  const gammaRe = /^\s*GAMMA\s*=\s*(\d+(\.\d+)?)\s*$/;
  const exposureRe = /^\s*EXPOSURE\s*=\s*(\d+(\.\d+)?)\s*$/;
  const formatRe = /^\s*FORMAT=(\S+)\s*$/;
  const sizeRe = /^\s*\-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/;
  const a: RgbeHeader = {
    valid: 0,
    string: "",
    comments: "",
    programtype: "RGBE",
    format: "",
    gamma: 1,
    exposure: 1,
    width: 0,
    height: 0
  };

  let line: string | false;
  if (buf.pos >= buf.byteLength || !(line = readLine(buf))) {
    rgbeError(1, "no header found");
  }
  let m = line.match(/^#\?(\S+)/);
  if (!m) rgbeError(3, `bad initial token '${line}'`);
  a.valid |= 1;
  a.programtype = m[1]!;
  a.string += line + "\n";

  while ((line = readLine(buf)) !== false) {
    a.string += line + "\n";
    if (line.charAt(0) === "#") {
      a.comments += line + "\n";
      continue;
    }
    if ((m = line.match(gammaRe))) a.gamma = parseFloat(m[1]!);
    if ((m = line.match(exposureRe))) a.exposure = parseFloat(m[1]!);
    if ((m = line.match(formatRe))) {
      a.valid |= 2;
      a.format = m[1]!;
    }
    if ((m = line.match(sizeRe))) {
      a.valid |= 4;
      a.height = parseInt(m[1]!, 10);
      a.width = parseInt(m[2]!, 10);
    }
    if (2 & a.valid && 4 & a.valid) break;
  }
  if (!(2 & a.valid)) rgbeError(3, "missing format specifier");
  if (!(4 & a.valid)) rgbeError(3, "missing image size specifier");
  return a;
}

function decodeRleScanlines(
  e: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const r = width;
  if (r < 8 || r > 32767 || e[0] !== 2 || e[1] !== 2 || (e[2]! & 128) !== 0) {
    return new Uint8Array(e);
  }
  if (r !== ((e[2]! << 8) | e[3]!)) rgbeError(3, "wrong scanline width");
  const s = new Uint8Array(4 * r * height);
  if (!s.length) rgbeError(4, "unable to allocate buffer space");
  let a = 0;
  let i = 0;
  const o = 4 * r;
  const _ = new Uint8Array(o);
  let c = height;
  const d = e.byteLength;
  while (c > 0 && i < d) {
    if (i + 4 > d) rgbeError(1);
    const t = e[i++]!;
    const n = e[i++]!;
    const u = e[i++]!;
    const l = e[i++]!;
    if (!(t === 2 && n === 2 && ((u << 8) | l) === r)) {
      rgbeError(3, "bad rgbe scanline format");
    }
    let h = 0;
    while (h < o && i < d) {
      let f = e[i++]!;
      const run = f > 128;
      if (run) f -= 128;
      if (f === 0 || h + f > o) rgbeError(3, "bad scanline data");
      if (run) {
        const v = e[i++]!;
        for (let k = 0; k < f; k++) _[h++] = v;
      } else {
        _.set(e.subarray(i, i + f), h);
        h += f;
        i += f;
      }
    }
    for (let x = 0; x < r; x++) {
      let t = x;
      s[a] = _[t]!;
      t += r;
      s[a + 1] = _[t]!;
      t += r;
      s[a + 2] = _[t]!;
      t += r;
      s[a + 3] = _[t]!;
      a += 4;
    }
    c--;
  }
  return s;
}

export function rgbeToFloat32(
  src: Uint8Array,
  srcOff: number,
  dst: Float32Array,
  dstOff: number
): void {
  const s = Math.pow(2, src[srcOff + 3]! - 128) / 255;
  dst[dstOff + 0] = src[srcOff + 0]! * s;
  dst[dstOff + 1] = src[srcOff + 1]! * s;
  dst[dstOff + 2] = src[srcOff + 2]! * s;
  dst[dstOff + 3] = 1;
}

export function rgbeToHalf(
  src: Uint8Array,
  srcOff: number,
  dst: Uint16Array,
  dstOff: number
): void {
  const s = Math.pow(2, src[srcOff + 3]! - 128) / 255;
  dst[dstOff + 0] = floatToHalf(Math.min(src[srcOff + 0]! * s, 65504));
  dst[dstOff + 1] = floatToHalf(Math.min(src[srcOff + 1]! * s, 65504));
  dst[dstOff + 2] = floatToHalf(Math.min(src[srcOff + 2]! * s, 65504));
  dst[dstOff + 3] = HALF_ONE;
}

function frexpMantissa(e: number, expOut: Uint8Array, expOff: number): number {
  if (e === 0 || !Number.isFinite(e)) {
    expOut[expOff] = 0;
    return e;
  }
  let r = Math.abs(e);
  let s = Math.max(-1023, Math.floor(Math.log2(r)) + 1);
  let a = r * Math.pow(2, -s);
  while (a < 0.5) {
    a *= 2;
    s--;
  }
  while (a >= 1) {
    a *= 0.5;
    s++;
  }
  if (e < 0) a = -a;
  expOut[expOff] = s & 0xff;
  return a;
}

export function floatRgbToRgbe(
  out: Uint8Array,
  r: number,
  g: number,
  b: number
): void {
  let s = r;
  if (g > s) s = g;
  if (b > s) s = b;
  if (s < 1e-32) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  const mant = frexpMantissa(s, out, 3);
  const scale = (256 * mant) / s;
  const exp = out[3]!;
  out[0] = r * scale;
  out[1] = g * scale;
  out[2] = b * scale;
  out[3] = exp + 128;
}

function writeRleChannel(out: number[], t: Uint8Array, n: number): void {
  let r = 0;
  while (r < n) {
    let s = r;
    let a = 0;
    let i = 0;
    while (a < 4 && s < n) {
      s += a;
      i = a;
      a = 1;
      while (s + a < n && a < 127 && t[s] === t[s + a]) a++;
    }
    if (i > 1 && i === s - r) {
      out.push(128 + i, t[r]!);
      r = s;
    }
    while (r < s) {
      let nChunk = s - r;
      if (nChunk > 128) nChunk = 128;
      out.push(nChunk);
      for (let k = 0; k < nChunk; k++) out.push(t[r + k]!);
      r += nChunk;
    }
    if (a >= 4) {
      out.push(128 + a, t[s]!);
      r += a;
    }
  }
}

export function encodeRgbe(
  rgba: Float32Array,
  width: number,
  height: number
): ArrayBuffer {
  if (width < 8 || width > 32767) {
    throw new Error("RGBE_WritePixels unsupported");
  }
  const headerText = `#?RGBE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const headerBytes: number[] = [];
  for (let i = 0; i < headerText.length; i++) {
    headerBytes.push(headerText.charCodeAt(i) & 0xff);
  }

  const body: number[] = [];
  const a = new Uint8Array(4);
  const i = new Uint8Array(4 * width);
  let o = 0;
  for (let y = 0; y < height; y++) {
    body.push(2, 2, width >> 8, width & 255);
    for (let x = 0; x < width; x++) {
      const n = rgba[o]!;
      const s = rgba[o + 1]!;
      const _ = rgba[o + 2]!;
      o += 4;
      floatRgbToRgbe(a, n, s, _);
      i[x] = a[0]!;
      i[x + width] = a[1]!;
      i[x + 2 * width] = a[2]!;
      i[x + 3 * width] = a[3]!;
    }
    for (let t = 0; t < 4; t++) {
      writeRleChannel(body, i.subarray(t * width, (t + 1) * width), width);
    }
  }

  const out = new Uint8Array(headerBytes.length + body.length);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.length);
  return out.buffer;
}

export function decodeRgbe(buffer: ArrayBuffer): RgbeDecodeResult {
  const n = new Uint8Array(buffer) as PosBuf;
  n.pos = 0;
  const header = parseHeader(n);
  const width = header.width;
  const height = header.height;
  const plane = decodeRleScanlines(n.subarray(n.pos), width, height);
  const pixelCount = plane.length / 4;
  const data = new Float32Array(4 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    rgbeToFloat32(plane, 4 * i, data, 4 * i);
  }
  return {
    width,
    height,
    data,
    header: header.string,
    gamma: header.gamma,
    exposure: header.exposure,
    type: "float32"
  };
}

export function decodeRgbeHalf(buffer: ArrayBuffer): RgbeDecodeHalfResult {
  const n = new Uint8Array(buffer) as PosBuf;
  n.pos = 0;
  const header = parseHeader(n);
  const width = header.width;
  const height = header.height;
  const plane = decodeRleScanlines(n.subarray(n.pos), width, height);
  const pixelCount = plane.length / 4;
  const data = new Uint16Array(4 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    rgbeToHalf(plane, 4 * i, data, 4 * i);
  }
  return {
    width,
    height,
    data,
    header: header.string,
    gamma: header.gamma,
    exposure: header.exposure,
    type: "float16"
  };
}
