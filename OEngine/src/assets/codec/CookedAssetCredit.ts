interface Charge {
  readonly total: number;
  readonly encoded: number;
  readonly ready: number;
}

interface Waiter {
  readonly charge: Charge;
  readonly priority: number;
  readonly enqueuedAt: number;
  readonly signal: AbortSignal;
  readonly resolve: (release: (remaining?: Charge) => void) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
}

/** Shared input, scratch and returned-page admission. Ready ownership stays
 * charged until the renderer stages or discards the page. Replay textures are
 * immutable caller-owned storage after their complete import. */
export class CookedAssetCredit {
  readonly #used = { total: 0, encoded: 0, ready: 0 };
  readonly #peak = { total: 0, encoded: 0, ready: 0 };
  readonly #waiters: Waiter[] = [];

  constructor(readonly limits: Charge) {}

  acquire(charge: Charge, priority: number, signal: AbortSignal): Promise<(remaining?: Charge) => void> {
    for (const key of ["total", "encoded", "ready"] as const) {
      if (!Number.isSafeInteger(charge[key]) || charge[key] < 0 || charge[key] > this.limits[key]) {
        return Promise.reject(new RangeError(`Cooked ${key} task exceeds its credit capacity`));
      }
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        charge,
        priority,
        signal,
        resolve,
        reject,
        enqueuedAt: performance.now(),
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
            reject(signal.reason);
            this.#pump();
          }
        }
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  evidence() {
    return { used: { ...this.#used }, peak: { ...this.#peak }, waiting: this.#waiters.length };
  }

  #pump(): void {
    const now = performance.now();
    this.#waiters.sort(
      (a, b) =>
        (now - a.enqueuedAt > 100 ? -1 : a.priority) - (now - b.enqueuedAt > 100 ? -1 : b.priority) ||
        a.enqueuedAt - b.enqueuedAt
    );
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0]!;
      // Reserve an aged large task's opportunity rather than starving it with
      // an endless stream of smaller jobs.
      if (
        this.#used.total + waiter.charge.total > this.limits.total ||
        this.#used.encoded + waiter.charge.encoded > this.limits.encoded ||
        this.#used.ready + waiter.charge.ready > this.limits.ready
      ) {
        return;
      }
      this.#waiters.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      for (const key of ["total", "encoded", "ready"] as const) {
        this.#used[key] += waiter.charge[key];
        this.#peak[key] = Math.max(this.#peak[key], this.#used[key]);
      }
      let held = waiter.charge;
      waiter.resolve((remaining = { total: 0, encoded: 0, ready: 0 }) => {
        for (const key of ["total", "encoded", "ready"] as const) {
          if (remaining[key] < 0 || remaining[key] > held[key]) {
            throw new RangeError("Cooked credit can only shrink after admission");
          }
        }
        for (const key of ["total", "encoded", "ready"] as const) {
          this.#used[key] -= held[key] - remaining[key];
        }
        held = remaining;
        this.#pump();
      });
    }
  }
}
