/**
 * load_usd：负责资源读取、解码或场景装载。
 */

import { mat4Identity, mat4Multiply } from "../core/math/Mat4.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { Node3D } from "../scene/Node3D.js";
import { detectUsdFormat } from "./usd/detectUsdFormat.js";
import {
  defaultUsdExtensions,
  type LoadUsdOptionsInternal,
  type UsdExtensionRegistry,
  type UsdSpecsByPath
} from "./usd/UsdExtensionRegistry.js";
import { UsdParseError, UsdUnsupportedError } from "./usd/UsdErrors.js";
import { decodeUtf8, isPrimSpec, parseUsda } from "./usd/parseUsda.js";
import { unpackUsdz } from "./usd/unpackUsdz.js";
import { buildUsdMeshNode } from "./usd/usdMesh.js";
import { buildUsdMaterials } from "./usd/usdPreviewSurface.js";
import {
  applyUsdStageRootToNode,
  composeUsdStageRootMatrix,
  readUsdStageRootMeta
} from "./usd/usdStageRoot.js";
import { composeLocalXform } from "./usd/usdXform.js";

export type LoadUsdOptions = {
  fileName?: string;
  extensions?: UsdExtensionRegistry;
};

export { UsdParseError, UsdUnsupportedError } from "./usd/UsdErrors.js";
export {
  UsdExtensionRegistry,
  defaultUsdExtensions
} from "./usd/UsdExtensionRegistry.js";
export type { UsdExtension } from "./usd/UsdExtensionRegistry.js";

const buildMaterials = buildUsdMaterials;

function processPrim(
  path: string,
  specs: UsdSpecsByPath,
  materials: Map<string, StandardShadeMaterial>,
  parentXform: Float32Array,
  options: LoadUsdOptionsInternal,
  extensions: UsdExtensionRegistry | null
): Node3D | null {
  const i = specs[path];
  if (!isPrimSpec(i)) return null;
  const o = i.fields;
  const typeName = (o.typeName as string) || "";
  const c = path.split("/").pop() as string;

  if (extensions) {
    for (const ext of extensions.values()) {
      if (ext.processPrim) {
        const a = ext.processPrim(path, o, {
          specs_by_path: specs,
          materials,
          options
        });
        if (a != null) return a;
      }
    }
  }

  const localXform = composeLocalXform(o, specs, path);
  const worldish = mat4Identity();
  mat4Multiply(worldish, parentXform, localXform);

  if (typeName === "Mesh") {
    const w = buildUsdMeshNode(path, c, specs, materials, localXform);
    if ((w as { isMesh?: boolean }).isMesh !== true) return w;
    const children = (o.primChildren as string[]) || [];
    for (const child of children) {
      const n = processPrim(
        `${path}/${child}`,
        specs,
        materials,
        worldish,
        options,
        null
      );
      if (n !== null) w.addChild(n);
    }
    return w;
  }

  if (
    typeName !== "" &&
    typeName !== "Xform" &&
    typeName !== "Scope" &&
    typeName !== "Material" &&
    typeName !== "Shader"
  ) {
    console.warn(
      `[USD] Unhandled prim type "${typeName}" at ${path}, treating as group node`
    );
  }

  const l = new Node3D();
  l.name = c;
  l.transform_local.fromMatrix(localXform);
  const f = (o.primChildren as string[]) || [];
  for (const child of f) {
    const n = processPrim(
      `${path}/${child}`,
      specs,
      materials,
      worldish,
      options,
      extensions
    );
    if (n !== null) l.addChild(n);
  }
  return l;
}

function buildNodes(
  specs: UsdSpecsByPath,
  options: LoadUsdOptionsInternal
): Node3D[] {
  const n = specs["/"];
  const r = n ? n.fields : {};
  const meta = readUsdStageRootMeta(specs);
  const i = composeUsdStageRootMatrix(meta.upAxis, meta.metersPerUnit);

  const o = buildMaterials(specs);
  const _ = options.extensions ?? null;
  const c = (r.primChildren as string[]) || [];
  const d: Node3D[] = [];

  for (const name of c) {
    const node = processPrim("/" + name, specs, o, i, options, _);
    if (node !== null) {
      if (meta.needsRootXform) applyUsdStageRootToNode(node, i);
      d.push(node);
    }
  }
  for (const e of d) e.updateMatrices();
  return d;
}

export async function load_usd(
  buffer: ArrayBuffer,
  options: LoadUsdOptions = {}
): Promise<Node3D[]> {
  const n = detectUsdFormat(buffer, options.fileName);
  const r = options.extensions || defaultUsdExtensions;
  let s: { specsByPath: UsdSpecsByPath };
  let a = new Map<string, Uint8Array>();

  switch (n) {
    case "usda":
      s = parseUsda(decodeUtf8(buffer));
      break;
    case "usdc":
      throw new UsdUnsupportedError(
        "USDC binary crate format is not yet implemented"
      );
    case "usdz": {
      const unpacked = unpackUsdz(buffer);
      a = unpacked.files;
      const rootBytes = a.get(unpacked.rootFileName);
      if (!rootBytes) {
        throw new UsdParseError(
          `Root layer "${unpacked.rootFileName}" not found in USDZ archive`
        );
      }
      const i = rootBytes.buffer.slice(
        rootBytes.byteOffset,
        rootBytes.byteOffset + rootBytes.byteLength
      ) as ArrayBuffer;
      const o = detectUsdFormat(i, unpacked.rootFileName);
      if (o !== "usda") {
        if (o === "usdc") {
          throw new UsdUnsupportedError(
            "USDC binary crate format is not yet implemented"
          );
        }
        throw new UsdParseError(
          `Unknown format for root layer "${unpacked.rootFileName}" inside USDZ`
        );
      }
      s = parseUsda(decodeUtf8(i));
      break;
    }
    default:
      throw new UsdParseError("Unable to determine USD format from data");
  }

  for (const e of r.values()) {
    if (e.postProcess) e.postProcess(s.specsByPath);
  }

  return buildNodes(s.specsByPath, {
    assetFiles: a
  });
}
