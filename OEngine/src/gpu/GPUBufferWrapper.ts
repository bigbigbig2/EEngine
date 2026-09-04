/**
 * GPUBufferWrapper：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

let nextGPUBufferWrapperId = 0;

export interface GPUBufferDescriptorJson {
  label?: string;
  size?: number;
  usage?: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
}

export type GPUBufferDescriptorLike = Pick<
  GPUBufferDescriptor,
  "size" | "usage" | "mappedAtCreation"
>;

export class GPUBufferDescriptorState {
  label = "";
  size = 0;
  usage: GPUBufferUsageFlags = 0;
  mappedAtCreation: boolean | undefined = false;

  setFromBuffer(buffer: GPUBuffer): void {
    this.size = buffer.size;
    this.usage = buffer.usage;
    this.mappedAtCreation = buffer.mapState === "mapped";
  }

  clone(): GPUBufferDescriptorState {
    const result = new GPUBufferDescriptorState();
    result.copy(this);
    return result;
  }

  copy(descriptor: GPUBufferDescriptorLike): void {
    this.size = Number(descriptor.size);
    this.usage = descriptor.usage;
    this.mappedAtCreation = descriptor.mappedAtCreation;
  }

  hash(): number {
    return (this.size ^ this.usage) | 0;
  }

  equals(other: GPUBufferDescriptorState): boolean {
    return (
      this.label === other.label &&
      this.size === other.size &&
      this.usage === other.usage &&
      this.mappedAtCreation === other.mappedAtCreation
    );
  }

  compare(other: GPUBufferDescriptorState): number {
    const sizeDifference = this.size - other.size;
    if (sizeDifference !== 0) return sizeDifference;
    const usageDifference = this.usage - other.usage;
    return usageDifference !== 0
      ? usageDifference
      : this.label.localeCompare(other.label);
  }

  fromJSON(json: GPUBufferDescriptorJson): void {
    this.label = json.label ?? "";
    this.size = json.size ?? 0;
    this.usage = json.usage ?? 0;
    this.mappedAtCreation = json.mappedAtCreation ?? false;
  }

  static fromJSON(json: GPUBufferDescriptorJson): GPUBufferDescriptorState {
    const result = new GPUBufferDescriptorState();
    result.fromJSON(json);
    return result;
  }
}

export class GPUBufferWrapper {
  readonly id = nextGPUBufferWrapperId++;
  readonly descriptor = new GPUBufferDescriptorState();
  private bufferValue: GPUBuffer | undefined;
  private onDestroyValue: (() => void) | undefined;

  static from(
    descriptor: GPUBufferDescriptorLike,
    buffer: GPUBuffer,
    onDestroy?: () => void
  ): GPUBufferWrapper {
    const result = new GPUBufferWrapper();
    result.descriptor.copy(descriptor);
    result.bufferValue = buffer;
    result.onDestroyValue = onDestroy;
    return result;
  }

  static fromBuffer(buffer: GPUBuffer): GPUBufferWrapper {
    const result = new GPUBufferWrapper();
    result.bufferValue = buffer;
    result.descriptor.setFromBuffer(buffer);
    return result;
  }

  get size(): number {
    return this.descriptor.size;
  }

  get gpu_buffer(): GPUBuffer | undefined {
    return this.bufferValue;
  }

  destroy(): void {
    if (this.bufferValue !== undefined) {
      this.bufferValue.destroy();
      this.bufferValue = undefined;
      this.onDestroyValue?.();
      this.onDestroyValue = undefined;
    }
  }
}

export { GPUBufferDescriptorState as JB, GPUBufferWrapper as VB };
