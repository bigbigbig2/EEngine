/**
 * 动画曲线：负责关键帧插值、切线处理、时间采样与曲线优化。
 */

import { hashArrayItems, arrayDeepEquals } from "../core/math/mathUtils.js";

export interface AnimationKeyframe {
  time: number;
  value: number;
  inTangent: number;
  outTangent: number;
}

export class AnimationKeyframeData implements AnimationKeyframe {
  declare readonly isKeyframe: true;
  time = 0;
  value = 0;
  inTangent = 0;
  outTangent = 0;

  static from(time: number, value: number, inTangent = 0, outTangent = 0): AnimationKeyframeData {
    const s = new AnimationKeyframeData();
    s.set(time, value, inTangent, outTangent);
    return s;
  }

  set(time: number, value: number, inTangent: number, outTangent: number): void {
    this.time = time;
    this.value = value;
    this.inTangent = inTangent;
    this.outTangent = outTangent;
  }

  copy(other: AnimationKeyframe): void {
    this.time = other.time;
    this.value = other.value;
    this.inTangent = other.inTangent;
    this.outTangent = other.outTangent;
  }

  clone(): AnimationKeyframeData {
    const e = new AnimationKeyframeData();
    e.copy(this);
    return e;
  }

  equals(other: AnimationKeyframe): boolean {
    return (
      this.time === other.time &&
      this.value === other.value &&
      this.inTangent === other.inTangent &&
      this.outTangent === other.outTangent
    );
  }

  hash(): number {
    const G = 4294967295;
    const p = (e: number) => {
      const t = e | 0;
      return (G - ((((e - t) * G) >>> 0) as number)) ^ t;
    };
    return p(this.time) ^ (31 * p(this.value));
  }

  toJSON(): AnimationKeyframe {
    return {
      value: this.value,
      time: this.time,
      inTangent: this.inTangent,
      outTangent: this.outTangent
    };
  }

  fromJSON({ value: e, time: t, inTangent: n, outTangent: r }: AnimationKeyframe): void {
    this.set(t, e, n, r);
  }
}

const OS_EPS = 1e-5;

function hermiteBasis(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number
): number {
  const a = e * e;
  const i = a * e;
  return (
    (2 * i - 3 * a + 1) * t +
    (i - 2 * a + e) * r +
    (i - a) * s +
    (3 * a - 2 * i) * n
  );
}

function evaluateSegment(
  time: number,
  a: AnimationKeyframe,
  b: AnimationKeyframe
): number {
  const s = b.time - a.time;
  if (s === 0) return a.value;
  const u = (time - a.time) / s;
  return hermiteBasis(
    u,
    a.value,
    b.value,
    (a.outTangent ?? 0) * s,
    (b.inTangent ?? 0) * s
  );
}

function keyframeError(
  e: AnimationKeyframe,
  t: AnimationKeyframe,
  n: AnimationKeyframe
): number {
  const r = n.time - t.time;
  if (r < 1e-9) return 0;
  const s = (e.time - t.time) / r;
  const a = evaluateSegment(e.time, t, n);
  const i = Math.abs(a - e.value);
  const u = s;
  const u2 = u * u;
  const m0 = (t.outTangent ?? 0) * r;
  const m1 = (n.inTangent ?? 0) * r;
  const deriv =
    (6 * u2 - 6 * u) * t.value +
    (-6 * u2 + 6 * u) * n.value +
    (3 * u2 - 4 * u + 1) * m0 +
    (3 * u2 - 2 * u) * m1;
  const _ = Math.abs(deriv / r - (e.inTangent ?? 0));
  return Math.max(i, _ * r * 0.125);
}


function hermiteValueRange(
  out: Float32Array,
  v0: number,
  v1: number,
  m0: number,
  m1: number
): void {
  const o = 3 * (m0 + m1 + 2 * v0 - 2 * v1);
  const _ = -2 * (2 * m0 + m1 + 3 * v0 - 3 * v1);
  const c = m0;
  let d = Math.min(v0, v1);
  let u = Math.max(v0, v1);
  if (Math.abs(o) < 1e-12) {
    if (Math.abs(_) >= 1e-12) {
      const e = -c / _;
      if (0 < e && e < 1) {
        const t = hermiteBasis(e, v0, v1, m0, m1);
        if (t < d) d = t;
        if (t > u) u = t;
      }
    }
  } else {
    const disc = _ * _ - 4 * c * o;
    if (disc >= 0) {
      const t = Math.sqrt(disc);
      const e1 = (-_ + t) / (2 * o);
      if (0 < e1 && e1 < 1) {
        const val = hermiteBasis(e1, v0, v1, m0, m1);
        if (val < d) d = val;
        if (val > u) u = val;
      }
      const e2 = (-_ - t) / (2 * o);
      if (0 < e2 && e2 < 1) {
        const val = hermiteBasis(e2, v0, v1, m0, m1);
        if (val < d) d = val;
        if (val > u) u = val;
      }
    }
  }
  out[0] = d;
  out[1] = u;
}

function curveValueHeight(curve: AnimationCurve): number {
  const keys = curve.keys;
  const o = keys.length;
  if (o === 0) return 0;
  let minV = keys[0]!.value;
  let maxV = keys[0]!.value;
  const rs = new Float32Array(2);
  let prev = keys[0]!;
  for (let t = 1; t < o; t++) {
    const cur = keys[t]!;
    const dt = cur.time - prev.time;
    hermiteValueRange(
      rs,
      prev.value,
      cur.value,
      (prev.outTangent ?? 0) * dt,
      (cur.inTangent ?? 0) * dt
    );
    if (rs[0]! < minV) minV = rs[0]!;
    if (rs[1]! > maxV) maxV = rs[1]!;
    prev = cur;
  }
  return maxV - minV;
}

export class AnimationCurve {
  declare readonly isAnimationCurve: true;
  keys: AnimationKeyframeData[] = [];

  get length(): number {
    return this.keys.length;
  }

  get start_time(): number {
    const e = this.keys;
    return e.length === 0 ? 0 : e[0]!.time;
  }

  get end_time(): number {
    const e = this.keys;
    const t = e.length;
    return t === 0 ? 0 : e[t - 1]!.time;
  }

  get duration(): number {
    const e = this.keys;
    const t = e.length;
    return t < 2 ? 0 : e[t - 1]!.time - e[0]!.time;
  }

  add(e: AnimationKeyframeData): number {
    const t = this.keys;
    const n = t.length;
    const r = n - 1;
    if (r < 0 || t[r]!.time <= e.time) {
      t.push(e);
      return n;
    }
    if (n > 0 && t[0]!.time > e.time) {
      t.unshift(e);
      return 0;
    }
    const s = this.getKeyIndexLow(e.time) + 1;
    t.splice(s, 0, e);
    return s;
  }

  addMany(e: AnimationKeyframeData[]): void {
    for (let n = 0; n < e.length; n++) this.add(e[n]!);
  }

  remove(e: AnimationKeyframeData): boolean {
    const t = this.keys.indexOf(e);
    if (t === -1) return false;
    this.keys.splice(t, 1);
    return true;
  }

  removeAt(index: number): boolean {
    if (index < 0 || index >= this.keys.length) return false;
    this.keys.splice(index, 1);
    return true;
  }

  clear(): void {
    this.keys.splice(0, this.keys.length);
  }

  isEmpty(): boolean {
    return this.keys.length === 0;
  }

  getKeyIndexLow(e: number): number {
    const t = this.keys;
    const n = t.length;
    if (n === 0) return 0;
    if (e <= t[0]!.time) return 0;
    if (e >= t[n - 1]!.time) return n - 1;
    let r = 0;
    let s = 0;
    let a = n - 1;
    while (s <= a) {
      const mid = (s + a) >>> 1;
      const i = t[mid]!.time;
      if (i <= e) {
        r = mid;
        s = mid + 1;
      } else {
        a = mid - 1;
      }
    }
    while (r + 2 < n && t[r + 1]!.time === e) r++;
    return r;
  }

  evaluate(time: number): number {
    const t = this.keys;
    const n = t.length;
    if (n === 0) return 0;
    if (n === 1) return t[0]!.value;
    const r = this.getKeyIndexLow(time);
    if (r >= n - 1) return t[n - 1]!.value;
    const a = t[r]!;
    if (a.time >= time) return a.value;
    return evaluateSegment(time, a, t[r + 1]!);
  }

  alignTangents(e: number): void {
    const t = this.keys;
    const n = t[e];
    if (!n) return;
    const hasNext = e < t.length - 1;
    if (e > 0) {
      const prev = t[e - 1]!;
      n.inTangent = (n.value - prev.value) / (n.time - prev.time);
    }
    if (hasNext) {
      const next = t[e + 1]!;
      n.outTangent = (next.value - n.value) / (next.time - n.time);
    }
  }

  smoothTangents(_e: number, _t?: number): never {
    throw new Error("Deprecated, use alignTagents() instead");
  }

  alignAllTangents(): void {
    const e = this.length;
    for (let t = 0; t < e; t++) this.alignTangents(t);
  }

  smooth(): void {
    this.alignAllTangents();
  }

  copy(other: AnimationCurve): void {
    this.keys = other.keys.map((key) => key.clone());
  }

  clone(): AnimationCurve {
    const e = new AnimationCurve();
    e.copy(this);
    return e;
  }

  equals(other: AnimationCurve): boolean {
    return arrayDeepEquals(this.keys, other.keys);
  }

  hash(): number {
    return hashArrayItems(this.keys, (key) => key.hash());
  }

  isConstantNear(value: number, eps = OS_EPS): boolean {
    const n = this.keys;
    for (let e = 0; e < n.length; e++) {
      const r = n[e]!;
      if (Math.abs(r.value - value) > eps) return false;
      if (Math.abs(r.inTangent ?? 0) > eps) return false;
      if (Math.abs(r.outTangent ?? 0) > eps) return false;
    }
    return true;
  }

  simplifyKeys(relativeTol = 0.001): boolean {
    const before = this.clone();
    let n = this.keys.length;
    if (n <= 1) return false;

    const r = Math.max(curveValueHeight(this) * relativeTol, 1e-9);
    const s = this.keys;
    for (let t = 1; t < n; t++) {
      const a = s[t - 1]!;
      const i = s[t]!;
      let o = false;
      if (keyframeEquals(i, a)) o = true;
      else if (t < n - 1 && keyframeError(i, a, s[t + 1]!) <= r) o = true;
      if (o) {
        this.keys.splice(t, 1);
        t--;
        n--;
      }
    }
    return !this.equals(before);
  }

  toJSON(): { keys: AnimationKeyframe[] } {
    return { keys: this.keys.map((key) => key.toJSON()) };
  }

  fromJSON({ keys: e = [] }: { keys?: AnimationKeyframe[] }): void {
    this.clear();
    for (let n = 0; n < e.length; n++) {
      const key = new AnimationKeyframeData();
      key.fromJSON(e[n]!);
      this.add(key);
    }
  }

  *[Symbol.iterator](): IterableIterator<AnimationKeyframeData> {
    for (const e of this.keys) yield e;
  }

  static from(e: AnimationKeyframeData[]): AnimationCurve {
    const t = new AnimationCurve();
    t.addMany(e);
    return t;
  }

  static fromKeys(keys: AnimationKeyframeData[]): AnimationCurve {
    return AnimationCurve.from(keys);
  }

  static easeInOut(e = 0, t = 0, n = 1, r = 1): AnimationCurve {
    return AnimationCurve.from([
      AnimationKeyframeData.from(e, t, 0, 0),
      AnimationKeyframeData.from(n, r, 0, 0)
    ]);
  }

  static constant(e = 0, t = 1, n = 0): AnimationCurve {
    return AnimationCurve.from([
      AnimationKeyframeData.from(e, n, 0, 0),
      AnimationKeyframeData.from(t, n, 0, 0)
    ]);
  }

  static linear(e = 0, t = 0, n = 1, r = 1): AnimationCurve {
    const s = n - e;
    const a = s === 0 ? 0 : (r - t) / s;
    return AnimationCurve.from([
      AnimationKeyframeData.from(e, t, 0, a),
      AnimationKeyframeData.from(n, r, a, 0)
    ]);
  }
}

function keyframeEquals(a: AnimationKeyframeData, b: AnimationKeyframeData): boolean {
  return a.equals(b);
}

(AnimationKeyframeData.prototype as { isKeyframe?: true }).isKeyframe = true;
(AnimationCurve.prototype as { isAnimationCurve?: true }).isAnimationCurve = true;
