/**
 * glTF 解析器：协调缓冲区、节点、几何、材质、纹理、灯光和动画的装载过程。
 */

import {
  baseUrlOf,
  pathBasename,
  pathExtension,
  resolveRelativeUri
} from "../pathUtils.js";
import {
  collectLoadImageSources,
  shouldLoadImageSource
} from "./gltfImageSlots.js";
import { preprocessGltfWorldMatrices } from "./gltfNodeWorld.js";

export {
  baseUrlOf,
  pathBasename,
  pathExtension,
  resolveRelativeUri,
  h_,
  m_,
  y_
} from "../pathUtils.js";

export const GLB_MAGIC = 0x46546c67;
export const GLB_CHUNK_JSON = 0x4e4f534a;
export const GLB_CHUNK_BIN = 0x004e4942;

const DEFAULT_TRANSLATION = [0, 0, 0];
const DEFAULT_ROTATION = [0, 0, 0, 1];
const DEFAULT_SCALE = [1, 1, 1];

export type GltfFileMap = Map<string, File | Blob | ArrayBuffer>;

export interface GltfImageDef {
  uri?: string;
  bufferView?: number;
  mimeType?: string;
  name?: string;
}

export interface GltfSamplerDef {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

export interface GltfTextureDef {
  source?: number;
  sampler?: number;
  name?: string;
  extensions?: {
    EXT_texture_webp?: { source?: number };
  };
}

export interface GltfDocument {
  asset?: { version?: string; minVersion?: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: ArrayBuffer[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  scenes?: GltfScene[];
  materials?: GltfMaterial[];
  skins?: GltfSkin[];
  animations?: {
    name?: string;
    channels: {
      sampler: number;
      target: { node?: number; path: string };
    }[];
    samplers: {
      input: number;
      output: number;
      interpolation?: string;
    }[];
  }[];
  images?: (ImageBitmap | GltfImageDef | undefined)[];
  textures?: GltfTextureDef[];
  samplers?: GltfSamplerDef[];
  extensions?: {
    KHR_lights_punctual?: {
      lights?: GltfPunctualLight[];
    };
  };
  [key: string]: unknown;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: {
      bufferView: number;
      byteOffset?: number;
      componentType: number;
    };
    values: {
      bufferView: number;
      byteOffset?: number;
    };
  };
}

export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extensions?: {
    KHR_lights_punctual?: { light: number };
  };
  worldMatrix?: Float32Array;
  normalMatrix?: Float32Array;
  aabb?: import("./gltfNodeWorld.js").GltfAabb3;
}

export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
  aabb?: import("./gltfNodeWorld.js").GltfAabb3;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

export interface GltfScene {
  nodes: number[];
  name?: string;
  aabb?: import("./gltfNodeWorld.js").GltfAabb3;
}

export interface GltfMaterial {
  name?: string;
  doubleSided?: boolean;
  alphaMode?: string;
  alphaCutoff?: number;
  emissiveFactor?: number[];
  normalTexture?: GltfTextureInfo & { scale?: number };
  emissiveTexture?: GltfTextureInfo;
  occlusionTexture?: GltfTextureInfo & { strength?: number };
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureInfo;
    metallicRoughnessTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  extensions?: {
    KHR_materials_emissive_strength?: { emissiveStrength?: number };
    KHR_materials_ior?: { ior?: number };
    KHR_materials_transmission?: { transmissionFactor?: number };
    KHR_materials_pbrSpecularGlossiness?: {
      diffuseFactor?: number[];
      specularFactor?: number[];
      glossinessFactor?: number;
      diffuseTexture?: { index: number };
      specularGlossinessTexture?: { index: number };
    };
    KHR_materials_specular?: {
      specularFactor?: number;
      specularColorFactor?: number[];
      specularTexture?: { index: number };
      specularColorTexture?: { index: number };
    };
    [key: string]: unknown;
  };
}

export interface GltfTextureInfo {
  index: number;
  texCoord?: number;
  extensions?: {
    KHR_texture_transform?: {
      offset?: number[];
      rotation?: number;
      scale?: number[];
      texCoord?: number;
    };
  };
}

export interface GltfSkin {
  name?: string;
  joints: number[];
  inverseBindMatrices?: number;
}

export interface GltfPunctualLight {
  type: string;
  name?: string;
  color?: number[];
  intensity?: number;
  range?: number;
  spot?: { outerConeAngle?: number; innerConeAngle?: number };
  extras?: { radius?: number; near_clip_distance?: number };
}

export function resolveUri(uri: string, baseUrl: string): string {
  return resolveRelativeUri(uri, baseUrl);
}

export class GltfLoader {
  fileMap: GltfFileMap | undefined = undefined;
  loadImageSlots: string[] | undefined = undefined;

  async loadFromUrl(url: string): Promise<GltfDocument> {
    const baseUrl = baseUrlOf(url);
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(`Failed to fetch glTF '${url}': HTTP ${r.status} ${r.statusText}`);
    }
    const s = pathExtension(url)?.toLowerCase() ?? null;
    if (s === "gltf") return this.loadFromJson((await r.json()) as GltfDocument, baseUrl);
    if (s === "glb") return this.loadFromBinary(await r.arrayBuffer(), baseUrl);
    const e = await r.arrayBuffer();
    if (e.byteLength >= 4 && new DataView(e, 0, 4).getUint32(0, true) === GLB_MAGIC) {
      return this.loadFromBinary(e, baseUrl);
    }
    const t = new TextDecoder("utf-8");
    return this.loadFromJson(JSON.parse(t.decode(e)) as GltfDocument, baseUrl);
  }

  async loadFromBinary(e: ArrayBuffer, baseUrl: string): Promise<GltfDocument> {
    if (e.byteLength < 12) {
      throw new Error(
        `Binary too small, expected at least 12 bytes, instead was ${e.byteLength}`
      );
    }
    const n = new DataView(e, 0, 12);
    const r = n.getUint32(0, true);
    const s = n.getUint32(4, true);
    const a = n.getUint32(8, true);
    if (r !== GLB_MAGIC) {
      throw new Error(
        `Invalid magic string in binary header, expected ${GLB_MAGIC.toString(16)}, instead got ${r.toString(16)}.`
      );
    }
    if (s !== 2) {
      throw new Error(
        `Unsupported glTF version ${s} in binary header. Only glTF 2.0 is supported.`
      );
    }
    if (a !== e.byteLength) {
      throw new Error(
        `Invalid GLB length ${a}; received ${e.byteLength} bytes.`
      );
    }
    const chunks: Record<number, ArrayBuffer> = {};
    let o = 12;
    while (o < a) {
      if (o + 8 > a) throw new Error("Truncated GLB chunk header.");
      const t = new DataView(e, o, 8);
      const nLen = t.getUint32(0, true);
      const type = t.getUint32(4, true);
      if (o + 8 + nLen > a) throw new Error("Truncated GLB chunk payload.");
      chunks[type] = e.slice(o + 8, o + 8 + nLen);
      o += nLen + 8;
    }
    if (!chunks[GLB_CHUNK_JSON]) {
      throw new Error("File contained no json chunk.");
    }
    const jsonText = new TextDecoder("utf-8").decode(chunks[GLB_CHUNK_JSON]);
    return this.loadFromJson(
      JSON.parse(jsonText) as GltfDocument,
      baseUrl,
      chunks[GLB_CHUNK_BIN] ?? null
    );
  }

  async loadFromJson(
    e: GltfDocument,
    baseUrl: string,
    binChunk: ArrayBuffer | null = null
  ): Promise<GltfDocument> {
    if (!baseUrl) throw new Error("baseUrl must be specified.");
    const r = e.asset;
    if (r === undefined) throw new Error("Missing asset description.");
    if (r.minVersion !== "2.0" && r.version !== "2.0") {
      throw new Error("Incompatible asset version.");
    }

    validateRequiredExtensions(e.extensionsRequired ?? []);

    e.accessors ??= [];
    e.bufferViews ??= [];
    e.nodes ??= [];
    e.meshes ??= [];
    e.scenes ??= [];
    e.materials ??= [];
    e.images ??= [];
    e.textures ??= [];

    for (const o of e.accessors) {
      o.byteOffset = o.byteOffset ?? 0;
      o.normalized = o.normalized ?? false;
    }
    for (const _ of e.bufferViews) {
      _.byteOffset = _.byteOffset ?? 0;
    }
    for (const c of e.nodes) {
      if (!c.matrix) {
        c.rotation = c.rotation ?? DEFAULT_ROTATION;
        c.scale = c.scale ?? DEFAULT_SCALE;
        c.translation = c.translation ?? DEFAULT_TRANSLATION;
      }
    }
    if (e.samplers) {
      for (const d of e.samplers) {
        d.wrapS = d.wrapS ?? 10497;
        d.wrapT = d.wrapT ?? 10497;
      }
    }

    const bufferDefs = (e.buffers ?? []) as unknown as {
      uri?: string;
      byteLength?: number;
    }[];
    const s: Promise<ArrayBuffer>[] = [];
    if (binChunk) {
      s.push(Promise.resolve(binChunk));
    } else {
      for (const u in bufferDefs) {
        const l = bufferDefs[u]!;
        const bufferIndex = Number(u);
        if (this.fileMap && l.uri) {
          const h = findFileMapEntry(this.fileMap, l.uri);
          if (h !== undefined) {
            s[bufferIndex] =
              h instanceof ArrayBuffer
                ? Promise.resolve(h)
                : (h as Blob).arrayBuffer();
            continue;
          }
        }
        const f = resolveUri(l.uri!, baseUrl);
        s[bufferIndex] = fetch(f).then((resp) => {
          if (!resp.ok) {
            throw new Error(
              `Failed to fetch glTF buffer '${l.uri}': HTTP ${resp.status} ${resp.statusText}`
            );
          }
          return resp.arrayBuffer();
        });
      }
    }

    const imageDefs = (e.images ?? []) as GltfImageDef[];
    const allowedSources = collectLoadImageSources(
      e.materials,
      e.textures,
      this.loadImageSlots
    );
    const i: Promise<ImageBitmap | undefined>[] = [];
    const toBitmap = (blob: Blob): Promise<ImageBitmap> =>
      createImageBitmap(blob, { premultiplyAlpha: "none" });

    for (let v = 0; v < imageDefs.length; ++v) {
      if (!shouldLoadImageSource(allowedSources, v)) continue;
      const A = imageDefs[v]!;
      if (A.uri) {
        if (this.fileMap) {
          const x = findFileMapEntry(this.fileMap, A.uri);
          if (x !== undefined) {
            const y = x instanceof Blob ? x : new Blob([x]);
            i[v] = toBitmap(y);
            continue;
          }
        }
        const w = resolveUri(A.uri, baseUrl);
        i[v] = fetch(w)
          .then((resp) => {
            if (!resp.ok) {
              throw new Error(
                `Failed to fetch glTF image '${A.uri}': HTTP ${resp.status} ${resp.statusText}`
              );
            }
            return resp.blob();
          })
          .then(toBitmap);
      } else {
        const B = e.bufferViews![A.bufferView!]!;
        i[v] = s[B.buffer]!.then((buf) =>
          toBitmap(
            new Blob(
              [new Uint8Array(buf, B.byteOffset!, B.byteLength)],
              { type: A.mimeType }
            )
          )
        );
      }
    }

    preprocessGltfWorldMatrices(e);

    e.buffers = await Promise.all(s);
    e.images = await Promise.all(i);
    return e;
  }
}

const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
  "EXT_texture_webp",
  "KHR_lights_punctual",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_texture_transform"
]);

function validateRequiredExtensions(extensions: readonly string[]): void {
  const unsupported = extensions.filter(
    (extension) => !SUPPORTED_REQUIRED_EXTENSIONS.has(extension)
  );
  if (unsupported.length === 0) return;
  const details = unsupported.map((extension) => {
    switch (extension) {
      case "KHR_draco_mesh_compression":
        return `${extension} (Draco compressed geometry)`;
      case "EXT_meshopt_compression":
        return `${extension} (meshopt compressed buffers)`;
      case "KHR_texture_basisu":
        return `${extension} (KTX2/Basis textures)`;
      default:
        return extension;
    }
  });
  throw new Error(
    `Unsupported required glTF extension(s): ${details.join(", ")}. ` +
      "Export an uncompressed GLB with PNG/JPEG/WebP textures or add the matching decoder."
  );
}

function findFileMapEntry(
  fileMap: GltfFileMap,
  uri: string
): File | Blob | ArrayBuffer | undefined {
  const candidates = new Set([uri, pathBasename(uri)]);
  try {
    const decoded = decodeURIComponent(uri);
    candidates.add(decoded);
    candidates.add(pathBasename(decoded));
  } catch {
  }
  for (const candidate of candidates) {
    const value = fileMap.get(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}
