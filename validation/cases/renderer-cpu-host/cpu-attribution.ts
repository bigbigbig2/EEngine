// Case-local synchronous attribution. No GPU work, frame owner or async wait is
// changed. Exclusive time is charged to the innermost measured method; promise
// continuations are separate background observations, never render wall time.
export function createCpuAttribution() {
  const names: string[] = [];
  const ids = new Map<string, number>();
  const inclusive = new Float64Array(256);
  const exclusive = new Float64Array(256);
  const calls = new Uint32Array(256);
  const background = new Float64Array(256);
  const backgroundCalls = new Uint32Array(256);
  const children = new Float64Array(128);
  const restores: Array<() => void> = [];
  let depth = 0;
  let renderScope = false;
  let enabled = false;

  function id(name: string): number {
    const existing = ids.get(name);
    if (existing !== undefined) return existing;
    if (names.length === inclusive.length) throw new Error("CPU attribution label capacity exceeded");
    const index = names.length;
    names.push(name);
    ids.set(name, index);
    return index;
  }

  function invoke(index: number, fn: Function, receiver: unknown, args: ArrayLike<unknown>): unknown {
    if (!enabled) return Reflect.apply(fn, receiver, args);
    const level = depth++;
    if (level >= children.length) throw new Error("CPU attribution stack capacity exceeded");
    children[level] = 0;
    const started = performance.now();
    try {
      return Reflect.apply(fn, receiver, args);
    } finally {
      const elapsed = performance.now() - started;
      depth--;
      if (renderScope) {
        inclusive[index] += elapsed;
        exclusive[index] += Math.max(0, elapsed - children[level]!);
        calls[index]++;
      } else {
        background[index] += Math.max(0, elapsed - children[level]!);
        backgroundCalls[index]++;
      }
      if (level > 0) children[level - 1] += elapsed;
    }
  }

  function replace(target: object, key: string, replacement: Function): void {
    const own = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
    restores.push(() => {
      if (own === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, own);
    });
  }

  function wrap(target: object, key: string, name: string): void {
    const original = Reflect.get(target, key);
    if (typeof original !== "function") throw new Error(`Missing attribution method ${name}/${key}`);
    const index = id(name);
    replace(target, key, function (this: unknown) {
      return invoke(index, original, this, arguments);
    });
  }

  function cache(target: object, name: string): void {
    const original = Reflect.get(target, "getOrCreate") as Function;
    const seen = new WeakSet<object>();
    const total = id(`${name}/key-and-cache`);
    const hit = id(`${name}/hit`);
    const miss = id(`${name}/new-identity`);
    replace(target, "getOrCreate", function (this: unknown) {
      const value = invoke(total, original, this, arguments) as object;
      if (enabled && renderScope) calls[seen.has(value) ? hit : miss]++;
      seen.add(value);
      return value;
    });
    const entries = Reflect.get(target, "entries") as Map<unknown, unknown>;
    wrap(entries, "get", `${name}/lookup`);
  }

  function resolvers(target: object): void {
    const original = Reflect.get(target, "slot") as Function;
    const index = id("framegraph/late-bindings");
    replace(target, "slot", function (this: unknown, name: string, initial: unknown, resolve: Function) {
      return original.call(this, name, initial, function (this: unknown) {
        return invoke(index, resolve, this, arguments);
      });
    });
  }

  function startFrame(timing: boolean): void {
    if (depth !== 0 || renderScope) throw new Error("CPU attribution frame nesting");
    enabled = timing;
    inclusive.fill(0);
    exclusive.fill(0);
    calls.fill(0);
    renderScope = true;
  }

  function endFrame() {
    if (depth !== 0) throw new Error("CPU attribution method did not return");
    renderScope = false;
    // Copies happen after the renderer.render stopwatch has stopped.
    return {
      inclusive: Array.from(inclusive.slice(0, names.length)),
      exclusive: Array.from(exclusive.slice(0, names.length)),
      calls: Array.from(calls.slice(0, names.length)),
    };
  }

  function resetBackground(): void {
    background.fill(0);
    backgroundCalls.fill(0);
  }

  function backgroundSnapshot() {
    return {
      exclusive: Array.from(background.slice(0, names.length)),
      calls: Array.from(backgroundCalls.slice(0, names.length)),
    };
  }

  function calibration() {
    const target = {
      increment(value: number) {
        return value + 1;
      },
    };
    const original = target.increment;
    const index = id("timer-calibration");
    const iterations = 100000;
    let sink = 0;
    const started = performance.now();
    for (let i = 0; i < iterations; ++i) sink = original(sink);
    const plainMs = performance.now() - started;
    enabled = true;
    const wrapped = function (value: number): number {
      return invoke(index, original, target, arguments) as number;
    };
    const timed = performance.now();
    for (let i = 0; i < iterations; ++i) sink = wrapped(sink);
    const timedMs = performance.now() - timed;
    enabled = false;
    resetBackground();
    return {
      iterations,
      plainMs,
      timedMs,
      extraNanosecondsPerCall: ((timedMs - plainMs) * 1e6) / iterations,
      sink,
    };
  }

  return {
    wrap,
    cache,
    resolvers,
    startFrame,
    endFrame,
    resetBackground,
    backgroundSnapshot,
    calibration,
    names,
    setEnabled(value: boolean) {
      enabled = value;
    },
    restore() {
      enabled = false;
      for (let i = restores.length - 1; i >= 0; --i) restores[i]!();
      restores.length = 0;
    },
  };
}
