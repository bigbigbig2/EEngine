/**
 * Static SDR grade/LUT profile from Filament 41f996de8fcc2d6b60b73159aa1bc44a05a40700:
 * ColorGrading.cpp::hdrColorAt and ToneMapper.cpp::GT7ToneMapper.
 * Scene input and the GT7 curve work in linear Rec.2020. The canvas receives
 * sRGB OETF values. Dynamic exposure is applied by Present before LUT lookup.
 */
type Rgb = readonly [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const REC2020_TO_SRGB: Mat3 = [
  1.660491, -0.1245505, -0.0181508,
  -0.5876411, 1.1328999, -0.1005789,
  -0.0728499, -0.0083494, 1.1187297
];
const REC2020_TO_P3: Mat3 = [
  1.325984, -0.064249, 0.001639,
  -0.279603, 1.062031, -0.019010,
  -0.046381, 0.002218, 1.017371
];
const REC2020_TO_XYZ: Mat3 = [
  0.636953, 0.2626983, 0,
  0.1446169, 0.6780088, 0.0280731,
  0.1688558, 0.0592929, 1.0608272
];
const XYZ_TO_REC2020: Mat3 = [
  1.7166634, -0.6666738, 0.0176425,
  -0.3556733, 1.6164557, -0.042777,
  -0.2533681, 0.0157683, 0.9422433
];
const XYZ_TO_CAT16: Mat3 = [
  0.401288, -0.250268, -0.002079,
  0.650173, 1.204414, 0.048952,
  -0.051461, 0.045854, 0.953127
];
const CAT16_TO_XYZ: Mat3 = [
  1.862068, 0.387527, -0.015841,
  -1.011255, 0.621447, -0.034123,
  0.149187, -0.008974, 1.049964
];
const LUMA: Rgb = [0.2627002, 0.6779981, 0.0593017];
const D65_LMS: Rgb = [0.975533, 1.016483, 1.084837];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface SdrGradeOptions {
  readonly temperature?: number;
  readonly tint?: number;
  readonly slope?: Rgb;
  readonly offset?: Rgb;
  readonly power?: Rgb;
  readonly contrast?: number;
  readonly vibrance?: number;
  readonly saturation?: number;
}

const mul = (m: Mat3, v: Rgb): Rgb => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
];
function compose(a: Mat3, b: Mat3): Mat3 {
  const columns = [mul(a, [b[0], b[1], b[2]]),
    mul(a, [b[3], b[4], b[5]]), mul(a, [b[6], b[7], b[8]])];
  return columns.flat() as unknown as Mat3;
}
const dot = (a: Rgb, b: Rgb): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: number, b: number, w: number): number => a + (b - a) * w;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t);
};
const map = (v: Rgb, f: (x: number, i: number) => number): Rgb =>
  [f(v[0], 0), f(v[1], 1), f(v[2], 2)];

export function linearToLogC(x: number): number {
  return 0.244161 * Math.log10(5.555556 * Math.max(0, x) + 0.047996) + 0.386036;
}
export function logCToLinear(x: number): number {
  return Math.max(0, (10 ** ((x - 0.386036) / 0.244161) - 0.047996) / 5.555556);
}

function whiteBalance(temperature: number, tint: number): Mat3 {
  if (temperature === 0 && tint === 0) return IDENTITY;
  const x = 0.31271 - temperature * (temperature < 0 ? 0.0214 : 0.066);
  const y = 2.87 * x - 3 * x * x - 0.275 + tint * 0.066;
  const lms = mul(XYZ_TO_CAT16, [x / y, 1, (1 - x - y) / y]);
  const diagonal: Mat3 = [D65_LMS[0] / lms[0], 0, 0,
    0, D65_LMS[1] / lms[1], 0, 0, 0, D65_LMS[2] / lms[2]];
  return compose(compose(compose(XYZ_TO_REC2020, CAT16_TO_XYZ), diagonal),
    compose(XYZ_TO_CAT16, REC2020_TO_XYZ));
}

function pqEncode(nits: number): number {
  const y = (Math.max(0, nits) / 10000) ** 0.1593017578125;
  return ((0.8359375 + 18.8515625 * y) / (1 + 18.6875 * y)) ** 78.84375;
}
function pqDecode(encoded: number): number {
  const y = Math.max(0, encoded) ** (1 / 78.84375);
  return 10000 * (Math.max(y - 0.8359375, 0) /
    (18.8515625 - 18.6875 * y)) ** (1 / 0.1593017578125);
}
function rec2020ToIctcp(v: Rgb): Rgb {
  const l = pqEncode((1688 * v[0] + 2146 * v[1] + 262 * v[2]) * 100 / 4096);
  const m = pqEncode((683 * v[0] + 2951 * v[1] + 462 * v[2]) * 100 / 4096);
  const s = pqEncode((99 * v[0] + 309 * v[1] + 3688 * v[2]) * 100 / 4096);
  return [(l + m) * 0.5,
    (6610 * l - 13613 * m + 7003 * s) / 4096,
    (17933 * l - 17390 * m - 543 * s) / 4096];
}
function ictcpToRec2020(v: Rgb): Rgb {
  const l = pqDecode(v[0] + 0.00860904 * v[1] + 0.11103 * v[2]);
  const m = pqDecode(v[0] - 0.00860904 * v[1] - 0.11103 * v[2]);
  const s = pqDecode(v[0] + 0.560031 * v[1] - 0.320627 * v[2]);
  return [
    Math.max(0, (3.43661 * l - 2.50645 * m + 0.0698454 * s) / 100),
    Math.max(0, (-0.79133 * l + 1.9836 * m - 0.192271 * s) / 100),
    Math.max(0, (-0.0259499 * l - 0.0989137 * m + 1.12486 * s) / 100)
  ];
}

/** Filament GT7 target in scene-linear Rec.2020; peak is relative to 100 nits. */
function gt7Rec2020(v: Rgb, peak: number): Rgb {
  const k = (0.444 - 1) / (0.25 - 1);
  const ka = peak * (0.444 + k);
  const kb = -peak * k * Math.exp(0.444 / k);
  const kc = -1 / (k * peak);
  const skewed = map(v, x => {
    if (x <= 0) return 0;
    if (x >= 0.444 * peak) return ka + kb * Math.exp(x * kc);
    const w = smoothstep(0, 0.538, x);
    return mix(0.538 * (x / 0.538) ** 1.280, x, w);
  });
  const original = rec2020ToIctcp(v);
  const mapped = rec2020ToIctcp(skewed);
  const fade = 1 - smoothstep(0.98, 1.16, original[0] / pqEncode(peak * 100));
  const chromatic = ictcpToRec2020([mapped[0], original[1] * fade, original[2] * fade]);
  return map(skewed, (x, i) => Math.min(peak, mix(x, chromatic[i]!, 0.6)));
}

/** Filament GT7 SDR target: 250 nits, paper-white correction, ICtCp chroma fade. */
export function gt7SdrRec2020(v: Rgb): Rgb {
  return map(gt7Rec2020(v, 2.5), x => x / 2.5);
}

function gradeUntonedRec2020(input: Rgb, options: SdrGradeOptions): Rgb {
  let v = map(mul(whiteBalance(options.temperature ?? 0, options.tint ?? 0), input),
    x => Math.max(0, x));
  const slope = options.slope ?? [1, 1, 1];
  const offset = options.offset ?? [0, 0, 0];
  const power = options.power ?? [1, 1, 1];
  const contrast = options.contrast ?? 1;
  // Filament hdrColorAt: LogC -> ASC CDL -> contrast -> linear -> vibrance -> saturation.
  v = map(v, (x, i) => {
    let c = linearToLogC(x) * slope[i]! + offset[i]!;
    if (c > 0) c **= power[i]!;
    return logCToLinear(c * contrast + 0.4135884 * (1 - contrast));
  });
  const vibrance = options.vibrance ?? 1;
  if (vibrance !== 1) {
    const factor = (vibrance - 1) /
      (1 + Math.exp(-(v[0] - Math.max(v[1], v[2])) * 3)) + 1;
    const y = dot(v, LUMA);
    v = map(v, x => y * (1 - factor) + x * factor);
  }
  const saturation = options.saturation ?? 1;
  if (saturation !== 1) {
    const y = dot(v, LUMA);
    v = map(v, x => y + saturation * (x - y));
  }
  return map(v, x => Math.max(0, x));
}

export function gradeSdrRec2020(input: Rgb, options: SdrGradeOptions = {}): Rgb {
  return gt7SdrRec2020(gradeUntonedRec2020(input, options));
}

/** Extended linear Display-P3 output; 1.0 denotes 250 nits paper white. */
export function gradeHdrP3(input: Rgb, options: SdrGradeOptions = {}): Rgb {
  return map(mul(REC2020_TO_P3, gt7Rec2020(gradeUntonedRec2020(input, options), 10)),
    x => Math.max(0, x / 2.5));
}

export function buildSdrDisplayLut(size: number, options: SdrGradeOptions = {}): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(size) || size < 2 || size > 64) throw new RangeError("SDR LUT size");
  const data = new Uint8Array(new ArrayBuffer(size ** 3 * 4));
  let out = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) {
    for (let r = 0; r < size; r++) {
      const linear: Rgb = [logCToLinear(r / (size - 1)),
        logCToLinear(g / (size - 1)), logCToLinear(b / (size - 1))];
      const graded = mul(REC2020_TO_SRGB, gradeSdrRec2020(linear, options));
      for (const c of graded) {
        const x = clamp01(c);
        const oetf = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
        data[out++] = Math.round(oetf * 255);
      }
      data[out++] = 255;
    }
  }
  return data;
}

/** rgba16float LUT preserves values above 1 for extended HDR presentation. */
export function buildHdrDisplayLut(size: number, options: SdrGradeOptions = {}): Uint16Array<ArrayBuffer> {
  if (!Number.isInteger(size) || size < 2 || size > 64) throw new RangeError("HDR LUT size");
  const data = new Uint16Array(new ArrayBuffer(size ** 3 * 8));
  let out = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) {
    for (let r = 0; r < size; r++) {
      const linear: Rgb = [logCToLinear(r / (size - 1)),
        logCToLinear(g / (size - 1)), logCToLinear(b / (size - 1))];
      for (const value of gradeHdrP3(linear, options)) data[out++] = floatToHalf(value);
      data[out++] = 0x3c00;
    }
  }
  return data;
}

function floatToHalf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  const bytes = new ArrayBuffer(4);
  const bits = new DataView(bytes);
  bits.setFloat32(0, Math.min(value, 65504), true);
  const word = bits.getUint32(0, true);
  const exponent = ((word >>> 23) & 0xff) - 127 + 15;
  const mantissa = word & 0x7fffff;
  if (exponent <= 0) return exponent < -10 ? 0 :
    ((mantissa | 0x800000) >>> (14 - exponent));
  if (exponent >= 31) return 0x7bff;
  return (exponent << 10) | (mantissa >>> 13);
}
