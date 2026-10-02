import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import { buildSurfaceContinuity, SURFACE_CONTINUITY_IDENTITY_RISK,
  type SurfaceContinuityInput } from "../geometry/SurfaceContinuity.js";
import { SURFACE_PRIMITIVE_BYTES } from "./SurfacePrimitiveAbi.js";
import { GPU_FRAME_ATTRIBUTE_STRIDE } from "./GpuFrameGeometryAttributesAbi.js";

/** Ordinary geometry uses unchanged source vertices for coarse index LODs.
 * Intersect each actual triangle's corner lineage independently per field.
 * Failed correspondence gets an explicitly LOD-local field domain; geometry
 * does not become domain=0 because some other field cannot inherit. */
export function prepareGeometrySurfacePublication(asset: GeometryAssetPackage,
  residentAttributes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const vertices = new Float32Array(residentAttributes.buffer, residentAttributes.byteOffset, residentAttributes.byteLength / 4);
  const base: Omit<SurfaceContinuityInput, "indices"> = { vertices, stride: GPU_FRAME_ATTRIBUTE_STRIDE / 4,
    normal: 0, tangent: 4, uv0: 8, uv1: 10, color: 12, position: 20 };
  const sourceCount = asset.indices.length / 3;
  const sourceMaterials = new Uint32Array(sourceCount);
  for (const range of asset.materialRanges) {
    for (let triangle = range.firstTriangle; triangle < range.firstTriangle + range.triangleCount; triangle++) {
      sourceMaterials[triangle] = range.materialId;
    }
  }
  const source = buildSurfaceContinuity({ ...base, indices: asset.indices, materialIds: sourceMaterials });
  // Lineage sets are publication scratch, not long-lived GPU/Loader owners.
  const lineage = Array.from({ length: 6 }, () => new Map<number, Set<number>>());
  for (let triangle = 0; triangle < sourceCount; triangle++) for (let corner = 0; corner < 3; corner++) {
    const vertex = asset.indices[triangle * 3 + corner]!;
    for (let field = 0; field < 6; field++) {
      const list = lineage[field]!.get(vertex) ?? new Set<number>();
      list.add(source.domains[triangle * 6 + field]!); lineage[field]!.set(vertex, list);
    }
  }
  const groups = new Map<number, { indices: number[]; output: number[]; materials: number[] }>();
  const meshletDepth = new Int32Array(asset.meshlets.length).fill(-1);
  const meshletError = new Float32Array(asset.meshlets.length);
  for (const cluster of asset.clusters) for (let i = cluster.meshletBegin; i < cluster.meshletBegin + cluster.meshletCount; i++) {
    if (meshletDepth[i] !== -1 && meshletDepth[i] !== cluster.depth) throw new Error("Meshlet has ambiguous LOD owner");
    meshletDepth[i] = cluster.depth; meshletError[i] = cluster.geometricError;
  }
  const total = asset.meshlets.reduce((sum, meshlet) => sum + meshlet.triangleCount, 0);
  if (total + sourceCount >= 0xffffffff || total !== asset.surfacePrimitiveIds.length) throw new RangeError("Surface publication range invalid");
  const errors = new Float32Array(total);
  let output = 0;
  for (let i = 0; i < asset.meshlets.length; i++) {
    const meshlet = asset.meshlets[i]!, depth = Math.max(0, meshletDepth[i]!);
    const group = groups.get(depth) ?? { indices: [], output: [], materials: [] };
    for (let primitive = 0; primitive < meshlet.triangleCount; primitive++) {
      const at = meshlet.triangleOffset + primitive * 3;
      for (let corner = 0; corner < 3; corner++) {
        group.indices.push(asset.meshletVertexIndices[meshlet.vertexOffset + asset.meshletTriangleIndices[at + corner]!]!);
      }
      group.output.push(output); group.materials.push(meshlet.materialId);
      errors[output++] = meshletError[i]!;
    }
    groups.set(depth, group);
  }
  const bytes = new Uint8Array(total * SURFACE_PRIMITIVE_BYTES), view = new DataView(bytes.buffer);
  let localDomainBase = sourceCount;
  for (const group of groups.values()) {
    const indices = new Uint32Array(group.indices);
    const local = buildSurfaceContinuity({ ...base, indices, materialIds: new Uint32Array(group.materials), domainBase: localDomainBase });
    localDomainBase += indices.length / 3;
    for (let triangle = 0; triangle < indices.length / 3; triangle++) {
      const slot = group.output[triangle]!, at = slot * SURFACE_PRIMITIVE_BYTES;
      const sourceId = asset.surfacePrimitiveIds[slot]!;
      const exactSource = sourceId < sourceCount;
      let localMask = 0;
      for (let field = 0; field < 6; field++) {
        const a = lineage[field]!.get(indices[triangle * 3]!), b = lineage[field]!.get(indices[triangle * 3 + 1]!),
          c = lineage[field]!.get(indices[triangle * 3 + 2]!);
        const candidates = a === undefined || b === undefined || c === undefined ? [] : [...a].filter(id => b.has(id) && c.has(id));
        const domain = exactSource ? source.domains[sourceId * 6 + field]!
          : candidates.length === 1 ? candidates[0]! : local.domains[triangle * 6 + field]!;
        if (!exactSource && candidates.length !== 1) localMask |= 1 << field;
        view.setUint32(at + field * 4, domain, true);
      }
      view.setUint32(at + 24, (exactSource ? source.identityRisk[sourceId]! : local.identityRisk[triangle]!)
        | (localMask !== 0 ? SURFACE_CONTINUITY_IDENTITY_RISK.lodLocal : 0), true);
      view.setUint32(at + 28, local.fieldRisk[triangle]! | (localMask << 16), true);
      view.setFloat32(at + 32, local.normalVariation[triangle]!, true);
      view.setFloat32(at + 36, local.colorVariation[triangle]!, true);
      for (let c = 0; c < 4; c++) view.setFloat32(at + 40 + c * 4, local.uvSpan[triangle * 4 + c]!, true);
      view.setFloat32(at + 56, errors[slot]!, true);
      // Ordinary coarse LOD retains source attributes; no vertex-update attribute error.
      view.setFloat32(at + 60, 0, true);
    }
  }
  return bytes;
}
