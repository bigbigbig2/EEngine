import { SURFACE_CELL_PLAN_MODE as MODE, SURFACE_CELL_PLANE_COUNT, SURFACE_CELL_FIELD_COUNT,
  SURFACE_CELL_SIGNAL as SIGNAL, SURFACE_CELL_RATE as RATE, packSurfaceCellSixBit } from "../../gpu/GpuSurfaceCellPlanAbi.js";

/** Independent CPU oracle input. Bounds describe filtered field/geometry facts,
 * not a CPU production classifier or a request to evaluate per-pixel material. */
export interface SurfaceCellReferenceLane {
  readonly covered: boolean;
  readonly winner: number;
  readonly geometryIdentity: readonly number[]; // complete instance/product/domain/side tuple
  readonly planeIdentity: readonly (readonly number[])[];
  readonly worldPosition: readonly [number, number, number];
  readonly plane: readonly [number, number, number, number];
  readonly worldUnitsPerPixel: number;
  readonly normal: readonly [number, number, number];
  readonly normalCone: number;
  readonly view: readonly [number, number, number];
  readonly roughnessLow: number;
  readonly coatRoughnessLow: number;
  readonly enabledMask: number;
  readonly publicationMask: number;
  readonly unknownMask: number;
  readonly directSafe: boolean;
  readonly valueHitMask?: number;
  readonly clusterIdentity?: readonly number[];
  readonly bounds: readonly { readonly low: readonly number[]; readonly high: readonly number[] }[];
}
export interface SurfaceCellReferencePlan {
  readonly mode: number;
  readonly rate: number;
  readonly groups: readonly (readonly number[])[];
  readonly slotCount: number;
  readonly ownerMap: Uint32Array<ArrayBuffer>;
  readonly representativeMap: Uint32Array<ArrayBuffer>;
  readonly crossWinnerGroups: number;
}
export const SURFACE_CELL_DEFAULT_ERROR = Object.freeze({ field: 0.02,
  normalRadians: 3 * Math.PI / 180, planePixels: 0.5, roughness: 0.35 });
const tupleEqual = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const angle = (a: readonly number[], b: readonly number[]): number => {
  const length = Math.hypot(...a) * Math.hypot(...b);
  if (!(length > 0)) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i]!, 0) / length)));
};
function canShare(lanes: readonly SurfaceCellReferenceLane[], members: readonly number[], plane: number): boolean {
  if (members.length < 2) return true;
  const first = lanes[members[0]!]!, bit = 1 << plane;
  const diffuse = plane === SIGNAL.directDiffuse || plane === SIGNAL.environmentDiffuse;
  const coat = plane === SIGNAL.directCoat || plane === SIGNAL.environmentCoat;
  for (const index of members) {
    const item = lanes[index]!;
    // Winner equality deliberately does not appear here.
    if (!tupleEqual(item.geometryIdentity, first.geometryIdentity) || !tupleEqual(item.planeIdentity[plane]!, first.planeIdentity[plane]!) ||
      (item.unknownMask & bit) !== 0) return false;
    const distance = Math.abs(first.plane[0] * item.worldPosition[0] + first.plane[1] * item.worldPosition[1] + first.plane[2] * item.worldPosition[2] + first.plane[3]);
    if (!(item.worldUnitsPerPixel > 0) || distance / item.worldUnitsPerPixel > SURFACE_CELL_DEFAULT_ERROR.planePixels) return false;
    if (plane >= SURFACE_CELL_FIELD_COUNT) {
      if (angle(item.normal, first.normal) + item.normalCone + first.normalCone > SURFACE_CELL_DEFAULT_ERROR.normalRadians) return false;
      if ((plane === SIGNAL.directDiffuse || plane === SIGNAL.directSpecular || plane === SIGNAL.directCoat) && !item.directSafe) return false;
      if ((plane === SIGNAL.directDiffuse || plane === SIGNAL.directSpecular || plane === SIGNAL.directCoat) &&
        !tupleEqual(item.clusterIdentity ?? [0], first.clusterIdentity ?? [0])) return false;
      if (!diffuse) {
        const roughness = coat ? item.coatRoughnessLow : item.roughnessLow;
        if (roughness < SURFACE_CELL_DEFAULT_ERROR.roughness || angle(item.view, first.view) > roughness * 0.1) return false;
      }
    }
  }
  if (plane < SURFACE_CELL_FIELD_COUNT) {
    const width = first.bounds[plane]!.low.length;
    const low = Array.from({ length: width }, (_, c) => Math.min(...members.map(index => lanes[index]!.bounds[plane]!.low[c]!)));
    const high = Array.from({ length: width }, (_, c) => Math.max(...members.map(index => lanes[index]!.bounds[plane]!.high[c]!)));
    if (plane === 6 || plane === 12) {
      const center = low.map((v, c) => (v + high[c]!) * 0.5), radius = Math.hypot(...low.map((v, c) => (high[c]! - v) * 0.5));
      const length = Math.hypot(...center);
      return length > radius && 2 * Math.asin(Math.min(1, radius / length)) <= SURFACE_CELL_DEFAULT_ERROR.normalRadians;
    }
    const scale = plane === 5 ? Math.max(1, ...low.map(Math.abs), ...high.map(Math.abs)) : 1;
    if (high.some((v, c) => !Number.isFinite(v) || !Number.isFinite(low[c]) || v - low[c]! > SURFACE_CELL_DEFAULT_ERROR.field * scale)) return false;
  }
  return true;
}
const rectangles = (width: number, height: number): readonly (readonly number[])[] => {
  const result: number[][] = [];
  for (let y = 0; y < 8; y += height) for (let x = 0; x < 8; x += width) {
    const members: number[] = [];
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) members.push((y + dy) * 8 + x + dx);
    result.push(members);
  }
  return result;
};

/** Independent exhaustive numeric oracle for the same fixed rectangles. It
 * checks every member of each parent directly, without sharing GPU reductions. */
export function referenceSurfaceCellPlans(lanes: readonly SurfaceCellReferenceLane[]): readonly SurfaceCellReferencePlan[] {
  if (lanes.length !== 64) throw new RangeError("Surface tile oracle requires 64 lanes");
  const plans: SurfaceCellReferencePlan[] = [];
  for (let plane = 0; plane < SURFACE_CELL_PLANE_COUNT; plane++) {
    const bit = 1 << plane, active = lanes.map((lane, index) => ({ lane, index })).filter(v => v.lane.covered && (v.lane.enabledMask & bit) !== 0);
    if (active.length === 0 || active.every(v => (v.lane.publicationMask & bit) !== 0)) {
      plans.push({ mode: active.length === 0 ? MODE.empty : MODE.publication, rate: RATE.fine, groups: [], slotCount: 0,
        ownerMap: new Uint32Array(0), representativeMap: new Uint32Array(0), crossWinnerGroups: 0 }); continue;
    }
    const owner = Uint8Array.from({ length: 64 }, (_, i) => i);
    const merge = (region: readonly number[]): void => {
      const members = region.filter(index => lanes[index]!.covered && (lanes[index]!.enabledMask & bit) !== 0);
      if (members.length === 0) return;
      if (members.every(index => ((lanes[index]!.valueHitMask ?? 0) & bit) !== 0)) return;
      if (canShare(lanes, members, plane)) for (const member of members) owner[member] = members[0]!;
    };
    for (const region of rectangles(2, 2)) merge(region);
    for (const region of rectangles(4, 4)) merge(region);
    if (plane === SIGNAL.directDiffuse || plane === SIGNAL.environmentDiffuse) merge(Array.from({ length: 64 }, (_, i) => i));
    const grouped = new Map<number, number[]>();
    for (const { index } of active) { const key = owner[index]!; const group = grouped.get(key) ?? []; group.push(index); grouped.set(key, group); }
    const groups = [...grouped.values()], map = new Uint8Array(64), representatives = new Uint8Array(64);
    groups.forEach((group, index) => { representatives[index] = group[0]!; for (const member of group) map[member] = index; });
    let mode: number = groups.length === active.length ? MODE.fine : MODE.masked, rate: number = RATE.fine;
    if (mode !== MODE.fine) for (const [w, h, code] of [[8,8,RATE.eight],[4,4,RATE.four],[2,2,RATE.quad],[2,1,RATE.horizontal],[1,2,RATE.vertical]]) {
      if (w === 8 && plane !== SIGNAL.directDiffuse && plane !== SIGNAL.environmentDiffuse) continue;
      const grid = rectangles(w!, h!).map(region => region.filter(i => lanes[i]!.covered && (lanes[i]!.enabledMask & bit) !== 0)).filter(region => region.length !== 0);
      if (grid.length === groups.length && grid.every(region => groups.some(group => group.length === region.length && group.every(i => region.includes(i))))) {
        mode = MODE.grid; rate = code!; break;
      }
    }
    const slotCount = mode === MODE.fine ? 64 : mode === MODE.grid ? (8 >> (rate & 3)) * (8 >> ((rate >> 2) & 3)) : groups.length;
    plans.push(Object.freeze({ mode, rate, groups: Object.freeze(groups.map(group => Object.freeze(group))), slotCount,
      ownerMap: mode === MODE.masked ? packSurfaceCellSixBit(map) : new Uint32Array(0),
      representativeMap: mode === MODE.masked ? packSurfaceCellSixBit(representatives) : new Uint32Array(0),
      crossWinnerGroups: groups.filter(group => new Set(group.map(index => lanes[index]!.winner)).size > 1).length }));
  }
  return Object.freeze(plans);
}
