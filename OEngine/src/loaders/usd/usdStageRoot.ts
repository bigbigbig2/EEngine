/**
 * usdStageRoot：解析 USD 数据并转换为引擎运行时对象。
 */

import {
  mat4Identity,
  mat4Multiply,
  mat4RotateX,
  mat4Scale
} from "../../core/math/Mat4.js";
import type { Node3D } from "../../scene/Node3D.js";
import type { UsdSpecsByPath } from "./UsdExtensionRegistry.js";

export type UsdStageRootMeta = {
  upAxis: string;
  metersPerUnit: number;
  needsRootXform: boolean;
};

export function readUsdStageRootMeta(
  specs: UsdSpecsByPath
): UsdStageRootMeta {
  const n = specs["/"];
  const r = n ? n.fields : {};
  const upAxis = (r.upAxis as string) || "Y";
  const metersPerUnit = (r.metersPerUnit as number | undefined) ?? 1;
  return {
    upAxis,
    metersPerUnit,
    needsRootXform: upAxis === "Z" || metersPerUnit !== 1
  };
}

export function composeUsdStageRootMatrix(
  upAxis: string,
  metersPerUnit: number,
  out: Float32Array = mat4Identity()
): Float32Array {
  mat4Identity(out);
  if (upAxis === "Z") {
    mat4RotateX(out, out, -Math.PI / 2);
  }
  if (metersPerUnit !== 1) {
    mat4Scale(out, out, [metersPerUnit, metersPerUnit, metersPerUnit]);
  }
  return out;
}

export function applyUsdStageRootToNode(
  node: Node3D,
  rootMatrix: Float32Array
): void {
  const e = mat4Identity();
  mat4Multiply(e, rootMatrix, node.transform_local.matrix);
  node.transform_local.fromMatrix(e);
}
