/**
 * Delayed ownership ring for GPU demand feedback.
 *
 * The ring deliberately knows nothing about visible work.  The producer writes
 * one bounded demand queue into a slot; a later completed frame makes that slot
 * eligible for mapping.  A caller must provide the actual WebGPU map operation,
 * which keeps this class testable without manufacturing a fake GPU device.
 */
export const GEOMETRY_DEMAND_READBACK_MAX_BYTES_V1 = 256 * 1024;

export type GeometryDemandReadbackSlotStateV1 = "free" | "submitted" | "mapping" | "ready";

export interface GeometryDemandReadbackSlotV1 {
  readonly index: number;
  readonly byteLength: number;
  readonly storage: ArrayBuffer;
  state: GeometryDemandReadbackSlotStateV1;
  submittedFrame: number;
}

export interface GeometryDemandReadbackResultV1 {
  readonly slotIndex: number;
  readonly frameIndex: number;
  readonly bytes: ArrayBuffer;
}

export interface GeometryDemandReadbackRingOptionsV1 {
  readonly slotCount?: number;
  readonly bytesPerSlot?: number;
  /** Maps an old slot after GPU completion; never called by submit(). */
  readonly mapCompletedSlot: (slot: GeometryDemandReadbackSlotV1) => Promise<ArrayBuffer>;
}

export class GeometryDemandReadbackRingV1 {
  readonly #slots: GeometryDemandReadbackSlotV1[];
  readonly #mapCompletedSlot: GeometryDemandReadbackRingOptionsV1["mapCompletedSlot"];
  readonly #frames = new Set<number>();
  #submitted = 0;
  #overflow = 0;
  #lastSubmittedFrame = -1;

  constructor(options: GeometryDemandReadbackRingOptionsV1) {
    const slotCount = options.slotCount ?? 3;
    const bytesPerSlot = options.bytesPerSlot ?? GEOMETRY_DEMAND_READBACK_MAX_BYTES_V1;
    if (!Number.isInteger(slotCount) || slotCount < 2) throw new RangeError("readback ring requires at least two slots");
    if (!Number.isInteger(bytesPerSlot) || bytesPerSlot <= 0 || bytesPerSlot > GEOMETRY_DEMAND_READBACK_MAX_BYTES_V1 || (bytesPerSlot & 3) !== 0) throw new RangeError("readback slot must be 4-byte aligned and no larger than 256 KiB");
    if (typeof options.mapCompletedSlot !== "function") throw new TypeError("readback ring requires a delayed map callback");
    this.#slots = Array.from({ length: slotCount }, (_, index) => ({ index, byteLength: bytesPerSlot, storage: new ArrayBuffer(bytesPerSlot), state: "free" as const, submittedFrame: -1 }));
    this.#mapCompletedSlot = options.mapCompletedSlot;
  }

  /** Reserve and encode one queue copy. This method never maps or awaits. */
  submit(frameIndex: number, encode: (slot: GeometryDemandReadbackSlotV1) => void): number | undefined {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new RangeError("readback frame index must be a non-negative integer");
    if (frameIndex <= this.#lastSubmittedFrame || this.#frames.has(frameIndex)) { this.#overflow++; return undefined; }
    const slot = this.#slots.find(candidate => candidate.state === "free");
    if (!slot) { this.#overflow++; return undefined; }
    encode(slot);
    slot.submittedFrame = frameIndex;
    slot.state = "submitted";
    this.#frames.add(frameIndex);
    this.#lastSubmittedFrame = frameIndex;
    this.#submitted++;
    return slot.index;
  }

  /**
   * Maps only slots from frames strictly older than completedFrame.  Mapping is
   * intentionally asynchronous and can be called after submit has returned.
   */
  async poll(completedFrame: number): Promise<readonly GeometryDemandReadbackResultV1[]> {
    if (!Number.isSafeInteger(completedFrame) || completedFrame < 0) throw new RangeError("completed frame index must be a non-negative integer");
    const pending = this.#slots.filter(slot => slot.state === "submitted" && slot.submittedFrame < completedFrame);
    const results: GeometryDemandReadbackResultV1[] = [];
    await Promise.all(pending.map(async slot => {
      slot.state = "mapping";
      try {
        const bytes = await this.#mapCompletedSlot(slot);
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > slot.byteLength) throw new RangeError("mapped readback exceeds slot capacity");
        const copy = bytes.slice(0);
        slot.state = "ready";
        results.push(Object.freeze({ slotIndex: slot.index, frameIndex: slot.submittedFrame, bytes: copy }));
      } catch (error) {
        const frame = slot.submittedFrame;
        slot.state = "free";
        slot.submittedFrame = -1;
        this.#frames.delete(frame);
        throw error;
      }
    }));
    results.sort((a, b) => a.frameIndex - b.frameIndex || a.slotIndex - b.slotIndex);
    return Object.freeze(results);
  }

  release(slotIndex: number): void {
    const slot = this.#slots[slotIndex];
    if (!slot || slot.state !== "ready") throw new RangeError("readback slot is not ready for release");
    slot.state = "free";
    this.#frames.delete(slot.submittedFrame);
    slot.submittedFrame = -1;
  }

  slot(slotIndex: number): GeometryDemandReadbackSlotV1 {
    const slot = this.#slots[slotIndex];
    if (!slot) throw new RangeError("readback slot index is invalid");
    return slot;
  }

  evidence(): Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }> {
    return Object.freeze({ submitted: this.#submitted, overflow: this.#overflow, inUse: this.#slots.filter(slot => slot.state !== "free").length, ready: this.#slots.filter(slot => slot.state === "ready").length });
  }
}

export interface GpuGeometryDemandReadbackRingOptionsV1 {
  readonly device: GPUDevice;
  readonly slotCount?: number;
  readonly bytesPerSlot?: number;
}

/**
 * WebGPU owner for the delayed demand ring.  The copy is encoded into the
 * caller's existing submission; mapping is only possible after a later frame
 * completion has been observed by the caller.
 */
export class GpuGeometryDemandReadbackRingV1 {
  readonly #device: GPUDevice;
  readonly #ring: GeometryDemandReadbackRingV1;
  readonly #buffers: GPUBuffer[];
  readonly #bytesPerSlot: number;
  #destroyed = false;

  constructor(options: GpuGeometryDemandReadbackRingOptionsV1) {
    this.#device = options.device;
    const slotCount = options.slotCount ?? 3;
    this.#bytesPerSlot = options.bytesPerSlot ?? GEOMETRY_DEMAND_READBACK_MAX_BYTES_V1;
    if (!Number.isInteger(slotCount) || slotCount < 2) {
      throw new RangeError("GPU demand readback ring requires at least two slots");
    }
    if (!Number.isInteger(this.#bytesPerSlot) || this.#bytesPerSlot <= 0 ||
        this.#bytesPerSlot > GEOMETRY_DEMAND_READBACK_MAX_BYTES_V1 ||
        (this.#bytesPerSlot & 3) !== 0) {
      throw new RangeError("GPU demand readback slot must be 4-byte aligned and bounded");
    }
    this.#buffers = Array.from({ length: slotCount }, (_, index) => this.#device.createBuffer({
      label: `Geometry Page Demand readback ${index}`,
      size: this.#bytesPerSlot,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    }));
    this.#ring = new GeometryDemandReadbackRingV1({
      slotCount,
      bytesPerSlot: this.#bytesPerSlot,
      mapCompletedSlot: async (slot) => {
        const buffer = this.#buffers[slot.index]!;
        await buffer.mapAsync(GPUMapMode.READ, 0, this.#bytesPerSlot);
        try {
          return buffer.getMappedRange(0, this.#bytesPerSlot).slice(0);
        } finally {
          buffer.unmap();
        }
      }
    });
  }

  get bytesPerSlot(): number { return this.#bytesPerSlot; }

  /** Encodes a bounded queue copy and never maps or waits for the GPU. */
  encode(
    encoder: GPUCommandEncoder,
    source: GPUBuffer,
    frameIndex: number
  ): number | undefined {
    this.assertAlive();
    if (!Number.isInteger(source.size) || source.size <= 0 ||
        source.size > this.#bytesPerSlot) {
      throw new RangeError("GPU demand source exceeds the readback slot capacity");
    }
    return this.#ring.submit(frameIndex, (slot) => {
      encoder.copyBufferToBuffer(
        source,
        0,
        this.#buffers[slot.index]!,
        0,
        source.size
      );
    });
  }

  async poll(completedFrame: number): Promise<readonly GeometryDemandReadbackResultV1[]> {
    this.assertAlive();
    return this.#ring.poll(completedFrame);
  }

  release(slotIndex: number): void {
    this.assertAlive();
    this.#ring.release(slotIndex);
  }

  slot(slotIndex: number): GeometryDemandReadbackSlotV1 {
    this.assertAlive();
    return this.#ring.slot(slotIndex);
  }

  evidence(): Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }> {
    return this.#ring.evidence();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const buffer of this.#buffers) buffer.destroy();
  }

  private assertAlive(): void {
    if (this.#destroyed) throw new Error("GPU demand readback ring is destroyed");
  }
}
