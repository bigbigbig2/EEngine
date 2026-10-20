import { decodeOegPackPageV3, HttpRangeReadablePackV3 } from "../../OegPackV3.js";
import { prepareProductResidentAttributes } from "../../geometry-product/GeometryProductResidentAttributes.js";
import {
  validateGeometryProductQuerySection,
  verifyGeometryProductQueryContent,
} from "../../geometry-product/GeometryProductQuerySection.js";
import { openTextureProduct, PC_TEXTURE_INPUT_LIMIT } from "../../TextureProduct.js";
import type {
  CookedAssetTask,
  CookedAssetResult,
  CookedGeometryRegistration,
} from "../CookedAssetProtocol.js";
import {
  fetchTiledDirectory,
  fetchTiledSpan,
  type TiledTextureRegistration,
} from "../TiledTextureTransport.js";
import { loadTiledTextureDecoder } from "../TiledTextureDecoder.js";

let decoder: Awaited<ReturnType<typeof loadTiledTextureDecoder>> | undefined;
async function getDecoder() {
  return (decoder ??= await loadTiledTextureDecoder());
}

const scope = self as unknown as {
  onmessage: (event: MessageEvent<CookedAssetTask | { forget: string }>) => void;
  postMessage: (value: unknown, transfer: Transferable[]) => void;
};
const registrations = new Map<string, CookedGeometryRegistration>();
const tiledRegistrations = new Map<string, TiledTextureRegistration>();
scope.onmessage = (event) => {
  if ("forget" in event.data) {
    registrations.delete(event.data.forget);
    tiledRegistrations.delete(event.data.forget);
    return;
  }
  void prepare(event.data);
};

async function prepare(task: CookedAssetTask): Promise<void> {
  const header = {
    version: task.version,
    session: task.session,
    epoch: task.epoch,
    task: task.task,
    decoderMemoryBytes: decoder?.memoryBytes ?? 0,
  };
  const transfer = new Set<ArrayBuffer>();
  let result: CookedAssetResult;
  try {
    if (task.version !== 3) {
      throw new Error("Unsupported Cooked Worker protocol");
    }
    if (task.kind === "geometry") {
      if (task.registration) {
        await verifyGeometryProductQueryContent(
          validateGeometryProductQuerySection(task.registration.descriptor),
        );
        registrations.set(task.session, task.registration);
      }
      const registration = registrations.get(task.session);
      if (!registration) {
        throw new Error("Cooked geometry descriptor is not registered");
      }
      const source = new HttpRangeReadablePackV3(registration.url, registration.init);
      const started = performance.now();
      const encoded = new Uint8Array(await source.read(task.span.offset, task.span.bytes));
      const ioMs = performance.now() - started;
      const busyStart = performance.now();
      const pages = [];
      for (const pageId of task.span.pageIds) {
        const entry = registration.pages[pageId];
        if (!entry) {
          throw new Error("Cooked page is outside the registered descriptor");
        }
        const offset = Number(entry.compressedFileOffset - task.span.offset);
        if (offset < 0 || offset + entry.compressedBytes > encoded.byteLength) {
          throw new Error("Cooked span does not contain its full page domain");
        }
        const decoded = await decodeOegPackPageV3(
          pageId,
          encoded.subarray(offset, offset + entry.compressedBytes),
          entry,
          registration.groups,
          registration.formats,
          registration.verifyPageSha256,
        );
        const bytes = decoded.bytes.buffer as ArrayBuffer;
        const prepared = prepareProductResidentAttributes(registration.descriptor, pageId, bytes);
        transfer.add(bytes);
        transfer.add(prepared.groupBounds.buffer as ArrayBuffer);
        transfer.add(prepared.refineEdges.buffer as ArrayBuffer);
        pages.push({
          pageId,
          bytes,
          integrity: decoded.integrity,
          decodedPageHash128: decoded.decodedPageHash128,
          prepared,
        });
      }
      result = {
        ...header,
        ok: true,
        kind: "geometry",
        pages,
        encodedBytes: encoded.byteLength,
        ioMs,
        busyMs: performance.now() - busyStart,
      };
    } else if (task.kind === "tiled-directory") {
      const prepared = await fetchTiledDirectory(task.url, task.expectedHash, task.byteLength);
      result = {
        ...header,
        ok: true,
        kind: "tiled-directory",
        ...prepared,
        encodedBytes: task.byteLength,
      };
    } else if (task.kind === "tiled-payload") {
      if (task.registration) {
        tiledRegistrations.set(task.registrationKey, task.registration);
      }
      const registration = tiledRegistrations.get(task.registrationKey);
      if (!registration) {
        throw new Error("Tiled texture directory is not registered");
      }
      const prepared = await fetchTiledSpan(registration, task.span, getDecoder);
      for (const p of prepared.payloads) {
        transfer.add(p.bytes);
      }
      result = {
        ...header,
        ok: true,
        kind: "tiled-payload",
        registrationKey: task.registrationKey,
        ...prepared,
      };
    } else {
      const started = performance.now();
      const response = await fetch(task.url);
      if (!response.ok) {
        throw new Error(`Cooked texture HTTP ${response.status}`);
      }
      const limit = Math.min(PC_TEXTURE_INPUT_LIMIT, task.maxBytes);
      const declared = Number(response.headers.get("content-length"));
      if (declared !== limit || (response.headers.get("content-encoding") ?? "identity") !== "identity") {
        await response.body?.cancel();
        throw new RangeError("Cooked texture response exceeds reserved input credit");
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Cooked texture response has no body");
      }
      // One admitted buffer avoids retaining transport chunks plus a concatenation.
      const storage = new Uint8Array(limit);
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          if (size + chunk.value.byteLength > limit) {
            throw new RangeError("Cooked texture input domain overflow");
          }
          storage.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
      const ioMs = performance.now() - started;
      const busyStart = performance.now();
      if (size !== limit) {
        throw new Error("Cooked texture response length mismatch");
      }
      const bytes = storage.buffer;
      const product = await openTextureProduct(bytes);
      if (product.identity !== task.expectedIdentity) {
        throw new Error("Cooked texture Product identity mismatch");
      }
      for (const chunk of product.chunks.values()) {
        transfer.add(chunk.buffer as ArrayBuffer);
      }
      result = {
        ...header,
        ok: true,
        kind: "texture",
        product,
        encodedBytes: size,
        ioMs,
        busyMs: performance.now() - busyStart,
      };
    }
  } catch (error) {
    result = { ...header, ok: false, message: error instanceof Error ? error.message : String(error) };
    transfer.clear();
  }
  scope.postMessage({ ...result, decoderMemoryBytes: decoder?.memoryBytes ?? 0 }, [...transfer]);
}
