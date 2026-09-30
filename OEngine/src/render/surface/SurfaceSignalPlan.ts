/** Signal-rate layout shared by the Surface probe, work builder and Resolve.
 *
 * The four two-bit fields intentionally live in one u32 so a cell keeps one
 * bounded record and no signal can accidentally acquire a second queue.
 * Rates use the existing Surface convention: 0 = full, 1 = horizontal,
 * 2 = vertical and 3 = 2x2.
 */
export const SURFACE_SIGNAL_SHIFT = Object.freeze({
  lighting: 0, material: 2, emissive: 4, normal: 6
} as const);
export const SURFACE_SIGNAL_PACKED_FLAG = 1 << 8;

export type SurfaceSignalGroup = keyof typeof SURFACE_SIGNAL_SHIFT;
export type SurfaceSignalRates = Readonly<Record<SurfaceSignalGroup, 0 | 1 | 2 | 3>>;

function rate(value: number): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new RangeError("Surface signal rate must be in [0, 3]");
  }
  return value as 0 | 1 | 2 | 3;
}

export function packSurfaceSignalRates(rates: SurfaceSignalRates): number {
  let packed = 0;
  for (const group of Object.keys(SURFACE_SIGNAL_SHIFT) as SurfaceSignalGroup[]) {
    packed |= rate(rates[group]) << SURFACE_SIGNAL_SHIFT[group];
  }
  return rates.material === rates.lighting && rates.emissive === rates.lighting && rates.normal === rates.lighting
    ? rates.lighting : (packed | SURFACE_SIGNAL_PACKED_FLAG) >>> 0;
}

export function unpackSurfaceSignalRates(packed: number): SurfaceSignalRates {
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new RangeError("Surface signal layout is invalid");
  }
  const lighting = ((packed >>> SURFACE_SIGNAL_SHIFT.lighting) & 3) as 0 | 1 | 2 | 3;
  const inherit = (packed & SURFACE_SIGNAL_PACKED_FLAG) === 0;
  return Object.freeze({
    lighting,
    material: (inherit ? lighting : (packed >>> SURFACE_SIGNAL_SHIFT.material) & 3) as 0 | 1 | 2 | 3,
    emissive: (inherit ? lighting : (packed >>> SURFACE_SIGNAL_SHIFT.emissive) & 3) as 0 | 1 | 2 | 3,
    normal: (inherit ? lighting : (packed >>> SURFACE_SIGNAL_SHIFT.normal) & 3) as 0 | 1 | 2 | 3
  });
}

/** The combined rate is the intersection of every demanded signal coverage. */
export function surfaceSignalEffectiveRate(rates: SurfaceSignalRates): 0 | 1 | 2 | 3 {
  let effective = 3;
  for (const group of Object.keys(SURFACE_SIGNAL_SHIFT) as SurfaceSignalGroup[]) {
    effective &= rate(rates[group]);
  }
  return effective as 0 | 1 | 2 | 3;
}

export interface SurfaceSignalRisk {
  readonly candidate: 0 | 1 | 2 | 3;
  readonly normalTexture?: boolean;
  readonly ormTexture?: boolean;
  readonly emissiveTexture?: boolean;
  readonly emissiveVariation?: number;
  readonly normalVariation?: number;
  readonly materialVariation?: number;
  readonly coated?: boolean;
  readonly sharpSpecular?: boolean;
  readonly shadow?: boolean;
  readonly aoVariation?: number;
  readonly budget?: number;
  readonly lighting?: 0 | 1 | 2 | 3;
}

/** CPU oracle for the signal split. Unknown or nonlinear closure inputs stay full. */
export function surfaceSignalRatesReference(input: SurfaceSignalRisk): SurfaceSignalRates {
  const candidate = rate(input.candidate);
  const budget = input.budget ?? 0;
  if (!Number.isFinite(budget) || budget < 0) throw new RangeError("Surface signal budget is invalid");
  const finite = (value: number | undefined) => value === undefined || Number.isFinite(value);
  if (!finite(input.emissiveVariation) || !finite(input.normalVariation) || !finite(input.materialVariation)) {
    return Object.freeze({ lighting: 0, material: 0, emissive: 0, normal: 0 });
  }
  const unsafeLighting = input.coated === true || input.sharpSpecular === true || input.shadow === true ||
    (input.aoVariation !== undefined && (!Number.isFinite(input.aoVariation) || input.aoVariation > budget));
  const materialSafe = !input.coated && !input.normalTexture && !input.ormTexture &&
    input.materialVariation !== undefined && input.materialVariation <= budget;
  const emissiveSafe = !input.emissiveTexture ||
    (input.emissiveVariation !== undefined && input.emissiveVariation <= budget);
  const normalSafe = !input.coated && !input.normalTexture &&
    input.normalVariation !== undefined && input.normalVariation <= budget;
  return Object.freeze({
    lighting: unsafeLighting ? 0 : (input.lighting === undefined ? candidate : rate(input.lighting)),
    material: materialSafe ? candidate : 0,
    emissive: emissiveSafe ? candidate : 0,
    normal: normalSafe ? candidate : 0
  });
}

export interface SurfaceResolveSample {
  readonly value: readonly [number, number, number, number];
  readonly domain: number;
  readonly depth: number;
  readonly normal: readonly [number, number, number];
  readonly valid: boolean;
  readonly identity: readonly [number, number, number];
  readonly representation: number;
  readonly layout: number;
  readonly position: readonly [number, number];
  readonly stride: readonly [number, number];
  readonly kind: 1 | 2;
}

/** Bounded owner/neighbor reconstruction oracle. It never crosses a surface domain. */
export function surfaceResolveReference(owner: SurfaceResolveSample,
  neighbors: readonly SurfaceResolveSample[], depthTolerance: number, normalTolerance: number,
  target: readonly [number, number] = owner.position, targetDepth = owner.depth): readonly [number, number, number, number] {
  if (!owner.valid || !Number.isFinite(depthTolerance) || depthTolerance < 0 ||
      !Number.isFinite(normalTolerance) || normalTolerance < 0) return owner.value;
  if (owner.kind !== 1 || !owner.stride.every(value => value === 1 || value === 2)) return owner.value;
  const fraction = target.map((value, index) => Math.max(0, Math.min(1,
    (value - owner.position[index]!) / owner.stride[index]!)));
  const weight = (corner: number) => ((corner & 1) ? fraction[0]! : 1 - fraction[0]!) *
    ((corner & 2) ? fraction[1]! : 1 - fraction[1]!);
  const result = [0, 0, 0, 0];
  let total = weight(0);
  for (let channel = 0; channel < 4; channel++) result[channel] = owner.value[channel]! * total;
  for (let corner = 1; corner < 4; corner++) {
    const position = [owner.position[0] + (corner & 1) * owner.stride[0],
      owner.position[1] + ((corner >> 1) & 1) * owner.stride[1]];
    const sample = neighbors.find(value => value.position.every((coordinate, index) => coordinate === position[index]));
    if (weight(corner) <= 0 || !sample || !sample.valid || owner.domain === 0 || sample.domain !== owner.domain ||
      sample.kind !== 1 || sample.layout !== owner.layout || sample.representation !== owner.representation ||
      !sample.identity.every((value, index) => value === owner.identity[index]) ||
      !(targetDepth >= 0 && targetDepth <= 1) || !Number.isFinite(sample.depth) || Math.abs(sample.depth - targetDepth) > depthTolerance ||
      !sample.normal.every((value, index) => Number.isFinite(value) && Math.abs(value - owner.normal[index]!) <= normalTolerance) ||
      !sample.value.every(value => Number.isFinite(value) && Math.abs(value) <= 65504)) continue;
    const contribution = weight(corner);
    for (let channel = 0; channel < 4; channel++) result[channel] = result[channel]! + sample.value[channel]! * contribution;
    total += contribution;
  }
  return total > 0 ? result.map(value => value / total) as [number, number, number, number] : owner.value;
}

export const SURFACE_SIGNAL_WGSL = /* wgsl */ `
const SURFACE_SIGNAL_LIGHTING_SHIFT:u32=${SURFACE_SIGNAL_SHIFT.lighting}u;
const SURFACE_SIGNAL_MATERIAL_SHIFT:u32=${SURFACE_SIGNAL_SHIFT.material}u;
const SURFACE_SIGNAL_EMISSIVE_SHIFT:u32=${SURFACE_SIGNAL_SHIFT.emissive}u;
const SURFACE_SIGNAL_NORMAL_SHIFT:u32=${SURFACE_SIGNAL_SHIFT.normal}u;
const SURFACE_SIGNAL_PACKED_FLAG:u32=${SURFACE_SIGNAL_PACKED_FLAG}u;
fn surface_signal_rate(packed:u32, shift:u32)->u32 {
  let value=(packed >> shift) & 3u;
  return select(value,packed & 3u,shift!=SURFACE_SIGNAL_LIGHTING_SHIFT &&
    (packed & SURFACE_SIGNAL_PACKED_FLAG)==0u);
}
fn surface_signal_effective(packed:u32)->u32 {
  return surface_signal_rate(packed,SURFACE_SIGNAL_LIGHTING_SHIFT) &
    surface_signal_rate(packed,SURFACE_SIGNAL_MATERIAL_SHIFT) &
    surface_signal_rate(packed,SURFACE_SIGNAL_EMISSIVE_SHIFT) &
    surface_signal_rate(packed,SURFACE_SIGNAL_NORMAL_SHIFT);
}
fn surface_signal_set(packed:u32, shift:u32, value:u32)->u32 {
  var expanded=packed;
  if (packed & SURFACE_SIGNAL_PACKED_FLAG)==0u {
    let rate=packed & 3u;
    expanded=rate | (rate<<2u) | (rate<<4u) | (rate<<6u) | SURFACE_SIGNAL_PACKED_FLAG;
  }
  return (expanded & ~(3u << shift)) | ((value & 3u) << shift);
}
`;
