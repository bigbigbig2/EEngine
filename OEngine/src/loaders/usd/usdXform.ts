/**
 * usdXform：解析 USD 数据并转换为引擎运行时对象。
 */

import {
  mat4Copy,
  mat4Identity,
  mat4Multiply
} from "../../core/math/Mat4.js";
import type { UsdSpecsByPath } from "./UsdExtensionRegistry.js";
import { getXformOpValue } from "./usdAttrs.js";

const DEG2RAD = Math.PI / 180;

function mat4Scale(
  out: Float32Array,
  a: Float32Array,
  v: [number, number, number]
): Float32Array {
  const [r, s, sc] = v;
  out[0] = a[0]! * r;
  out[1] = a[1]! * r;
  out[2] = a[2]! * r;
  out[3] = a[3]! * r;
  out[4] = a[4]! * s;
  out[5] = a[5]! * s;
  out[6] = a[6]! * s;
  out[7] = a[7]! * s;
  out[8] = a[8]! * sc;
  out[9] = a[9]! * sc;
  out[10] = a[10]! * sc;
  out[11] = a[11]! * sc;
  out[12] = a[12]!;
  out[13] = a[13]!;
  out[14] = a[14]!;
  out[15] = a[15]!;
  return out;
}

function mat4RotateX(
  out: Float32Array,
  a: Float32Array,
  rad: number
): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  if (out !== a) {
    out[0] = a[0]!;
    out[1] = a[1]!;
    out[2] = a[2]!;
    out[3] = a[3]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[4] = a10 * s + a20 * r;
  out[5] = a11 * s + a21 * r;
  out[6] = a12 * s + a22 * r;
  out[7] = a13 * s + a23 * r;
  out[8] = a20 * s - a10 * r;
  out[9] = a21 * s - a11 * r;
  out[10] = a22 * s - a12 * r;
  out[11] = a23 * s - a13 * r;
  return out;
}

function mat4RotateY(
  out: Float32Array,
  a: Float32Array,
  rad: number
): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  if (out !== a) {
    out[4] = a[4]!;
    out[5] = a[5]!;
    out[6] = a[6]!;
    out[7] = a[7]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[0] = a00 * s - a20 * r;
  out[1] = a01 * s - a21 * r;
  out[2] = a02 * s - a22 * r;
  out[3] = a03 * s - a23 * r;
  out[8] = a00 * r + a20 * s;
  out[9] = a01 * r + a21 * s;
  out[10] = a02 * r + a22 * s;
  out[11] = a03 * r + a23 * s;
  return out;
}

function mat4RotateZ(
  out: Float32Array,
  a: Float32Array,
  rad: number
): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  if (out !== a) {
    out[8] = a[8]!;
    out[9] = a[9]!;
    out[10] = a[10]!;
    out[11] = a[11]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[0] = a00 * s + a10 * r;
  out[1] = a01 * s + a11 * r;
  out[2] = a02 * s + a12 * r;
  out[3] = a03 * s + a13 * r;
  out[4] = a10 * s - a00 * r;
  out[5] = a11 * s - a01 * r;
  out[6] = a12 * s - a02 * r;
  out[7] = a13 * s - a03 * r;
  return out;
}

function mat4Translate(
  out: Float32Array,
  a: Float32Array,
  v: [number, number, number]
): Float32Array {
  const [m, g, p] = v;
  if (out === a) {
    out[12] = a[0]! * m + a[4]! * g + a[8]! * p + a[12]!;
    out[13] = a[1]! * m + a[5]! * g + a[9]! * p + a[13]!;
    out[14] = a[2]! * m + a[6]! * g + a[10]! * p + a[14]!;
    out[15] = a[3]! * m + a[7]! * g + a[11]! * p + a[15]!;
  } else {
    mat4Copy(out, a);
    out[12] = a[0]! * m + a[4]! * g + a[8]! * p + a[12]!;
    out[13] = a[1]! * m + a[5]! * g + a[9]! * p + a[13]!;
    out[14] = a[2]! * m + a[6]! * g + a[10]! * p + a[14]!;
    out[15] = a[3]! * m + a[7]! * g + a[11]! * p + a[15]!;
  }
  return out;
}

function mat4FromRowMajor(
  out: Float32Array,
  t: ArrayLike<number>
): Float32Array {
  out[0] = t[0]!;
  out[1] = t[4]!;
  out[2] = t[8]!;
  out[3] = t[12]!;
  out[4] = t[1]!;
  out[5] = t[5]!;
  out[6] = t[9]!;
  out[7] = t[13]!;
  out[8] = t[2]!;
  out[9] = t[6]!;
  out[10] = t[10]!;
  out[11] = t[14]!;
  out[12] = t[3]!;
  out[13] = t[7]!;
  out[14] = t[11]!;
  out[15] = t[15]!;
  return out;
}

function mat4FromQuatXYZW(
  out: Float32Array,
  x: number,
  y: number,
  z: number,
  w: number
): Float32Array {
  const a = x + x,
    i = y + y,
    o = z + z;
  const _ = x * a,
    c = y * a,
    d = y * i,
    u = z * a,
    l = z * i,
    f = z * o,
    h = w * a,
    m = w * i,
    g = w * o;
  out[0] = 1 - d - f;
  out[1] = c + g;
  out[2] = u - m;
  out[3] = 0;
  out[4] = c - g;
  out[5] = 1 - _ - f;
  out[6] = l + h;
  out[7] = 0;
  out[8] = u + m;
  out[9] = l - h;
  out[10] = 1 - _ - d;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

const _op = mat4Identity();
const _acc = mat4Identity();

export function applyXformOp(
  e: Float32Array,
  opToken: string,
  value: unknown
): void {
  const r = opToken.replace(/^xformOp:/, "");
  mat4Identity(_op);
  const n = value as ArrayLike<number>;

  if (r === "translate") {
    mat4Translate(_op, _op, [n[0]!, n[1]!, n[2]!]);
  } else if (r === "scale") {
    mat4Scale(_op, _op, [n[0]!, n[1]!, n[2]!]);
  } else if (r === "rotateX") {
    mat4RotateX(_op, _op, (value as number) * DEG2RAD);
  } else if (r === "rotateY") {
    mat4RotateY(_op, _op, (value as number) * DEG2RAD);
  } else if (r === "rotateZ") {
    mat4RotateZ(_op, _op, (value as number) * DEG2RAD);
  } else if (
    r === "rotateXYZ" ||
    r === "rotateXZY" ||
    r === "rotateYXZ" ||
    r === "rotateYZX" ||
    r === "rotateZXY" ||
    r === "rotateZYX"
  ) {
    const order = r.replace("rotate", "");
    const rx = n[0]! * DEG2RAD;
    const ry = n[1]! * DEG2RAD;
    const rz = n[2]! * DEG2RAD;
    for (let t = 0; t < order.length; t++) {
      const axis = order[t]!;
      if (axis === "X") mat4RotateX(_op, _op, rx);
      else if (axis === "Y") mat4RotateY(_op, _op, ry);
      else if (axis === "Z") mat4RotateZ(_op, _op, rz);
    }
  } else if (r === "orient") {
    mat4FromQuatXYZW(
      _op,
      n[1]!,
      n[2]!,
      n[3]!,
      n[0]!
    );
  } else if (r === "transform") {
    mat4FromRowMajor(_op, n);
  } else {
    console.warn(`[USD] Unknown xformOp: "${opToken}", skipping`);
    return;
  }

  mat4Multiply(_acc, e, _op);
  mat4Copy(e, _acc);
}

export function composeLocalXform(
  fields: Record<string, unknown>,
  specs: UsdSpecsByPath,
  primPath: string
): Float32Array {
  const order = fields.xformOpOrder as string[] | undefined;
  if (!order || order.length === 0) return mat4Identity();

  const s = mat4Identity();
  for (let a = 0; a < order.length; a++) {
    const i = order[a]!;
    const o = getXformOpValue(fields, specs, primPath, i);
    if (o !== null) applyXformOp(s, i, o);
  }
  return new Float32Array(s);
}
