import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";

const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol === "file:" && url.pathname.endsWith("/tiled_zstd.wasm")) {
    const bytes = await readFile(url);
    return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
  }
  return networkFetch(input, init);
};

globalThis.self = {
  onmessage: null,
  postMessage(result, transfer) {
    parentPort.postMessage(result, transfer);
    parentPort.postMessage({ transferProof: true, detached: transfer.map((buffer) => buffer.byteLength) });
  },
};
await import("../../.test-dist/assets/codec/workers/cooked-asset-worker.js");
parentPort.on("message", (data) => {
  if (data.crash) {
    throw new Error("deliberate Worker crash");
  }
  self.onmessage({ data });
});
