import { WEB_COOK_PROTOCOL_VERSION, type WebCookCommand, type WebCookEvent } from "./protocol/CookSessionProtocol.js";

export interface WebCookWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  terminate?(): void;
}

export interface WebCookWorkerTransportEvidence {
  readonly sentCommands: number;
  readonly receivedEvents: number;
  readonly queuedEvents: number;
  readonly droppedLateEvents: number;
  readonly failures: number;
  readonly closed: boolean;
}

/** Generation-filtered, bounded Dedicated Worker message transport. */
export class WebCookWorkerTransport implements AsyncIterable<WebCookEvent> {
  readonly #queue: WebCookEvent[] = [];
  readonly #waiters: Deferred<IteratorResult<WebCookEvent>>[] = [];
  readonly #messageListener = (event: MessageEvent<unknown>): void => { this.#accept(event.data); };
  readonly #errorListener = (): void => { this.#fail(new Error("Web Cook Worker failed")); };
  #iteratorTaken = false;
  #closed = false;
  #failure: unknown;
  #sentCommands = 0;
  #receivedEvents = 0;
  #droppedLateEvents = 0;
  #failures = 0;

  constructor(readonly worker: WebCookWorkerPort, readonly sessionId: string, readonly sessionGeneration: number, readonly maxQueuedEvents: number) {
    if (!sessionId || !Number.isInteger(sessionGeneration) || sessionGeneration <= 0 || sessionGeneration === 0xffffffff || !Number.isInteger(maxQueuedEvents) || maxQueuedEvents <= 0) throw new RangeError("invalid Web Cook Worker transport configuration");
    worker.addEventListener("message", this.#messageListener);
    worker.addEventListener("error", this.#errorListener);
    worker.addEventListener("messageerror", this.#errorListener);
  }

  send(command: WebCookCommand, transfer: Transferable[] = []): void {
    if (this.#closed) throw new Error("Web Cook Worker transport is closed");
    if (command.protocolVersion !== WEB_COOK_PROTOCOL_VERSION || command.sessionId !== this.sessionId || command.sessionGeneration !== this.sessionGeneration) throw new Error("Web Cook command targets the wrong session generation");
    this.worker.postMessage(command, transfer);
    this.#sentCommands++;
  }

  [Symbol.asyncIterator](): AsyncIterator<WebCookEvent> {
    if (this.#iteratorTaken) throw new Error("Web Cook Worker events can only be consumed once");
    this.#iteratorTaken = true;
    return { next: () => this.#next() };
  }

  close(terminate = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    if (terminate) this.worker.terminate?.();
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  evidence(): WebCookWorkerTransportEvidence { return Object.freeze({ sentCommands: this.#sentCommands, receivedEvents: this.#receivedEvents, queuedEvents: this.#queue.length, droppedLateEvents: this.#droppedLateEvents, failures: this.#failures, closed: this.#closed }); }

  async #next(): Promise<IteratorResult<WebCookEvent>> {
    const event = this.#queue.shift();
    if (event) return { done: false, value: event };
    if (this.#failure) throw this.#failure;
    if (this.#closed) return { done: true, value: undefined };
    const waiter = new Deferred<IteratorResult<WebCookEvent>>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  #accept(value: unknown): void {
    let event: WebCookEvent;
    try { event = assertWebCookEvent(value); } catch (error) { this.#fail(error); return; }
    if (event.sessionId !== this.sessionId || event.sessionGeneration !== this.sessionGeneration) { this.#droppedLateEvents++; return; }
    if (this.#closed) { this.#droppedLateEvents++; return; }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else {
      if (this.#queue.length >= this.maxQueuedEvents) { this.#fail(new Error("Web Cook Worker event queue capacity exceeded")); return; }
      this.#queue.push(event);
    }
    this.#receivedEvents++;
  }

  #fail(error: unknown): void {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    this.#failures++;
    this.#detach();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  #detach(): void {
    this.worker.removeEventListener("message", this.#messageListener);
    this.worker.removeEventListener("error", this.#errorListener);
    this.worker.removeEventListener("messageerror", this.#errorListener);
  }
}

function assertWebCookEvent(value: unknown): WebCookEvent {
  if (!value || typeof value !== "object") throw new TypeError("Web Cook Worker emitted a non-object message");
  const event = value as Partial<WebCookEvent>;
  if (event.protocolVersion !== WEB_COOK_PROTOCOL_VERSION || typeof event.sessionId !== "string" || !Number.isInteger(event.sessionGeneration)) throw new Error("Web Cook Worker emitted an incompatible message header");
  if (!["SceneCatalogReady", "RevisionOffered", "PageReady", "Progress", "RecoverableFailure", "FatalSessionFailure"].includes(String(event.type))) throw new Error(`Web Cook Worker emitted unknown event '${String(event.type)}'`);
  return event as WebCookEvent;
}

class Deferred<T> { readonly promise: Promise<T>; resolve!: (value: T) => void; reject!: (reason: unknown) => void; constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); } }
