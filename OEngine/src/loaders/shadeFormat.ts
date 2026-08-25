/**
 * shadeFormat：负责资源读取、解码或场景装载。
 */

import { Color } from "../core/Color.js";
import { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import { rebuildBvhFromMeshlets } from "../geometry/niMeshlets.js";
import { DirectionalLight } from "../light/DirectionalLight.js";
import { PointLight } from "../light/PointLight.js";
import { SpotLight } from "../light/SpotLight.js";
import type { Light } from "../light/Light.js";
import { LinearModifier } from "../material/LinearModifier.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { ShadeImage, ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeDataType } from "../texture/ShadeDataType.js";
import type { BinaryReader } from "./BinaryReader.js";
import { decodeAvifOo } from "./decodeAvif.js";

export const SHADE_INVALID_INDEX = 0xffffffff;

export const SHADE_DATA_TYPE: Record<number, string> = {
  0: ShadeDataType.Uint8,
  1: ShadeDataType.Uint16,
  2: ShadeDataType.Uint32,
  3: ShadeDataType.Int8,
  4: ShadeDataType.Int16,
  5: ShadeDataType.Int32,
  6: ShadeDataType.Float32,
  7: ShadeDataType.Float64,
  8: ShadeDataType.Float16
};

export function deserializeMeshletGeometry(
  e: BinaryReader,
  t: MeshletGeometryBase = new MeshletGeometryBase()
): MeshletGeometryBase {
  t.primitive_count = e.readUint32();
  e.readFloat32Array(t.bounding_box, 0, 6);
  e.readFloat32Array(t.bounding_sphere, 0, 4);
  t.name = e.readUTF8String() as string;
  t.meshlets.count = e.readUint32();

  const metadataLength = e.readUint32();
  const metadata = new Uint8Array(metadataLength);
  e.readBytes(metadata, 0, metadataLength);
  t.meshlets.metadata_buffer = metadata.buffer;

  const dataLength = e.readUint32();
  const data = new Uint8Array(dataLength);
  e.readBytes(data, 0, dataLength);
  t.meshlets.data_buffer = data.buffer;

  const bvhLength = e.readUint32();
  if (bvhLength === 0 && t.primitive_count > 0) {
    t.bvh = rebuildBvhFromMeshlets(t.meshlets, t.bounding_box);
  } else {
    const bvh = new Uint8Array(bvhLength);
    e.readBytes(bvh, 0, bvhLength);
    t.bvh = bvh.buffer;
  }
  return t;
}

export function deserializeMaterialTextures(
  e: BinaryReader,
  t: StandardShadeMaterial,
  textures: ShadeTexture[]
): void {
  const albedo = e.readUint32();
  const normal = e.readUint32();
  const orm = e.readUint32();
  const emissive = e.readUint32();
  t.texture_albedo = albedo !== SHADE_INVALID_INDEX ? textures[albedo] : undefined;
  t.texture_normal = normal !== SHADE_INVALID_INDEX ? textures[normal] : undefined;
  t.texture_orm = orm !== SHADE_INVALID_INDEX ? textures[orm] : undefined;
  t.texture_emissive = emissive !== SHADE_INVALID_INDEX ? textures[emissive] : undefined;
  t.diffuse_color.setFromPackedUint32(e.readUint32());
  t.roughness_factor = e.readFloat32();
  t.metallic_factor = e.readFloat32();
  t.emissive_factor.setFromPackedUint32(e.readUint32());
  t.ambient_factors = new LinearModifier(e.readFloat32(), e.readFloat32());
}

export function deserializeLight(e: BinaryReader): Light {
  const type = e.readUint8();
  let light: Light;
  if (type === 1) light = new DirectionalLight();
  else if (type === 0) light = new PointLight();
  else if (type === 2) light = new SpotLight();
  else throw new Error(`Unsupported light type: ${type}`);

  const transform = new Float32Array(16);
  e.readFloat32Array(transform, 0, 16);
  light.transform_global.fromMatrix(transform);
  light.intensity = e.readFloat32();
  light.color.setFromPackedUint32(e.readUint32());
  light.radius = e.readFloat32();
  light.near_clip_distance = e.readFloat32();
  if (type === 0) {
    (light as PointLight).distance = e.readFloat32();
  } else if (type === 2) {
    const spot = light as SpotLight;
    spot.distance = e.readFloat32();
    spot.angle = e.readFloat32();
    spot.penumbra = e.readFloat32();
  }
  return light;
}

export function isColrnclxSource(e: ArrayBuffer): boolean {
  const source = new Uint8Array(e);
  for (let i = 0; i < source.length - 16; i++) {
    if (
      source[i] === 99 &&
      source[i + 1] === 111 &&
      source[i + 2] === 108 &&
      source[i + 3] === 114 &&
      source[i + 4] === 110 &&
      source[i + 5] === 99 &&
      source[i + 6] === 108 &&
      source[i + 7] === 120 &&
      16 === ((source[i + 10]! << 8) | source[i + 11]!)
    ) {
      return true;
    }
  }
  return false;
}

export async function decodeSourceBlob(e: ArrayBuffer): Promise<ImageBitmap> {
  const blob = new Blob([e], { type: "image/avif" });
  return createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none"
  });
}

export async function decodeShadeSource(e: ArrayBuffer): Promise<unknown> {
  return isColrnclxSource(e) ? decodeAvifOo(e) : decodeSourceBlob(e);
}

export function readLengthPrefixedBuffer(e: BinaryReader): ArrayBuffer {
  const length = e.readUint32();
  const source = e.data.slice(e.position, e.position + length);
  e.skip(length);
  return source;
}

export function readShadeImageMeta(e: BinaryReader): {
  image: ShadeImage;
  source_index: number;
} {
  const width = e.readUint32();
  const height = e.readUint32();
  const depth = e.readUint32();
  const sourceIndex = e.readUint32();
  const dataType = e.readUint32();
  const channelCount = e.readUint32();
  const flags = e.readUint32();
  const image = new ShadeImage();
  image.width = width;
  image.height = height;
  image.depth = depth;
  image.data_type = SHADE_DATA_TYPE[dataType] as string;
  image.channel_count = channelCount;
  image.normalized = !!(flags & 1);
  image.color_space = (flags >>> 4) & 15;
  return { image, source_index: sourceIndex };
}

export function readShadeTextureParams(e: BinaryReader): ShadeTexture {
  const texture = new ShadeTexture();
  texture.label = e.readUTF8String() as string;
  texture.flags = e.readUint32();
  texture.dimensions = e.readUint8();
  texture.minFilter = e.readUint8();
  texture.magFilter = e.readUint8();
  texture.mipmapFilter = e.readUint8();
  texture.wrapS = e.readUint8();
  texture.wrapT = e.readUint8();
  texture.wrapR = e.readUint8();
  texture.mipmapGenerationFilter = e.readUint32();
  return texture;
}

export { Color };
