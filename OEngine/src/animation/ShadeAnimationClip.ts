/**
 * 动画片段：组织一组动画通道，并管理播放时长、循环方式与采样过程。
 */

import { ShadeAnimationChannel } from "./ShadeAnimationChannel.js";
import type { AnimationCurve } from "./AnimationCurve.js";

function curveTimes(
  curves: { x?: AnimationCurve; y?: AnimationCurve; z?: AnimationCurve; w?: AnimationCurve },
  pick: "start" | "end"
): number[] {
  const out: number[] = [];
  for (const k of ["x", "y", "z", "w"] as const) {
    const c = curves[k];
    if (c !== undefined) {
      out.push(pick === "start" ? c.start_time : c.end_time);
    }
  }
  return out;
}

export class ShadeAnimationClip {
  declare readonly isShadeAnimationClip: boolean;

  name = "";
  channels: ShadeAnimationChannel[] = [];

  get start_time(): number {
    let e = Infinity;
    const t = this.channels;
    for (let n = 0; n < t.length; n++) {
      for (const s of curveTimes(t[n]!.curves, "start")) {
        if (s < e) e = s;
      }
    }
    return e === Infinity ? 0 : e;
  }

  get end_time(): number {
    let e = -Infinity;
    const t = this.channels;
    for (let n = 0; n < t.length; n++) {
      for (const s of curveTimes(t[n]!.curves, "end")) {
        if (s > e) e = s;
      }
    }
    return e === -Infinity ? 0 : e;
  }

  get duration(): number {
    return this.end_time - this.start_time;
  }

  static from({
    name = "",
    channels
  }: {
    name?: string;
    channels: ShadeAnimationChannel[];
  }): ShadeAnimationClip {
    const n = new ShadeAnimationClip();
    n.name = name;
    n.channels = channels;
    return n;
  }

  copy(other: ShadeAnimationClip): void {
    if (this === other) return;
    this.name = other.name;
    const t = other.channels;
    const n = new Array<ShadeAnimationChannel>(t.length);
    for (let e = 0; e < t.length; e++) n[e] = t[e]!.clone();
    this.channels = n;
  }

  clone(): ShadeAnimationClip {
    const e = new ShadeAnimationClip();
    e.copy(this);
    return e;
  }

  apply(t: number): void {
    const channels = this.channels;
    for (let r = 0; r < channels.length; r++) {
      channels[r]!.apply(t);
    }
  }

  optimize(): void {
    const e = this.channels;
    const t: ShadeAnimationChannel[] = [];
    for (let n = 0; n < e.length; n++) {
      const r = e[n]!;
      r.optimize();
      if (r.curve_count > 0) t.push(r);
    }
    this.channels = t;
  }
}

(ShadeAnimationClip.prototype as { isShadeAnimationClip?: boolean }).isShadeAnimationClip = true;
