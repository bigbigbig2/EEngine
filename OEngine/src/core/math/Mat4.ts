/**
 * Mat4：提供渲染系统使用的数学运算与基础数据结构。
 */

export function mat4Identity(out: Float32Array = new Float32Array(16)): Float32Array {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mat4Copy(out: Float32Array, a: Float32Array): Float32Array {
  out.set(a);
  return out;
}

export function mat4Invert(out: Float32Array, a: Float32Array): boolean {
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  const a30 = a[12]!,
    a31 = a[13]!,
    a32 = a[14]!,
    a33 = a[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return false;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;

  let b0 = b[0]!, b1 = b[1]!, b2 = b[2]!, b3 = b[3]!;
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[4]!; b1 = b[5]!; b2 = b[6]!; b3 = b[7]!;
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[8]!; b1 = b[9]!; b2 = b[10]!; b3 = b[11]!;
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[12]!; b1 = b[13]!; b2 = b[14]!; b3 = b[15]!;
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

export function mat4Perspective(
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number,
  far: number
): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

export function mat4PerspectiveInfiniteReverseZ(
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number
): Float32Array {
  const s = 1 / Math.tan(0.5 * fovy);
  out.fill(0);
  out[0] = s / aspect;
  out[5] = s;
  out[11] = -1;
  out[14] = near;
  return out;
}

export function mat4ViewFromWorldTransform(
  out: Float32Array,
  world: Float32Array
): Float32Array {
  const n = world[12]!;
  const r = world[13]!;
  const s = world[14]!;
  const a = world[0]!;
  const i = world[1]!;
  const o = world[2]!;
  const _ = world[4]!;
  const c = world[5]!;
  const d = world[6]!;
  const u = world[8]!;
  const l = world[9]!;
  const f = world[10]!;
  const dot = (x: number, y: number, z: number, rx: number, ry: number, rz: number) =>
    x * rx + y * ry + z * rz;
  out[0] = -a;
  out[4] = -i;
  out[8] = -o;
  out[1] = _;
  out[5] = c;
  out[9] = d;
  out[2] = -u;
  out[6] = -l;
  out[10] = -f;
  out[12] = dot(n, r, s, a, i, o);
  out[13] = -dot(n, r, s, _, c, d);
  out[14] = dot(n, r, s, u, l, f);
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
  return out;
}

export function mat4ExtractFrustumPlanes(
  out: Float32Array,
  vp: Float32Array
): void {
  const writePlane = (offset: number, x: number, y: number, z: number, w: number) => {
    const inverseLength = 1 / Math.hypot(x, y, z);
    out[offset] = x * inverseLength;
    out[offset + 1] = y * inverseLength;
    out[offset + 2] = z * inverseLength;
    out[offset + 3] = w * inverseLength;
  };
  const t = vp;
  writePlane(0, t[3]! + t[0]!, t[7]! + t[4]!, t[11]! + t[8]!, t[15]! + t[12]!);
  writePlane(4, t[3]! - t[0]!, t[7]! - t[4]!, t[11]! - t[8]!, t[15]! - t[12]!);
  writePlane(8, t[3]! + t[1]!, t[7]! + t[5]!, t[11]! + t[9]!, t[15]! + t[13]!);
  writePlane(12, t[3]! - t[1]!, t[7]! - t[5]!, t[11]! - t[9]!, t[15]! - t[13]!);
  writePlane(16, t[3]! - t[2]!, t[7]! - t[6]!, t[11]! - t[10]!, t[15]! - t[14]!);
  writePlane(20, t[2]!, t[6]!, t[10]!, t[14]!);
}

export function mat4LookAt(
  out: Float32Array,
  eye: { x: number; y: number; z: number },
  center: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }
): Float32Array {
  let zx = eye.x - center.x;
  let zy = eye.y - center.y;
  let zz = eye.z - center.z;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
  out[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
  out[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
  out[15] = 1;
  return out;
}

export function mat4FromTranslationScale(
  out: Float32Array,
  t: { x: number; y: number; z: number },
  s: { x: number; y: number; z: number }
): Float32Array {
  out.fill(0);
  out[0] = s.x;
  out[5] = s.y;
  out[10] = s.z;
  out[12] = t.x;
  out[13] = t.y;
  out[14] = t.z;
  out[15] = 1;
  return out;
}

export function mat4FromTRS(
  out: Float32Array,
  t: { x: number; y: number; z: number },
  q: { x: number; y: number; z: number; w: number },
  s: { x: number; y: number; z: number }
): Float32Array {
  const sx = q.x;
  const sy = q.y;
  const sz = q.z;
  const sw = q.w;
  const x2 = sx + sx;
  const y2 = sy + sy;
  const z2 = sz + sz;
  const xx = sx * x2;
  const xy = sx * y2;
  const xz = sx * z2;
  const yy = sy * y2;
  const yz = sy * z2;
  const zz = sz * z2;
  const wx = sw * x2;
  const wy = sw * y2;
  const wz = sw * z2;
  const bx = s.x;
  const by = s.y;
  const bz = s.z;
  out[0] = (1 - (yy + zz)) * bx;
  out[1] = (xy + wz) * bx;
  out[2] = (xz - wy) * bx;
  out[3] = 0;
  out[4] = (xy - wz) * by;
  out[5] = (1 - (xx + zz)) * by;
  out[6] = (yz + wx) * by;
  out[7] = 0;
  out[8] = (xz + wy) * bz;
  out[9] = (yz - wx) * bz;
  out[10] = (1 - (xx + yy)) * bz;
  out[11] = 0;
  out[12] = t.x;
  out[13] = t.y;
  out[14] = t.z;
  out[15] = 1;
  return out;
}

export function mat4ApplyDirection(
  out: { x: number; y: number; z: number },
  m: Float32Array,
  v: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  const t = v.x;
  const n = v.y;
  const r = v.z;
  const sx = m[0]! * t + m[4]! * n + m[8]! * r;
  const sy = m[1]! * t + m[5]! * n + m[9]! * r;
  const sz = m[2]! * t + m[6]! * n + m[10]! * r;
  const len = Math.hypot(sx, sy, sz) || 1;
  out.x = sx / len;
  out.y = sy / len;
  out.z = sz / len;
  return out;
}

export function mat4TransformAABB(
  out: Float32Array | { [i: number]: number },
  local: ArrayLike<number>,
  m: Float32Array
): void {
  out[0] = out[3] = m[12]!;
  out[1] = out[4] = m[13]!;
  out[2] = out[5] = m[14]!;
  for (let r = 0; r < 3; r++) {
    for (let s = 0; s < 3; s++) {
      const a = m[r + 4 * s]!;
      const i = a * local[s]!;
      const o = a * local[s + 3]!;
      if (i < o) {
        out[r] = (out[r] as number) + i;
        out[r + 3] = (out[r + 3] as number) + o;
      } else {
        out[r] = (out[r] as number) + o;
        out[r + 3] = (out[r + 3] as number) + i;
      }
    }
  }
}

export function mat4TransformPoint(
  out: { x: number; y: number; z: number },
  m: Float32Array,
  p: { x: number; y: number; z: number }
): void {
  const a = p.x;
  const i = p.y;
  const o = p.z;
  const w = 1 / (m[3]! * a + m[7]! * i + m[11]! * o + m[15]!);
  out.x = (m[0]! * a + m[4]! * i + m[8]! * o + m[12]!) * w;
  out.y = (m[1]! * a + m[5]! * i + m[9]! * o + m[13]!) * w;
  out.z = (m[2]! * a + m[6]! * i + m[10]! * o + m[14]!) * w;
}

export function mat4MaxColumnScale(m: Float32Array): number {
  const c0 = m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!;
  const c1 = m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!;
  const c2 = m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!;
  return Math.sqrt(Math.max(c0, c1, c2));
}

export function mat4Transpose(out: Float32Array, a: Float32Array): Float32Array {
  if (out === a) {
    const n = a[1]!;
    const r = a[2]!;
    const s = a[3]!;
    const u = a[6]!;
    const i = a[7]!;
    const o = a[11]!;
    out[1] = a[4]!;
    out[2] = a[8]!;
    out[3] = a[12]!;
    out[4] = n;
    out[6] = a[9]!;
    out[7] = a[13]!;
    out[8] = r;
    out[9] = u;
    out[11] = a[14]!;
    out[12] = s;
    out[13] = i;
    out[14] = o;
    return out;
  }
  out[0] = a[0]!;
  out[1] = a[4]!;
  out[2] = a[8]!;
  out[3] = a[12]!;
  out[4] = a[1]!;
  out[5] = a[5]!;
  out[6] = a[9]!;
  out[7] = a[13]!;
  out[8] = a[2]!;
  out[9] = a[6]!;
  out[10] = a[10]!;
  out[11] = a[14]!;
  out[12] = a[3]!;
  out[13] = a[7]!;
  out[14] = a[11]!;
  out[15] = a[15]!;
  return out;
}

export function mat4Scale(
  out: Float32Array,
  a: Float32Array,
  v: { x: number; y: number; z: number } | ArrayLike<number>
): Float32Array {
  let r: number;
  let s: number;
  let u: number;
  if (typeof (v as { x?: number }).x === "number") {
    const o = v as { x: number; y: number; z: number };
    r = o.x;
    s = o.y;
    u = o.z;
  } else {
    const o = v as ArrayLike<number>;
    r = o[0]!;
    s = o[1]!;
    u = o[2]!;
  }
  out[0] = a[0]! * r;
  out[1] = a[1]! * r;
  out[2] = a[2]! * r;
  out[3] = a[3]! * r;
  out[4] = a[4]! * s;
  out[5] = a[5]! * s;
  out[6] = a[6]! * s;
  out[7] = a[7]! * s;
  out[8] = a[8]! * u;
  out[9] = a[9]! * u;
  out[10] = a[10]! * u;
  out[11] = a[11]! * u;
  out[12] = a[12]!;
  out[13] = a[13]!;
  out[14] = a[14]!;
  out[15] = a[15]!;
  return out;
}

export function mat4RotateX(out: Float32Array, a: Float32Array, rad: number): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a4 = a[4]!;
  const a5 = a[5]!;
  const a6 = a[6]!;
  const a7 = a[7]!;
  const a8 = a[8]!;
  const a9 = a[9]!;
  const a10 = a[10]!;
  const a11 = a[11]!;
  if (a !== out) {
    out[0] = a[0]!;
    out[1] = a[1]!;
    out[2] = a[2]!;
    out[3] = a[3]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[4] = a4 * s + a8 * r;
  out[5] = a5 * s + a9 * r;
  out[6] = a6 * s + a10 * r;
  out[7] = a7 * s + a11 * r;
  out[8] = a8 * s - a4 * r;
  out[9] = a9 * s - a5 * r;
  out[10] = a10 * s - a6 * r;
  out[11] = a11 * s - a7 * r;
  return out;
}

export function mat4RotateY(out: Float32Array, a: Float32Array, rad: number): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a0 = a[0]!;
  const a1 = a[1]!;
  const a2 = a[2]!;
  const a3 = a[3]!;
  const a8 = a[8]!;
  const a9 = a[9]!;
  const a10 = a[10]!;
  const a11 = a[11]!;
  if (a !== out) {
    out[4] = a[4]!;
    out[5] = a[5]!;
    out[6] = a[6]!;
    out[7] = a[7]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[0] = a0 * s - a8 * r;
  out[1] = a1 * s - a9 * r;
  out[2] = a2 * s - a10 * r;
  out[3] = a3 * s - a11 * r;
  out[8] = a0 * r + a8 * s;
  out[9] = a1 * r + a9 * s;
  out[10] = a2 * r + a10 * s;
  out[11] = a3 * r + a11 * s;
  return out;
}

export function mat4RotateZ(out: Float32Array, a: Float32Array, rad: number): Float32Array {
  const r = Math.sin(rad);
  const s = Math.cos(rad);
  const a0 = a[0]!;
  const a1 = a[1]!;
  const a2 = a[2]!;
  const a3 = a[3]!;
  const a4 = a[4]!;
  const a5 = a[5]!;
  const a6 = a[6]!;
  const a7 = a[7]!;
  if (a !== out) {
    out[8] = a[8]!;
    out[9] = a[9]!;
    out[10] = a[10]!;
    out[11] = a[11]!;
    out[12] = a[12]!;
    out[13] = a[13]!;
    out[14] = a[14]!;
    out[15] = a[15]!;
  }
  out[0] = a0 * s + a4 * r;
  out[1] = a1 * s + a5 * r;
  out[2] = a2 * s + a6 * r;
  out[3] = a3 * s + a7 * r;
  out[4] = a4 * s - a0 * r;
  out[5] = a5 * s - a1 * r;
  out[6] = a6 * s - a2 * r;
  out[7] = a7 * s - a3 * r;
  return out;
}

export function mat4Ortho(
  out: Float32Array,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number
): Float32Array {
  const o = 1 / (left - right);
  const _ = 1 / (bottom - top);
  const c = 1 / (near - far);
  out[0] = -2 * o;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * _;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = c;
  out[11] = 0;
  out[12] = (left + right) * o;
  out[13] = (top + bottom) * _;
  out[14] = near * c;
  out[15] = 1;
  return out;
}

export function mat4Create(): Float32Array {
  return mat4Identity();
}

export function mat4Clone(a: Float32Array | ArrayLike<number>): Float32Array {
  const t = new Float32Array(16);
  for (let i = 0; i < 16; i++) t[i] = a[i]!;
  return t;
}

export function vec3Create(): Float32Array {
  return new Float32Array(3);
}

export function vec3FromValues(e: number, t: number, n: number): Float32Array {
  const r = new Float32Array(3);
  r[0] = e;
  r[1] = t;
  r[2] = n;
  return r;
}

export function vec3Copy(out: Float32Array, a: ArrayLike<number>): Float32Array {
  out[0] = a[0]!;
  out[1] = a[1]!;
  out[2] = a[2]!;
  return out;
}

export function vec3Set(
  out: Float32Array,
  x: number,
  y: number,
  z: number
): Float32Array {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vec3Min(
  out: Float32Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>
): Float32Array {
  out[0] = Math.min(a[0]!, b[0]!);
  out[1] = Math.min(a[1]!, b[1]!);
  out[2] = Math.min(a[2]!, b[2]!);
  return out;
}

export function vec3Max(
  out: Float32Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>
): Float32Array {
  out[0] = Math.max(a[0]!, b[0]!);
  out[1] = Math.max(a[1]!, b[1]!);
  out[2] = Math.max(a[2]!, b[2]!);
  return out;
}

export function vec3TransformMat4(
  out: Float32Array,
  a: ArrayLike<number>,
  m: ArrayLike<number>
): Float32Array {
  const r = a[0]!;
  const s = a[1]!;
  const t = a[2]!;
  let i = m[3]! * r + m[7]! * s + m[11]! * t + m[15]!;
  i = i || 1;
  out[0] = (m[0]! * r + m[4]! * s + m[8]! * t + m[12]!) / i;
  out[1] = (m[1]! * r + m[5]! * s + m[9]! * t + m[13]!) / i;
  out[2] = (m[2]! * r + m[6]! * s + m[10]! * t + m[14]!) / i;
  return out;
}

export function quatCreate(): Float32Array {
  const e = new Float32Array(4);
  e[3] = 1;
  return e;
}

export function mat4Translate(
  out: Float32Array,
  a: Float32Array,
  v: { x: number; y: number; z: number } | ArrayLike<number>
): Float32Array {
  let m: number;
  let g: number;
  let p: number;
  if (typeof (v as { x?: number }).x === "number") {
    const o = v as { x: number; y: number; z: number };
    m = o.x;
    g = o.y;
    p = o.z;
  } else {
    const o = v as ArrayLike<number>;
    m = o[0]!;
    g = o[1]!;
    p = o[2]!;
  }
  const a0 = a[0]!;
  const a1 = a[1]!;
  const a2 = a[2]!;
  const a3 = a[3]!;
  const a4 = a[4]!;
  const a5 = a[5]!;
  const a6 = a[6]!;
  const a7 = a[7]!;
  const a8 = a[8]!;
  const a9 = a[9]!;
  const a10 = a[10]!;
  const a11 = a[11]!;
  if (out !== a) {
    out[0] = a0;
    out[1] = a1;
    out[2] = a2;
    out[3] = a3;
    out[4] = a4;
    out[5] = a5;
    out[6] = a6;
    out[7] = a7;
    out[8] = a8;
    out[9] = a9;
    out[10] = a10;
    out[11] = a11;
  }
  out[12] = a0 * m + a4 * g + a8 * p + a[12]!;
  out[13] = a1 * m + a5 * g + a9 * p + a[13]!;
  out[14] = a2 * m + a6 * g + a10 * p + a[14]!;
  out[15] = a3 * m + a7 * g + a11 * p + a[15]!;
  return out;
}

export function aabbExtentLength(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function aabbToBoundingSphere(
  out: Float32Array,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
): Float32Array {
  out[0] = 0.5 * (x0 + x1);
  out[1] = 0.5 * (y0 + y1);
  out[2] = 0.5 * (z0 + z1);
  out[3] = aabbExtentLength(x0, y0, z0, x1, y1, z1);
  return out;
}
