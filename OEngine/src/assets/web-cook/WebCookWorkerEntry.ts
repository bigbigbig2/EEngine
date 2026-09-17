import { NyxWebRuntimeCooker } from "./NyxWebRuntimeCooker.js";
import { WebCookWorkerHost, type WebCookWorkerHostPort } from "./WebCookWorkerHost.js";
import type { GlbRangeSourceOptions } from "../../loaders/gltf/streaming/GlbRangeSource.js";
import type { GeometryCookRecipeV3 } from "../GeometryCookRecipe.js";
import type { EmscriptenWebGeometryCookerModuleV1 } from "./wasm/WebGeometryCookerAbi.js";

export interface WebCookWorkerModuleFactory {
  (): EmscriptenWebGeometryCookerModuleV1 | Promise<EmscriptenWebGeometryCookerModuleV1>;
}

export interface WebCookWorkerEntryOptions {
  readonly port: WebCookWorkerHostPort;
  readonly moduleFactory: WebCookWorkerModuleFactory;
  readonly source?: GlbRangeSourceOptions;
  readonly recipe?: Partial<GeometryCookRecipeV3>;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
}

/**
 * Boots the browser WASM producer inside a Dedicated Worker. Commands arriving
 * while the Emscripten module initializes are retained in a bounded queue.
 */
export async function installWebCookWorkerEntry(options: WebCookWorkerEntryOptions): Promise<WebCookWorkerHost> {
  const pending: unknown[] = [];
  let host: WebCookWorkerHost | undefined;
  let closed = false;
  const listener = (event: MessageEvent<unknown>): void => {
    if (closed) return;
    if (host) { void host.receive(event.data); return; }
    if (pending.length >= 16) {
      closed = true;
      postFailure(options.port, event.data, "worker-bootstrap-command-queue-exhausted");
      return;
    }
    pending.push(event.data);
  };
  options.port.addEventListener("message", listener);
  try {
    const module = await options.moduleFactory();
    if (closed) throw new Error("Web Cook Worker entry was closed during module initialization");
    const cooker = new NyxWebRuntimeCooker(module, {
      recipe: options.recipe,
      maxCanonicalInputBytes: options.maxCanonicalInputBytes,
      maxDecodedProductBytes: options.maxDecodedProductBytes
    });
    host = new WebCookWorkerHost({ port: options.port, cooker, source: options.source });
    options.port.removeEventListener("message", listener);
    for (const value of pending.splice(0)) await host.receive(value);
    return host;
  } catch (error) {
    closed = true;
    options.port.removeEventListener("message", listener);
    postFailure(options.port, pending[0], error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function postFailure(port: WebCookWorkerHostPort, value: unknown, code: string): void {
  if (!value || typeof value !== "object") return;
  const header = value as { protocolVersion?: unknown; sessionId?: unknown; sessionGeneration?: unknown };
  if (header.protocolVersion !== 1 || typeof header.sessionId !== "string" || !Number.isInteger(header.sessionGeneration)) return;
  port.postMessage({ protocolVersion: 1, sessionId: header.sessionId, sessionGeneration: header.sessionGeneration, type: "FatalSessionFailure", code });
}
