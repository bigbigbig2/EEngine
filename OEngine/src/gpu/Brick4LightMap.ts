/** GPU owner for an immutable, monolithically resident Brick4 generation. */

import {
  validateBrick4LightMapPackageV1,
  type Brick4LightMapPackageV1,
  type Brick4LightMapPackageValidation
} from "../assets/Brick4LightMapPackage.js";

/**
 * Minimum legal binding size for Brick4LightMapStorage in the production WGSL.
 * The unavailable-provider buffer is never sampled, but WebGPU validates the
 * statically reachable storage layout before uniform control flow can reject it.
 */
export const BRICK4_LIGHT_MAP_MIN_BINDING_BYTES = 48;

export interface Brick4LightMapEvidence {
  readonly registered: boolean;
  readonly available: boolean;
  readonly generation: number;
  readonly expectedGeneration: number;
  readonly residentByteLength: number;
  readonly sourceUri: string | null;
  readonly branchNodeCount: number;
  readonly leafNodeCount: number;
  readonly referencedProbeCount: number;
}

export class Brick4LightMap {
  private bufferValue: GPUBuffer;
  private readonly retiredBuffers = new Set<GPUBuffer>();
  private generationValue = 0;
  private expectedGenerationValue = 0;
  private residentByteLengthValue = 0;
  private sourceUriValue: string | null = null;
  private validationValue: Brick4LightMapPackageValidation | null = null;
  private registeredValue = false;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    this.bufferValue = this.createBuffer(BRICK4_LIGHT_MAP_MIN_BINDING_BYTES, false);
  }

  get buffer(): GPUBuffer { return this.bufferValue; }
  get generation(): number { return this.generationValue; }
  get expected_generation(): number { return this.expectedGenerationValue; }
  get registered(): boolean { return this.registeredValue; }
  get available(): boolean {
    return this.registeredValue && this.residentByteLengthValue > 0 &&
      this.generationValue === this.expectedGenerationValue;
  }
  get resident_byte_length(): number { return this.residentByteLengthValue; }

  get gpu_memory_usage(): number {
    let bytes = this.bufferValue.size;
    for (const retired of this.retiredBuffers) bytes += retired.size;
    return bytes;
  }

  /**
   * Publishes a complete validated package atomically. The active buffer is
   * immutable; replacement never overwrites bytes referenced by an in-flight
   * frame, and the previous allocation retires only after submitted work.
   */
  upload(source: Brick4LightMapPackageV1): Brick4LightMapPackageValidation {
    this.assertAlive();
    const validation = validateBrick4LightMapPackageV1(source);
    if (this.registeredValue && source.generation < this.expectedGenerationValue) {
      throw new RangeError(
        `Brick4 generation ${source.generation} is older than expected ${this.expectedGenerationValue}`
      );
    }
    if (this.available && source.generation === this.generationValue) {
      throw new RangeError(`Brick4 generation ${source.generation} is already resident`);
    }

    const alignedSize = alignTo(source.storage.byteLength, 4);
    const next = this.createBuffer(alignedSize, true);
    new Uint8Array(next.getMappedRange(), 0, source.storage.byteLength)
      .set(source.storage);
    next.unmap();

    const previous = this.bufferValue;
    this.bufferValue = next;
    this.generationValue = source.generation;
    this.expectedGenerationValue = source.generation;
    this.residentByteLengthValue = source.storage.byteLength;
    this.sourceUriValue = source.sourceUri;
    this.validationValue = validation;
    this.registeredValue = true;
    this.retire(previous);
    return validation;
  }

  /**
   * Declares a newer desired mapping generation before its bytes arrive.
   * Frames deterministically fall through to Probe/IBL and increment the
   * invalid-generation counter until upload() atomically publishes it.
   */
  invalidate(nextGeneration = this.generationValue + 1): void {
    this.assertAlive();
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.generationValue ||
        nextGeneration > 0xffffffff) {
      throw new RangeError("Brick4 invalidation generation must advance as uint32");
    }
    this.registeredValue = true;
    this.expectedGenerationValue = nextGeneration;
    this.residentByteLengthValue = 0;
    this.sourceUriValue = null;
    this.validationValue = null;
  }

  evidence(): Brick4LightMapEvidence {
    return Object.freeze({
      registered: this.registered,
      available: this.available,
      generation: this.generationValue,
      expectedGeneration: this.expectedGenerationValue,
      residentByteLength: this.residentByteLengthValue,
      sourceUri: this.sourceUriValue,
      branchNodeCount: this.validationValue?.branchNodeCount ?? 0,
      leafNodeCount: this.validationValue?.leafNodeCount ?? 0,
      referencedProbeCount: this.validationValue?.referencedProbeCount ?? 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bufferValue.destroy();
    for (const retired of this.retiredBuffers) retired.destroy();
    this.retiredBuffers.clear();
  }

  private retire(buffer: GPUBuffer): void {
    this.retiredBuffers.add(buffer);
    void this.device.queue.onSubmittedWorkDone().then(
      () => this.destroyRetired(buffer),
      () => this.destroyRetired(buffer)
    );
  }

  private destroyRetired(buffer: GPUBuffer): void {
    if (!this.retiredBuffers.delete(buffer)) return;
    buffer.destroy();
  }

  private createBuffer(size: number, mappedAtCreation: boolean): GPUBuffer {
    return this.device.createBuffer({
      label: "Brick4 immutable light-map generation",
      size,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation
    });
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Brick4LightMap is destroyed");
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
