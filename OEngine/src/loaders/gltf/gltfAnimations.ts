/**
 * gltfAnimations：解析 glTF 数据并转换为引擎运行时对象。
 */

import {
  AnimationCurve,
  AnimationKeyframeData
} from "../../animation/AnimationCurve.js";
import { ShadeAnimationChannel } from "../../animation/ShadeAnimationChannel.js";
import { ShadeAnimationClip } from "../../animation/ShadeAnimationClip.js";
import type { Node3D } from "../../scene/Node3D.js";
import type { GltfDocument } from "./GltfLoader.js";
import { readAccessor } from "./gltfGeometry.js";

export const GltfInterpolation = {
  Step: 0,
  Linear: 1,
  CubicSpline: 2
} as const;

export type GltfInterpolation =
  (typeof GltfInterpolation)[keyof typeof GltfInterpolation];

export interface GltfAnimationChannel {
  sampler: number;
  target: { node?: number; path: string };
}

export interface GltfAnimationSampler {
  input: number;
  output: number;
  interpolation?: string;
}

export interface GltfAnimation {
  name?: string;
  channels: GltfAnimationChannel[];
  samplers: GltfAnimationSampler[];
}

export function gltfPathToProperty(path: string): number {
  switch (path) {
    case "translation":
      return 0;
    case "rotation":
      return 1;
    case "scale":
      return 2;
    default:
      return -1;
  }
}

export function gltfPropertyComponentCount(property: number): number {
  switch (property) {
    case 0:
    case 2:
      return 3;
    case 1:
      return 4;
    default:
      throw new Error(`Unsupported animated property ${property}`);
  }
}

export function gltfInterpolationCode(e: string | undefined): GltfInterpolation {
  switch (e) {
    case "STEP":
      return GltfInterpolation.Step;
    case "CUBICSPLINE":
      return GltfInterpolation.CubicSpline;
    case "LINEAR":
    case undefined:
      return GltfInterpolation.Linear;
    default:
      throw new Error(`Unsupported interpolation '${e}'`);
  }
}

export function flipQuaternionHemisphere(
  output: Float32Array,
  keyCount: number,
  interpolation: GltfInterpolation
): void {
  const cubic = interpolation === GltfInterpolation.CubicSpline;
  const stride = cubic ? 12 : 4;
  const valueOff = cubic ? 4 : 0;
  for (let n = 1; n < keyCount; n++) {
    const t = (n - 1) * stride + valueOff;
    const r = n * stride + valueOff;
    if (
      output[t]! * output[r]! +
        output[t + 1]! * output[r + 1]! +
        output[t + 2]! * output[r + 2]! +
        output[t + 3]! * output[r + 3]! <
      0
    ) {
      const start = n * stride;
      const end = start + stride;
      for (let i = start; i < end; i++) output[i] = -output[i]!;
    }
  }
}

export function fillCurveFromSampler(
  curve: AnimationCurve,
  interpolation: GltfInterpolation,
  output: ArrayLike<number>,
  times: ArrayLike<number>,
  componentCount: number,
  componentIndex: number
): void {
  const keyCount = times.length;
  switch (interpolation) {
    case GltfInterpolation.Step: {
      for (let i = 0; i < keyCount; i++) {
        curve.add(
          AnimationKeyframeData.from(
            times[i] as number,
            output[i * componentCount + componentIndex] as number,
            0,
            0
          )
        );
      }
      const keys = curve.keys;
      for (let e = keyCount - 1; e > 0; e--) {
        keys.splice(
          e,
          0,
          AnimationKeyframeData.from(
            keys[e]!.time,
            keys[e - 1]!.value,
            0,
            0
          )
        );
      }
      break;
    }
    case GltfInterpolation.Linear: {
      for (let i = 0; i < keyCount; i++) {
        curve.add(
          AnimationKeyframeData.from(
            times[i] as number,
            output[i * componentCount + componentIndex] as number,
            0,
            0
          )
        );
      }
      for (let t = 0; t < keyCount; t++) curve.alignTangents(t);
      break;
    }
    case GltfInterpolation.CubicSpline: {
      for (let i = 0; i < keyCount; i++) {
        const base = i * componentCount * 3;
        curve.add(
          AnimationKeyframeData.from(
            times[i] as number,
            output[base + componentCount + componentIndex] as number,
            output[base + componentIndex] as number,
            output[base + 2 * componentCount + componentIndex] as number
          )
        );
      }
      break;
    }
    default:
      throw new Error(`Unsupported type '${interpolation as number}'`);
  }
}

export function readFloatAccessor(
  doc: GltfDocument,
  accessorIndex: number
): Float32Array {
  const accessor = doc.accessors![accessorIndex]!;
  if (accessor.componentType !== 5126) {
    throw new Error(
      `Animation accessor ${accessorIndex} must use FLOAT components`
    );
  }
  return Float32Array.from(readAccessor(doc, accessorIndex, "animation").data);
}

export function buildGltfAnimationClips(
  doc: GltfDocument,
  nodeObjects: (Node3D | undefined)[]
): ShadeAnimationClip[] {
  const z: ShadeAnimationClip[] = [];
  const animations = (doc.animations ?? []) as GltfAnimation[];
  for (let e = 0; e < animations.length; e++) {
    const anim = animations[e]!;
    const channels: ShadeAnimationChannel[] = [];
    for (let c = 0; c < anim.channels.length; c++) {
      const ch = anim.channels[c]!;
      const target = ch.target;
      const property = gltfPathToProperty(target.path);
      if (property === -1) continue;
      if (target.node === undefined) continue;
      const node = nodeObjects[target.node]!;
      const sampler = anim.samplers[ch.sampler]!;
      const times = readFloatAccessor(doc, sampler.input);
      const values = readFloatAccessor(doc, sampler.output);
      const interpolation = gltfInterpolationCode(sampler.interpolation);
      const compCount = gltfPropertyComponentCount(property);
      if (property === 1 && times.length >= 2) {
        flipQuaternionHemisphere(values, times.length, interpolation);
      }
      const axis = ["x", "y", "z", "w"] as const;
      const curves: {
        x?: AnimationCurve;
        y?: AnimationCurve;
        z?: AnimationCurve;
        w?: AnimationCurve;
      } = {};
      for (let i = 0; i < compCount; i++) {
        const curve = new AnimationCurve();
        fillCurveFromSampler(
          curve,
          interpolation,
          values,
          times,
          compCount,
          i
        );
        curves[axis[i]!] = curve;
      }
      channels.push(
        ShadeAnimationChannel.from({
          target: node,
          property,
          curves
        })
      );
    }
    if (channels.length === 0) continue;
    const clip = ShadeAnimationClip.from({
      name: anim.name ?? "",
      channels
    });
    let curveCountBefore = 0;
    for (let e = 0; e < clip.channels.length; e++) {
      curveCountBefore += clip.channels[e]!.curve_count;
    }
    clip.optimize();
    let curveCountAfter = 0;
    for (let e = 0; e < clip.channels.length; e++) {
      curveCountAfter += clip.channels[e]!.curve_count;
    }
    void curveCountBefore;
    void curveCountAfter;
    z.push(clip);
  }
  return z;
}
