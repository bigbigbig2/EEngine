import type { GlbByteRange, GlbCookPrimitive } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import { WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES, WEB_GEOMETRY_CANONICAL_HEADER_BYTES, WEB_GEOMETRY_CANONICAL_VERTEX_BYTES } from "./wasm/WebGeometryCookerAbi.js";

export interface CanonicalWindowPlan {
  readonly units: readonly GlbCookPrimitive[];
  readonly sourceBytes: number;
  readonly canonicalBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly domainCount: number;
}

export interface ProductWorkBudgetV1 {
  readonly maxSourceBytes: number;
  readonly maxCanonicalBytes: number;
  readonly maxTriangles: number;
  readonly maxVertices: number;
  readonly maxDomains: number;
}

export interface ProductWorkEstimateV1 {
  readonly sourceBytes: number;
  readonly canonicalBytes: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly domainCount: number;
}

/** Deterministic whole-primitive Products bounded by both memory and cook work. */
export function planCanonicalWindows(units: readonly GlbCookPrimitive[], budget: ProductWorkBudgetV1): readonly CanonicalWindowPlan[] {
  validateProductWorkBudgetV1(budget);
  const windows: CanonicalWindowPlan[] = [];
  let pending: GlbCookPrimitive[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    windows.push(Object.freeze({ units: Object.freeze(pending), ...estimateProductWorkV1(pending) }));
    pending = [];
  };
  for (const unit of units) {
    const single = estimateProductWorkV1([unit]);
    if (exceedsProductWorkBudgetV1(single, budget)) throw new Error(`canonical unit ${unit.meshIndex}:${unit.primitiveIndex} requires source=${single.sourceBytes}, canonical=${single.canonicalBytes}, triangles=${single.triangleCount}, vertices=${single.vertexCount}, domains=${single.domainCount}; spatial expansion is required before primitive window planning`);
    const candidate = [...pending, unit];
    if (pending.length > 0 && exceedsProductWorkBudgetV1(estimateProductWorkV1(candidate), budget)) flush();
    pending.push(unit);
  }
  flush();
  return Object.freeze(windows);
}

export function estimateProductWorkV1(units: readonly GlbCookPrimitive[]): ProductWorkEstimateV1 {
  let triangleCount = 0, vertexCount = 0;
  for (const unit of units) {
    triangleCount = checkedAdd(triangleCount, unit.triangleCount);
    vertexCount = checkedAdd(vertexCount, unit.vertexCount);
  }
  return Object.freeze({
    sourceBytes: estimateSourceBytes(units),
    canonicalBytes: estimateCanonicalBytes(units),
    triangleCount,
    vertexCount,
    domainCount: units.length
  });
}

export function exceedsProductWorkBudgetV1(estimate: ProductWorkEstimateV1, budget: ProductWorkBudgetV1): boolean {
  return estimate.sourceBytes > budget.maxSourceBytes ||
    estimate.canonicalBytes > budget.maxCanonicalBytes ||
    estimate.triangleCount > budget.maxTriangles ||
    estimate.vertexCount > budget.maxVertices ||
    estimate.domainCount > budget.maxDomains;
}

export function validateProductWorkBudgetV1(budget: ProductWorkBudgetV1): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function estimateSourceBytes(units: readonly GlbCookPrimitive[]): number {
  const ranges = new Map<string, GlbByteRange>();
  for (const unit of units) for (const range of unit.ranges) ranges.set(`${range.bufferIndex}:${range.byteOffset}:${range.byteLength}`, range);
  return [...ranges.values()].reduce((sum, range) => checkedAdd(sum, range.byteLength), 0);
}

export function estimateCanonicalBytes(units: readonly GlbCookPrimitive[]): number {
  if (units.length === 0) return 0;
  let vertices = 0, indices = 0;
  for (const unit of units) {
    vertices = checkedAdd(vertices, unit.vertexCount);
    indices = checkedAdd(indices, unit.indices?.count ?? unit.vertexCount);
  }
  const vertexOffset = align16(checkedAdd(WEB_GEOMETRY_CANONICAL_HEADER_BYTES, units.length * WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES));
  const indexOffset = align16(checkedAdd(vertexOffset, vertices * WEB_GEOMETRY_CANONICAL_VERTEX_BYTES));
  return align16(checkedAdd(indexOffset, indices * 4));
}

function align16(value: number): number { return Math.ceil(value / 16) * 16; }
function checkedAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value)) throw new RangeError("canonical window byte count exceeds safe integer range"); return value; }
