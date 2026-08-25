/**
 * HashSet：提供渲染器共享的基础数据结构与通用工具。
 */

import {
  HashMap,
  type KeyEqualityFunction,
  type KeyHashFunction
} from "./HashMap.js";
import { equalsViaMethod, hashViaMethod } from "./memoryUtils.js";

export interface HashSetOptions<K> {
  keyHashFunction?: KeyHashFunction<K>;
  keyEqualityFunction?: KeyEqualityFunction<K>;
  capacity?: number;
}

export class HashSet<K = unknown> {
  readonly __map: HashMap<K, K>;

  constructor({
    keyHashFunction: e = hashViaMethod as KeyHashFunction<K>,
    keyEqualityFunction: t = equalsViaMethod as KeyEqualityFunction<K>,
    capacity: n
  }: HashSetOptions<K> = {}) {
    this.__map = new HashMap<K, K>({
      keyHashFunction: e,
      keyEqualityFunction: t,
      capacity: n
    });
  }

  get size(): number {
    return this.__map.size;
  }

  add(e: K): this {
    this.__map.set(e, e);
    return this;
  }

  clear(): void {
    this.__map.clear();
  }

  delete(e: K): boolean {
    return this.__map.delete(e);
  }

  has(e: K): boolean {
    return this.__map.has(e);
  }

  get(e: K): K | undefined {
    return this.__map.get(e);
  }

  ensure(e: K): K {
    const t = this.get(e);
    return t !== undefined ? t : (this.add(e), e);
  }

  keys(): IterableIterator<K> {
    return this.__map.keys();
  }

  values(): IterableIterator<K> {
    return this.__map.keys();
  }

  entries(): never {
    throw new Error("Not implemented");
  }

  *[Symbol.iterator](): IterableIterator<K> {
    for (const e of this.__map.keys()) yield e;
  }

  forEach(
    e: (value: K, value2: K, set: HashSet<K>) => void,
    t?: unknown
  ): void {
    for (const n of this.values()) e.call(t, n, n, this);
  }
}

export const Wo = HashSet;
