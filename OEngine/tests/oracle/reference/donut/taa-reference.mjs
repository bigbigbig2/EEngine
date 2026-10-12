/** CPU oracle for NVIDIA Donut e50042f4bbd762971cc90431261e967404855b81.
 * Source: shaders/passes/taa_cs.hlsl, SAMPLE_COUNT=1, Catmull-Rom enabled.
 * Uses the source's nine bilinear fetches, independently of the WGSL port's
 * sixteen point-load expansion. The EEngine own-motion/qualification delta
 * is explicit in resolvePixel; no engine shader helpers are imported.
 *
 * Copyright (c) 2014-2021, NVIDIA CORPORATION. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export function pqEncode(value, maximum = 1e8) {
  const lm = Math.max(0, value / maximum) ** (2610 / 16384);
  return clamp(((3424 / 4096 + (2413 / 128) * lm) / (1 + (2392 / 128) * lm)) ** (2523 / 32), 0, 1);
}
export function pqDecode(value, maximum = 1e8) {
  const np = Math.max(0, value) ** (32 / 2523);
  return Math.max(0, (np - 3424 / 4096) / (2413 / 128 - (2392 / 128) * np)) ** (16384 / 2610) * maximum;
}
function weights(f) {
  const f2 = f * f,
    f3 = f2 * f;
  const w0 = f2 - 0.5 * (f3 + f),
    w1 = 1.5 * f3 - 2.5 * f2 + 1;
  const w3 = 0.5 * (f3 - f2);
  return [w0, w1, 1 - w0 - w1 - w3, w3];
}
function load(image, width, height, x, y, channel) {
  return x < 0 || y < 0 || x >= width || y >= height ? 0 : image[(y * width + x) * 4 + channel];
}
function bilinear(image, width, height, x, y, channel) {
  const bx = Math.floor(x),
    by = Math.floor(y),
    fx = x - bx,
    fy = y - by;
  return (
    load(image, width, height, bx, by, channel) * (1 - fx) * (1 - fy) +
    load(image, width, height, bx + 1, by, channel) * fx * (1 - fy) +
    load(image, width, height, bx, by + 1, channel) * (1 - fx) * fy +
    load(image, width, height, bx + 1, by + 1, channel) * fx * fy
  );
}
export function sampleHistory(image, width, height, x, y, channel) {
  const bx = Math.floor(x),
    by = Math.floor(y);
  const wx = weights(x - bx),
    wy = weights(y - by);
  const xs = [bx - 1, bx + wx[2] / (wx[1] + wx[2]), bx + 2];
  const ys = [by - 1, by + wy[2] / (wy[1] + wy[2]), by + 2];
  const xw = [wx[0], wx[1] + wx[2], wx[3]],
    yw = [wy[0], wy[1] + wy[2], wy[3]];
  let result = 0;
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++)
      result += bilinear(image, width, height, xs[i], ys[j], channel) * xw[i] * yw[j];
  return Math.max(0, result);
}
export function resolvePixel({
  color,
  feedback,
  width,
  height,
  x,
  y,
  jitter,
  motion,
  exposure,
  valid,
  coverage,
  reactive,
  maxRadiance = 1e8,
}) {
  const sx = Math.round(jitter[0]),
    sy = Math.round(jitter[1]);
  const qx = x + sx,
    qy = y + sy;
  const hx = x - motion[0],
    hy = y - motion[1];
  const supported =
    valid &&
    coverage > 0 &&
    reactive < 1 &&
    hx + 0.5 >= 0 &&
    hy + 0.5 >= 0 &&
    hx + 0.5 < width &&
    hy + 0.5 < height;
  const distance2 = (jitter[0] - sx) ** 2 + (jitter[1] - sy) ** 2;
  const mv = clamp(Math.hypot(...motion), 0, 1);
  const motionWeight = mv * mv * (3 - 2 * mv);
  const sourceWeight = clamp(Math.max(motionWeight, clamp(1 - distance2, 0, 1)) * 0.1, 0, 1);
  const blend = 1 - (1 - sourceWeight) * clamp(coverage, 0, 1) * (1 - reactive);
  const pq = [],
    hdr = [];
  for (let channel = 0; channel < 3; channel++) {
    let first = 0,
      second = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const v = pqEncode(load(color, width, height, qx + dx, qy + dy, channel) / exposure, maxRadiance);
        first += v;
        second += v * v;
      }
    first /= 9;
    second /= 9;
    const sigma = Math.sqrt(Math.max(0, second - first * first));
    const current = pqEncode(load(color, width, height, qx, qy, channel) / exposure, maxRadiance);
    const history = sampleHistory(feedback, width, height, hx, hy, channel);
    const clipped = clamp(history, first - sigma, first + sigma);
    const result = supported ? clipped * (1 - blend) + current * blend : current;
    pq.push(result);
    hdr.push(pqDecode(result, maxRadiance) * exposure);
  }
  return { pq, hdr };
}
