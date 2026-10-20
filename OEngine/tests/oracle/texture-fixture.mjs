import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { encodeCanonicalPng } from "../../.test-dist/assets/codec/ImageTextureImport.js";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";
import { imageTextureHash } from "../../.test-dist/assets/ImageTextureProduct.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ImageTextureTranscoder } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";

const deviceKernels = new WeakMap();
const fixtureOwners = new WeakMap();

export async function evaluationImageKernels() {
  const root = "/.local/extreme-web-asset/";
  const identity = await (await fetch(root + "sources.json")).json();
  const shaders = {};
  for (const [key, name] of Object.entries({
    "bc7-rgb": "spark_bc7_rgb.wgsl", "bc7-rgba": "spark_bc7_rgba.wgsl",
    "bc5-rg": "spark_bc5_rg.wgsl", "bc4-r": "spark_bc4_r.wgsl", utils: "utils.wgsl"
  })) {
    const response = await fetch(root + "sources/spark/src/shaders/" + name);
    if (!response.ok) throw new Error("Missing explicitly scoped evaluation kernels");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await imageTextureHash(bytes) !== identity.sources.spark.files["src/shaders/" + name]) {
      throw new Error("Evaluation kernel hash mismatch");
    }
    shaders[key] = new TextDecoder().decode(bytes);
  }
  return { revision: identity.sources.spark.revision, scope: "local-evaluation", shaders };
}

/** Diagnostic composition only; production uses GraphicsContext's sole owner. */
export async function prepareFixtureImageEncoding(graphics) {
  if (graphics.prepareImageTranscoder) return;
  let pending = deviceKernels.get(graphics.device);
  if (!pending) {
    pending = evaluationImageKernels().then((kernels) => ImageTextureTranscoder.create(graphics.device, kernels));
    deviceKernels.set(graphics.device, pending);
  }
  const transcoder = await pending;
  graphics.prepareImageTranscoder = async () => transcoder;
}

export async function fixtureImageBatch(graphics, record) {
  const command = ShadeGPUCommandContext.create(graphics, "Renderer/hidden-image-batch");
  try {
    record(command);
    command.finish();
    await command.gpuDone;
  } catch (error) {
    if (!command.closed) command.abort(error);
    throw error;
  }
}

export function releaseFixtureTexture(texture) {
  const preparation = fixtureOwners.get(texture);
  if (preparation) {
    texture.image_source.close();
    preparation.dispose();
    fixtureOwners.delete(texture);
  }
}

const semantics = {
  "base-color-srgb": "color-rgba", "emissive-srgb": "color-rgb",
  "normal-linear": "moment-xyz", "orm-linear": "data-rgb", "occlusion-linear": "data-rgb"
};

/** Authored mips become lossless image items, never CPU BC blocks. Only the
 * cold producer is injected; source registration, Worker decode, ready leases
 * and GPU encoding remain production code. Dispose after the final GPU fence. */
export async function fixtureImageSource(semantic, inputs, { exactAlpha = false, virtual = false } = {}) {
  const payloads = new Map();
  const result = await cookImageTexture({
    semantic, inputs, quality: "high", mode: virtual ? "virtual" : "resident",
    mips: "provided", exactCoverage: exactAlpha ? inputs : undefined,
    addressU: "repeat", addressV: "repeat", cellSize: 128,
    toolHash: await imageTextureHash(new TextEncoder().encode("oracle-lossless-png-v1"))
  }, {
    imageCodec: "png", encodeAvif: encodeCanonicalPng,
    async put(hash, bytes, kind) {
      payloads.set(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      return hash + (kind === "exact" ? ".bin" : ".png");
    }
  });
  const preparation = new CookedAssetPreparation({ maxWorkers: 1 });
  preparation.importImage = async () => ({ directory: result.directory, payloads, decodeMs: 0, release() {} });
  try {
    const { source } = await ImageTextureSource.importWeb({
      input: new ArrayBuffer(1), width: inputs[0].width, height: inputs[0].height,
      semantic, exactAlpha, addressU: "repeat", addressV: "repeat"
    }, undefined, preparation);
    return { source, preparation };
  } catch (error) {
    preparation.dispose();
    throw error;
  }
}

export async function fixtureTexture(semantic, mips, exactAlpha = false) {
  const inputs = mips.map((mip) => ({ width: mip.logicalWidth, height: mip.logicalHeight, rgba: mip.payload }));
  const fixture = await fixtureImageSource(semantics[semantic] ?? semantic, inputs, { exactAlpha });
  const texture = ShadeTexture.fromImageSource(fixture.source);
  fixtureOwners.set(texture, fixture.preparation);
  return texture;
}

export async function sourceFixture() {
  const inputs = [];
  for (let size = 256; ; size = Math.max(1, Math.floor(size / 2))) {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = size <= 64 ? 32 : 224;
        rgba.set([value, value, value, 255], (y * size + x) * 4);
      }
    }
    inputs.push({ width: size, height: size, rgba });
    if (size === 1) break;
  }
  return fixtureImageSource("scalar-r", inputs, { virtual: true });
}
