import {
  TILED_TEXTURE_DIRECTORY_LIMIT,
  openTiledTextureDirectory,
  type TiledTextureDirectory,
  type TiledTexturePayload
} from "../TiledTextureProduct.js";
import { textureProductHash } from "../TextureProduct.js";

export interface TiledTextureRegistration {
  readonly identity: string;
  readonly pack: { readonly uri: string; readonly byteLength: number };
  readonly directoryUrl: string;
  /** Optional strong HTTP validator in addition to mandatory per-payload hashes. */
  readonly etag?: string;
}
export interface TiledTextureSpan {
  readonly offset: number;
  readonly byteLength: number;
  readonly payloadIds: readonly number[];
  /** Only this admitted span's authenticated records cross the Worker boundary. */
  readonly payloads: readonly TiledTexturePayload[];
}
export interface TiledTexturePreparedPayload {
  readonly id: number;
  readonly hash: string;
  readonly bytes: ArrayBuffer;
}

/** Local IO batching: never more than 1MiB or 2x useful bytes, including intervening gaps. */
export function tiledTextureSpans(
  directory: TiledTextureDirectory,
  payloadIds: readonly number[]
): readonly TiledTextureSpan[] {
  if (payloadIds.length > 64) {
    throw new RangeError("Tiled batch exceeds 64 payload IDs");
  }
  const ids = [...new Set(payloadIds)];
  if (ids.length > 64) {
    throw new RangeError("Tiled batch exceeds 64 payloads");
  }
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0 || id >= directory.metadata.payloads.length) {
      throw new RangeError("Tiled payload ID outside directory");
    }
  }
  ids.sort((a, b) => directory.metadata.payloads[a]!.offset - directory.metadata.payloads[b]!.offset);
  const spans: { offset: number; byteLength: number; payloadIds: number[]; useful: number }[] = [];
  for (const id of ids) {
    const p = directory.metadata.payloads[id]!;
    const last = spans.at(-1);
    const bytes = last ? p.offset + p.byteLength - last.offset : p.byteLength;
    if (
      last &&
      p.offset - (last.offset + last.byteLength) <= 65536 &&
      bytes <= 1024 * 1024 &&
      bytes <= 2 * (last.useful + p.byteLength)
    ) {
      last.byteLength = bytes;
      last.useful += p.byteLength;
      last.payloadIds.push(id);
    } else {
      spans.push({ offset: p.offset, byteLength: p.byteLength, payloadIds: [id], useful: p.byteLength });
    }
  }
  return spans.map(({ offset, byteLength, payloadIds }) => ({
    offset,
    byteLength,
    payloadIds,
    payloads: payloadIds.map((id) => directory.metadata.payloads[id]!)
  }));
}

export async function fetchTiledDirectory(
  url: string,
  expectedHash: string,
  byteLength: number
): Promise<{ directory: TiledTextureDirectory; ioMs: number; busyMs: number }> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > TILED_TEXTURE_DIRECTORY_LIMIT) {
    throw new RangeError("Tiled directory fetch requires bounded manifest length");
  }
  const start = performance.now();
  const response = await fetch(url);
  const bytes = await boundedResponse(response, byteLength, 200);
  const busyStart = performance.now();
  const directory = await openTiledTextureDirectory(bytes, expectedHash);
  return { directory, ioMs: busyStart - start, busyMs: performance.now() - busyStart };
}

/** Worker-only transport. 200 on a pack range is cancelled before any body allocation. */
export async function fetchTiledSpan(
  registration: TiledTextureRegistration,
  span: TiledTextureSpan
): Promise<{
  payloads: readonly TiledTexturePreparedPayload[];
  encodedBytes: number;
  ioMs: number;
  busyMs: number;
}> {
  const { pack, directoryUrl, etag } = registration;
  if (
    !/^[a-f0-9]{64}$/u.test(registration.identity) ||
    !Number.isSafeInteger(span.offset) ||
    span.offset < 0 ||
    !Number.isSafeInteger(span.byteLength) ||
    span.byteLength < 1 ||
    span.byteLength > 1024 * 1024 ||
    !Number.isSafeInteger(pack.byteLength) ||
    span.offset + span.byteLength > pack.byteLength ||
    span.payloads.length === 0 ||
    span.payloads.length > 64 ||
    span.payloads.length !== span.payloadIds.length
  ) {
    throw new Error("Tiled range task exceeds admitted domain");
  }
  let end = span.offset;
  let useful = 0;
  for (let i = 0; i < span.payloads.length; i++) {
    const p = span.payloads[i]!;
    if (
      p.id !== span.payloadIds[i] ||
      !Number.isSafeInteger(p.id) ||
      p.id < 0 ||
      !Number.isSafeInteger(p.offset) ||
      p.offset < end ||
      p.offset - end > 65536 ||
      (i === 0 && p.offset !== span.offset) ||
      !Number.isSafeInteger(p.byteLength) ||
      p.byteLength < 1 ||
      p.byteLength > 1024 * 1024 ||
      p.offset + p.byteLength > span.offset + span.byteLength ||
      !/^[a-f0-9]{64}$/u.test(p.hash)
    ) {
      throw new Error("Tiled range task differs from authenticated span records");
    }
    end = p.offset + p.byteLength;
    useful += p.byteLength;
  }
  if (end !== span.offset + span.byteLength || span.byteLength > useful * 2) {
    throw new Error("Tiled range task exceeds coalescing bounds");
  }
  const headers: Record<string, string> = {
    Range: `bytes=${span.offset}-${span.offset + span.byteLength - 1}`
  };
  if (etag !== undefined) {
    if (!/^"[^"]+"$/u.test(etag)) {
      throw new Error("Tiled resource validator must be a strong ETag");
    }
    headers["If-Match"] = etag;
  }
  const start = performance.now();
  let busyMs = 0;
  const response = await fetch(new URL(pack.uri, directoryUrl), { headers });
  if (response.status === 200) {
    await response.body?.cancel();
    const payloads: TiledTexturePreparedPayload[] = [];
    let encodedBytes = 0;
    for (const p of span.payloads) {
      const shard = await fetch(new URL(p.shard, directoryUrl));
      const bytes = await boundedResponse(shard, p.byteLength, 200);
      const busyStart = performance.now();
      await verifyPayload(bytes, p.hash);
      payloads.push({ id: p.id, hash: p.hash, bytes: bytes.buffer as ArrayBuffer });
      busyMs += performance.now() - busyStart;
      encodedBytes += bytes.byteLength;
    }
    return { payloads, encodedBytes, ioMs: performance.now() - start - busyMs, busyMs };
  }
  const range = `bytes ${span.offset}-${span.offset + span.byteLength - 1}/${pack.byteLength}`;
  if (
    response.headers.get("content-range") !== range ||
    (etag !== undefined && response.headers.get("etag") !== etag)
  ) {
    await response.body?.cancel();
    throw new Error("Tiled Content-Range/resource version mismatch");
  }
  const encoded = await boundedResponse(response, span.byteLength, 206);
  const busyStart = performance.now();
  const payloads: TiledTexturePreparedPayload[] = [];
  for (const p of span.payloads) {
    const start = p.offset - span.offset;
    // Own exact transfer storage; retaining a small tile cannot pin a 1MiB range buffer.
    const bytes = encoded.slice(start, start + p.byteLength);
    await verifyPayload(bytes, p.hash);
    payloads.push({ id: p.id, hash: p.hash, bytes: bytes.buffer as ArrayBuffer });
  }
  busyMs = performance.now() - busyStart;
  return {
    payloads,
    encodedBytes: encoded.byteLength,
    ioMs: busyStart - start,
    busyMs
  };
}

async function verifyPayload(bytes: Uint8Array, expected: string): Promise<void> {
  if ((await textureProductHash(bytes)) !== expected) {
    throw new Error("Tiled payload hash mismatch");
  }
}

async function boundedResponse(
  response: Response,
  expectedBytes: number,
  status: number
): Promise<Uint8Array> {
  if (
    response.status !== status ||
    response.headers.get("content-length") !== String(expectedBytes) ||
    (response.headers.get("content-encoding") ?? "identity") !== "identity"
  ) {
    await response.body?.cancel();
    throw new Error("Tiled response status/length/encoding exceeds reserved input");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Tiled response body is missing");
  }
  const bytes = new Uint8Array(expectedBytes);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > expectedBytes) {
        throw new RangeError("Tiled response body exceeds admitted extent");
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (size !== expectedBytes) {
      throw new Error("Tiled response truncated");
    }
    return bytes;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
