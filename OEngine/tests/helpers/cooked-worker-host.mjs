import { parentPort } from "node:worker_threads";

globalThis.self = {
  onmessage: null,
  postMessage(result, transfer) {
    parentPort.postMessage(result, transfer);
    parentPort.postMessage({ transferProof: true, detached: transfer.map((buffer) => buffer.byteLength) });
  }
};
await import("../../.test-dist/assets/codec/workers/cooked-asset-worker.js");
parentPort.on("message", (data) => {
  if (data.crash) {
    throw new Error("deliberate Worker crash");
  }
  self.onmessage({ data });
});
