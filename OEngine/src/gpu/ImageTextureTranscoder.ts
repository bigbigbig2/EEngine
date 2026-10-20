import {
  imageTarget,
  checkedImageInteger,
  type ImageTexturePlane,
  type ImageTextureSemantic
} from "../assets/ImageTextureProduct.js";
import { assertImageTextureLease, type ImageTextureLease } from "../assets/codec/ImageTexturePreparation.js";
import type { CommandSubmissionObserver } from "../framegraph/ShadeGPUCommandContext.js";

export type ImageEncoderVariant = "bc7-rgb" | "bc7-rgba" | "bc5-rg" | "bc4-r";
export interface ImageKernelSource {
  readonly revision: "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf";
  readonly scope: "local-evaluation" | "authorized-production";
  readonly shaders: Readonly<Record<ImageEncoderVariant | "utils", string>>;
}

export interface ImageRecordCommand {
  readonly gpu_encoder: GPUCommandEncoder;
  observeSubmission(observer: CommandSubmissionObserver): void;
}

export interface ImageEncodeDestination {
  readonly texture: GPUTexture;
  readonly mip: number;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
}

interface Level {
  readonly width: number;
  readonly height: number;
  readonly offset: number;
  readonly bytesPerRow: number;
  readonly bytes: number;
}

interface InputSlot {
  readonly key: string;
  readonly textures: GPUTexture[];
  readonly upload: GPUTexture;
  readonly blocks: GPUBuffer;
  readonly params: GPUBuffer;
  readonly rgbaBytes: number;
  readonly blockBytes: number;
  readonly levels: readonly Level[];
  busy: boolean;
}

export function imageGpuFormat(semantic: ImageTextureSemantic): GPUTextureFormat {
  switch (semantic) {
    case "color-rgb":
    case "color-rgba":
      return "bc7-rgba-unorm-srgb";
    case "data-rgb":
    case "moment-xyz":
      return "bc7-rgba-unorm";
    case "normal-xy":
      return "bc5-rg-unorm";
    case "scalar-r":
      return "bc4-r-unorm";
    case "exact-r":
      return "r8unorm";
  }
}

/** Same five mechanical substitutions as the pinned Spark #loadPipeline, not a rewritten encoder. */
export function sparkPrecisionSource(source: string, precision: "f16" | "f32"): string {
  if (precision === "f16") {
    return source;
  }
  return source
    .replace(/^enable f16;\s*/m, "")
    .replace(/\bf16\b/g, "f32")
    .replace(/\bvec([234])h\b/g, "vec$1f")
    .replace(/\bmat([234]x[234])h/g, "mat$1f")
    .replace(/\b(\d*\.\d+|\d+\.)h\b/g, "$1");
}

/** Local canonical constant restoration. Algorithms and mip filtering remain upstream. */
const restoreSource = `
struct Params {
  constants: vec4<i32>,
};
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= textureDimensions(destination))) {
    return;
  }
  var color = textureLoad(source, vec2<i32>(id.xy), 0);
  for (var channel = 0u; channel < 4u; channel++) {
    if (params.constants[channel] >= 0) {
      color[channel] = f32(params.constants[channel]) / 255.0;
    }
  }
  textureStore(destination, id.xy, color);
}
`;

/** Encode-only E1 owner. No fetch, final texture allocation, finish or submit rights.
 * Cost: one external upload, optional constant pass, donor mip chain + one BC dispatch/copy
 * per actual level. RGBA and padded block/uniform bytes are admitted before allocation;
 * idle work is zero. Slots remain exclusive through submission fence, including abort/loss. */
export class ImageTextureTranscoder {
  readonly #device: GPUDevice;
  readonly #encoders: Readonly<Record<ImageEncoderVariant, GPUComputePipeline>>;
  readonly #mips: Readonly<Record<"magic" | "box", GPUComputePipeline>>;
  readonly #restore: GPUComputePipeline;
  readonly #sampler: GPUSampler;
  readonly #fragmentMips: Readonly<Record<"rgba8unorm" | "rgba8unorm-srgb", GPURenderPipeline>>;
  readonly #mipProfile: "compute" | "fragment";
  readonly #slots: InputSlot[] = [];
  readonly #exactRetire = new Set<() => void>();
  readonly #rgbaLimit: number;
  readonly #blockLimit: number;
  readonly precision: "f16" | "f32";
  readonly sourceScope: ImageKernelSource["scope"];
  #disposed = false;
  #rgbaBytes = 0;
  #blockBytes = 0;
  #records = 0;
  #mipDispatches = 0;
  #encodeDispatches = 0;
  #needsDrain = 0;

  private constructor(
    device: GPUDevice,
    source: ImageKernelSource,
    encoders: Record<ImageEncoderVariant, GPUComputePipeline>,
    mips: Record<"magic" | "box", GPUComputePipeline>,
    restore: GPUComputePipeline,
    precision: "f16" | "f32",
    rgbaLimit: number,
    blockLimit: number,
    fragmentMips: Record<"rgba8unorm" | "rgba8unorm-srgb", GPURenderPipeline>,
    mipProfile: "compute" | "fragment"
  ) {
    this.#device = device;
    this.#encoders = encoders;
    this.#mips = mips;
    this.#restore = restore;
    this.precision = precision;
    this.sourceScope = source.scope;
    this.#rgbaLimit = rgbaLimit;
    this.#blockLimit = blockLimit;
    this.#fragmentMips = fragmentMips;
    this.#mipProfile = mipProfile;
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    void device.lost.then(() => {
      this.#disposed = true;
      // No GPU work can read these resources after device loss, even an unsubmitted command.
      for (const slot of [...this.#slots]) {
        this.#retire(slot);
      }
      for (const retire of this.#exactRetire) {
        retire();
      }
    });
  }

  static async create(
    device: GPUDevice,
    source: ImageKernelSource,
    options: {
      precision?: "f16" | "f32";
      maxRgbaBytes?: number;
      maxScratchBytes?: number;
      mipProfile?: "compute" | "fragment";
    } = {}
  ): Promise<ImageTextureTranscoder> {
    const precision = options.precision ?? (device.features.has("shader-f16") ? "f16" : "f32");
    if (
      !device.features.has("texture-compression-bc") ||
      (precision === "f16" && !device.features.has("shader-f16")) ||
      device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
      device.limits.maxComputeWorkgroupSizeX < 16 ||
      device.limits.maxComputeWorkgroupSizeY < 8 ||
      device.limits.maxComputeWorkgroupStorageSize < 5184
    ) {
      throw new Error("Image transcoder BC/precision/workgroup profile unsupported");
    }
    if (
      source.revision !== "b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf" ||
      !["local-evaluation", "authorized-production"].includes(source.scope)
    ) {
      throw new Error("Image transcoder requires pinned, explicitly scoped upstream kernels");
    }
    const rgbaLimit = checkedImageInteger(options.maxRgbaBytes ?? 48 * 1024 * 1024, 1, 512 * 1024 * 1024);
    const blockLimit = checkedImageInteger(options.maxScratchBytes ?? 16 * 1024 * 1024, 1, 128 * 1024 * 1024);
    // This module targets the engine's core binding profile, not WebGPU compatibility mode.
    if (!device.features.has("core-features-and-limits")) {
      throw new Error("Image transcoder requires the renderer core profile");
    }
    const mipProfile =
      options.mipProfile ??
      (/Firefox\//.test(globalThis.navigator?.userAgent ?? "") ? "fragment" : "compute");
    const compile = async (code: string, entryPoint: string, label: string) => {
      const module = device.createShaderModule({ code, label });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      if (errors.length) {
        throw new Error(errors.map((error) => `${label}:${error.lineNum}: ${error.message}`).join("\n"));
      }
      return device.createComputePipelineAsync({ label, layout: "auto", compute: { module, entryPoint } });
    };
    const encoders = {} as Record<ImageEncoderVariant, GPUComputePipeline>;
    for (const variant of ["bc7-rgb", "bc7-rgba", "bc5-rg", "bc4-r"] as const) {
      encoders[variant] = await compile(
        sparkPrecisionSource(source.shaders[variant], precision),
        "main",
        `Spark ${variant}/${precision}`
      );
    }
    const mips = {
      magic: await compile(source.shaders.utils, "magic_mipmap", "Spark magic mip"),
      box: await compile(source.shaders.utils, "mipmap", "Spark alpha box mip")
    };
    const restore = await compile(restoreSource, "main", "Canonical channel restore");
    const fragmentModule = device.createShaderModule({
      code: source.shaders.utils,
      label: "Spark fragment mip"
    });
    const fragmentMips = {} as Record<"rgba8unorm" | "rgba8unorm-srgb", GPURenderPipeline>;
    for (const format of ["rgba8unorm", "rgba8unorm-srgb"] as const) {
      fragmentMips[format] = await device.createRenderPipelineAsync({
        label: `Spark fragment mip ${format}`,
        layout: "auto",
        vertex: { module: fragmentModule, entryPoint: "fullscreen_vs" },
        fragment: { module: fragmentModule, entryPoint: "mipmap_fs", targets: [{ format }] },
        primitive: { topology: "triangle-strip" }
      });
    }
    return new ImageTextureTranscoder(
      device,
      source,
      encoders,
      mips,
      restore,
      precision,
      rgbaLimit,
      blockLimit,
      fragmentMips,
      mipProfile
    );
  }

  /** Destinations are hidden caller-owned regions; publish only after successful command settlement.
   * One destination per generated logical mip (or one for a provided item). NPOT/tiny output
   * uses complete physical BC blocks, not resized source texels. E2 owns sampling metadata. */
  record(
    command: ImageRecordCommand,
    lease: ImageTextureLease,
    destinations: readonly ImageEncodeDestination[],
    inspect?: (encoder: GPUCommandEncoder, upload: GPUTexture, logicalMips: readonly GPUTexture[]) => void
  ): "recorded" | "needs-drain" {
    assertImageTextureLease(lease);
    if (this.#disposed) {
      throw new Error("Image transcoder is disposed/device lost");
    }
    const { item, directory, result } = lease;
    const plane = directory.planes[item.plane]!;
    if (result.representation !== "decoded-image" || plane.target === "r8") {
      throw new Error("BC recorder requires a decoded image receipt");
    }
    const mipCount = plane.mips === "runtime" ? directory.mipCount : 1;
    if (
      this.#mipProfile === "fragment" &&
      mipCount > 1 &&
      (plane.semantic === "color-rgba" || plane.alphaScales.length > 0)
    ) {
      throw new Error(
        "Donor fragment mip does not preserve alpha weighting/scale; use canonical provided mips"
      );
    }
    if (destinations.length !== mipCount) {
      throw new Error("Image encode destinations must cover the complete admitted domain");
    }
    const levels = layoutLevels(
      item.width,
      item.height,
      mipCount,
      plane.target === "bc4-r" ? 8 : 16,
      this.#device.limits.minStorageBufferOffsetAlignment
    );
    for (let mip = 0; mip < levels.length; mip++) {
      this.#validateDestination(destinations[mip]!, levels[mip]!, plane);
    }
    const key = `${item.width}/${item.height}/${mipCount}/${plane.target}`;
    let slot = this.#slots.find((candidate) => !candidate.busy && candidate.key === key);
    if (!slot) {
      const rgbaBytes =
        4 * (item.width * item.height + levels.reduce((sum, level) => sum + level.width * level.height, 0));
      const uniformBytes =
        Math.max(256, this.#device.limits.minUniformBufferOffsetAlignment) * (mipCount + 1);
      const last = levels.at(-1)!;
      const blockBytes = last.offset + last.bytes + uniformBytes;
      if (
        rgbaBytes > this.#rgbaLimit ||
        blockBytes > this.#blockLimit ||
        item.width > this.#device.limits.maxTextureDimension2D ||
        item.height > this.#device.limits.maxTextureDimension2D ||
        last.offset + last.bytes > this.#device.limits.maxBufferSize ||
        levels.some((level) => level.bytes > this.#device.limits.maxStorageBufferBindingSize)
      ) {
        throw new RangeError("Complete image encode exceeds negotiated scratch capacity");
      }
      for (const candidate of [...this.#slots]) {
        if (
          this.#rgbaBytes + rgbaBytes <= this.#rgbaLimit &&
          this.#blockBytes + blockBytes <= this.#blockLimit
        ) {
          break;
        }
        if (!candidate.busy) {
          this.#retire(candidate);
        }
      }
      if (this.#rgbaBytes + rgbaBytes > this.#rgbaLimit || this.#blockBytes + blockBytes > this.#blockLimit) {
        this.#needsDrain++;
        return "needs-drain";
      }
      slot = this.#createSlot(key, levels, rgbaBytes, blockBytes, uniformBytes);
    }
    slot.busy = true;
    const held = slot;
    let settled = false;
    const retire = () => {
      if (settled) {
        return;
      }
      settled = true;
      held.busy = false;
      if (this.#disposed) {
        this.#retire(held);
      }
    };
    try {
      command.observeSubmission({
        submitted: (fence) => {
          void fence.then(retire, () => {
            this.dispose();
            retire();
          });
        },
        aborted: retire,
        failed: () => {
          this.dispose();
          retire();
        }
      });
    } catch (error) {
      retire();
      throw error;
    }
    try {
      this.#device.queue.copyExternalImageToTexture(
        { source: result.image, flipY: false },
        { texture: held.upload, colorSpace: "srgb", premultipliedAlpha: false },
        { width: item.width, height: item.height }
      );
      lease.close();
      const stride = Math.max(256, this.#device.limits.minUniformBufferOffsetAlignment);
      const params = new ArrayBuffer(held.params.size);
      const values = new DataView(params);
      for (let channel = 0; channel < 4; channel++) {
        values.setInt32(channel * 4, plane.constants[channel] ?? -1, true);
      }
      const mode =
        plane.semantic === "normal-xy"
          ? 4
          : (plane.semantic.startsWith("color-") ? 1 : 0) | (plane.semantic === "color-rgba" ? 2 : 0);
      for (let level = 1; level < mipCount; level++) {
        values.setUint32(level * stride, mode, true);
        values.setFloat32(
          level * stride + 4,
          plane.alphaScales[Math.min(level - 1, plane.alphaScales.length - 1)] ?? 1,
          true
        );
      }
      this.#device.queue.writeBuffer(held.params, 0, params);
      const encoder = command.gpu_encoder;
      const restore = encoder.beginComputePass({ label: "Image canonical restore" });
      restore.setPipeline(this.#restore);
      restore.setBindGroup(
        0,
        this.#device.createBindGroup({
          layout: this.#restore.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: held.upload.createView() },
            {
              binding: 1,
              resource: held.textures[0]!.createView({ usage: GPUTextureUsage.STORAGE_BINDING })
            },
            { binding: 2, resource: { buffer: held.params, offset: 0, size: 16 } }
          ]
        })
      );
      restore.dispatchWorkgroups(Math.ceil(item.width / 8), Math.ceil(item.height / 8));
      restore.end();
      for (let level = 1; level < mipCount; level++) {
        const layout = levels[level]!;
        if (this.#mipProfile === "fragment") {
          const format = mode & 1 ? "rgba8unorm-srgb" : "rgba8unorm";
          const pipeline = this.#fragmentMips[format];
          const pass = encoder.beginRenderPass({
            label: "Spark fragment logical mip",
            colorAttachments: [
              {
                view: held.textures[level]!.createView({ format, usage: GPUTextureUsage.RENDER_ATTACHMENT }),
                loadOp: "clear",
                storeOp: "store",
                clearValue: [0, 0, 0, 0]
              }
            ]
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            this.#device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                {
                  binding: 0,
                  resource: held.textures[level - 1]!.createView({
                    format,
                    usage: GPUTextureUsage.TEXTURE_BINDING
                  })
                },
                { binding: 2, resource: this.#sampler },
                { binding: 3, resource: { buffer: held.params, offset: level * stride, size: 8 } }
              ]
            })
          );
          pass.draw(4);
          pass.end();
          this.#mipDispatches++;
          continue;
        }
        const pipeline = this.#mips[plane.semantic === "color-rgba" ? "box" : "magic"];
        const pass = encoder.beginComputePass({ label: "Spark logical mip" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          this.#device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: held.textures[level - 1]!.createView({
                  format: mode & 1 ? "rgba8unorm-srgb" : "rgba8unorm",
                  usage: GPUTextureUsage.TEXTURE_BINDING
                })
              },
              {
                binding: 1,
                resource: held.textures[level]!.createView({ usage: GPUTextureUsage.STORAGE_BINDING })
              },
              { binding: 2, resource: this.#sampler },
              { binding: 3, resource: { buffer: held.params, offset: level * stride, size: 8 } }
            ]
          })
        );
        pass.dispatchWorkgroups(Math.ceil(layout.width / 8), Math.ceil(layout.height / 8));
        pass.end();
        this.#mipDispatches++;
      }
      const pipeline = this.#encoders[plane.target];
      const pass = encoder.beginComputePass({ label: `Spark ${plane.target}/${this.precision}` });
      pass.setPipeline(pipeline);
      for (let level = 0; level < mipCount; level++) {
        const layout = levels[level]!;
        pass.setBindGroup(
          0,
          this.#device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: held.textures[level]!.createView({ usage: GPUTextureUsage.TEXTURE_BINDING })
              },
              { binding: 1, resource: this.#sampler },
              { binding: 2, resource: { buffer: held.blocks, offset: layout.offset, size: layout.bytes } }
            ]
          })
        );
        pass.dispatchWorkgroups(Math.ceil(layout.width / 64), Math.ceil(layout.height / 32));
        this.#encodeDispatches++;
      }
      pass.end();
      for (let level = 0; level < mipCount; level++) {
        const layout = levels[level]!;
        const destination = destinations[level]!;
        encoder.copyBufferToTexture(
          { buffer: held.blocks, offset: layout.offset, bytesPerRow: layout.bytesPerRow },
          {
            texture: destination.texture,
            mipLevel: destination.mip,
            origin: { x: destination.x, y: destination.y, z: destination.layer }
          },
          { width: Math.ceil(layout.width / 4) * 4, height: Math.ceil(layout.height / 4) * 4 }
        );
      }
      inspect?.(encoder, held.upload, held.textures);
      this.#records++;
      return "recorded";
    } catch (error) {
      // Caller must abort this command; never recycle partially recorded resources here.
      lease.close();
      throw error;
    }
  }

  recordExact(
    command: ImageRecordCommand,
    lease: ImageTextureLease,
    destination: ImageEncodeDestination
  ): void {
    assertImageTextureLease(lease);
    const { item, result, directory } = lease;
    const plane = directory.planes[item.plane]!;
    const texture = destination.texture;
    if (
      this.#disposed ||
      result.representation !== "exact-bytes" ||
      plane.target !== "r8" ||
      texture.format !== "r8unorm" ||
      !(texture.usage & GPUTextureUsage.COPY_DST)
    ) {
      throw new Error("Exact image recorder requires a live exact R8 receipt/target");
    }
    checkedImageInteger(destination.mip, 0, texture.mipLevelCount - 1);
    checkedImageInteger(destination.layer, 0, texture.depthOrArrayLayers - 1);
    checkedImageInteger(
      destination.x,
      0,
      Math.max(1, Math.floor(texture.width / 2 ** destination.mip)) - item.width
    );
    checkedImageInteger(
      destination.y,
      0,
      Math.max(1, Math.floor(texture.height / 2 ** destination.mip)) - item.height
    );
    const pitch = Math.ceil(item.width / 256) * 256;
    const size = pitch * item.height;
    if (size > this.#blockLimit || this.#blockBytes + size > this.#blockLimit) {
      throw new RangeError("Exact plane staging requires drain or exceeds capacity");
    }
    const buffer = this.#device.createBuffer({
      label: "Exact R8 hidden staging",
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    const bytes = new Uint8Array(buffer.getMappedRange());
    for (let row = 0; row < item.height; row++) {
      bytes.set(new Uint8Array(result.bytes, row * item.width, item.width), row * pitch);
    }
    buffer.unmap();
    this.#blockBytes += size;
    let released = false;
    const retire = () => {
      if (!released) {
        released = true;
        buffer.destroy();
        this.#blockBytes -= size;
        this.#exactRetire.delete(retire);
      }
    };
    this.#exactRetire.add(retire);
    try {
      command.observeSubmission({
        submitted: (fence) => {
          void fence.then(retire, retire);
        },
        aborted: retire,
        failed: retire
      });
    } catch (error) {
      retire();
      throw error;
    }
    command.gpu_encoder.copyBufferToTexture(
      { buffer, bytesPerRow: pitch },
      {
        texture,
        mipLevel: destination.mip,
        origin: { x: destination.x, y: destination.y, z: destination.layer }
      },
      { width: item.width, height: item.height }
    );
    lease.close();
    this.#records++;
  }

  #validateDestination(destination: ImageEncodeDestination, level: Level, plane: ImageTexturePlane): void {
    const texture = destination.texture;
    checkedImageInteger(destination.mip, 0, texture.mipLevelCount - 1);
    checkedImageInteger(destination.layer, 0, texture.depthOrArrayLayers - 1);
    const width = Math.max(1, Math.floor(texture.width / 2 ** destination.mip));
    const height = Math.max(1, Math.floor(texture.height / 2 ** destination.mip));
    checkedImageInteger(destination.x, 0, Math.ceil(width / 4) * 4 - Math.ceil(level.width / 4) * 4);
    checkedImageInteger(destination.y, 0, Math.ceil(height / 4) * 4 - Math.ceil(level.height / 4) * 4);
    if (
      destination.x % 4 ||
      destination.y % 4 ||
      texture.format !== imageGpuFormat(plane.semantic) ||
      !(texture.usage & GPUTextureUsage.COPY_DST) ||
      texture.dimension !== "2d" ||
      texture.sampleCount !== 1 ||
      imageTarget(plane.semantic) !== plane.target
    ) {
      throw new Error("Image destination format/usage/block domain mismatch");
    }
  }

  #createSlot(
    key: string,
    levels: readonly Level[],
    rgbaBytes: number,
    blockBytes: number,
    uniformBytes: number
  ): InputSlot {
    const textures: GPUTexture[] = [];
    let upload: GPUTexture | undefined;
    let blocks: GPUBuffer | undefined;
    let params: GPUBuffer | undefined;
    try {
      for (const level of levels) {
        textures.push(
          this.#device.createTexture({
            label: "Image exact logical mip",
            size: [level.width, level.height],
            format: "rgba8unorm",
            viewFormats: ["rgba8unorm-srgb"],
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.STORAGE_BINDING |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.RENDER_ATTACHMENT
          })
        );
      }
      upload = this.#device.createTexture({
        label: "Image external upload",
        size: [levels[0]!.width, levels[0]!.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING
      });
      blocks = this.#device.createBuffer({
        label: "Image padded blocks",
        size: blockBytes - uniformBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      params = this.#device.createBuffer({
        label: "Image exclusive recipe params",
        size: uniformBytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      const slot: InputSlot = {
        key,
        textures,
        upload,
        blocks,
        params,
        rgbaBytes,
        blockBytes,
        levels,
        busy: false
      };
      this.#slots.push(slot);
      this.#rgbaBytes += rgbaBytes;
      this.#blockBytes += blockBytes;
      return slot;
    } catch (error) {
      for (const texture of textures) {
        texture.destroy();
      }
      upload?.destroy();
      blocks?.destroy();
      params?.destroy();
      throw error;
    }
  }

  #retire(slot: InputSlot): void {
    const index = this.#slots.indexOf(slot);
    if (index < 0) {
      return;
    }
    this.#slots.splice(index, 1);
    for (const texture of slot.textures) {
      texture.destroy();
    }
    slot.upload.destroy();
    slot.blocks.destroy();
    slot.params.destroy();
    this.#rgbaBytes -= slot.rgbaBytes;
    this.#blockBytes -= slot.blockBytes;
  }

  evidence() {
    return {
      rgbaBytes: this.#rgbaBytes,
      scratchBytes: this.#blockBytes,
      slots: this.#slots.length,
      busySlots: this.#slots.filter((slot) => slot.busy).length,
      records: this.#records,
      mipDispatches: this.#mipDispatches,
      encodeDispatches: this.#encodeDispatches,
      needsDrain: this.#needsDrain
    };
  }

  dispose(): void {
    this.#disposed = true;
    for (const slot of [...this.#slots]) {
      if (!slot.busy) {
        this.#retire(slot);
      }
    }
  }
}

function layoutLevels(
  width: number,
  height: number,
  count: number,
  blockBytes: number,
  storageAlignment: number
): Level[] {
  const result: Level[] = [];
  let offset = 0;
  for (let mip = 0; mip < count; mip++) {
    offset = Math.ceil(offset / storageAlignment) * storageAlignment;
    const bytesPerRow = Math.ceil((Math.ceil(width / 4) * blockBytes) / 256) * 256;
    const bytes = bytesPerRow * Math.ceil(height / 4);
    result.push({ width, height, offset, bytesPerRow, bytes });
    offset += bytes;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return result;
}
