/**
 * glTF 加载入口：读取 GLB 或 glTF 资源，并转换为场景、材质、纹理和动画对象。
 */

import { Skin } from "../animation/Skin.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { Mesh } from "../scene/Mesh.js";
import { Node3D } from "../scene/Node3D.js";
import { SkinnedMesh } from "../scene/SkinnedMesh.js";
import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import { SceneBundle } from "./SceneBundle.js";
import {
  GltfLoader,
  type GltfDocument,
  type GltfFileMap,
  type GltfPrimitive
} from "./gltf/GltfLoader.js";
import {
  readAccessor,
  createGltfGeometryBuildContext,
  primitiveToGeometry
} from "./gltf/gltfGeometry.js";
import { parseGltfMaterial } from "./gltf/gltfMaterials.js";
import { buildGltfTextures } from "./gltf/gltfTextures.js";
import { buildGltfAnimationClips } from "./gltf/gltfAnimations.js";
import { dedupeByHashEquals } from "./gltf/gltfDedup.js";
import {
  applyDirSpotLookRotation,
  parsePunctualLight
} from "./gltf/gltfLights.js";

function buildSceneBundle(doc: GltfDocument): SceneBundle {
  const nodes = doc.nodes!;
  const meshes = doc.meshes!;
  const sceneDefs = doc.scenes!;
  const materialsSrc = doc.materials ?? [];
  const nodeObjects: (Node3D | undefined)[] = new Array((doc.nodes ?? []).length);
  const skinPending: { skin_index: number; meshes: SkinnedMesh[] }[] = [];

  const defaultMat = new StandardShadeMaterial();
  const textures = buildGltfTextures(doc);
  const materials = materialsSrc.map((m) => parseGltfMaterial(m, textures));
  dedupeByHashEquals(materials);
  const geomCtx = createGltfGeometryBuildContext();
  let primitiveCount = 0;
  let geometryCount = 0;
  const geometryErrors: string[] = [];

  function obtainGeometry(
    primitive: GltfPrimitive,
    primIndex: number
  ): MeshletGeometryBase | null {
    primitiveCount++;
    try {
      const geometry = primitiveToGeometry(doc, primitive, "", geomCtx);
      geometryCount++;
      return geometry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      geometryErrors.push(`primitive ${primIndex}: ${message}`);
      console.error(
        `Failed to obtain geometry for primitive [${primIndex}] ${primitive}. `,
        err
      );
      return null;
    }
  }

  function buildMeshInstances(
    meshIndex: number,
    gltfNode: (typeof nodes)[number],
    skinned: boolean
  ): Mesh[] {
    const r = meshes[meshIndex]!;
    const s = r.primitives;
    const o: Mesh[] = [];
    for (let e = 0; e < s.length; e++) {
      const a = s[e]!;
      const geom = obtainGeometry(a, e);
      if (geom === null) continue;
      if (s.length === 1 && r.name !== undefined) geom.name = r.name;
      const c = a.material;
      let d: StandardShadeMaterial;
      if (c !== undefined) {
        d = materials[c] ?? defaultMat;
        if (materials[c] === undefined) {
          console.warn(`specified material ${c} does not exist. Using default.`);
        }
      } else {
        d = defaultMat;
      }
      const u = skinned ? new SkinnedMesh() : new Mesh();
      u.geometry = geom;
      u.material = d;
      u.transform_global.fromMatrix(gltfNode.worldMatrix!);
      if (r.name !== undefined) u.name = r.name;
      o.push(u);
    }
    return o;
  }

  function processNode(parent: Node3D, nodeIndex: number): void {
    const r = nodes[nodeIndex]!;
    const skinIdx = typeof r.skin === "number" ? r.skin : -1;
    let i: Node3D | undefined;
    let c: Mesh[] | null = null;

    if (r.extensions?.KHR_lights_punctual !== undefined) {
      const t = r.extensions.KHR_lights_punctual.light;
      try {
        const light = doc.extensions!.KHR_lights_punctual!.lights![t]!;
        i = parsePunctualLight(light);
      } catch (err) {
        console.error("Failed to process light ", t, " ", err);
      }
    }

    if (typeof r.mesh === "number") {
      const e = buildMeshInstances(r.mesh, r, skinIdx !== -1);
      if (e.length === 1) i = e[0];
      else if (e.length > 1) {
        i = new Node3D();
        i.addChildren(e);
      }
      if (skinIdx !== -1) c = e;
    }

    if (i === undefined) i = new Node3D();
    nodeObjects[nodeIndex] = i;
    if (r.name !== undefined) i.name = r.name;

    if (r.matrix !== undefined) {
      i.transform_local.fromMatrix(r.matrix);
    } else {
      const e = i.transform_local;
      if (r.translation !== undefined) e.position.fromArray(r.translation);
      if (r.rotation !== undefined) e.rotation.fromArray(r.rotation);
      if (r.scale !== undefined) e.scale.fromArray(r.scale);
    }

    applyDirSpotLookRotation(i);

    parent.addChild(i);
    if (c !== null) {
      skinPending.push({
        skin_index: skinIdx,
        meshes: c as SkinnedMesh[]
      });
    }
    if (r.children !== undefined) {
      for (let e = 0; e < r.children.length; e++) {
        processNode(i, r.children[e]!);
      }
    }
  }

  console.time("parse-gltf");
  const x: Node3D[] = [];
  for (let e = 0; e < sceneDefs.length; e++) {
    const t = sceneDefs[e]!;
    const n = new Node3D();
    x.push(n);
    const r = t.nodes;
    for (let k = 0; k < r.length; k++) processNode(n, r[k]!);
    n.updateMatrices();
  }

  if (primitiveCount > 0 && geometryCount === 0) {
    const extensions = doc.extensionsUsed?.length
      ? ` extensionsUsed=${doc.extensionsUsed.join(",")}.`
      : "";
    throw new Error(
      `glTF contains ${primitiveCount} mesh primitive(s), but none could be decoded.${extensions} ` +
        geometryErrors.slice(0, 4).join("; ")
    );
  }

  const P = (doc.skins ?? []).map((e) => {
    const a = e.joints;
    const i = a.length;
    const _ = new Array<Node3D>(i);
    for (let j = 0; j < i; j++) {
      _[j] = nodeObjects[a[j]!]!;
    }
    let c: Float32Array;
    if (e.inverseBindMatrices !== undefined) {
      c = Float32Array.from(
        readAccessor(
          doc,
          e.inverseBindMatrices,
          "inverse_bind_matrices"
        ).data
      );
    } else {
      c = new Float32Array(16 * i);
      for (let j = 0; j < i; j++) {
        c[16 * j + 0] = 1;
        c[16 * j + 5] = 1;
        c[16 * j + 10] = 1;
        c[16 * j + 15] = 1;
      }
    }
    return Skin.from({
      name: e.name ?? "",
      joints: _,
      inverse_bind_matrices: c,
      meshes: []
    });
  });

  for (let e = 0; e < skinPending.length; e++) {
    const { skin_index: t, meshes: n } = skinPending[e]!;
    P[t]!.meshes.push(...n);
  }

  const z = buildGltfAnimationClips(doc, nodeObjects);
  console.timeEnd("parse-gltf");

  const C = new SceneBundle();
  C.scenes = x;
  C.skins = P;
  C.clips = z;
  return C;
}

/**
 * 从 URL 加载 glTF/GLB，并返回可直接加入场景的节点、动画及关联资源集合。
 */
export async function load_gltf(
  url: string,
  { fileMap }: { fileMap?: GltfFileMap } = {}
): Promise<SceneBundle> {
  const n = new GltfLoader();
  if (fileMap) n.fileMap = fileMap;
  const doc = await n.loadFromUrl(url);
  return buildSceneBundle(doc);
}

export type { GltfFileMap };
