import type { GlbByteRange, GlbCookPrimitive } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import { WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES, WEB_GEOMETRY_CANONICAL_HEADER_BYTES, WEB_GEOMETRY_CANONICAL_VERTEX_BYTES } from "./wasm/WebGeometryCookerAbi.js";

export interface CanonicalWindowPlan {
  readonly units: readonly GlbCookPrimitive[];
  readonly sourceBytes: number;
  readonly canonicalBytes: number;
}

/** Deterministic whole-primitive windows; callers spatially expand oversized units first. */
export function planCanonicalWindows(units: readonly GlbCookPrimitive[], maxSourceBytes: number, maxCanonicalBytes: number): readonly CanonicalWindowPlan[] {
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0 || !Number.isSafeInteger(maxCanonicalBytes) || maxCanonicalBytes <= 0) throw new RangeError("canonical window budgets must be positive safe integers");
  const windows: CanonicalWindowPlan[] = [];
  let pending: GlbCookPrimitive[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    windows.push(Object.freeze({ units: Object.freeze(pending), sourceBytes: estimateSourceBytes(pending), canonicalBytes: estimateCanonicalBytes(pending) }));
    pending = [];
  };
  for (const unit of units) {
    const singleSource = estimateSourceBytes([unit]), singleCanonical = estimateCanonicalBytes([unit]);
    if (singleSource > maxSourceBytes || singleCanonical > maxCanonicalBytes) throw new Error(`canonical unit ${unit.meshIndex}:${unit.primitiveIndex} requires source=${singleSource}, canonical=${singleCanonical}; spatial expansion is required before primitive window planning`);
    const candidate = [...pending, unit];
    if (pending.length > 0 && (estimateSourceBytes(candidate) > maxSourceBytes || estimateCanonicalBytes(candidate) > maxCanonicalBytes)) flush();
    pending.push(unit);
  }
  flush();
  return Object.freeze(windows);
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
