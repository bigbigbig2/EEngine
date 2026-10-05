import type { WebCookWorkerPort } from "./WebCookWorkerTransport.js";
import { WebCookWorkerPool } from "./WebCookWorkerPool.js";
import type { WebCookRuntimeProfile } from "./protocol/CookSessionProtocol.js";

export interface WebCookWorkerFactoryOptions {
  /** URL of the real Emscripten-generated Web geometry `.mjs` module. */
  readonly wasmModuleUrl: string | URL;
  /** URL of the matching Emscripten `.wasm` binary when it is separately emitted. */
  readonly wasmBinaryUrl?: string | URL;
  readonly maxCanonicalInputBytes: number;
  readonly maxSourceWindowBytes?: number;
  readonly maxDecodedProductBytes: number;
  readonly maxSessionSpillBytes?: number;
  readonly maxTrianglesPerProduct?: number;
  readonly maxVerticesPerProduct?: number;
  readonly maxDomainsPerProduct?: number;
  /** Maximum wait for main-thread catalog priorities before the Worker cooks its first cut. */
  readonly catalogPriorityWindowMs?: number;
  readonly createWorker?: (url: URL) => WebCookWorkerPort;
  /** Number of Dedicated Workers used by portable-pool. Defaults to one. */
  readonly maxWorkers?: number;
}

export interface DefaultWebCookWorkerFactoryOptions {
  readonly maxCanonicalInputBytes: number;
  readonly maxSourceWindowBytes?: number;
  readonly maxDecodedProductBytes: number;
  readonly maxSessionSpillBytes?: number;
  readonly maxTrianglesPerProduct?: number;
  readonly maxVerticesPerProduct?: number;
  readonly maxDomainsPerProduct?: number;
  /** Maximum wait for main-thread catalog priorities before the Worker cooks its first cut. */
  readonly catalogPriorityWindowMs?: number;
  readonly createWorker?: (url: URL) => WebCookWorkerPort;
  /**
   * `isolated-pthreads` selects the pthread cooker when the document is
   * cross-origin isolated; otherwise the portable-single artifact is used.
   * `auto` lets `resolveWebCookRuntimeProfile` pick pthreads, a worker pool or
   * a single portable worker from the page's isolation and core count.
   */
  readonly runtimeProfile?: WebCookRuntimeProfile | "auto";
  readonly maxWorkers?: number;
}

export interface WebCookRuntimeProfileCapability {
  readonly requested: WebCookRuntimeProfile | "auto";
  readonly selected: WebCookRuntimeProfile;
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly hardwareConcurrency: number;
  readonly fallbackReason?:
    | "cross-origin-isolation-required"
    | "shared-array-buffer-unavailable"
    | "cross-origin-isolation-unavailable";
}

/** Below this core count neither the pthread cooker nor the worker pool pays off. */
const PROFILE_MINIMUM_CORES = 4;

/** Resolves the execution profile without ever claiming pthread support on an unisolated page. */
export function resolveWebCookRuntimeProfile(
  requested: WebCookRuntimeProfile | "auto" = "portable-single",
): WebCookRuntimeProfileCapability {
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof globalThis.SharedArrayBuffer === "function";
  const hardwareConcurrency =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number" &&
    navigator.hardwareConcurrency > 0
      ? Math.floor(navigator.hardwareConcurrency)
      : 1;
  const capability = (
    selected: WebCookRuntimeProfile,
    fallbackReason?: WebCookRuntimeProfileCapability["fallbackReason"],
  ): WebCookRuntimeProfileCapability =>
    Object.freeze({
      requested,
      selected,
      crossOriginIsolated,
      sharedArrayBuffer,
      hardwareConcurrency,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    });

  if (requested === "auto") {
    // Automatic selection. Prefer the pthread cooker only on an isolated page
    // with enough cores; otherwise the bounded worker pool, then the single
    // portable worker. A pool on an unisolated page is recorded with a
    // cross-origin-isolation fallback so it is never mistaken for pthreads.
    if (crossOriginIsolated && sharedArrayBuffer && hardwareConcurrency >= PROFILE_MINIMUM_CORES)
      return capability("isolated-pthreads");
    if (hardwareConcurrency >= PROFILE_MINIMUM_CORES)
      return capability(
        "portable-pool",
        crossOriginIsolated ? "shared-array-buffer-unavailable" : "cross-origin-isolation-unavailable",
      );
    return capability("portable-single");
  }
  if (requested !== "isolated-pthreads") return capability(requested);
  if (!crossOriginIsolated) return capability("portable-single", "cross-origin-isolation-required");
  if (!sharedArrayBuffer) return capability("portable-single", "shared-array-buffer-unavailable");
  return capability("isolated-pthreads");
}

/** Versioned browser-first cooker module built from the pinned Nyx sources. */
export const DEFAULT_WEB_GEOMETRY_COOKER_MODULE_URL = defaultWebGeometryCookerModuleUrl();
export const DEFAULT_WEB_GEOMETRY_COOKER_WASM_URL = new URL(
  "./wasm/vendor/oengine-web-geometry-cooker.wasm",
  import.meta.url,
);
/** Cross-origin-isolated pthread specialization of the same cooker ABI. */
export const DEFAULT_WEB_GEOMETRY_COOKER_THREADS_MODULE_URL = new URL(
  "./wasm/vendor/threads/oengine-web-geometry-cooker.mjs",
  import.meta.url,
);
export const DEFAULT_WEB_GEOMETRY_COOKER_THREADS_WASM_URL = new URL(
  "./wasm/vendor/threads/oengine-web-geometry-cooker.wasm",
  import.meta.url,
);

/** Starts the production Dedicated Worker around a real Emscripten module. */
export function createWebCookWorker(options: WebCookWorkerFactoryOptions): WebCookWorkerPort {
  const wasmModuleUrl =
    typeof options.wasmModuleUrl === "string"
      ? new URL(options.wasmModuleUrl, globalThis.location?.href ?? "http://localhost/")
      : new URL(options.wasmModuleUrl.href);
  const wasmBinaryUrl =
    options.wasmBinaryUrl === undefined
      ? undefined
      : typeof options.wasmBinaryUrl === "string"
        ? new URL(options.wasmBinaryUrl, globalThis.location?.href ?? "http://localhost/")
        : new URL(options.wasmBinaryUrl.href);
  const maxSourceWindowBytes = options.maxSourceWindowBytes ?? options.maxCanonicalInputBytes;
  if (
    !Number.isSafeInteger(options.maxCanonicalInputBytes) ||
    options.maxCanonicalInputBytes <= 0 ||
    !Number.isSafeInteger(maxSourceWindowBytes) ||
    maxSourceWindowBytes <= 0 ||
    !Number.isSafeInteger(options.maxDecodedProductBytes) ||
    options.maxDecodedProductBytes <= 0 ||
    !optionalPositiveSafeInteger(options.maxSessionSpillBytes) ||
    !optionalPositiveSafeInteger(options.maxTrianglesPerProduct) ||
    !optionalPositiveSafeInteger(options.maxVerticesPerProduct) ||
    !optionalPositiveSafeInteger(options.maxDomainsPerProduct) ||
    !optionalPositiveSafeInteger(options.catalogPriorityWindowMs)
  ) {
    throw new RangeError("Web Cook Worker WASM budgets must be positive safe integers");
  }
  const worker = options.createWorker
    ? options.createWorker(new URL("./WebCookWorkerEntrypoint.ts", import.meta.url))
    : new Worker(new URL("./WebCookWorkerEntrypoint.ts", import.meta.url), { type: "module" });
  worker.postMessage(
    {
      type: "InitializeWebCookWorker",
      wasmModuleUrl: wasmModuleUrl.href,
      ...(wasmBinaryUrl === undefined ? {} : { wasmBinaryUrl: wasmBinaryUrl.href }),
      maxCanonicalInputBytes: options.maxCanonicalInputBytes,
      maxSourceWindowBytes,
      maxDecodedProductBytes: options.maxDecodedProductBytes,
      ...(options.maxSessionSpillBytes === undefined
        ? {}
        : { maxSessionSpillBytes: options.maxSessionSpillBytes }),
      ...(options.maxTrianglesPerProduct === undefined
        ? {}
        : { maxTrianglesPerProduct: options.maxTrianglesPerProduct }),
      ...(options.maxVerticesPerProduct === undefined
        ? {}
        : { maxVerticesPerProduct: options.maxVerticesPerProduct }),
      ...(options.maxDomainsPerProduct === undefined
        ? {}
        : { maxDomainsPerProduct: options.maxDomainsPerProduct }),
      ...(options.catalogPriorityWindowMs === undefined
        ? {}
        : { catalogPriorityWindowMs: options.catalogPriorityWindowMs }),
    },
    [],
  );
  return worker;
}

function optionalPositiveSafeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

/** Starts a bounded pool of independent Dedicated Workers for portable-pool. */
export function createWebCookWorkerPool(options: WebCookWorkerFactoryOptions): WebCookWorkerPort {
  const maxWorkers = options.maxWorkers ?? 2;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0)
    throw new RangeError("Web Cook Worker pool maxWorkers must be positive");
  return new WebCookWorkerPool({
    maxWorkers,
    createWorker: () => createWebCookWorker({ ...options, maxWorkers: undefined }),
  });
}

/** Starts a Worker using the repository's real Emscripten cooker artifact. */
export function createDefaultWebCookWorker(options: DefaultWebCookWorkerFactoryOptions): WebCookWorkerPort {
  const capability = resolveWebCookRuntimeProfile(options.runtimeProfile ?? "portable-single");
  // Branch on the resolved profile, not the requested string: `auto` may have
  // selected `portable-pool`, which must then actually start a pool.
  const selected = capability.selected;
  const useThreads = selected === "isolated-pthreads";
  const factoryOptions = {
    ...options,
    wasmModuleUrl: useThreads
      ? DEFAULT_WEB_GEOMETRY_COOKER_THREADS_MODULE_URL
      : DEFAULT_WEB_GEOMETRY_COOKER_MODULE_URL,
    wasmBinaryUrl: useThreads
      ? DEFAULT_WEB_GEOMETRY_COOKER_THREADS_WASM_URL
      : DEFAULT_WEB_GEOMETRY_COOKER_WASM_URL,
  };
  if (selected === "portable-pool") return createWebCookWorkerPool(factoryOptions);
  return createWebCookWorker(factoryOptions);
}

function defaultWebGeometryCookerModuleUrl(): URL {
  // Vite serves this source-relative URL in dev and rewrites it to the
  // emitted hashed asset in a package build.
  return new URL("./wasm/vendor/oengine-web-geometry-cooker.mjs", import.meta.url);
}
