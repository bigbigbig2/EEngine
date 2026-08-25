/**
 * 哈希表：使用开放寻址和墓碑槽位实现可扩容的结构化键值存储。
 */

import { fmin } from "./math/mathUtils.js";
import {
  copyArrayRange,
  countTrailingZeros32,
  equalsViaMethod,
  hashMapSlot,
  hashViaMethod,
  nextPowerOfTwo
} from "./memoryUtils.js";

const HASH_TOMBSTONE = 4294967295;

const EMPTY_BINS = new Uint32Array(0);

export class HashMapEntry<K = unknown, V = unknown> {
  key: K | null;
  value: V | null;
  hash: number;

  constructor(e: K, t: V, n: number) {
    this.key = e;
    this.value = t;
    this.hash = n;
  }

  get isHashMapEntry(): boolean {
    return true;
  }
}

export type KeyHashFunction<K> = (key: K) => number;
export type KeyEqualityFunction<K> = (a: K, b: K) => boolean;

export interface HashMapOptions<K> {
  keyHashFunction?: KeyHashFunction<K>;
  keyEqualityFunction?: KeyEqualityFunction<K>;
  capacity?: number;
  loadFactor?: number;
}

export class HashMap<K = unknown, V = unknown> {
  __bins: Uint8Array | Uint16Array | Uint32Array = EMPTY_BINS;
  __entries: Array<HashMapEntry<K, V> | undefined> = new Array(0);
  __entries_bound = 0;
  __entries_start = 0;
  __size = 0;
  __bin_count = 0;
  __entries_allocated_count = 0;
  __bin_count_power_of_two = 0;
  __entries_count_power_of_two = 0;
  __bin_count_mask = 0;
  __load_factor = 0.75;
  __version = 0;

  readonly keyHashFunction: KeyHashFunction<K>;
  readonly keyEqualityFunction: KeyEqualityFunction<K>;

  constructor({
    keyHashFunction = hashViaMethod as KeyHashFunction<K>,
    keyEqualityFunction = equalsViaMethod as KeyEqualityFunction<K>,
    capacity: n = 16,
    loadFactor: r = 0.75
  }: HashMapOptions<K> = {}) {
    this.keyHashFunction = keyHashFunction;
    this.keyEqualityFunction = keyEqualityFunction;
    this.__load_factor = r;
    this.#resizeEntries(nextPowerOfTwo(n));
  }

  get size(): number {
    return this.__size;
  }

  getCurrentLoad(): number {
    return this.__bin_count === 0 ? 0 : this.__size / this.__bin_count;
  }

  #resizeEntries(e: number): void {
    if (e < this.__size) {
      throw new Error(
        `count must be at least equal to must of records in the map (=${this.__size}), instead was ${e}`
      );
    }
    this.__entries_count_power_of_two = countTrailingZeros32(e);
    this.__bin_count_power_of_two = this.__entries_count_power_of_two + 1;
    this.__bin_count = 2 ** this.__bin_count_power_of_two;
    this.__bin_count_mask = this.__bin_count - 1;
    const t = this.__entries_allocated_count;
    this.__entries_allocated_count = 2 ** this.__entries_count_power_of_two;
    const Ctor = pickBinArrayCtor(this.__entries_allocated_count + 2);
    this.__bins = new Ctor(this.__bin_count);
    const r = new Array<HashMapEntry<K, V> | undefined>(
      this.__entries_allocated_count
    );
    const s = this.__entries;
    this.__entries = r;
    copyArrayRange(
      s as unknown as ArrayLike<number>,
      0,
      r as unknown as { [i: number]: number },
      0,
      fmin(t, this.__entries_allocated_count)
    );
    if (this.__size > 0) this.rebuild();
  }

  compute_bin_index(e: number): number {
    return ((((e >>> 16) ^ e) >>> 0) & this.__bin_count_mask) >>> 0;
  }

  #hashKey(e: K): number {
    const t = this.keyHashFunction(e);
    return t === HASH_TOMBSTONE ? 0 : t;
  }

  #entryMatches(e: HashMapEntry<K, V>, t: number, n: K): boolean {
    return (
      e.hash === t &&
      (e.key === n || this.keyEqualityFunction(e.key as K, n))
    );
  }

  #allocEntry(e: K, t: V, n: number): number {
    const r = this.__entries_bound;
    this.__entries_bound++;
    const s = this.__entries[r];
    if (s !== undefined) {
      s.hash = n;
      s.key = e;
      s.value = t;
    } else {
      this.__entries[r] = new HashMapEntry(e, t, n);
    }
    return r;
  }

  #clearEntry(e: HashMapEntry<K, V>): void {
    e.key = null;
    e.value = null;
    e.hash = HASH_TOMBSTONE;
  }

  #ensureRoom(): void {
    if (this.__entries_bound === this.__entries_allocated_count) {
      if (this.__size === this.__entries_allocated_count) this.#grow();
      else this.rebuild();
    }
  }

  set(e: K, t: V): void {
    this.#ensureRoom();
    const n = this.#hashKey(e);
    let r = this.compute_bin_index(n);
    let s = -1;
    for (;;) {
      const a = this.__bins[r]!;
      if (a > 1) {
        const ent = this.__entries[a - 2]!;
        if (this.#entryMatches(ent, n, e)) {
          ent.value = t;
          return;
        }
      } else {
        if (a === 0) {
          if (s !== -1) r = s;
          const a2 = this.#allocEntry(e, t, n);
          this.__bins[r] = a2 + 2;
          break;
        }
        if (s === -1) s = r;
      }
      r = hashMapSlot(r, this.__bin_count_mask);
    }
    const a = this.__size + 1;
    this.__size = a;
    if (a / this.__bin_count > this.__load_factor) this.#grow();
  }

  get(e: K): V | undefined {
    const t = this.#hashKey(e);
    let n = this.compute_bin_index(t);
    for (;;) {
      const r = this.__bins[n]!;
      if (r > 1) {
        const ent = this.__entries[r - 2]!;
        if (this.#entryMatches(ent, t, e)) return ent.value as V;
      } else if (r === 0) return undefined;
      n = hashMapSlot(n, this.__bin_count_mask);
    }
  }

  getOrCompute(e: K, t: (key: K) => V, n?: unknown): V {
    const r = this.get(e);
    if (r !== undefined) return r;
    const s = t.call(n, e);
    this.set(e, s);
    return s;
  }

  getOrSet(e: K, t: V): V {
    const n = this.get(e);
    return n !== undefined ? n : (this.set(e, t), t);
  }

  #advanceStart(e: number): void {
    if (this.__entries_start !== e) return;
    let t = e + 1;
    const n = this.__entries_bound;
    const r = this.__entries;
    while (t < n && r[t]!.hash === HASH_TOMBSTONE) t++;
    this.__entries_start = t;
  }

  delete(e: K): boolean {
    const t = this.#hashKey(e);
    let n = this.compute_bin_index(t);
    const r = this.__bins;
    const s = this.__entries;
    for (;;) {
      const a = r[n]!;
      if (a > 1) {
        const i = a - 2;
        const o = s[i]!;
        if (this.#entryMatches(o, t, e)) {
          this.#clearEntry(o);
          r[n] = 1;
          this.__size--;
          this.#advanceStart(i);
          return true;
        }
      } else if (a === 0) return false;
      n = hashMapSlot(n, this.__bin_count_mask);
    }
  }

  verifyHashes(
    e: (msg: string, key: K | null, value: V | null) => void,
    t?: unknown
  ): boolean {
    let n = true;
    const r = this.__bin_count;
    for (let s = 0; s < r; s++) {
      const bin = this.__bins[s]!;
      if (bin <= 1) continue;
      const a = this.__entries[bin - 2]!;
      const i = this.#hashKey(a.key as K);
      if (a.hash !== i) {
        e.call(
          t,
          `Hash stored on the entry(=${a.hash}) is different from the computed key hash(=${i}).`,
          a.key,
          a.value
        );
        n = false;
      }
    }
    return n;
  }

  #grow(): void {
    this.#resizeEntries(2 * this.__entries_allocated_count);
  }

  rebuild(): void {
    const e = this.__entries_bound;
    const t = this.__entries;
    const n = this.__bins;
    n.fill(0);
    let r = 0;
    for (let s = this.__entries_start; s < e; s++) {
      const h = t[s]!.hash;
      if (h === HASH_TOMBSTONE) continue;
      const a = r;
      r++;
      if (a !== s) {
        const tmp = t[a];
        t[a] = t[s];
        t[s] = tmp;
      }
      let i = this.compute_bin_index(h);
      for (;;) {
        if (n[i] === 0) {
          n[i] = a + 2;
          break;
        }
        i = hashMapSlot(i, this.__bin_count_mask);
      }
    }
    this.__entries_start = 0;
    this.__entries_bound = this.__size;
    this.__version++;
  }

  forEach(
    e: (value: V, key: K, map: HashMap<K, V>) => void,
    t?: unknown
  ): void {
    const n = this.__bin_count;
    const r = this.__entries;
    const s = this.__bins;
    for (let a = 0; a < n; a++) {
      const bin = s[a]!;
      if (bin <= 1) continue;
      const i = r[bin - 2]!;
      e.call(t, i.value as V, i.key as K, this);
    }
  }

  has(e: K): boolean {
    return this.get(e) !== undefined;
  }

  clear(): void {
    const e = this.__bins;
    const t = this.__bin_count;
    for (let n = 0; n < t; n++) {
      const bin = e[n]!;
      if (bin !== 0) {
        if (bin !== 1) this.#clearEntry(this.__entries[bin - 2]!);
        e[n] = 0;
      }
    }
    this.__size = 0;
    this.__entries_start = 0;
    this.__entries_bound = 0;
  }

  *[Symbol.iterator](): Generator<[K, V]> {
    const e = this.__bin_count;
    const t = this.__bins;
    const n = this.__entries;
    for (let r = 0; r < e; r++) {
      const bin = t[r]!;
      if (bin <= 1) continue;
      const s = n[bin - 2]!;
      yield [s.key as K, s.value as V];
    }
  }

  *entries(): Generator<[K, V]> {
    for (const e of this) yield e;
  }

  *values(): Generator<V> {
    for (const [, t] of this) yield t;
  }

  *keys(): Generator<K> {
    for (const [e] of this) yield e;
  }
}

function pickBinArrayCtor(
  e: number
): Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor {
  if (e <= 256) return Uint8Array;
  if (e <= 65536) return Uint16Array;
  if (e <= 4294967295) return Uint32Array;
  throw new Error(`Unsupported size ${e}`);
}
