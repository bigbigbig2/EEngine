import { decodeOegPackPageV3, HttpRangeReadablePackV3 } from "../../OegPackV3.js";
import { prepareProductResidentAttributes } from "../../geometry-product/GeometryProductResidentAttributes.js";
import {
  validateGeometryProductQuerySection,
  verifyGeometryProductQueryContent,
} from "../../geometry-product/GeometryProductQuerySection.js";
import type {
  CookedAssetTask,
  CookedAssetResult,
  CookedGeometryRegistration,
} from "../CookedAssetProtocol.js";
import { prepareImageTextureTask, type ImageTextureTask } from "../ImageTexturePreparation.js";
import { importImageTexture, type ImageTextureImportTask } from "../ImageTextureImport.js";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<CookedAssetTask | ImageTextureTask | ImageTextureImportTask | { forget: string }>) => void;
  postMessage: (value: unknown, transfer: Transferable[]) => void;
};
const registrations = new Map<string, CookedGeometryRegistration>();
scope.onmessage = (event) => {
  if ("forget" in event.data) {
    registrations.delete(event.data.forget);
    return;
  }
  if (event.data.version === 5) {
    void importImageTexture(event.data).then((result) => {
      scope.postMessage(result, result.ok ? [...result.payloads.values()] : []);
    });
  } else if (event.data.version === 4) {
    void prepareImageTextureTask(event.data).then((result) => {
      const transfer: Transferable[] = result.ok
        ? [result.representation === "decoded-image" ? result.image : result.bytes]
        : [];
      try {
        scope.postMessage({ ...result, decoderMemoryBytes: 0 }, transfer);
      } catch (error) {
        if (result.ok && result.representation === "decoded-image") {
          result.image.close();
        }
        scope.postMessage({ version: result.version, session: result.session, epoch: result.epoch,
          task: result.task, sourceRevision: result.sourceRevision, recipe: result.recipe,
          itemId: result.itemId, decoderMemoryBytes: 0,
          ok: false, message: `Image receipt transfer failed: ${String(error)}` }, []);
      }
    });
  } else {
    void prepare(event.data);
  }
};

async function prepare(task: CookedAssetTask): Promise<void> {
  const header = {
    version: task.version,
    session: task.session,
    epoch: task.epoch,
    task: task.task,
    decoderMemoryBytes: 0,
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
    } else {
      throw new Error("Retired Cooked texture protocol; recook schema4 images");
    }
  } catch (error) {
    result = { ...header, ok: false, message: error instanceof Error ? error.message : String(error) };
    transfer.clear();
  }
  scope.postMessage({ ...result, decoderMemoryBytes: 0 }, [...transfer]);
}
