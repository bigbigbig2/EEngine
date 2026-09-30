export interface SurfaceProbeBudget {
  readonly color: number;
  readonly parameter: number;
  readonly normal: number;
  readonly depth: number;
  readonly uv: number;
  readonly lightingPosition?: number;
  readonly lightingView?: number;
  readonly minimumRoughness?: number;
}
export const EXACT_SURFACE_PROBE_BUDGET: SurfaceProbeBudget = Object.freeze({
  color: 0, parameter: 0, normal: 0, depth: 0, uv: 0
});
export const SURFACE_PROBE_REASONS = Object.freeze({
  cells: 0, pbrPixels: 1, full: 2, horizontal: 3, vertical: 4, quad: 5,
  invalid: 6, geometry: 7, continuity: 8, material: 9, residency: 10,
  variation: 11, uv: 12, samePrimitive: 13, crossPrimitive: 14, recoveries: 15
});
export const SURFACE_PROBE_COUNTER_BYTES = 64;
export const SURFACE_PROBE_LIGHTING_WORKGROUP_STORAGE_BYTES = 176 * 64;
export interface SurfaceLightingCellRisk {
  readonly shadow: boolean;
  readonly environment: boolean;
  readonly punctualLights: number;
  readonly roughness: number;
  readonly ormTexture: boolean;
  readonly positions: readonly (readonly [number, number, number])[];
  readonly viewDirections: readonly (readonly [number, number, number])[];
  readonly ao?: readonly number[];
}
export function surfaceLightingRateReference(candidate: 0 | 1 | 2 | 3,
  budget: SurfaceProbeBudget, risk: SurfaceLightingCellRisk): 0 | 1 | 2 | 3 {
  packSurfaceProbeBudget(budget);
  if (candidate === 0 || risk.shadow || risk.environment || risk.punctualLights !== 0 ||
      risk.ormTexture || !(risk.roughness >= (budget.minimumRoughness ?? 0.6) && risk.roughness <= 1) ||
      risk.positions.length !== 4 || risk.viewDirections.length !== 4 ||
      (risk.ao !== undefined && (risk.ao.length !== 4 || !risk.ao.every(value => Number.isFinite(value) && value === risk.ao![0])))) return 0;
  const difference = (values: readonly (readonly number[])[], begin: number, end: number, maximum: number) =>
    values[begin]!.every((value, index) => Number.isFinite(value) && Number.isFinite(values[end]![index]) &&
      Math.abs(value - values[end]![index]!) <= maximum);
  const pair = (begin: number, end: number) =>
    difference(risk.positions, begin, end, budget.lightingPosition ?? 0) &&
    difference(risk.viewDirections, begin, end, budget.lightingView ?? 0);
  const horizontal = (candidate & 1) !== 0 && pair(0, 1) && pair(2, 3);
  const vertical = (candidate & 2) !== 0 && pair(0, 2) && pair(1, 3);
  return (Number(horizontal) | (Number(vertical) << 1)) as 0 | 1 | 2 | 3;
}
export function packSurfaceProbeBudget(budget: SurfaceProbeBudget): Float32Array<ArrayBuffer> {
  const values = [budget.color, budget.parameter, budget.normal, budget.depth, budget.uv];
  if (!values.every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("SurfaceProbe requires finite nonnegative named signal budgets");
  }
  const lighting = [budget.lightingPosition ?? 0, budget.lightingView ?? 0, budget.minimumRoughness ?? 0.6];
  if (!lighting.every(value => Number.isFinite(value) && value >= 0) || lighting[2]! > 1) {
    throw new RangeError("Surface lighting budgets must be finite and nonnegative");
  }
  return new Float32Array([...values, ...lighting]);
}
export interface SurfaceProbeFact {
  readonly valid: boolean;
  readonly instance: number;
  readonly material: number;
  readonly geometry: number;
  readonly representation: number;
  readonly domain: number;
  readonly primitive: number;
  readonly depth: number;
  readonly normal: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly uv: readonly [number, number];
  readonly risk: number;
  readonly normalVariation?: number;
  readonly colorVariation?: number;
  readonly variation: number;
  readonly parameterVariation: number;
  readonly residencyValid: boolean;
}
export function surfaceProbePairReference(begin: SurfaceProbeFact, end: SurfaceProbeFact,
  budget: SurfaceProbeBudget, includeLighting = true): boolean {
  if (!begin.valid || !end.valid || begin.risk !== 0 || end.risk !== 0 ||
      !begin.residencyValid || !end.residencyValid || begin.instance !== end.instance ||
      begin.material !== end.material || begin.geometry !== end.geometry ||
      begin.representation !== end.representation || begin.domain === 0 || begin.domain !== end.domain) return false;
  const finite = [...begin.normal, ...end.normal, ...begin.color, ...end.color,
    ...begin.uv, ...end.uv, begin.depth, end.depth, begin.variation, end.variation,
    begin.parameterVariation, end.parameterVariation, begin.normalVariation ?? 0,
    end.normalVariation ?? 0, begin.colorVariation ?? 0, end.colorVariation ?? 0].every(Number.isFinite);
  if (!finite) return false;
  const difference = (left: readonly number[], right: readonly number[]) =>
    Math.max(...left.map((value, index) => Math.abs(value - right[index]!)));
  return (!includeLighting || (difference(begin.normal, end.normal) <= budget.normal &&
    Math.max(begin.normalVariation ?? 0, end.normalVariation ?? 0) <= budget.normal &&
    Math.abs(begin.depth - end.depth) <= budget.depth)) &&
    difference(begin.color, end.color) <= budget.color &&
    Math.max(begin.colorVariation ?? 0, end.colorVariation ?? 0, begin.variation, end.variation) <= budget.color &&
    Math.max(begin.parameterVariation, end.parameterVariation) <= budget.parameter &&
    ((begin.variation === 0 && end.variation === 0 && begin.parameterVariation === 0 && end.parameterVariation === 0) ||
      difference(begin.uv, end.uv) <= budget.uv);
}
export function surfaceProbeCellReference(facts: readonly SurfaceProbeFact[],
  budget: SurfaceProbeBudget): 0 | 1 | 2 | 3 {
  packSurfaceProbeBudget(budget);
  if (facts.length !== 4) return 0;
  const pair = (begin: number, end: number) => surfaceProbePairReference(facts[begin]!, facts[end]!, budget);
  const horizontal = pair(0, 1) && pair(2, 3);
  const vertical = pair(0, 2) && pair(1, 3);
  return horizontal && vertical ? 3 : horizontal ? 1 : vertical ? 2 : 0;
}
