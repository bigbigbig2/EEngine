import type { WebCookWorkerPort } from "./WebCookWorkerTransport.js";
import type { WebCookRuntimeProfile } from "./protocol/CookSessionProtocol.js";

export interface WebCookWorkerFactoryOptions {
  /** URL of the real Emscripten-generated Web geometry `.mjs` module. */
  readonly wasmModuleUrl: string | URL;
  /** URL of the matching Emscripten `.wasm` binary when it is separately emitted. */
  readonly wasmBinaryUrl?: string | URL;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
  readonly createWorker?: (url: URL) => WebCookWorkerPort;
}

export interface DefaultWebCookWorkerFactoryOptions {
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
  readonly createWorker?: (url: URL) => WebCookWorkerPort;
  /**
   * `isolated-pthreads` selects the pthread cooker when the document is
   * cross-origin isolated; otherwise the portable-single artifact is used.
   */
  readonly runtimeProfile?: WebCookRuntimeProfile;
}

/** Versioned browser-first cooker module built from the pinned Nyx sources. */
export const DEFAULT_WEB_GEOMETRY_COOKER_MODULE_URL = defaultWebGeometryCookerModuleUrl();
export const DEFAULT_WEB_GEOMETRY_COOKER_WASM_URL = new URL("./wasm/vendor/oengine-web-geometry-cooker.wasm", import.meta.url);
/** Cross-origin-isolated pthread specialization of the same cooker ABI. */
export const DEFAULT_WEB_GEOMETRY_COOKER_THREADS_MODULE_URL = new URL("./wasm/vendor/threads/oengine-web-geometry-cooker.mjs", import.meta.url);
export const DEFAULT_WEB_GEOMETRY_COOKER_THREADS_WASM_URL = new URL("./wasm/vendor/threads/oengine-web-geometry-cooker.wasm", import.meta.url);

/** Starts the production Dedicated Worker around a real Emscripten module. */
export function createWebCookWorker(options: WebCookWorkerFactoryOptions): WebCookWorkerPort {
  const wasmModuleUrl = typeof options.wasmModuleUrl === "string"
    ? new URL(options.wasmModuleUrl, globalThis.location?.href ?? "http://localhost/")
    : new URL(options.wasmModuleUrl.href);
  const wasmBinaryUrl = options.wasmBinaryUrl === undefined
    ? undefined
    : typeof options.wasmBinaryUrl === "string"
      ? new URL(options.wasmBinaryUrl, globalThis.location?.href ?? "http://localhost/")
      : new URL(options.wasmBinaryUrl.href);
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
    ...(wasmBinaryUrl === undefined ? {} : { wasmBinaryUrl: wasmBinaryUrl.href }),
    maxCanonicalInputBytes: options.maxCanonicalInputBytes,
    maxDecodedProductBytes: options.maxDecodedProductBytes
  }, []);
  return worker;
}

/** Starts a Worker using the repository's real Emscripten cooker artifact. */
export function createDefaultWebCookWorker(options: DefaultWebCookWorkerFactoryOptions): WebCookWorkerPort {
  const useThreads = options.runtimeProfile === "isolated-pthreads" && globalThis.crossOriginIsolated === true;
  return createWebCookWorker({
    ...options,
    wasmModuleUrl: useThreads ? DEFAULT_WEB_GEOMETRY_COOKER_THREADS_MODULE_URL : DEFAULT_WEB_GEOMETRY_COOKER_MODULE_URL,
    wasmBinaryUrl: useThreads ? DEFAULT_WEB_GEOMETRY_COOKER_THREADS_WASM_URL : DEFAULT_WEB_GEOMETRY_COOKER_WASM_URL
  });
}

function defaultWebGeometryCookerModuleUrl(): URL {
  // Vite serves this source-relative URL in dev and rewrites it to the
  // emitted hashed asset in a package build.
  return new URL("./wasm/vendor/oengine-web-geometry-cooker.mjs", import.meta.url);
}
