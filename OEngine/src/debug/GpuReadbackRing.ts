import type {
  AccountedResourceCategory,
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle
} from "./profiling/ResourceAccounting.js";

export interface GpuReadbackRingOptions {
  byteLength: number;
  slotCount?: number;
  label?: string;
  onResult: (result: GpuReadbackResult) => void;
  onError?: (failure: GpuReadbackFailure) => void;
  resourceAccounting?: ResourceAccounting;
  resourceCategory?: AccountedResourceCategory;
  resourceOwner?: string;
}

export interface GpuReadbackResult {
  frameIndex: number;
  data: ArrayBuffer;
}

export interface GpuReadbackFailure {
  frameIndex: number;
  error: unknown;
}

export interface GpuReadbackRingStats {
  slotCount: number;
  pending: number;
  completed: number;
  dropped: number;
  failed: number;
}

export interface GpuReadbackTicket {
  readonly slotIndex: number;
  readonly generation: number;
  readonly frameIndex: number;
}

type SlotState = "idle" | "encoded" | "mapping";

interface GpuReadbackSlot {
  buffer: GPUBuffer;
  accountingHandle?: AccountingResourceHandle;
  state: SlotState;
  generation: number;
  frameIndex: number;
}

/**
 * Fixed-capacity non-blocking MAP_READ ring. A full ring drops the new sample;
 * it never waits on the render frame or allocates another staging buffer.
 */
export class GpuReadbackRing {
  readonly byteLength: number;
  readonly slotCount: number;
  private readonly slots: GpuReadbackSlot[];
  private readonly onResult: GpuReadbackRingOptions["onResult"];
  private readonly onError: NonNullable<GpuReadbackRingOptions["onError"]>;
  private readonly resourceAccounting?: ResourceAccounting;
  private cursor = 0;
  private completedCount = 0;
  private droppedCount = 0;
  private failedCount = 0;
  private destroyed = false;

  constructor(device: GPUDevice, options: GpuReadbackRingOptions) {
    this.byteLength = alignedByteLength(options.byteLength);
    this.slotCount = positiveInteger(options.slotCount ?? 3, "slotCount");
    if (this.slotCount < 3) {
      throw new RangeError("GpuReadbackRing requires at least three slots");
    }
    this.onResult = options.onResult;
    this.onError = options.onError ?? (() => {});
    this.resourceAccounting = options.resourceAccounting;
    const label = options.label ?? "gpu-readback";
    this.slots = Array.from({ length: this.slotCount }, (_, index) => {
      const buffer = device.createBuffer({
        label: `${label}/slot-${index}`,
        size: this.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const accountingHandle = options.resourceAccounting?.created({
        kind: "buffer",
        category: options.resourceCategory ?? "readback",
        owner: options.resourceOwner ?? label,
        bytes: this.byteLength,
        label: `${label}/slot-${index}`
      });
      return {
        buffer,
        ...(accountingHandle === undefined ? {} : { accountingHandle }),
        state: "idle" as const,
        generation: 0,
        frameIndex: -1
      };
    });
  }

  get stats(): GpuReadbackRingStats {
    return {
      slotCount: this.slotCount,
      pending: this.slots.reduce(
        (count, slot) => count + (slot.state === "idle" ? 0 : 1),
        0
      ),
      completed: this.completedCount,
      dropped: this.droppedCount,
      failed: this.failedCount
    };
  }

  encodeCopy(
    encoder: Pick<GPUCommandEncoder, "copyBufferToBuffer">,
    source: GPUBuffer,
    sourceOffset: number,
    frameIndex: number
  ): GpuReadbackTicket | null {
    this.assertAlive();
    assertNonNegativeInteger(frameIndex, "frameIndex");
    assertAlignedOffset(sourceOffset);
    if (sourceOffset + this.byteLength > source.size) {
      throw new RangeError("Readback source range exceeds the source buffer");
    }
    const slotIndex = this.findIdleSlot();
    if (slotIndex < 0) {
      this.droppedCount++;
      return null;
    }
    const slot = this.slots[slotIndex]!;
    slot.state = "encoded";
    slot.frameIndex = frameIndex;
    slot.generation++;
    encoder.copyBufferToBuffer(
      source,
      sourceOffset,
      slot.buffer,
      0,
      this.byteLength
    );
    this.cursor = (slotIndex + 1) % this.slotCount;
    return {
      slotIndex,
      generation: slot.generation,
      frameIndex
    };
  }

  markSubmitted(ticket: GpuReadbackTicket): void {
    if (this.destroyed) return;
    const slot = this.slots[ticket.slotIndex];
    if (
      slot === undefined ||
      slot.generation !== ticket.generation ||
      slot.frameIndex !== ticket.frameIndex ||
      slot.state !== "encoded"
    ) {
      throw new Error("GpuReadbackTicket is stale or was not encoded");
    }
    slot.state = "mapping";
    void this.mapSlot(slot, ticket);
  }

  cancel(ticket: GpuReadbackTicket, error: unknown): void {
    if (this.destroyed) return;
    const slot = this.slots[ticket.slotIndex];
    if (
      slot === undefined ||
      slot.generation !== ticket.generation ||
      slot.frameIndex !== ticket.frameIndex ||
      slot.state !== "encoded"
    ) {
      return;
    }
    slot.state = "idle";
    this.failedCount++;
    this.onError({ frameIndex: ticket.frameIndex, error });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const slot of this.slots) {
      if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
      slot.buffer.destroy();
      if (slot.accountingHandle !== undefined) {
        this.resourceAccounting!.destroyed(slot.accountingHandle);
      }
      slot.state = "idle";
    }
  }

  private async mapSlot(
    slot: GpuReadbackSlot,
    ticket: GpuReadbackTicket
  ): Promise<void> {
    try {
      await slot.buffer.mapAsync(GPUMapMode.READ, 0, this.byteLength);
      if (this.destroyed || !this.ticketMatches(slot, ticket)) {
        if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
        return;
      }
      const mapped = slot.buffer.getMappedRange(0, this.byteLength);
      const data = mapped.slice(0);
      slot.buffer.unmap();
      slot.state = "idle";
      this.completedCount++;
      this.onResult({ frameIndex: ticket.frameIndex, data });
    } catch (error) {
      if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
      if (!this.ticketMatches(slot, ticket)) return;
      slot.state = "idle";
      if (this.destroyed) return;
      this.failedCount++;
      this.onError({ frameIndex: ticket.frameIndex, error });
    }
  }

  private ticketMatches(
    slot: GpuReadbackSlot,
    ticket: GpuReadbackTicket
  ): boolean {
    return slot.generation === ticket.generation &&
      slot.frameIndex === ticket.frameIndex;
  }

  private findIdleSlot(): number {
    for (let offset = 0; offset < this.slotCount; offset++) {
      const index = (this.cursor + offset) % this.slotCount;
      if (this.slots[index]!.state === "idle") return index;
    }
    return -1;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("GpuReadbackRing has been destroyed");
  }
}

function alignedByteLength(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError("byteLength must be a positive integer");
  }
  return Math.ceil(value / 4) * 4;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertAlignedOffset(value: number): void {
  assertNonNegativeInteger(value, "sourceOffset");
  if (value % 4 !== 0) throw new RangeError("sourceOffset must be 4-byte aligned");
}
