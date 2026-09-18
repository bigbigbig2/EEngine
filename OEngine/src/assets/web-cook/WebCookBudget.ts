export interface WebCookGlobalBudgetLimits {
  /** Maximum concurrently admitted CookSessions across the whole page. */
  readonly maxActiveSessions: number;
  /** Maximum live decoded output bytes across all sessions. */
  readonly maxOutputBytes: number;
  /** Maximum live source bytes across all sessions. */
  readonly maxSourceBytes: number;
  /** Maximum live WASM bytes across all sessions. */
  readonly maxWasmBytes: number;
}

export type WebCookBudgetKind = "output" | "source" | "wasm";

export interface WebCookBudgetLease {
  readonly id: number;
  readonly sessionId: string;
  release(): void;
}

export interface WebCookBudgetEvidence {
  readonly activeSessions: number;
  readonly waitingSessions: number;
  readonly outputBytes: number;
  readonly sourceBytes: number;
  readonly wasmBytes: number;
  readonly peakOutputBytes: number;
  readonly peakSourceBytes: number;
  readonly peakWasmBytes: number;
  readonly admissions: number;
  readonly backpressureEvents: number;
  readonly rejectedReservations: number;
  readonly cancelledWaiters: number;
}

interface Waiter {
  readonly sessionId: string;
  readonly priority: number;
  readonly sequence: number;
  readonly resolve: (lease: WebCookBudgetLease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface LeaseRecord {
  readonly id: number;
  readonly sessionId: string;
  readonly bytes: Record<WebCookBudgetKind, number>;
}

const KINDS: readonly WebCookBudgetKind[] = ["output", "source", "wasm"];

/**
 * Page-global Web Cook budget ledger.
 *
 * It owns the repository-wide caps that individual CookSessions cannot enforce
 * on their own: concurrent sessions, live source bytes, live WASM bytes and
 * outstanding decoded output. Waiting admission is FIFO by priority and then by
 * arrival age, and every counter has a high-water mark so a saturated budget is
 * observable rather than silent.
 */
export class WebCookBudgetLedger {
  readonly #limits: WebCookGlobalBudgetLimits;
  readonly #active = new Map<number, LeaseRecord>();
  readonly #waiters: Waiter[] = [];
  readonly #bytes: Record<WebCookBudgetKind, number> = { output: 0, source: 0, wasm: 0 };
  readonly #peak: Record<WebCookBudgetKind, number> = { output: 0, source: 0, wasm: 0 };
  #nextId = 1;
  #sequence = 0;
  #admissions = 0;
  #backpressureEvents = 0;
  #rejectedReservations = 0;
  #cancelledWaiters = 0;

  constructor(limits: WebCookGlobalBudgetLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Web Cook global budget ${name} must be a positive safe integer`);
    }
    this.#limits = Object.freeze({ ...limits });
  }

  get limits(): WebCookGlobalBudgetLimits { return this.#limits; }

  /** Admits a session immediately or waits for a bounded, aged slot. */
  acquireSession(sessionId: string, priority = 0, signal?: AbortSignal): Promise<WebCookBudgetLease> {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("Web Cook session id must be a non-empty string");
    if (!Number.isFinite(priority)) throw new RangeError("Web Cook session priority must be finite");
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Web Cook budget acquisition was aborted"));
    if (this.#active.size < this.#limits.maxActiveSessions) return Promise.resolve(this.#grant(sessionId));
    this.#backpressureEvents++;
    return new Promise<WebCookBudgetLease>((resolve, reject) => {
      const waiter: Waiter = { sessionId, priority, sequence: this.#sequence++, resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          this.#cancelledWaiters++;
          reject(signal.reason ?? new Error("Web Cook budget acquisition was aborted"));
        };
        Object.assign(waiter, { onAbort });
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  /** Reserves live bytes for one session; returns false when the global cap is hit. */
  reserve(lease: WebCookBudgetLease, kind: WebCookBudgetKind, bytes: number): boolean {
    const record = this.#requireLease(lease);
    assertKind(kind);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Web Cook reservation bytes must be a non-negative safe integer");
    if (this.#bytes[kind] + bytes > this.#limits[limitFor(kind)]) {
      this.#rejectedReservations++;
      return false;
    }
    this.#bytes[kind] += bytes;
    record.bytes[kind] += bytes;
    this.#peak[kind] = Math.max(this.#peak[kind], this.#bytes[kind]);
    return true;
  }

  /** Returns live bytes; never goes negative. */
  release(lease: WebCookBudgetLease, kind: WebCookBudgetKind, bytes: number): void {
    const record = this.#requireLease(lease);
    assertKind(kind);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Web Cook release bytes must be a non-negative safe integer");
    const applied = Math.min(bytes, record.bytes[kind]);
    record.bytes[kind] -= applied;
    this.#bytes[kind] -= applied;
  }

  evidence(): WebCookBudgetEvidence {
    return Object.freeze({
      activeSessions: this.#active.size,
      waitingSessions: this.#waiters.length,
      outputBytes: this.#bytes.output,
      sourceBytes: this.#bytes.source,
      wasmBytes: this.#bytes.wasm,
      peakOutputBytes: this.#peak.output,
      peakSourceBytes: this.#peak.source,
      peakWasmBytes: this.#peak.wasm,
      admissions: this.#admissions,
      backpressureEvents: this.#backpressureEvents,
      rejectedReservations: this.#rejectedReservations,
      cancelledWaiters: this.#cancelledWaiters
    });
  }

  #grant(sessionId: string): WebCookBudgetLease {
    const id = this.#nextId++;
    const record: LeaseRecord = { id, sessionId, bytes: { output: 0, source: 0, wasm: 0 } };
    this.#active.set(id, record);
    this.#admissions++;
    let released = false;
    return Object.freeze({
      id,
      sessionId,
      release: (): void => {
        if (released) return;
        released = true;
        this.#releaseRecord(record);
      }
    });
  }

  #releaseRecord(record: LeaseRecord): void {
    if (!this.#active.delete(record.id)) return;
    for (const kind of KINDS) this.#bytes[kind] -= record.bytes[kind];
    const next = this.#takeWaiter();
    if (next === undefined) return;
    next.resolve(this.#grant(next.sessionId));
  }

  #takeWaiter(): Waiter | undefined {
    if (this.#waiters.length === 0) return undefined;
    let best = 0;
    for (let index = 1; index < this.#waiters.length; index++) {
      const candidate = this.#waiters[index]!;
      const current = this.#waiters[best]!;
      // Higher priority first, then older arrival; stable for equal keys.
      if (candidate.priority > current.priority || (candidate.priority === current.priority && candidate.sequence < current.sequence)) best = index;
    }
    const [waiter] = this.#waiters.splice(best, 1);
    if (waiter?.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
    return waiter;
  }

  #requireLease(lease: WebCookBudgetLease): LeaseRecord {
    const record = this.#active.get(lease.id);
    if (record === undefined || record.sessionId !== lease.sessionId) throw new Error("Web Cook budget lease is not active");
    return record;
  }
}

function limitFor(kind: WebCookBudgetKind): keyof WebCookGlobalBudgetLimits {
  return kind === "output" ? "maxOutputBytes" : kind === "source" ? "maxSourceBytes" : "maxWasmBytes";
}

function assertKind(kind: WebCookBudgetKind): void {
  if (kind !== "output" && kind !== "source" && kind !== "wasm") throw new RangeError(`unknown Web Cook budget kind '${String(kind)}'`);
}
