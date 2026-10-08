import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { compileCanonicalMaterial } from "../material/CanonicalMaterial.js";
import { snapshotAppearanceTexture } from "../material/AppearanceGraph.js";
import { AppearanceMaterialDefinition } from "../material/AppearanceMaterialDefinition.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeImage } from "../texture/ShadeImage.js";
import { PcTexturePreparation } from "./codec/PcTexturePreparation.js";
import type { TextureSemanticV2 } from "./TextureProduct.js";
import type { TextureProduct } from "./TextureProduct.js";

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
  "texture_clearcoat_normal",
] as const;
type Property = (typeof MATERIAL_TEXTURE_PROPERTIES)[number];
const preparedImages = new WeakMap<object, Map<string, Promise<TextureProduct>>>();
const preparedTextures = new WeakMap<ShadeTexture, Map<string, ShadeTexture>>();
const bitmapReplay = new WeakMap<ShadeImage, Uint8Array>();

export function materialTextureSemantic(property: Property): TextureSemanticV2 {
  if (property === "texture_albedo" || property === "texture_specular_color") {
    return "base-color-srgb";
  }
  if (property === "texture_emissive") {
    return "emissive-srgb";
  }
  if (property === "texture_normal" || property === "texture_clearcoat_normal") {
    return "normal-linear";
  }
  // Multi-channel/alpha extension maps must preserve their authored channels.
  if (property === "texture_occlusion" || property === "texture_clearcoat") {
    return "occlusion-linear";
  }
  return "orm-linear";
}

/** All live graph leaves, including user-authored graphs. Constant-dead maps do
 * not consume layers. This is publication-time CPU work, never a frame scan. */
export function materialTextureLeaves(material: StandardShadeMaterial): readonly ShadeTexture[] {
  return [
    ...new Set(compileCanonicalMaterial(material).appearance.samples.map((sample) => sample.binding.texture)),
  ];
}

/** Cold producer. It commits CPU material replacements only when the complete
 * batch is ready; the returned immutable Products are the device-loss source. */
export async function prepareMaterialTextureProducts(
  materials: readonly StandardShadeMaterial[],
  signal?: AbortSignal,
): Promise<void> {
  let cooker: PcTexturePreparation | undefined;
  const changes: Array<() => void> = [];
  const close = new Set<ImageBitmap>();
  const assertLive = () => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Texture preparation aborted", "AbortError");
    }
  };
  const prepare = async (
    texture: ShadeTexture,
    semantic: TextureSemanticV2,
    exactAlpha: boolean,
    channel: 0 | 1 | 2 | 3 = 0,
  ) => {
    assertLive();
    const existing = texture.texture_product;
    if (existing) {
      if (
        existing.metadata.semantic !== semantic &&
        !(semantic === "occlusion-linear" && existing.metadata.semantic === "orm-linear")
      ) {
        throw new Error(
          `Texture Product semantic '${existing.metadata.semantic}' cannot serve '${semantic}' without recooking`,
        );
      }
      if (
        semantic === "occlusion-linear" &&
        existing.metadata.semantic === semantic &&
        existing.metadata.channel !== channel
      ) {
        throw new Error("Scalar Texture Product channel does not match the material interpretation");
      }
      if (exactAlpha && !existing.metadata.exactAlpha) {
        throw new Error("Covered material requires an exact R8 coverage Product; recook the source");
      }
      return texture;
    }
    const image = texture.image;
    if (!image) {
      throw new Error("Material texture has no final BC Product or cold source");
    }
    const key = JSON.stringify([semantic, exactAlpha, channel]);
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
      cooker ??= new PcTexturePreparation();
      const sourceUri = texture.appearance_content_version ?? `image:${image.id}`;
      const options = { semantic, exactAlpha, channel, sourceUri };
      if (image.encoded_mime_type) {
        const input = (image.source as ArrayBuffer).slice(0);
        pending = (
          image.encoded_mime_type === "image/ktx2"
            ? cooker.importKtx(input, options, signal)
            : cooker.cookImage(
                input,
                image.encoded_mime_type as "image/png" | "image/jpeg" | "image/webp",
                options,
                signal,
              )
        ).then((result) => result.product);
      } else {
        const rgba = imageRgba(image);
        pending = cooker
          .cookRgba(rgba.buffer as ArrayBuffer, image.width, image.height, options, signal)
          .then((result) => result.product);
      }
      products.set(key, pending);
      pending.catch(() => {
        if (products!.get(key) === pending) {
          products!.delete(key);
        }
      });
    }
    const product = await pending;
    assertLive();
    const result = ShadeTexture.fromProduct(product);
    for (const name of [
      "minFilter",
      "magFilter",
      "mipmapFilter",
      "wrapS",
      "wrapT",
      "wrapR",
      "dimensions",
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
    if (typeof ImageBitmap !== "undefined" && image.source instanceof ImageBitmap) {
      close.add(image.source);
    }
    return result;
  };
  try {
    // Sharing an image with ORM must keep all channels for the AO consumer.
    const multichannel = new Set<object>();
    for (const material of materials) {
      for (const name of ["texture_orm", "texture_clearcoat_roughness", "texture_specular"] as const) {
        const texture = material[name];
        if (texture) {
          multichannel.add(texture.image ?? texture);
        }
      }
    }
    for (const material of new Set(materials)) {
      const live = new Set(materialTextureLeaves(material));
      for (const property of MATERIAL_TEXTURE_PROPERTIES) {
        const texture = material[property];
        if (!texture || !live.has(texture)) {
          continue;
        }
        let semantic = materialTextureSemantic(property);
        if (semantic === "occlusion-linear" && multichannel.has(texture.image ?? texture)) {
          semantic = "orm-linear";
        }
        const exact =
          property === "texture_albedo" && material.transparency_mode !== ShadeTransparencyMode.Opaque;
        const result = await prepare(
          texture,
          semantic,
          exact,
          property === "texture_clearcoat_roughness" ? 1 : 0,
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
          const exactAlpha =
            material.transparency_mode !== ShadeTransparencyMode.Opaque &&
            queries.some((sample) => (sample.readMask & 8) !== 0);
          const existing = b.texture.texture_product;
          if (
            existing &&
            (b.decode === "srgb-rgb") !== existing.metadata.planes[0]!.format.endsWith("-srgb")
          ) {
            throw new Error("Custom graph decode does not match Texture Product transfer function");
          }
          const semantic =
            existing?.metadata.semantic ?? (b.decode === "srgb-rgb" ? "base-color-srgb" : "orm-linear");
          const texture = await prepare(b.texture, semantic, exactAlpha, existing?.metadata.channel ?? 0);
          nodes.push({
            ...node,
            binding: snapshotAppearanceTexture(
              texture,
              b.decode,
              b.offset,
              b.scale,
              b.rotation,
              b.range,
              b.fallback,
            ),
          });
        }
        changes.push(() => {
          material.appearance_definition = new AppearanceMaterialDefinition(
            { ...definition.graph!, nodes },
            definition.products,
          );
        });
      }
    }
    assertLive();
    for (const commit of changes) {
      commit();
    }
    for (const bitmap of close) {
      bitmap.close();
    }
  } finally {
    cooker?.dispose();
  }
}

function imageRgba(image: ShadeImage): Uint8Array {
  if (image.depth !== 1 || image.data_type !== "uint8") {
    throw new Error("PC material cold cook requires a 2D uint8 image");
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
  const canvas = new OffscreenCanvas(image.width, image.height);
  const replay = bitmapReplay.get(image);
  if (replay) {
    return replay.slice();
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("PC texture decode needs a 2D canvas");
  }
  context.drawImage(source as ImageBitmap, 0, 0);
  const pixels = new Uint8Array(context.getImageData(0, 0, image.width, image.height).data.buffer);
  bitmapReplay.set(image, pixels);
  return pixels.slice();
}
