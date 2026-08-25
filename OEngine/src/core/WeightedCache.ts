/**
 * WeightedCache：提供渲染器共享的基础数据结构与通用工具。
 */

import { ChangeSignal } from "./Signal.js";
import { HashMap } from "./HashMap.js";
import {
  equalsViaMethod,
  hashViaMethod
} from "./memoryUtils.js";
import type { KeyEqualityFunction, KeyHashFunction } from "./HashMap.js";

export function weightOne(_e?: unknown): number {
  return 1;
}

export function weightZero(_e?: unknown): number {
  return 0;
}

export class CacheElement<K = unknown, V = unknown> {
  key: K | null = null;
  value: V | null = null;
  weight = 0;
  next: CacheElement<K, V> | null = null;
  previous: CacheElement<K, V> | null = null;

  unlink(): void {
    const e = this.next;
    const t = this.previous;
    if (t !== null) t.next = e;
    if (e !== null) e.previous = t;
  }

  toString(): string {
    return `CacheElement{ hasNext:${this.next !== null}, hasPrevious:${this.previous !== null}, weight:${this.weight}, key:${this.key}, value:${this.value} }`;
  }
}

export interface WeightedCacheOptions<K, V> {
  maxWeight?: number;
  keyWeigher?: (key: K) => number;
  valueWeigher?: (value: V) => number;
  keyHashFunction?: KeyHashFunction<K>;
  keyEqualityFunction?: KeyEqualityFunction<K>;
  capacity?: number;
}

export class WeightedCache<K = unknown, V = unknown> {
  #maxWeight = Number.POSITIVE_INFINITY;
  #totalWeight = 0;

  readonly keyWeigher: (key: K) => number;
  readonly valueWeigher: (value: V) => number;
  readonly data: HashMap<K, CacheElement<K, V>>;
  readonly onEvicted = new ChangeSignal();
  readonly onRemoved = new ChangeSignal();
  readonly onSet = new ChangeSignal();

  __first: CacheElement<K, V> | null = null;
  __last: CacheElement<K, V> | null = null;

  constructor({
    maxWeight: e = Number.POSITIVE_INFINITY,
    keyWeigher: t = weightZero as (key: K) => number,
    valueWeigher: n = weightOne as (value: V) => number,
    keyHashFunction: r = hashViaMethod as KeyHashFunction<K>,
    keyEqualityFunction: s = equalsViaMethod as KeyEqualityFunction<K>,
    capacity: a
  }: WeightedCacheOptions<K, V> = {}) {
    this.#maxWeight = e;
    this.keyWeigher = t;
    this.valueWeigher = n;
    this.data = new HashMap<K, CacheElement<K, V>>({
      keyHashFunction: r,
      keyEqualityFunction: s,
      capacity: a
    });
  }

  __promote(e: CacheElement<K, V>): void {
    if (e === this.__first) return;
    if (e === this.__last) this.__last = e.previous;
    e.unlink();
    e.previous = null;
    if (this.__first !== null) {
      e.next = this.__first;
      this.__first.previous = e;
    } else {
      e.next = null;
    }
    this.__first = e;
  }

  size(): number {
    return this.data.size;
  }

  setMaxWeight(_e: number): never {
    throw new Error("setMaxWeight is deprecated, use .maxWeight property instead");
  }

  get weight(): number {
    return this.#totalWeight;
  }

  set maxWeight(e: number) {
    if (typeof e !== "number" || e < 0) {
      throw new Error(`Weight must be a non-negative number, instead was '${e}'`);
    }
    const t = this.#maxWeight;
    this.#maxWeight = e;
    if (t > e) this.evictUntilWeight(this.#maxWeight);
  }

  get maxWeight(): number {
    return this.#maxWeight;
  }

  recomputeWeight(): void {
    let e = 0;
    for (const [t, n] of this.data) {
      const r = this.computeElementWeight(t, n.value as V);
      n.weight = r;
      e += r;
    }
    this.#totalWeight = e;
    this.evictUntilWeight(this.#maxWeight);
  }

  updateElementWeight(e: K): boolean {
    const t = this.data.get(e);
    if (t === undefined) return false;
    const n = t.weight;
    const r = this.computeElementWeight(e, t.value as V);
    if (r !== n) {
      t.weight = r;
      this.#totalWeight += r - n;
      if (this.#totalWeight > this.#maxWeight && r <= this.#maxWeight) {
        this.evictUntilWeight(this.#maxWeight);
      }
    }
    return true;
  }

  computeElementWeight(e: K, t: V): number {
    return this.keyWeigher(e) + this.valueWeigher(t);
  }

  findEvictionVictim(): CacheElement<K, V> | null {
    return this.__last;
  }

  evictOne(): boolean {
    const e = this.findEvictionVictim();
    if (e === null) return false;
    this.remove(e.key as K);
    this.onEvicted.send2(e.key, e.value);
    return true;
  }

  evictUntilWeight(e: number): void {
    const t = Math.max(e, 0);
    while (this.#totalWeight > t) this.evictOne();
  }

  put(e: K, t: V): void {
    let n = this.data.get(e);
    if (n === undefined) {
      const r = this.computeElementWeight(e, t);
      const s = this.#maxWeight - r;
      if (s < 0) return;
      n = new CacheElement<K, V>();
      n.key = e;
      n.value = t;
      n.next = this.__first;
      if (this.__first !== null) this.__first.previous = n;
      this.__first = n;
      if (this.__last === null) this.__last = n;
      n.weight = r;
      this.evictUntilWeight(s);
      this.data.set(e, n);
      this.#totalWeight += r;
    } else {
      if (t !== n.value) {
        this.#totalWeight -= n.weight;
        const r = this.computeElementWeight(e, t);
        this.#totalWeight += r;
        n.weight = r;
        n.value = t;
      }
      this.__promote(n);
    }
    this.onSet.send2(e, t);
  }

  set(e: K, t: V): void {
    this.put(e, t);
  }

  contains(e: K): boolean {
    return this.data.has(e);
  }

  get(e: K): V | null {
    const t = this.data.get(e);
    if (t === undefined) return null;
    this.__promote(t);
    return t.value as V;
  }

  getOrCompute(e: K, t: (key: K) => V, n?: unknown): V {
    const r = this.get(e);
    if (r !== null) return r;
    const s = t.call(n, e);
    this.set(e, s);
    return s;
  }

  __removeElement(e: CacheElement<K, V>): void {
    if (e === this.__first) this.__first = e.next;
    if (e === this.__last) this.__last = e.previous;
    e.unlink();
    this.data.delete(e.key as K);
    this.#totalWeight -= e.weight;
  }

  remove(e: K): boolean {
    const t = this.data.get(e);
    if (t === undefined) return false;
    this.__removeElement(t);
    this.onRemoved.send2(e, t.value);
    return true;
  }

  delete(e: K): boolean {
    return this.remove(e);
  }

  silentRemove(e: K): boolean {
    const t = this.data.get(e);
    if (t === undefined) return false;
    this.__removeElement(t);
    return true;
  }

  clear(): void {
    const e: K[] = [];
    for (const k of this.data.keys()) e.push(k);
    for (let n = 0; n < e.length; n++) this.remove(e[n]!);
  }

  drop(): void {
    this.data.clear();
    this.__first = null;
    this.__last = null;
    this.#totalWeight = 0;
  }

  validate(
    e: (msg: string, key: K | null, value: V | null) => void,
    t?: unknown
  ): boolean {
    return this.data.verifyHashes((n, r, s) => {
      e.call(t, n, r, (s as CacheElement<K, V>).value);
    });
  }
}
