import {
  initializePcTextureCodecs,
  cookPcTextureRgba,
  importPcTextureKtx,
  type PcTextureCodecs
} from "../PcTextureCook.js";
import { estimatePcTextureCookBytes } from "../PcTextureCook.js";
import type { PcTextureCookTask } from "../PcTexturePreparation.js";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<PcTextureCookTask | { init: true }>) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
let codecs: PcTextureCodecs | undefined;
scope.onmessage = (event) => {
  void run(event.data);
};
async function run(task: PcTextureCookTask | { init: true }): Promise<void> {
  try {
    if ("init" in task) {
      if (codecs) {
        throw new Error("Duplicate PC codec init");
      }
      codecs = await initializePcTextureCodecs();
      scope.postMessage({ ready: true });
      return;
    }
    if (!codecs) {
      throw new Error("PC codec Worker not initialized");
    }
    const started = performance.now();
    const queueAndInitMs =
      task.queuedAtMs === undefined ? null : performance.timeOrigin + started - task.queuedAtMs;
    const result =
      task.kind === "image"
        ? await cookImage(task)
        : task.kind === "ktx"
          ? await importPcTextureKtx(codecs, new Uint8Array(task.input), task.options)
          : await cookPcTextureRgba(
              codecs,
              new Uint8Array(task.input),
              task.width,
              task.height,
              task.options,
              task.providedMips?.map((m) => new Uint8Array(m))
            );
    const { metadata, chunks } = result.product;
    scope.postMessage(
      {
        taskId: task.taskId,
        ok: true,
        metadata,
        chunks,
        evidence: { ...result.evidence, workerTaskMs: performance.now() - started, queueAndInitMs }
      },
      [...chunks.values()].map((v) => v.buffer)
    );
  } catch (error) {
    // A trapped WASM instance cannot serve retry work. Let the existing pool
    // retire this Worker, release its credits, and create a fresh one.
    if (error instanceof WebAssembly.RuntimeError) {
      setTimeout(() => {
        throw error;
      });
      return;
    }
    scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}
async function cookImage(task: PcTextureCookTask) {
  const started = performance.now();
  const bitmap = await createImageBitmap(new Blob([task.input], { type: task.mimeType }), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none"
  });
  try {
    estimatePcTextureCookBytes(
      bitmap.width,
      bitmap.height,
      task.options.semantic,
      task.options.exactAlpha === true || task.options.semantic === "alpha-mask"
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Raw image canvas decode unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const decodeMs = performance.now() - started;
    const result = await cookPcTextureRgba(
      codecs!,
      new Uint8Array(rgba.buffer),
      bitmap.width,
      bitmap.height,
      {
        ...task.options,
        sourceBytes: task.input.byteLength
      }
    );
    return { ...result, evidence: { ...result.evidence, decodeMs } };
  } finally {
    bitmap.close();
  }
}
