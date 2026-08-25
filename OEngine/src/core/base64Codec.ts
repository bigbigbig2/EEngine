/**
 * base64Codec：提供渲染器共享的基础数据结构与通用工具。
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const encodeTable: string[] = [];
const decodeTable: number[] = [];
for (let i = 0; i < 64; ++i) {
  encodeTable[i] = ALPHABET[i]!;
  decodeTable[ALPHABET.charCodeAt(i)] = i;
}
decodeTable["-".charCodeAt(0)] = 62;
decodeTable["_".charCodeAt(0)] = 63;

const CHUNK = 16383;

function tripleToChars(e: number): string {
  return (
    encodeTable[(e >> 18) & 63]! +
    encodeTable[(e >> 12) & 63]! +
    encodeTable[(e >> 6) & 63]! +
    encodeTable[63 & e]!
  );
}

function encodeRange(e: Uint8Array, t: number, n: number): string {
  const r: string[] = [];
  for (let s = t; s < n; s += 3) {
    r.push(
      tripleToChars(
        ((e[s]! << 16) & 16711680) +
          ((e[s + 1]! << 8) & 65280) +
          (255 & e[s + 2]!)
      )
    );
  }
  return r.join("");
}

export function base64Encode(e: ArrayBuffer | ArrayBufferView): string {
  const u8 =
    e instanceof ArrayBuffer
      ? new Uint8Array(e)
      : new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
  const t = u8.length;
  const n = t % 3;
  const r: string[] = [];
  const s = t - n;
  for (let i = 0; i < s; i += CHUNK) {
    r.push(encodeRange(u8, i, i + CHUNK > s ? s : i + CHUNK));
  }
  if (n === 1) {
    const b = u8[t - 1]!;
    r.push(encodeTable[b >> 2]! + encodeTable[(b << 4) & 63]! + "==");
  } else if (n === 2) {
    const b = (u8[t - 2]! << 8) + u8[t - 1]!;
    r.push(
      encodeTable[b >> 10]! +
        encodeTable[(b >> 4) & 63]! +
        encodeTable[(b << 2) & 63]! +
        "="
    );
  }
  return r.join("");
}

export function base64Decode(e: string): ArrayBuffer {
  const t = e.length;
  if (t % 4 > 0) {
    throw new Error("Invalid string. Length must be a multiple of 4");
  }
  let padAt = e.indexOf("=");
  if (padAt === -1) padAt = t;
  const pad = padAt === t ? 0 : 4 - (padAt % 4);
  const outLen = (3 * (padAt + pad)) / 4 - pad;
  const a = new Uint8Array(outLen);
  let i = 0;
  const o = pad > 0 ? padAt - 4 : padAt;
  let _ = 0;
  for (; _ < o; _ += 4) {
    const n = e.charCodeAt(_);
    const r = e.charCodeAt(_ + 1);
    const s = e.charCodeAt(_ + 2);
    const o2 = e.charCodeAt(_ + 3);
    const word =
      (decodeTable[n]! << 18) |
      (decodeTable[r]! << 12) |
      (decodeTable[s]! << 6) |
      decodeTable[o2]!;
    a[i++] = (word >> 16) & 255;
    a[i++] = (word >> 8) & 255;
    a[i++] = 255 & word;
  }
  if (pad === 2) {
    const n = e.charCodeAt(_);
    const r = e.charCodeAt(_ + 1);
    const word = (decodeTable[n]! << 2) | (decodeTable[r]! >> 4);
    a[i++] = 255 & word;
  } else if (pad === 1) {
    const n = e.charCodeAt(_);
    const r = e.charCodeAt(_ + 1);
    const s = e.charCodeAt(_ + 2);
    const word =
      (decodeTable[n]! << 10) | (decodeTable[r]! << 4) | (decodeTable[s]! >> 2);
    a[i++] = (word >> 8) & 255;
    a[i++] = 255 & word;
  }
  return a.buffer;
}

export const Base64Codec = {
  encode: base64Encode,
  decode: base64Decode
} as const;

export const ir = Base64Codec;
