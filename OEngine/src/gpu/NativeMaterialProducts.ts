import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";
import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

export interface NativePackedProductField {
  /** Exact half-component offsets, including every original mip. */
  readonly offsets: readonly number[];
  readonly field: AppearanceAssetField;
}

/** Immutable cooked payload for resource-limited native programs. All half bits
 * remain in their original order: four half components occupy one RGBA texel.
 * Original field dimensions/mips are shader metadata, not physical texture mips.
 * One sampled binding, no storage binding, interpreter, cache or private submit.
 * This is local adaptation of EEngine's exact cooked-field sampling mathematics.
 * Caller selects this representation when the full hardware profile exceeds
 * negotiated limits; it is not a throughput optimization or an algorithm selector.
 *
 * Cost: original payload bytes + <2MiB page/alignment padding at the 256MiB
 * profile, one immutable upload, 8 explicit bilinear/trilinear corner reads.
 * No per-frame full-screen material store.
 * Caller owns its publication lifetime and supplies the final consumer fence.
 */
export class NativeMaterialProducts {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly payloadBytes: number;
  readonly physicalBytes: number;
  private accountingHandle: ResourceHandle | undefined;
  private readonly fields = new Map<string, NativePackedProductField>();
  private state: "staging" | "resident" | "retiring" | "destroyed" = "staging";

  constructor(
    device: GPUDevice,
    graphs: readonly CompiledAppearanceGraph[],
    command: ShadeGPUCommandContext,
    maximumPayloadBytes = 256 * 1024 * 1024,
    maximumUploadBytes = 258 * 1024 * 1024,
    private readonly accounting?: ResourceAccounting
  ) {
    if (command.device !== device || command.closed) {
      throw new Error("Native Products require an open same-device upload transaction");
    }
    for (const budget of [maximumPayloadBytes, maximumUploadBytes]) {
      if (!Number.isSafeInteger(budget) || budget < 1) {
        throw new RangeError("Native Product budgets must be positive finite byte capacities");
      }
    }
    const copies: { offset: number; payload: Uint8Array }[] = [];
    let bytes = 0;
    let payloadBytes = 0;
    for (const graph of graphs) {
      for (const read of graph.productReads ?? []) {
        const field = read.field;
        if (field.constant !== undefined || this.fields.has(field.contentKey)) {
          continue;
        }
        const channels = field.width === 3 ? 4 : field.width;
        if (channels !== 1 && channels !== 2 && channels !== 4) {
          throw new RangeError("Native Products require validated half-field channels");
        }
        const offsets: number[] = [];
        for (const mip of field.mips) {
          if (
            !Number.isInteger(mip.width) ||
            !Number.isInteger(mip.height) ||
            mip.width < 1 ||
            mip.height < 1 ||
            mip.payload.byteLength !== mip.width * mip.height * channels * 2
          ) {
            throw new RangeError("Native Product payload must match its exact original mip");
          }
          // Mips start on a packed RGBA texel, preserving every half bit.
          bytes = Math.ceil(bytes / 8) * 8;
          offsets.push(bytes / 2);
          copies.push({ offset: bytes, payload: mip.payload });
          bytes += mip.payload.byteLength;
          payloadBytes += mip.payload.byteLength;
        }
        if (offsets.length === 0) {
          throw new RangeError("Native nonconstant Products require their complete mip chain");
        }
        this.fields.set(field.contentKey, Object.freeze({ field, offsets: Object.freeze(offsets) }));
      }
    }
    if (bytes === 0 || payloadBytes > maximumPayloadBytes) {
      throw new RangeError("Native Product payload exceeds the declared immutable capacity");
    }
    const texels = Math.ceil(bytes / 8);
    const width = Math.min(512, Math.max(32, 2 ** Math.ceil(Math.log2(Math.sqrt(texels)))));
    const height = Math.min(512, Math.max(1, 2 ** Math.ceil(Math.log2(texels / width))));
    const pageBytes = width * height * 8;
    const layers = Math.ceil(bytes / pageBytes);
    const physicalBytes = pageBytes * layers;
    if (
      width > device.limits.maxTextureDimension2D ||
      height > device.limits.maxTextureDimension2D ||
      layers > device.limits.maxTextureArrayLayers ||
      pageBytes > device.limits.maxBufferSize ||
      physicalBytes > maximumUploadBytes
    ) {
      throw new RangeError("Native Product physical/upload capacity exceeds negotiated limits");
    }
    this.payloadBytes = payloadBytes;
    this.physicalBytes = physicalBytes;
    this.texture = device.createTexture({
      label: "SurfaceV4/exact packed cooked Products",
      size: [width, height, layers],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    try {
      this.view = this.texture.createView({ dimension: "2d-array" });
      this.accountingHandle = accounting?.created(
        {
          kind: "texture",
          category: "resident",
          owner: "NativeMaterialProducts",
          bytes: this.physicalBytes,
          label: this.texture.label
        },
        this.texture
      );
    } catch (error) {
      this.texture.destroy();
      throw error;
    }
    command.onAborted.addOne(() => this.destroy());
    command.onBeforeFinish.addOne(() => {
      if (this.state !== "staging") {
        throw new Error("Native Product upload was retired before submit");
      }
    });
    command.onFinished.addOne(() => {
      this.state = "resident";
    });
    void device.lost.then(() => this.destroy());
    try {
      // A page-sized CPU staging window avoids another full-payload CPU copy.
      for (let layer = 0; layer < layers; layer++) {
        const page = new Uint8Array(pageBytes);
        const start = layer * pageBytes;
        for (const copy of copies) {
          const low = Math.max(start, copy.offset);
          const high = Math.min(start + pageBytes, copy.offset + copy.payload.byteLength);
          if (high > low) {
            page.set(copy.payload.subarray(low - copy.offset, high - copy.offset), low - start);
          }
        }
        const staging = command.allocateTextureUploadBuffer(page.buffer);
        command.copyBufferToTexture(
          { buffer: staging, bytesPerRow: width * 8, rowsPerImage: height },
          { texture: this.texture, origin: [0, 0, layer] },
          [width, height, 1]
        );
      }
    } catch (error) {
      this.destroy();
      command.abort(error);
      throw error;
    }
  }

  field(field: AppearanceAssetField): NativePackedProductField {
    if (this.state === "retiring" || this.state === "destroyed") {
      throw new Error("Native Product publication is no longer consumable");
    }
    const result = this.fields.get(field.contentKey);
    if (result === undefined) {
      throw new RangeError("Native Product field is missing from the immutable publication");
    }
    return result;
  }

  get allocatedBytes(): number {
    return this.state === "destroyed" ? 0 : this.physicalBytes;
  }

  async retire(completion: Promise<void>): Promise<void> {
    if (this.state === "destroyed") {
      return;
    }
    this.state = "retiring";
    if (this.accountingHandle) {
      this.accounting?.setRetired(this.accountingHandle, true);
    }
    try {
      await completion;
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.state === "destroyed") {
      return;
    }
    this.state = "destroyed";
    this.texture.destroy();
    if (this.accountingHandle) {
      this.accounting?.destroyed(this.accountingHandle);
      this.accountingHandle = undefined;
    }
  }
}
