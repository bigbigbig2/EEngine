/**
 * 动画通道：把曲线采样结果写入场景节点的位移、旋转和缩放属性。
 */

import type { Node3D } from "../scene/Node3D.js";
import type { AnimationCurve } from "./AnimationCurve.js";

export type ChannelCurves = {
  x?: AnimationCurve;
  y?: AnimationCurve;
  z?: AnimationCurve;
  w?: AnimationCurve;
};

export const AnimationChannelProperty = {
  Position: 0,
  Rotation: 1,
  Scale: 2
} as const;

export type AnimationChannelProperty =
  (typeof AnimationChannelProperty)[keyof typeof AnimationChannelProperty];

export class ShadeAnimationChannel {
  declare readonly isShadeAnimationChannel: boolean;

  target: Node3D = null!;
  property = 0;
  curves: ChannelCurves = {};

  static from({
    target,
    property,
    curves
  }: {
    target: Node3D;
    property: number;
    curves: ChannelCurves;
  }): ShadeAnimationChannel {
    const r = new ShadeAnimationChannel();
    r.target = target;
    r.property = property;
    r.curves = {
      x: curves.x,
      y: curves.y,
      z: curves.z,
      w: curves.w
    };
    return r;
  }

  copy(other: ShadeAnimationChannel): void {
    if (this === other) return;
    this.target = other.target;
    this.property = other.property;
    this.curves = {
      x: other.curves.x,
      y: other.curves.y,
      z: other.curves.z,
      w: other.curves.w
    };
  }

  clone(): ShadeAnimationChannel {
    const e = new ShadeAnimationChannel();
    e.copy(this);
    return e;
  }

  apply(t: number): void {
    const curves = this.curves;
    const n = this.target!.transform_local;
    switch (this.property) {
      case AnimationChannelProperty.Position:
        if (curves.x !== undefined) n.position.setX(curves.x.evaluate(t));
        if (curves.y !== undefined) n.position.setY(curves.y.evaluate(t));
        if (curves.z !== undefined) n.position.setZ(curves.z.evaluate(t));
        break;
      case AnimationChannelProperty.Rotation: {
        const r = curves.x !== undefined ? curves.x.evaluate(t) : 0;
        const s = curves.y !== undefined ? curves.y.evaluate(t) : 0;
        const a = curves.z !== undefined ? curves.z.evaluate(t) : 0;
        const i = curves.w !== undefined ? curves.w.evaluate(t) : 1;
        n.rotation.set(r, s, a, i);
        n.rotation.normalize();
        break;
      }
      case AnimationChannelProperty.Scale:
        if (curves.x !== undefined) n.scale.setX(curves.x.evaluate(t));
        if (curves.y !== undefined) n.scale.setY(curves.y.evaluate(t));
        if (curves.z !== undefined) n.scale.setZ(curves.z.evaluate(t));
        break;
    }
  }

  get curve_count(): number {
    const e = this.curves;
    let t = 0;
    if (e.x !== undefined) t++;
    if (e.y !== undefined) t++;
    if (e.z !== undefined) t++;
    if (e.w !== undefined) t++;
    return t;
  }

  optimize(): number {
    const e = this.curves;
    let t = 0;
    const dropIfConst = (key: keyof ChannelCurves, def: number) => {
      const c = e[key];
      if (c !== undefined && c.isConstantNear(def)) {
        e[key] = undefined;
        t++;
      }
    };
    switch (this.property) {
      case AnimationChannelProperty.Position:
        dropIfConst("x", 0);
        dropIfConst("y", 0);
        dropIfConst("z", 0);
        break;
      case AnimationChannelProperty.Scale:
        dropIfConst("x", 1);
        dropIfConst("y", 1);
        dropIfConst("z", 1);
        break;
      case AnimationChannelProperty.Rotation:
        if (
          (e.x === undefined || e.x.isConstantNear(0)) &&
          (e.y === undefined || e.y.isConstantNear(0)) &&
          (e.z === undefined || e.z.isConstantNear(0))
        ) {
          for (const k of ["x", "y", "z", "w"] as const) {
            if (e[k] !== undefined) {
              e[k] = undefined;
              t++;
            }
          }
        }
        break;
    }
    this.#simplifyAxis("x");
    this.#simplifyAxis("y");
    this.#simplifyAxis("z");
    this.#simplifyAxis("w");
    return t;
  }

  #simplifyAxis(axis: keyof ChannelCurves): void {
    const t = this.curves[axis];
    if (t === undefined) return;
    const n = t.clone();
    n.simplifyKeys(0.001);
    if (!t.equals(n)) {
      this.curves[axis] = n;
    }
  }
}

(ShadeAnimationChannel.prototype as { isShadeAnimationChannel?: boolean }).isShadeAnimationChannel = true;
