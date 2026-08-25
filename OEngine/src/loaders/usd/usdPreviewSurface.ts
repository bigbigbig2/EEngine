/**
 * usdPreviewSurface：解析 USD 数据并转换为引擎运行时对象。
 */

import { clamp01 } from "../../core/math/mathUtils.js";
import { ShadeTransparencyMode } from "../../material/enums.js";
import { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { UsdSpecsByPath } from "./UsdExtensionRegistry.js";
import { getAttrDefault } from "./usdAttrs.js";

export function buildUsdPreviewSurfaceMaterial(
  materialPath: string,
  specs: UsdSpecsByPath
): StandardShadeMaterial {
  const n = new StandardShadeMaterial();
  n.name = materialPath.split("/").pop() as string;
  const r = (specs[materialPath]!.fields.primChildren as string[]) || [];
  for (const s of r) {
    const shaderPath = `${materialPath}/${s}`;
    const a = specs[shaderPath];
    if (!a || a.specType !== 6) continue;
    if (a.fields.typeName !== "Shader") continue;
    if (getAttrDefault(specs, shaderPath, "info:id") !== "UsdPreviewSurface") {
      continue;
    }
    const i = getAttrDefault(specs, shaderPath, "inputs:diffuseColor");
    if (i && Array.isArray(i)) {
      n.diffuse_color.setRGB(i[0] as number, i[1] as number, i[2] as number);
    }
    const o = getAttrDefault(specs, shaderPath, "inputs:metallic");
    if (typeof o === "number") n.metallic_factor = clamp01(o);
    const rough = getAttrDefault(specs, shaderPath, "inputs:roughness");
    if (typeof rough === "number") n.roughness_factor = clamp01(rough);
    const c = getAttrDefault(specs, shaderPath, "inputs:opacity");
    if (typeof c === "number" && c < 1) {
      n.diffuse_color.a = clamp01(c);
      n.transparency_mode = ShadeTransparencyMode.Transparent;
    }
    const d = getAttrDefault(specs, shaderPath, "inputs:emissiveColor");
    if (
      d &&
      Array.isArray(d) &&
      Math.max(d[0] as number, d[1] as number, d[2] as number) > 0
    ) {
      n.emissive_factor.setRGB(d[0] as number, d[1] as number, d[2] as number);
    }
    break;
  }
  return n;
}

export const oc = buildUsdPreviewSurfaceMaterial;

export function buildUsdMaterials(
  specs: UsdSpecsByPath
): Map<string, StandardShadeMaterial> {
  const t = new Map<string, StandardShadeMaterial>();
  for (const n of Object.keys(specs)) {
    const r = specs[n]!;
    if (r.specType !== 6) continue;
    if (r.fields.typeName !== "Material") continue;
    t.set(n, buildUsdPreviewSurfaceMaterial(n, specs));
  }
  return t;
}
