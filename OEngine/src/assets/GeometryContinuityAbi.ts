/** Cooked Geometry Product continuity-v2 metadata. Independent of Surface execution. */
export const GEOMETRY_CONTINUITY_BYTES = 64;
export const GEOMETRY_CONTINUITY_VERSION = 2;
export const GEOMETRY_METADATA_GROUP_FLAG = 1 << 6;
export const GEOMETRY_CONTINUITY_V2_GROUP_FLAG = 1 << 7;
export interface GeometryContinuityMetadata {
  readonly domain: number;
  readonly uv0Domain: number;
  readonly uv1Domain: number;
  readonly normalDomain: number;
  readonly tangentDomain: number;
  readonly colorDomain: number;
  readonly risk: number;
  readonly fieldRisk: number;
  readonly tangentVariation: number;
  readonly lodLocalFieldMask: number;
  readonly normalVariation: number;
  readonly colorVariation: number;
  readonly uv0Span: readonly [number, number];
  readonly uv1Span: readonly [number, number];
  readonly positionError: number;
  readonly attributeError: number;
}
export function decodeGeometryContinuity(bytes: Uint8Array, offset: number): GeometryContinuityMetadata {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + GEOMETRY_CONTINUITY_BYTES > bytes.byteLength) {
    throw new RangeError("Geometry continuity metadata range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, GEOMETRY_CONTINUITY_BYTES);
  return Object.freeze({
    domain: view.getUint32(0, true),
    uv0Domain: view.getUint32(4, true),
    uv1Domain: view.getUint32(8, true),
    normalDomain: view.getUint32(12, true),
    tangentDomain: view.getUint32(16, true),
    colorDomain: view.getUint32(20, true),
    risk: view.getUint32(24, true),
    fieldRisk: view.getUint32(28, true),
    tangentVariation: 1 - Math.cos(((view.getUint32(28, true) >>> 24) / 255) * Math.PI),
    lodLocalFieldMask: (view.getUint32(28, true) >>> 16) & 63,
    normalVariation: view.getFloat32(32, true),
    colorVariation: view.getFloat32(36, true),
    uv0Span: [view.getFloat32(40, true), view.getFloat32(44, true)] as const,
    uv1Span: [view.getFloat32(48, true), view.getFloat32(52, true)] as const,
    positionError: view.getFloat32(56, true),
    attributeError: view.getFloat32(60, true)
  });
}
