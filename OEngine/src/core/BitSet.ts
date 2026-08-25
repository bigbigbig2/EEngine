/**
 * BitSet：提供渲染器共享的基础数据结构与通用工具。
 */

import { fmin } from "./math/mathUtils.js";
import { max3, popcount32, trailingZeroIndex32 } from "./memoryUtils.js";

export class BitSet {
  __length = 0;
  __capacity: number;
  __data_uint32: Uint32Array;
  __shrinkFactor = 0.5;

  constructor(e = 64) {
    this.__capacity = ((e + 31) >>> 5) << 5;
    this.__data_uint32 = new Uint32Array(this.__capacity >> 5);
  }

  preventShrink(): void {
    this.setShrinkFactor(0);
  }

  setShrinkFactor(e: number): void {
    this.__shrinkFactor = e;
  }

  setCapacity(e: number): void {
    if (this.__length > e) {
      throw new Error(
        `Current length(=${this.__length}) is greater than requested size(=${e})`
      );
    }
    this.__resize(e);
  }

  size(): number {
    return this.__length;
  }

  capacity(): number {
    return this.__capacity;
  }

  __resize(e: number): void {
    const t = Math.ceil(e / 32);
    const n = this.__data_uint32;
    const r = new Uint32Array(t);
    r.set(n.length < t ? n : n.subarray(0, t));
    this.__data_uint32 = r;
    this.__capacity = 32 * t;
  }

  __updateLength(): void {
    const e = this.previousSetBit(this.__length) + 1;
    if (e < this.__length) this.__setLength(e);
  }

  __setLength(e: number): void {
    this.__length = e;
    const t = this.__capacity;
    if (e > t) {
      const n = Math.ceil(max3(e, t + 128, 1.3 * t));
      this.__resize(n);
    } else if (e < t - 128 && e < t * this.__shrinkFactor) {
      this.__resize(e);
    }
  }

  previousSetBit(e: number): number {
    const t = fmin(e, this.__length - 1);
    let n = t >> 5;
    let r = 31 & t;
    const s = this.__data_uint32;
    let a = s[n]!;
    for (; r >= 0; r--) {
      if (a & (1 << r)) return 32 * n + r;
    }
    for (n--; n >= 0; n--) {
      a = s[n]!;
      for (r = 31; r >= 0; r--) {
        if (a & (1 << r)) return 32 * n + r;
      }
    }
    return -1;
  }

  nextSetBit(e: number): number {
    const t = this.__length;
    if (e >= t) return -1;
    const n = this.__data_uint32;
    let a = e >> 5;
    let i = 31 & e;
    if (i !== 0) {
      const masked = n[a]! & ~((1 << i) - 1);
      if (masked !== 0) {
        i = trailingZeroIndex32(masked);
        return (a << 5) + i;
      }
      a++;
    }
    const o = (t + 31) >> 5;
    for (; a < o; a++) {
      const r = n[a]!;
      if (r !== 0) {
        i = trailingZeroIndex32(r);
        return (a << 5) + i;
      }
    }
    return -1;
  }

  nextClearBit(e: number): number {
    let n = e >> 5;
    let r = 31 & e;
    const s = this.__data_uint32;
    if (r !== 0) {
      const t = s[n]!;
      const masked = (t | ((1 << r) - 1)) >>> 0;
      if (masked !== 4294967295) {
        r = trailingZeroIndex32(~masked);
        return r + 32 * n;
      }
      n++;
    }
    const a = this.__length;
    const i = (a + 31) >> 5;
    for (; n < i; n++) {
      const t = s[n]!;
      if (t !== 4294967295) {
        r = trailingZeroIndex32(~t);
        return r + 32 * n;
      }
    }
    return a;
  }

  set(e: number, t: boolean): void {
    const n = e >> 5;
    const r = 1 << (31 & e);
    if (t) {
      const next = e + 1;
      if (next > this.__length) this.__setLength(next);
      this.__data_uint32[n]! |= r;
    } else if (e < this.__length) {
      this.__data_uint32[n]! &= ~r;
      this.__updateLength();
    }
  }

  clear(e: number): void {
    this.set(e, false);
  }

  setRange(e: number, t: number): void {
    for (let n = e; n <= t; n++) this.set(n, true);
  }

  clearRange(e: number, t: number): void {
    for (let n = e; n < t; n++) this.set(n, false);
  }

  get(e: number): boolean {
    return !(
      e >= this.__length ||
      !(this.__data_uint32[e >> 5]! & (1 << (31 & e)))
    );
  }

  getAndSet(e: number): boolean {
    const t = this.get(e);
    if (!t) this.set(e, true);
    return t;
  }

  getAndClear(e: number): boolean {
    const t = this.get(e);
    if (t) this.set(e, false);
    return t;
  }

  shift_right(e: number, t: number, n: number): void {
    for (let r = n; r >= t; r--) {
      const v = this.get(r);
      this.set(r + e, v);
    }
  }

  shift_left(e: number, t: number, n: number): void {
    for (let r = t; r <= n; r++) {
      const v = this.get(r);
      this.set(r - e, v);
    }
  }

  shift(e: number, t: number, n: number): void {
    this.shift_right(e > 0 ? e : -e, t, n);
  }

  reset(): void {
    const e = this.__length;
    if (e <= 0) return;
    if (e <= 32) this.__data_uint32[0] = 0;
    else this.__data_uint32.fill(0, 0, Math.ceil(e / 32));
    this.__length = 0;
  }

  cardinality(): number {
    const e = this.__length;
    if (e === 0) return 0;
    const t = this.__data_uint32;
    let n = 0;
    const r = e >> 5;
    for (let i = 0; i < r; i++) n += popcount32(t[i]!);
    const s = 31 & e;
    if (s > 0) n += popcount32(t[r]! & ((1 << s) - 1));
    return n;
  }

  copy(e: BitSet): void {
    const t = e.__length;
    const n = t >> 5;
    const r = this.__length;
    if (r !== t) {
      if (r < t) this.__resize(t);
      else this.__data_uint32.fill(0, n);
      this.__length = t;
    }
    for (let i = 0; i < n; i++) this.__data_uint32[i] = e.__data_uint32[i]!;
    const s = n << 5;
    const a = t - s;
    for (let i = 0; i < a; i++) {
      const idx = s + i;
      this.set(idx, e.get(idx));
    }
  }

  static fixedSize(e: number): BitSet {
    const t = new BitSet(e);
    t.preventShrink();
    return t;
  }
}
