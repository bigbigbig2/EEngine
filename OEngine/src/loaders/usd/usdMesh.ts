/**
 * usdMesh：解析 USD 数据并转换为引擎运行时对象。
 */

import { Attribute } from "../../geometry/Attribute.js";
import { Geometry } from "../../geometry/Geometry.js";
import { MeshletAttrName } from "../../geometry/meshletPackedAttrs.js";
import { niFromGeometry } from "../../geometry/niMeshlets.js";
import { ShadeDrawSide } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import { Mesh } from "../../scene/Mesh.js";
import { Node3D } from "../../scene/Node3D.js";
import type { UsdSpecsByPath } from "./UsdExtensionRegistry.js";
import {
  getAttrDefault,
  getAttrInterpolation,
  toFloat32Array,
  toNumberArray
} from "./usdAttrs.js";
import {
  expandFaceVaryingAttr,
  gatherIndexedAttr,
  gatherPrimvarIndices
} from "./usdFaceVarying.js";

export function triangulateFaces(
  counts: ArrayLike<number>,
  indices: ArrayLike<number>
): { indices: Uint32Array; triangle_count: number; face_map: Uint32Array } {
  const count = counts.length;
  let indexCount = 0;
  for (let i = 0; i < count; i++) indexCount += counts[i]!;
  if (indexCount !== indices.length) {
    console.warn(
      `[USD] faceVertexCounts sum (${indexCount}) does not match faceVertexIndices length (${indices.length})`
    );
  }
  let triangleCount = 0;
  for (let i = 0; i < count; i++) {
    if (counts[i]! >= 3) triangleCount += counts[i]! - 2;
  }
  const output = new Uint32Array(3 * triangleCount);
  const faceMap = new Uint32Array(triangleCount);
  let outputIndex = 0;
  let faceOutputIndex = 0;
  let inputIndex = 0;
  for (let faceIndex = 0; faceIndex < count; faceIndex++) {
    const faceVertexCount = counts[faceIndex]!;
    if (faceVertexCount < 3) {
      inputIndex += faceVertexCount;
      continue;
    }
    const first = indices[inputIndex]!;
    for (let i = 1; i < faceVertexCount - 1; i++) {
      output[outputIndex++] = first;
      output[outputIndex++] = indices[inputIndex + i]!;
      output[outputIndex++] = indices[inputIndex + i + 1]!;
      faceMap[faceOutputIndex++] = faceIndex;
    }
    inputIndex += faceVertexCount;
  }
  return {
    indices: output,
    face_map: faceMap,
    triangle_count: triangleCount
  };
}

export function gatherIndexedAttrUsd(
  indices: ArrayLike<number>,
  source: Float32Array,
  itemSize: number
): Float32Array {
  return gatherIndexedAttr(indices, source, itemSize);
}

export function deindexUsdGeometry(
  geometry: Geometry,
  positions: Float32Array,
  normals: Float32Array | null
): void {
  geometry.index = null;
  const position = Attribute.from(positions, 3, MeshletAttrName.Position);
  geometry.removeAttribute(MeshletAttrName.Position);
  geometry.addAttribute(position);
  if (normals) {
    const normal = Attribute.from(normals, 3, MeshletAttrName.Normal);
    geometry.removeAttribute(MeshletAttrName.Normal);
    geometry.addAttribute(normal);
  }
}

export function buildUsdMeshNode(
  path: string,
  name: string,
  specs: UsdSpecsByPath,
  materials: Map<string, StandardShadeMaterial>,
  localXform: Float32Array
): Node3D {
  const faceVertexCountsRaw = getAttrDefault(specs, path, "faceVertexCounts");
  const faceVertexIndicesRaw = getAttrDefault(specs, path, "faceVertexIndices");
  const pointsRaw = getAttrDefault(specs, path, "points");
  if (!faceVertexCountsRaw || !faceVertexIndicesRaw || !pointsRaw) {
    const node = new Node3D();
    node.name = name;
    node.transform_local.fromMatrix(localXform);
    return node;
  }

  const faceVertexCounts = toNumberArray(faceVertexCountsRaw);
  const faceVertexIndices = toNumberArray(faceVertexIndicesRaw);
  const points = toFloat32Array(pointsRaw);
  const vertexCount = points.length / 3;
  for (let i = 0; i < faceVertexIndices.length; i++) {
    if (faceVertexIndices[i]! >= vertexCount || faceVertexIndices[i]! < 0) {
      console.warn(
        `[USD] faceVertexIndices[${i}] = ${faceVertexIndices[i]} is out of bounds (vertex count: ${vertexCount}) at ${path}`
      );
      break;
    }
  }

  const positionSource = toFloat32Array(points);
  const { indices } = triangulateFaces(
    faceVertexCounts,
    faceVertexIndices
  );
  const geometry = new Geometry();
  geometry.addAttribute(
    Attribute.from(positionSource, 3, MeshletAttrName.Position)
  );
  geometry.index = Attribute.from(indices, 1, "index");

  const normalsRaw = getAttrDefault(specs, path, "normals");
  if (normalsRaw) {
    const normals = toFloat32Array(normalsRaw);
    if (getAttrInterpolation(specs, path, "normals") === "faceVarying") {
      const expandedNormals = expandFaceVaryingAttr(
        faceVertexCounts,
        normals,
        3
      );
      deindexUsdGeometry(
        geometry,
        gatherIndexedAttrUsd(indices, positionSource, 3),
        expandedNormals
      );
    } else {
      geometry.addAttribute(
        Attribute.from(normals, 3, MeshletAttrName.Normal)
      );
    }
  }

  const stRaw = getAttrDefault(specs, path, "primvars:st");
  if (stRaw) {
    const source = toFloat32Array(stRaw);
    const stIndicesRaw = getAttrDefault(specs, path, "primvars:st:indices");
    const interpolation = getAttrInterpolation(specs, path, "primvars:st");
    let st = source;
    if (stIndicesRaw) {
      st = gatherPrimvarIndices(source, toNumberArray(stIndicesRaw));
    }
    if (interpolation === "faceVarying") {
      st = expandFaceVaryingAttr(faceVertexCounts, st, 2);
      if (!geometry.getAttribute(MeshletAttrName.Normal)) {
        deindexUsdGeometry(
          geometry,
          gatherIndexedAttrUsd(indices, positionSource, 3),
          null
        );
      }
    }
    geometry.addAttribute(Attribute.from(st, 2, MeshletAttrName.Uv0));
  }

  const binding = specs[path + ".material:binding"];
  let material = new StandardShadeMaterial();
  if (binding?.fields.targetPaths) {
    const materialPath = (binding.fields.targetPaths as string[])[0]!;
    if (materials.has(materialPath)) {
      material = materials.get(materialPath)!;
    } else {
      console.warn(
        `[USD] Material binding at ${path} references "${materialPath}" which was not found`
      );
    }
  }
  if (getAttrDefault(specs, path, "doubleSided") === true) {
    material.draw_side = ShadeDrawSide.Double;
  }

  const mesh = new Mesh();
  mesh.name = name;
  mesh.geometry = niFromGeometry(geometry);
  mesh.material = material;
  mesh.transform_local.fromMatrix(localXform);
  return mesh;
}
