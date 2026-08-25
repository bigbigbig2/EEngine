/**
 * materialBucketId：定义材质参数、着色模型或材质资源绑定。
 */

import {
  ShadeDrawMode,
  ShadeDrawSide,
  ShadeTransparencyMode
} from "./enums.js";
import type { ShadeMaterial } from "./ShadeMaterial.js";

function qmBitWidth(enumObj: Record<string, number>): number {
  const t = Math.max(...Object.values(enumObj));
  return 32 - Math.clz32(t);
}

const km = qmBitWidth(ShadeTransparencyMode);
const Im = qmBitWidth(ShadeDrawMode);
const Fm = qmBitWidth(ShadeDrawSide);

export const BUCKET_ALPHA_BITS = km + 1;
export const BUCKET_DRAW_MODE_BITS = Im + 1;
export const BUCKET_SIDE_BITS = Fm + 1;
export const BUCKET_DRAW_MODE_SHIFT = 0 + km;
export const BUCKET_SIDE_SHIFT = BUCKET_DRAW_MODE_SHIFT + Im;

export const MATERIAL_BUCKET_COUNT = 1 << (km + Im + Fm);

export function materialBucketId(
  transparencyMode: number,
  drawMode: number,
  drawSide: number
): number {
  return (
    (transparencyMode & BUCKET_ALPHA_BITS) |
    ((drawMode & BUCKET_DRAW_MODE_BITS) << BUCKET_DRAW_MODE_SHIFT) |
    ((drawSide & BUCKET_SIDE_BITS) << BUCKET_SIDE_SHIFT)
  );
}

export function materialBucketIdOf(mat: {
  transparency_mode: number;
  draw_mode: number;
  draw_side: number;
}): number {
  return materialBucketId(
    mat.transparency_mode,
    mat.draw_mode,
    mat.draw_side
  );
}

export const DRAW_MODE_TOPOLOGY: Partial<
  Record<number, GPUPrimitiveTopology>
> = {
  [ShadeDrawMode.Triangles]: "triangle-list"
};

export const CULL_POLICY_STANDARD: Readonly<
  Record<number, GPUCullMode>
> = Object.freeze({
  [ShadeDrawSide.Front]: "back",
  [ShadeDrawSide.Back]: "front",
  [ShadeDrawSide.Double]: "none"
});

export const CULL_POLICY_REVERSED: Readonly<
  Record<number, GPUCullMode>
> = Object.freeze({
  [ShadeDrawSide.Front]: "front",
  [ShadeDrawSide.Back]: "back",
  [ShadeDrawSide.Double]: "none"
});

export function primitiveStateForBucket(
  drawMode: number,
  drawSide: number,
  cullPolicy: Readonly<Record<number, GPUCullMode>> = CULL_POLICY_STANDARD
): GPUPrimitiveState | null {
  const topology = DRAW_MODE_TOPOLOGY[drawMode];
  if (!topology) return null;
  const cullMode = cullPolicy[drawSide] ?? "none";
  return { topology, cullMode };
}

export type ActiveMaterialBucket = {
  bucketId: number;
  transparency_mode: number;
  draw_mode: number;
  draw_side: number;
};

export function collectActiveMaterialBuckets(
  materials: Iterable<ShadeMaterial | null | undefined>
): ActiveMaterialBucket[] {
  const seen = new Map<number, ActiveMaterialBucket>();
  for (const m of materials) {
    if (!m) continue;
    const id = materialBucketIdOf(m);
    if (seen.has(id)) continue;
    seen.set(id, {
      bucketId: id,
      transparency_mode: m.transparency_mode,
      draw_mode: m.draw_mode,
      draw_side: m.draw_side
    });
  }
  return Array.from(seen.values()).sort((a, b) => a.bucketId - b.bucketId);
}

export function listOpaqueActiveBuckets(
  active: ActiveMaterialBucket[]
): ActiveMaterialBucket[] {
  return active.filter(
    (b) => b.transparency_mode === ShadeTransparencyMode.Opaque
  );
}

export function listAlphaTestedActiveBuckets(
  active: ActiveMaterialBucket[]
): ActiveMaterialBucket[] {
  return active.filter(
    (b) =>
      b.transparency_mode === ShadeTransparencyMode.AlphaTested &&
      b.draw_mode === ShadeDrawMode.Triangles &&
      (b.draw_side === ShadeDrawSide.Front ||
        b.draw_side === ShadeDrawSide.Double)
  );
}

export function singleOpaquePrimitive(
  opaqueBuckets: ActiveMaterialBucket[],
  cullPolicy: Readonly<Record<number, GPUCullMode>> = CULL_POLICY_STANDARD
): GPUPrimitiveState | null {
  if (opaqueBuckets.length === 0) {
    return { topology: "triangle-list", cullMode: "none" };
  }
  const first = opaqueBuckets[0]!;
  for (let i = 1; i < opaqueBuckets.length; i++) {
    const b = opaqueBuckets[i]!;
    if (
      b.draw_mode !== first.draw_mode ||
      b.draw_side !== first.draw_side
    ) {
      return null;
    }
  }
  return primitiveStateForBucket(
    first.draw_mode,
    first.draw_side,
    cullPolicy
  );
}

export function buildMaterialIdToBucketMap(
  materials: Iterable<ShadeMaterial | null | undefined>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const m of materials) {
    if (!m) continue;
    map.set(m.id, materialBucketIdOf(m));
  }
  return map;
}

export function buildMaterialIdToBucketMapFromMeshes(
  meshes: Iterable<{ material?: ShadeMaterial | null }>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const mesh of meshes) {
    const m = mesh.material;
    if (!m) continue;
    if (!map.has(m.id)) map.set(m.id, materialBucketIdOf(m));
  }
  return map;
}
