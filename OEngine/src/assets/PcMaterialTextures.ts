import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../material/CanonicalMaterial.js";
import { snapshotAppearanceTexture } from "../material/AppearanceGraph.js";
import { AppearanceMaterialDefinition } from "../material/AppearanceMaterialDefinition.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeImage } from "../texture/ShadeImage.js";
import { ImageTextureSource } from "./ImageTextureSource.js";
import type { ImageTextureSemantic } from "./ImageTextureProduct.js";

export interface MaterialImagePreparationEvidence {
  readonly decodeMs: number;
  readonly encodeMs: number;
}

export const MATERIAL_TEXTURE_PROPERTIES = [
  "texture_albedo",
  "texture_normal",
  "texture_orm",
  "texture_emissive",
  "texture_occlusion",
  "texture_specular",
  "texture_specular_color",
  "texture_clearcoat",
  "texture_clearcoat_roughness",
  "texture_clearcoat_normal"
] as const;
type Property = (typeof MATERIAL_TEXTURE_PROPERTIES)[number];

export function materialTextureSemantic(property: Property): Exclude<ImageTextureSemantic, "exact-r"> {
  if (property === "texture_albedo" || property === "texture_specular_color") {
    return "color-rgba";
  }
  if (property === "texture_emissive") {
    return "color-rgb";
  }
  if (property === "texture_normal" || property === "texture_clearcoat_normal") {
    return "normal-xy";
  }
  // Multi-channel/alpha extension maps must preserve their authored channels.
  if (property === "texture_occlusion" || property === "texture_clearcoat") {
    return "data-rgb";
  }
  return "data-rgb";
}

/** All live graph leaves, including user-authored graphs. Constant-dead maps do
 * not consume layers. This is publication-time CPU work, never a frame scan. */
export function materialTextureLeaves(material: StandardShadeMaterial): readonly ShadeTexture[] {
  return [
    ...new Set(compileCanonicalMaterial(material).appearance.samples.map((sample) => sample.binding.texture))
  ];
}

/** Cold producer. It commits CPU material replacements only when the complete
 * batch is ready. Published materials own their image_source lifetime (close it
 * after unload); it remains open across GPU device replacement. */
export async function prepareMaterialTextureProducts(
  materials: readonly StandardShadeMaterial[],
  signal?: AbortSignal,
  onCooked?: (evidence: MaterialImagePreparationEvidence) => void
): Promise<void> {
  const changes: Array<() => void> = [];
  const preparedImages = new Map<object, Map<string, Promise<ImageTextureSource>>>();
  const preparedTextures = new Map<ShadeTexture, Map<string, ShadeTexture>>();
  const createdSources = new Set<ImageTextureSource>();
  const assertLive = () => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Texture preparation aborted", "AbortError");
    }
  };
  const prepare = async (
    texture: ShadeTexture,
    semantic: Exclude<ImageTextureSemantic, "exact-r">,
    exactAlpha: boolean
  ) => {
    assertLive();
    const existing = texture.image_source;
    if (existing) {
      const actual = existing.directory.planes[0]!.semantic;
      const colorCompatible = semantic.startsWith("color-") && actual.startsWith("color-");
      if (actual !== semantic && !colorCompatible && !(semantic === "normal-xy" && actual === "moment-xyz")) {
        throw new Error(`Image semantic '${actual}' cannot serve '${semantic}' without recooking`);
      }
      if (exactAlpha && !existing.directory.planes.some((plane) => plane.semantic === "exact-r")) {
        throw new Error("Covered material requires an exact R8 image plane; recook the source");
      }
      return texture;
    }
    const image = texture.image;
    if (!image) {
      throw new Error("Material texture has no image source or cold source");
    }
    const key = JSON.stringify([semantic, exactAlpha, texture.wrapS, texture.wrapT]);
    const known = preparedTextures.get(texture)?.get(key);
    if (known) {
      return known;
    }
    let products = preparedImages.get(image);
    if (!products) {
      products = new Map();
      preparedImages.set(image, products);
    }
    let pending = products.get(key);
    if (!pending) {
      if (image.encoded_mime_type && (image.source as ArrayBuffer).byteLength > 16 * 1024 * 1024) {
        throw new RangeError("Encoded Web image exceeds cold input capacity");
      }
      const input = image.encoded_mime_type
        ? (image.source as ArrayBuffer).slice(0)
        : (await imageRgba(image)).buffer as ArrayBuffer;
      assertLive();
      const address = (value: number) => value === 0 ? "clamp-to-edge" as const
        : value === 2 ? "mirror-repeat" as const : "repeat" as const;
      pending = ImageTextureSource.importWeb({
        input, mime: image.encoded_mime_type, width: image.width, height: image.height,
        semantic, exactAlpha, addressU: address(texture.wrapS), addressV: address(texture.wrapT)
      }, signal).then(({ source, decodeMs }) => {
        createdSources.add(source);
        onCooked?.({ decodeMs, encodeMs: 0 });
        return source;
      });
      products.set(key, pending);
      pending.catch(() => {
        if (products!.get(key) === pending) {
          products!.delete(key);
        }
      });
    }
    const product = await pending;
    assertLive();
    const result = ShadeTexture.fromImageSource(product);
    for (const name of [
      "minFilter",
      "magFilter",
      "mipmapFilter",
      "wrapS",
      "wrapT",
      "wrapR",
      "dimensions"
    ] as const) {
      result[name] = texture[name];
    }
    result.label = texture.label;
    let textures = preparedTextures.get(texture);
    if (!textures) {
      textures = new Map();
      preparedTextures.set(texture, textures);
    }
    textures.set(key, result);
    return result;
  };
  try {
    for (const material of new Set(materials)) {
      const live = new Set(materialTextureLeaves(material));
      for (const property of MATERIAL_TEXTURE_PROPERTIES) {
        const texture = material[property];
        if (!texture || !live.has(texture)) {
          continue;
        }
        const semantic = materialTextureSemantic(property);

        const exact = compileCanonicalMaterial(material).appearance.samples.some(
          (sample) => sample.binding.texture === texture && (sample.readMask & 8) !== 0
        );
        const result = await prepare(
          texture,
          semantic,
          exact
        );
        changes.push(() => {
          material[property] = result;
        });
      }
      const definition = material.appearance_definition;
      if (definition?.graph) {
        const samples = compileCanonicalMaterial(material).appearance.samples;
        const nodes: import("../material/AppearanceGraph.js").AppearanceNode[] = [];
        for (const node of definition.graph.nodes) {
          if (node.kind !== "texture") {
            nodes.push(node);
            continue;
          }
          const b = node.binding;
          const queries = samples.filter((sample) => sample.binding.texture === b.texture);
          if (queries.length === 0) {
            nodes.push(node);
            continue;
          }
          const exactAlpha = queries.some((sample) => (sample.readMask & 8) !== 0);
          const existing = b.texture.image_source;
          if (
            existing &&
            (b.decode === "srgb-rgb") !== existing.directory.planes[0]!.semantic.startsWith("color-")
          ) {
            throw new Error("Custom graph decode does not match Texture Product transfer function");
          }
          const semantic =
            existing?.directory.planes[0]!.semantic ?? (b.decode === "srgb-rgb" ? "color-rgba" : "data-rgb");
          if (semantic === "exact-r") throw new Error("Exact-only image cannot serve a general graph texture");
          const texture = await prepare(b.texture, semantic, exactAlpha);
          nodes.push({
            ...node,
            binding: snapshotAppearanceTexture(
              texture,
              b.decode,
              b.offset,
              b.scale,
              b.rotation,
              b.range,
              b.fallback
            )
          });
        }
        changes.push(() => {
          material.appearance_definition = new AppearanceMaterialDefinition(
            { ...definition.graph!, nodes },
            definition.products
          );
        });
      }
    }
    assertLive();
    for (const commit of changes) {
      commit();
    }
  } catch (error) {
    for (const source of createdSources) {
      source.close();
    }
    throw error;
  }
}

async function imageRgba(image: ShadeImage): Promise<Uint8Array> {
  if (image.depth !== 1 || image.data_type !== "uint8") {
    throw new Error("Web material import requires a 2D uint8 image");
  }
  if (image.width < 1 || image.height < 1 || image.width > 2048 || image.height > 2048) {
    throw new RangeError("Web material import requires a bounded 1..2048 image");
  }
  const source = image.source;
  if (
    ArrayBuffer.isView(source) ||
    source instanceof ArrayBuffer ||
    (source && typeof source === "object" && "data" in source)
  ) {
    const data =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : ArrayBuffer.isView(source)
          ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
          : (source as { data: ArrayLike<number> }).data;
    const channels = image.channel_count;
    if (channels < 1 || channels > 4 || data.length !== image.width * image.height * channels) {
      throw new Error("Raw image byte domain mismatch");
    }
    const rgba = new Uint8Array(image.width * image.height * 4);
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
      const at = pixel * channels;
      const out = pixel * 4;
      rgba[out] = data[at]!;
      rgba[out + 1] = channels > 1 ? data[at + 1]! : data[at]!;
      rgba[out + 2] = channels > 2 ? data[at + 2]! : data[at]!;
      rgba[out + 3] = channels > 3 ? data[at + 3]! : 255;
    }
    return rgba;
  }
  // Avoid the premultiplied 2D canvas round trip; the caller owns the bitmap.
  const frame = new VideoFrame(source as ImageBitmap, { timestamp: 0 });
  try {
    const rgba = new Uint8Array(image.width * image.height * 4);
    const layout = await frame.copyTo(rgba, {
      format: "RGBA",
      layout: [{ offset: 0, stride: image.width * 4 }]
    });
    if (layout.length !== 1 || layout[0]!.offset !== 0 || layout[0]!.stride !== image.width * 4) {
      throw new Error("Material image copy differs from its admitted RGBA layout");
    }
    return rgba;
  } finally {
    frame.close();
  }
}
