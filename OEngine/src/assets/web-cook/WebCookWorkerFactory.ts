import type { WebCookWorkerPort } from "./WebCookWorkerTransport.js";

export interface WebCookWorkerFactoryOptions {
  /** URL of the real Emscripten-generated Web geometry `.mjs` module. */
  readonly wasmModuleUrl: string | URL;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
  readonly createWorker?: (url: URL) => WebCookWorkerPort;
}

/** Starts the production Dedicated Worker around a real Emscripten module. */
export function createWebCookWorker(options: WebCookWorkerFactoryOptions): WebCookWorkerPort {
  const wasmModuleUrl = typeof options.wasmModuleUrl === "string"
    ? new URL(options.wasmModuleUrl, globalThis.location?.href ?? "http://localhost/")
    : new URL(options.wasmModuleUrl.href);
  if (!Number.isSafeInteger(options.maxCanonicalInputBytes) || options.maxCanonicalInputBytes <= 0 ||
      !Number.isSafeInteger(options.maxDecodedProductBytes) || options.maxDecodedProductBytes <= 0) {
    throw new RangeError("Web Cook Worker WASM budgets must be positive safe integers");
  }
  const worker = options.createWorker
    ? options.createWorker(new URL("./WebCookWorkerEntrypoint.ts", import.meta.url))
    : new Worker(new URL("./WebCookWorkerEntrypoint.ts", import.meta.url), { type: "module" });
  worker.postMessage({
    type: "InitializeWebCookWorker",
    wasmModuleUrl: wasmModuleUrl.href,
    maxCanonicalInputBytes: options.maxCanonicalInputBytes,
    maxDecodedProductBytes: options.maxDecodedProductBytes
  }, []);
  return worker;
}
