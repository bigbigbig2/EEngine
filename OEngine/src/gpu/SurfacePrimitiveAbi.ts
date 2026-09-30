export const SURFACE_PRIMITIVE_BYTES = 32;
export const SURFACE_METADATA_GROUP_FLAG = 1 << 6;
export interface SurfacePrimitiveMetadata {
  readonly domain: number;
  readonly risk: number;
  readonly normalVariation: number;
  readonly colorVariation: number;
  readonly uv0Span: readonly [number, number];
  readonly uv1Span: readonly [number, number];
}
export function decodeSurfacePrimitive(bytes: Uint8Array, offset: number): SurfacePrimitiveMetadata {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + SURFACE_PRIMITIVE_BYTES > bytes.byteLength) {
    throw new RangeError("Surface primitive metadata range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, SURFACE_PRIMITIVE_BYTES);
  return Object.freeze({ domain: view.getUint32(0, true), risk: view.getUint32(4, true),
    normalVariation: view.getFloat32(8, true), colorVariation: view.getFloat32(12, true),
    uv0Span: [view.getFloat32(16, true), view.getFloat32(20, true)] as const,
    uv1Span: [view.getFloat32(24, true), view.getFloat32(28, true)] as const });
}
