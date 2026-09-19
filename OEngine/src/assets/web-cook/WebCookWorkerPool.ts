import { WEB_COOK_PROTOCOL_VERSION, type WebCookCommand, type WebCookEvent } from "./protocol/CookSessionProtocol.js";
import type { WebCookWorkerPort } from "./WebCookWorkerTransport.js";

export interface WebCookWorkerPoolOptions {
  readonly maxWorkers: number;
  readonly createWorker: () => WebCookWorkerPort;
}

interface WorkerSlot {
  readonly port: WebCookWorkerPort;
  readonly index: number;
  readonly sessions: Set<string>;
  failed: boolean;
}

type MessageListener = (event: MessageEvent<unknown>) => void;
type ErrorListener = (event: Event) => void;

/**
 * Multiplexes independent CookSessions over a bounded set of Dedicated
 * Workers. A session is pinned to one worker for its whole generation; a
 * crashed worker invalidates only the sessions it owned and late commands are
 * rejected instead of being replayed on another generation.
 */
export class WebCookWorkerPool implements WebCookWorkerPort {
  readonly #options: WebCookWorkerPoolOptions;
  readonly #workers: WorkerSlot[] = [];
  readonly #sessionWorkers = new Map<string, WorkerSlot>();
  readonly #invalidSessions = new Set<string>();
  readonly #messageListeners = new Set<MessageListener>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #messageErrorListeners = new Set<ErrorListener>();
  #roundRobin = 0;
  #closed = false;

  constructor(options: WebCookWorkerPoolOptions) {
    if (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers <= 0) throw new RangeError("Web Cook Worker pool maxWorkers must be positive");
    this.#options = options;
    for (let index = 0; index < options.maxWorkers; index++) this.#addWorker(options.createWorker(), index);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.#closed) throw new Error("Web Cook Worker pool is closed");
    const command = message as Partial<WebCookCommand> | null | undefined;
    const sessionKey = command && typeof command.sessionId === "string" && Number.isInteger(command.sessionGeneration)
      ? `${command.sessionId}:${command.sessionGeneration}`
      : undefined;
    if (sessionKey === undefined) throw new Error("Web Cook Worker pool requires a session command header");
    let slot = this.#sessionWorkers.get(sessionKey);
    if (command?.type === "CreateSession") {
      if (command.protocolVersion !== WEB_COOK_PROTOCOL_VERSION) throw new Error("Web Cook Worker pool received an incompatible command");
      if (this.#invalidSessions.has(sessionKey)) throw new Error("Web Cook session generation was invalidated by a Worker failure");
      if (slot !== undefined) throw new Error("Web Cook session is already assigned to a Worker");
      slot = this.#chooseWorker();
      this.#sessionWorkers.set(sessionKey, slot);
      slot.sessions.add(sessionKey);
    }
    if (slot === undefined || slot.failed) {
      if (this.#invalidSessions.has(sessionKey)) throw new Error("Web Cook session generation was invalidated by a Worker failure");
      throw new Error("Web Cook session is not assigned to a live Worker");
    }
    slot.port.postMessage(message, transfer);
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error" | "messageerror", listener: ErrorListener): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: MessageListener | ErrorListener): void {
    if (type === "message") this.#messageListeners.add(listener as MessageListener);
    else if (type === "error") this.#errorListeners.add(listener as ErrorListener);
    else this.#messageErrorListeners.add(listener as ErrorListener);
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "error" | "messageerror", listener: ErrorListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: MessageListener | ErrorListener): void {
    if (type === "message") this.#messageListeners.delete(listener as MessageListener);
    else if (type === "error") this.#errorListeners.delete(listener as ErrorListener);
    else this.#messageErrorListeners.delete(listener as ErrorListener);
  }

  terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const slot of this.#workers) slot.port.terminate?.();
    this.#sessionWorkers.clear();
    this.#invalidSessions.clear();
    for (const slot of this.#workers) slot.sessions.clear();
  }

  evidence(): Readonly<{ readonly workerCount: number; readonly liveWorkers: number; readonly assignedSessions: number; readonly invalidatedSessions: number; readonly closed: boolean }> {
    return Object.freeze({
      workerCount: this.#workers.length,
      liveWorkers: this.#workers.filter(slot => !slot.failed).length,
      assignedSessions: this.#sessionWorkers.size,
      invalidatedSessions: this.#invalidSessions.size,
      closed: this.#closed
    });
  }

  #addWorker(port: WebCookWorkerPort, index: number): WorkerSlot {
    const slot: WorkerSlot = { port, index, sessions: new Set(), failed: false };
    this.#workers.push(slot);
    port.addEventListener("message", event => this.#forwardMessage(event));
    port.addEventListener("error", event => this.#failWorker(slot, event, false));
    port.addEventListener("messageerror", event => this.#failWorker(slot, event, true));
    return slot;
  }

  #chooseWorker(): WorkerSlot {
    const live = this.#workers.filter(slot => !slot.failed);
    if (live.length === 0) throw new Error("Web Cook Worker pool has no live Worker");
    const slot = live[this.#roundRobin % live.length]!;
    this.#roundRobin++;
    return slot;
  }

  #forwardMessage(event: MessageEvent<unknown>): void {
    if (this.#closed) return;
    for (const listener of this.#messageListeners) listener(event);
  }

  #failWorker(slot: WorkerSlot, event: Event, messageError: boolean): void {
    if (slot.failed || this.#closed) return;
    slot.failed = true;
    const code = messageError ? "worker-messageerror" : "worker-error";
    for (const sessionKey of [...slot.sessions]) {
      const separator = sessionKey.lastIndexOf(":");
      const sessionId = sessionKey.slice(0, separator);
      const sessionGeneration = Number(sessionKey.slice(separator + 1));
      this.#sessionWorkers.delete(sessionKey);
      this.#invalidSessions.add(sessionKey);
      this.#forwardMessage({ data: { protocolVersion: WEB_COOK_PROTOCOL_VERSION, sessionId, sessionGeneration, type: "FatalSessionFailure", code } } as MessageEvent<unknown>);
    }
    slot.sessions.clear();
    slot.port.terminate?.();
    // Keep the configured pool width after a crash. The failed generation is
    // never replayed; a new session may be assigned to this replacement.
    if (!this.#closed) {
      try {
        const replacement = this.#addWorker(this.#options.createWorker(), slot.index);
        const slotIndex = this.#workers.indexOf(slot);
        if (slotIndex >= 0) {
          this.#workers[slotIndex] = replacement;
          this.#workers.pop();
        }
      } catch {
        // A factory failure leaves this slot unavailable and is reflected by
        // liveWorkers; callers receive an explicit no-live-worker error.
      }
    }
    // Do not broadcast the raw Worker error: WebCookWorkerTransport would
    // fail every session sharing this pool. Each owned generation already
    // received its own FatalSessionFailure above.
  }
}
