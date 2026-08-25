/**
 * 信号系统：管理回调注册、单次监听、静默派发以及派发期间的安全移除。
 */

export type SignalHandler<T = void> = (payload: T) => void;
export type ChangeSignalHandler = Function;

export class Signal<T = void> {
  private readonly handlers = new Set<SignalHandler<T>>();

  subscribe(handler: SignalHandler<T>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(payload: T): void {
    for (const handler of this.handlers) handler(payload);
  }

  send1(payload: T): void {
    this.emit(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}

const HANDLER_ONE_SHOT = 1;
const SIGNAL_SILENT = 1;

class ChangeSignalHandlerNode {
  next: ChangeSignalHandlerNode | null = null;
  flags = 0;
  generation = -1;

  constructor(
    readonly handle: ChangeSignalHandler,
    readonly context: unknown
  ) {}

  get isSignalHandler(): boolean {
    return true;
  }

  setFlag(flag: number): void {
    this.flags |= flag;
  }

  clearFlag(flag: number): void {
    this.flags &= ~flag;
  }

  writeFlag(flag: number, value: boolean): void {
    if (value) this.setFlag(flag);
    else this.clearFlag(flag);
  }

  getFlag(flag: number): boolean {
    return (this.flags & flag) === flag;
  }
}

export class ChangeSignal<
  A = any,
  B = any,
  C = any,
  D = any,
  E = any,
  F = any,
  G = any,
  H = any
> {
  readonly handlers = new Map<
    ChangeSignalHandler,
    ChangeSignalHandlerNode
  >();
  flags = 0;
  generation = 0;

  get isSignal(): boolean {
    return true;
  }

  get silent(): boolean {
    return this.getFlag(SIGNAL_SILENT);
  }

  set silent(value: boolean) {
    this.writeFlag(SIGNAL_SILENT, value);
  }

  setFlag(flag: number): void {
    this.flags |= flag;
  }

  clearFlag(flag: number): void {
    this.flags &= ~flag;
  }

  writeFlag(flag: number, value: boolean): void {
    if (value) this.setFlag(flag);
    else this.clearFlag(flag);
  }

  getFlag(flag: number): boolean {
    return (this.flags & flag) === flag;
  }

  contains(listener: ChangeSignalHandler, thisArg?: unknown): boolean {
    let node = this.handlers.get(listener);
    if (node === undefined) return false;
    for (;;) {
      if (node.handle === listener && node.context === thisArg) return true;
      node = node.next!;
      if (node === null) return false;
    }
  }

  mute(): void {
    this.setFlag(SIGNAL_SILENT);
  }

  unmute(): void {
    this.clearFlag(SIGNAL_SILENT);
  }

  hasHandlers(): boolean {
    return this.handlers.size > 0;
  }

  addOne(listener: () => any, thisArg?: any): void;
  addOne(listener: (a: A) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C, d: D) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C, d: D, e: E) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C, d: D, e: E, f: F) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => any, thisArg?: any): void;
  addOne(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => any, thisArg?: any): void;
  addOne(listener: ChangeSignalHandler, thisArg?: unknown): void {
    const node = new ChangeSignalHandlerNode(listener, thisArg);
    node.setFlag(HANDLER_ONE_SHOT);
    addSignalNode(this, node);
  }

  add(listener: () => any, thisArg?: any): void;
  add(listener: (a: A) => any, thisArg?: any): void;
  add(listener: (a: A, b: B) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C, d: D) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C, d: D, e: E) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C, d: D, e: E, f: F) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => any, thisArg?: any): void;
  add(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => any, thisArg?: any): void;
  add(listener: ChangeSignalHandler, thisArg?: unknown): void {
    addSignalNode(this, new ChangeSignalHandlerNode(listener, thisArg));
  }

  remove(listener: () => any, thisArg?: any): void;
  remove(listener: (a: A) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C, d: D) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C, d: D, e: E) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C, d: D, e: E, f: F) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => any, thisArg?: any): void;
  remove(listener: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => any, thisArg?: any): void;
  remove(listener: ChangeSignalHandler, thisArg?: unknown): boolean {
    const head = this.handlers.get(listener);
    if (head === undefined) return false;
    if (head.handle === listener && head.context === thisArg) {
      if (head.next === null) this.handlers.delete(listener);
      else this.handlers.set(listener, head.next);
      return true;
    }
    let previous = head;
    let node = head.next;
    while (node !== null) {
      if (node.handle === listener && node.context === thisArg) {
        previous.next = node.next;
        return true;
      }
      previous = node;
      node = node.next;
    }
    return false;
  }

  removeAll(): void {
    this.handlers.clear();
  }

  promise(): Promise<[A, B, C, D, E, F, G, H]> {
    return new Promise((resolve) => {
      this.addOne((...args: unknown[]) => resolve(args as [A, B, C, D, E, F, G, H]));
    });
  }

  dispatch(...params: any[]): void {
    dispatchSignal(this, (node) => node.handle.apply(node.context, params));
  }

  send0(): void {
    dispatchSignal(this, (node) => node.handle.call(node.context));
  }

  send1(a: A): void {
    dispatchSignal(this, (node) => node.handle.call(node.context, a));
  }

  send2(a: A, b: B): void {
    dispatchSignal(this, (node) => node.handle.call(node.context, a, b));
  }

  send3(a: A, b: B, c: C): void {
    dispatchSignal(this, (node) => node.handle.call(node.context, a, b, c));
  }

  send4(a: A, b: B, c: C, d: D): void {
    dispatchSignal(this, (node) => node.handle.call(node.context, a, b, c, d));
  }

  send5(e: unknown, t: unknown, n: unknown, r: unknown, s: unknown): void {
    dispatchSignal(this, (node) => node.handle.call(node.context, e, t, n, r, s));
  }

  send6(
    a: A,
    b: B,
    c: C,
    d: D,
    e: E,
    f: F
  ): void {
    dispatchSignal(
      this,
      (node) => node.handle.call(node.context, a, b, c, d, e, f),
      f
    );
  }

  send8(
    a: A,
    b: B,
    c: C,
    d: D,
    e: E,
    f: F,
    g: G,
    h: H
  ): void {
    dispatchSignal(
      this,
      (node) => node.handle.call(node.context, a, b, c, d, e, f, g, h),
      f
    );
  }

  merge(other: ChangeSignal<A, B, C, D, E, F, G, H>): ChangeSignal<A, B, C, D, E, F, G, H> {
    const merged = new ChangeSignal<A, B, C, D, E, F, G, H>();
    function forward(): void {
      merged.dispatch(arguments);
    }
    this.add(forward);
    other.add(forward);
    return merged;
  }

}

function addSignalNode(signal: ChangeSignal, node: ChangeSignalHandlerNode): void {
  node.generation = signal.generation;
  const head = signal.handlers.get(node.handle);
  if (head !== undefined) node.next = head;
  signal.handlers.set(node.handle, node);
}

function removeSignalNode(
  signal: ChangeSignal,
  target: ChangeSignalHandlerNode
): boolean {
  const head = signal.handlers.get(target.handle);
  if (head === undefined) return false;
  if (head === target) {
    if (head.next === null) signal.handlers.delete(target.handle);
    else signal.handlers.set(target.handle, head.next);
    return true;
  }
  let previous = head;
  let node = head.next;
  while (node !== null) {
    const next = node.next;
    if (node === target) {
      previous.next = next;
      return true;
    }
    previous = node;
    node = next;
  }
  return false;
}

function dispatchSignal(
  signal: ChangeSignal,
  invoke: (node: ChangeSignalHandlerNode) => unknown,
  originalErrorHandle?: unknown
): void {
  if ((signal.flags & SIGNAL_SILENT) !== 0) return;
  signal.generation++;
  for (const head of signal.handlers.values()) {
    let node: ChangeSignalHandlerNode | null = head;
    do {
      const next: ChangeSignalHandlerNode | null = node.next;
      if (node.generation < signal.generation) {
        if (node.getFlag(HANDLER_ONE_SHOT)) removeSignalNode(signal, node);
        try {
          invoke(node);
        } catch (error) {
          console.error(
            "Failed to dispatch handler",
            originalErrorHandle ?? node.handle,
            error
          );
        }
      }
      node = next;
    } while (node !== null);
  }
}
