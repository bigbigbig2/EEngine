import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";

/** Exact source-index mapping. Cyclic rotations preserve orientation; reversing
 * winding, duplicated seam vertices and simplified triangles do not alias.
 * An unchanged triangle keeps its source address across meshlet/LOD reordering.
 * A triangle without a source correspondence receives a distinct representation
 * identity. This is address integration, not a surface parameterization solver. */
export function prepareSurfacePrimitiveMapping(asset: Pick<GeometryAssetPackage,
  "indices" | "meshlets" | "meshletVertexIndices" | "meshletTriangleIndices">): {
  readonly words: Uint32Array<ArrayBuffer>;
  readonly meshletOffsets: readonly number[];
} {
  const ids = new Map<string, number>();
  const key = (a: number, b: number, c: number): string => {
    let first=a, second=b, third=c;
    if(b<first || b===first && c<second) { first=b; second=c; third=a; }
    if(c<first || c===first && a<second) { first=c; second=a; third=b; }
    return `${first}:${second}:${third}`;
  };
  for (let at = 0; at < asset.indices.length; at += 3) {
    const value = key(asset.indices[at]!, asset.indices[at + 1]!, asset.indices[at + 2]!);
    if (!ids.has(value)) ids.set(value, at / 3);
  }
  const total = asset.meshlets.reduce((sum, meshlet) => sum + meshlet.triangleCount, 0);
  if (asset.indices.length / 3 + total >= 0xffffffff) throw new RangeError("Surface primitive address space exhausted");
  const words = new Uint32Array(total), meshletOffsets: number[] = [];
  let next = asset.indices.length / 3, cursor = 0;
  for (const meshlet of asset.meshlets) {
    meshletOffsets.push(cursor);
    for (let triangle = 0; triangle < meshlet.triangleCount; triangle++) {
      const at = meshlet.triangleOffset + triangle * 3;
      const corner = (offset: number): number => asset.meshletVertexIndices[
        meshlet.vertexOffset + asset.meshletTriangleIndices[at + offset]!]!;
      const value = key(corner(0), corner(1), corner(2));
      let id = ids.get(value);
      if (id === undefined) { id = next++; ids.set(value, id); }
      words[cursor++] = id;
    }
  }
  return Object.freeze({ words, meshletOffsets: Object.freeze(meshletOffsets) });
}
