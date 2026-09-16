export const WEB_COOK_PROTOCOL_VERSION = 1;
export const WEB_COOK_PAGE_BYTES = 262144;

export type WebCookRuntimeProfile = "portable-single" | "portable-pool" | "isolated-pthreads";

export interface WebCookSessionHeader {
  readonly protocolVersion: typeof WEB_COOK_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface WebCookBudgets {
  readonly maxConcurrentWorkers: number;
  readonly maxSourceBytes: number;
  readonly maxWasmBytes: number;
  readonly maxOutputBytes: number;
  readonly maxQueuedEvents: number;
}

export type WebCookCommand =
  | (WebCookSessionHeader & { readonly type: "CreateSession"; readonly runtimeProfile: WebCookRuntimeProfile; readonly recipe: Readonly<Record<string, unknown>>; readonly budgets: WebCookBudgets })
  | (WebCookSessionHeader & { readonly type: "OpenSource"; readonly source: Readonly<Record<string, unknown>> })
  | (WebCookSessionHeader & { readonly type: "SetSourcePriority"; readonly assetKey: string; readonly score: number; readonly cameraHintRevision: number })
  | (WebCookSessionHeader & { readonly type: "RequestPages"; readonly productId: Uint8Array; readonly revision: number; readonly pageIds: Uint32Array; readonly priority: number })
  | (WebCookSessionHeader & { readonly type: "GrantOutputCredits"; readonly blockCount: number; readonly bytes: number })
  | (WebCookSessionHeader & { readonly type: "CancelScope"; readonly scope: string })
  | (WebCookSessionHeader & { readonly type: "DisposeSession" });

export type WebCookEvent =
  | (WebCookSessionHeader & { readonly type: "SceneCatalogReady"; readonly catalog: Readonly<Record<string, unknown>> })
  | (WebCookSessionHeader & { readonly type: "RevisionOffered"; readonly descriptor: ArrayBuffer })
  | (WebCookSessionHeader & { readonly type: "PageReady"; readonly productId: Uint8Array; readonly revision: number; readonly pageId: number; readonly decodedHash128: Uint8Array; readonly bytes: ArrayBuffer })
  | (WebCookSessionHeader & { readonly type: "Progress"; readonly stage: string; readonly units: number; readonly bytes: number; readonly timings: Readonly<Record<string, number>> })
  | (WebCookSessionHeader & { readonly type: "RecoverableFailure"; readonly scope: string; readonly code: string; readonly retryAfterMs?: number })
  | (WebCookSessionHeader & { readonly type: "FatalSessionFailure"; readonly code: string; readonly diagnostics?: Readonly<Record<string, unknown>> });

export interface WebCookSessionEvidence {
  readonly sessionGeneration: number;
  readonly state: "created" | "open" | "cancelled" | "failed" | "disposed";
  readonly queuedEvents: number;
  readonly outputCreditsBlocks: number;
  readonly outputCreditsBytes: number;
  readonly peakOutputBytes: number;
  readonly droppedLateMessages: number;
}

export class WebCookSessionProtocol {
  #state: WebCookSessionEvidence["state"] = "created";
  #sourceOpened = false;
  #budgets: WebCookBudgets | undefined;
  #events: WebCookEvent[] = [];
  #creditsBlocks = 0;
  #creditsBytes = 0;
  #peakOutputBytes = 0;
  #droppedLateMessages = 0;
  constructor(readonly sessionId: string, readonly sessionGeneration: number) {
    if (!sessionId || !Number.isInteger(sessionGeneration) || sessionGeneration <= 0 || sessionGeneration === 0xffffffff) throw new RangeError("invalid CookSession identity");
  }

  accept(command: WebCookCommand): void {
    this.validateHeader(command);
    if (command.type === "CreateSession") { this.requireState("created"); this.#budgets = validateBudgets(command.budgets); this.#state = "open"; return; }
    if (command.type === "OpenSource") { this.requireState("open"); this.#sourceOpened = true; return; }
    if (command.type === "GrantOutputCredits") { this.requireState("open"); if (!Number.isInteger(command.blockCount) || command.blockCount < 0 || !Number.isInteger(command.bytes) || command.bytes < 0) throw new RangeError("output credits must be non-negative integers"); this.#creditsBlocks += command.blockCount; this.#creditsBytes += command.bytes; return; }
    if (command.type === "CancelScope") { if (this.#state === "open") this.#state = "cancelled"; return; }
    if (command.type === "DisposeSession") { this.#state = "disposed"; this.#events.length = 0; return; }
    this.requireState("open"); if (!this.#sourceOpened) throw new Error("CookSession source must be opened before work commands");
    if (command.type === "RequestPages") { if (command.productId.byteLength !== 32 || !Number.isInteger(command.revision) || command.revision < 0 || command.pageIds.some(page => page === 0xffffffff)) throw new RangeError("RequestPages contains an invalid Product key"); }
    if (command.type === "SetSourcePriority" && (!Number.isFinite(command.score) || !Number.isInteger(command.cameraHintRevision) || command.cameraHintRevision < 0)) throw new RangeError("invalid source priority");
  }

  emit(event: WebCookEvent): boolean {
    this.validateHeader(event);
    if (this.#state !== "open") { this.#droppedLateMessages++; return false; }
    const max = this.#budgets?.maxQueuedEvents ?? 0;
    if (this.#events.length >= max) throw new RangeError("CookSession event queue capacity exceeded");
    if (event.type === "RevisionOffered") decodeGeometryProductDescriptorBinaryV1(event.descriptor);
    if (event.type === "PageReady") { if (event.bytes.byteLength !== WEB_COOK_PAGE_BYTES || event.decodedHash128.byteLength !== 16 || this.#creditsBlocks < 1 || this.#creditsBytes < event.bytes.byteLength) return false; this.#creditsBlocks--; this.#creditsBytes -= event.bytes.byteLength; }
    this.#events.push(event); this.#peakOutputBytes = Math.max(this.#peakOutputBytes, maxOutputBytes(this.#events)); return true;
  }

  drain(maxEvents = Number.MAX_SAFE_INTEGER): WebCookEvent[] { if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) throw new RangeError("maxEvents must be non-negative"); return this.#events.splice(0, maxEvents); }
  returnOutputCredits(blockCount: number, bytes: number): void { if (!Number.isInteger(blockCount) || blockCount < 0 || !Number.isInteger(bytes) || bytes < 0) throw new RangeError("returned output credits must be non-negative integers"); this.#creditsBlocks += blockCount; this.#creditsBytes += bytes; }
  fail(code: string, diagnostics?: Readonly<Record<string, unknown>>): void { if (this.#state === "disposed") return; this.#state = "failed"; this.#events.length = 0; }
  evidence(): WebCookSessionEvidence { return Object.freeze({ sessionGeneration: this.sessionGeneration, state: this.#state, queuedEvents: this.#events.length, outputCreditsBlocks: this.#creditsBlocks, outputCreditsBytes: this.#creditsBytes, peakOutputBytes: this.#peakOutputBytes, droppedLateMessages: this.#droppedLateMessages }); }
  private validateHeader(message: WebCookSessionHeader): void { if (message.protocolVersion !== WEB_COOK_PROTOCOL_VERSION || message.sessionId !== this.sessionId || message.sessionGeneration !== this.sessionGeneration) { this.#droppedLateMessages++; throw new Error("stale or incompatible CookSession message"); } }
  private requireState(state: WebCookSessionEvidence["state"]): void { if (this.#state !== state) throw new Error(`CookSession expected state '${state}', got '${this.#state}'`); }
}

function validateBudgets(budgets: WebCookBudgets): WebCookBudgets { for (const [name, value] of Object.entries(budgets)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`); return Object.freeze({ ...budgets }); }
function maxOutputBytes(events: readonly WebCookEvent[]): number { return events.reduce((sum, event) => sum + (event.type === "PageReady" ? event.bytes.byteLength : 0), 0); }
import { decodeGeometryProductDescriptorBinaryV1 } from "../../geometry-product/GeometryProductBinaryV1.js";
