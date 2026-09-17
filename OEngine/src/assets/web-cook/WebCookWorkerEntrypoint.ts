import { installWebCookWorkerEntry } from "./WebCookWorkerEntry.js";
import type { WebCookWorkerHostPort } from "./WebCookWorkerHost.js";
import type { EmscriptenWebGeometryCookerModuleV1 } from "./wasm/WebGeometryCookerAbi.js";

const BOOTSTRAP_TYPE = "InitializeWebCookWorker";
const MAX_PENDING_MESSAGES = 16;

interface BootstrapMessage {
  readonly type: typeof BOOTSTRAP_TYPE;
  readonly wasmModuleUrl: string;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
}

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const pending: unknown[] = [];
let downstream: ((event: MessageEvent<unknown>) => void) | undefined;
let initialized = false;
let initializing = false;
let closed = false;

const port: WebCookWorkerHostPort = {
  postMessage: (message, transfer) => scope.postMessage(message, transfer),
  addEventListener: (_type, listener) => { downstream = listener; },
  removeEventListener: (_type, listener) => { if (downstream === listener) downstream = undefined; }
};

scope.addEventListener("message", event => {
  if (closed) return;
  if (!initialized) {
    if (isBootstrapMessage(event.data)) {
      if (initializing) {
        postBootstrapFailure(event.data, "duplicate-worker-bootstrap");
        return;
      }
      initializing = true;
      void initialize(event.data);
      return;
    }
    if (pending.length >= MAX_PENDING_MESSAGES) {
      closed = true;
      postBootstrapFailure(event.data, "worker-bootstrap-command-queue-exhausted");
      return;
    }
    pending.push(event.data);
    return;
  }
  downstream?.(event);
});

async function initialize(message: BootstrapMessage): Promise<void> {
  try {
    const moduleUrl = new URL(message.wasmModuleUrl, globalThis.location?.href).href;
    const imported = await import(/* @vite-ignore */ moduleUrl) as unknown as Record<string, unknown>;
    const factory = imported.default;
    if (typeof factory !== "function") throw new Error("Emscripten Web geometry module has no default factory export");
    const module = await (factory as (options?: Readonly<Record<string, unknown>>) => EmscriptenWebGeometryCookerModuleV1)({
      locateFile: (file: string) => new URL(file, moduleUrl).href
    });
    await installWebCookWorkerEntry({
      port,
      moduleFactory: () => module,
      maxCanonicalInputBytes: message.maxCanonicalInputBytes,
      maxDecodedProductBytes: message.maxDecodedProductBytes
    });
    initialized = true;
    for (const value of pending.splice(0)) downstream?.({ data: value } as MessageEvent<unknown>);
  } catch (error) {
    closed = true;
    const code = error instanceof Error ? error.message : String(error);
    for (const value of pending.splice(0)) if (isProtocolHeader(value)) postBootstrapFailure(value, code);
  }
}

function isBootstrapMessage(value: unknown): value is BootstrapMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<BootstrapMessage>;
  const maxCanonicalInputBytes = message.maxCanonicalInputBytes;
  const maxDecodedProductBytes = message.maxDecodedProductBytes;
  return message.type === BOOTSTRAP_TYPE && typeof message.wasmModuleUrl === "string" &&
    typeof maxCanonicalInputBytes === "number" && Number.isSafeInteger(maxCanonicalInputBytes) && maxCanonicalInputBytes > 0 &&
    typeof maxDecodedProductBytes === "number" && Number.isSafeInteger(maxDecodedProductBytes) && maxDecodedProductBytes > 0;
}

function isProtocolHeader(value: unknown): value is { readonly protocolVersion: number; readonly sessionId: string; readonly sessionGeneration: number } {
  if (!value || typeof value !== "object") return false;
  const header = value as Partial<{ protocolVersion: number; sessionId: string; sessionGeneration: number }>;
  return header.protocolVersion === 1 && typeof header.sessionId === "string" && Number.isInteger(header.sessionGeneration);
}

function postBootstrapFailure(value: unknown, code: string): void {
  if (!isProtocolHeader(value)) return;
  scope.postMessage({ ...value, type: "FatalSessionFailure", code });
}
