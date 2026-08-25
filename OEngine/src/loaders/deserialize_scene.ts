/**
 * deserialize_scene：负责资源读取、解码或场景装载。
 */

import { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { Mesh } from "../scene/Mesh.js";
import type { Scene } from "../scene/Scene.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeDataType } from "../texture/ShadeDataType.js";
import { BinaryReader } from "./BinaryReader.js";
import {
  decodeShadeSource,
  deserializeLight,
  deserializeMaterialTextures,
  deserializeMeshletGeometry,
  readLengthPrefixedBuffer,
  readShadeImageMeta,
  readShadeTextureParams,
  SHADE_INVALID_INDEX
} from "./shadeFormat.js";

export interface ShadeMeshInstanceRecord {
  name: string;
  material_index: number;
  geometry_index: number;
  transform: Float32Array;
}

export async function deserialize_scene(
  buffer: BinaryReader,
  scene: Scene
): Promise<Scene> {
  const e = buffer;
  const r = e.readASCIICharacters(5);
  if (r !== "SHADE") {
    throw new Error(`Unsupported wrong format tag: "${r}", expected "SHADE"`);
  }
  const s = e.readUint32();
  if (s !== 1) {
    throw new Error(`Unsupported wrong format version: ${s}, expected 1`);
  }

  const a = e.readUint32();
  const i: ShadeMeshInstanceRecord[] = [];
  for (let t = 0; t < a; t++) {
    const name = e.readUTF8String() as string;
    const material_index = e.readUint32();
    const geometry_index = e.readUint32();
    const transform = new Float32Array(16);
    e.readFloat32Array(transform, 0, 16);
    i.push({ name, material_index, geometry_index, transform });
  }

  const o = e.readUint32();
  const geometries: MeshletGeometryBase[] = [];
  for (let t = 0; t < o; t++) {
    geometries.push(deserializeMeshletGeometry(e, new MeshletGeometryBase()));
  }

  const c = e.readUint32();
  const d: { material: StandardShadeMaterial; buffer_position: number }[] = [];
  for (let t = 0; t < c; t++) {
    const mat = new StandardShadeMaterial();
    mat.name = e.readUTF8String() as string;
    mat.transparency_mode = e.readUint32();
    mat.draw_mode = e.readUint32();
    mat.draw_side = e.readUint32();
    const n = e.position;
    e.position = n + 40;
    d.push({ material: mat, buffer_position: n });
  }

  const u = e.readUint32();
  const l: { texture: ShadeTexture }[] = [];
  for (let t = 0; t < u; t++) {
    l.push({ texture: readShadeTextureParams(e) });
  }

  const f = e.readUint32();
  const h: { image: ReturnType<typeof readShadeImageMeta>["image"]; source_index: number }[] =
    [];
  for (let t = 0; t < f; t++) {
    h.push(readShadeImageMeta(e));
  }

  const m = e.readUint32();
  const g: ArrayBuffer[] = [];
  for (let t = 0; t < m; t++) {
    g.push(readLengthPrefixedBuffer(e));
  }

  const p = g.map((src) => decodeShadeSource(src));
  const v = await Promise.all(p);

  const A: (typeof h)[0]["image"][] = [];
  for (const { image: img, source_index: srcIdx } of h) {
    img.source = v[srcIdx];
    const src = img.source as { isSampler2D?: boolean; itemSize: number } | undefined;
    if (src && src.isSampler2D) {
      img.channel_count = src.itemSize;
      img.data_type = ShadeDataType.Float16;
    }
    A.push(img);
  }

  const b: ShadeTexture[] = [];
  for (let idx = 0; idx < u; idx++) {
    const { texture: t } = l[idx]!;
    const n = ShadeTexture.from(A[idx]!);
    n.label = t.label;
    n.flags = t.flags;
    n.dimensions = t.dimensions;
    n.minFilter = t.minFilter;
    n.magFilter = t.magFilter;
    n.mipmapFilter = t.mipmapFilter;
    n.wrapS = t.wrapS;
    n.wrapT = t.wrapT;
    n.wrapR = t.wrapR;
    n.mipmapGenerationFilter = t.mipmapGenerationFilter;
    b.push(n);
  }

  const w: StandardShadeMaterial[] = [];
  for (const { material: mat, buffer_position: n } of d) {
    const saved = e.position;
    e.position = n;
    deserializeMaterialTextures(e, mat, b);
    e.position = saved;
    w.push(mat);
  }

  const x = e.readUint32();
  if (x !== SHADE_INVALID_INDEX) {
    scene.lights.environment = b[x]!;
  }

  const y = e.readUint32();
  for (let n = 0; n < y; n++) {
    scene.lights.add(deserializeLight(e));
  }

  for (const rec of i) {
    const mesh = new Mesh();
    mesh.name = rec.name;
    mesh.geometry = geometries[rec.geometry_index]!;
    mesh.material = w[rec.material_index]!;
    mesh.transform_global.fromMatrix(rec.transform);
    mesh.updateBoundsBasic();
    scene.instances.add(mesh);
  }

  return scene;
}
