export type AccountedResourceKind = "buffer" | "texture" | "sampler" | "bindGroup" | "pipeline";

export interface ResourceAccountedInput {
  readonly kind: AccountedResourceKind;
  readonly owner: string;
  readonly bytes: number;
  readonly label?: string;
}

export interface ResourceHandle extends ResourceAccountedInput {
  readonly id: number;
}

export interface ResourceAccountingSnapshot {
  readonly totalBytes: number;
  readonly peakBytes: number;
  readonly counts: Readonly<Record<AccountedResourceKind, number>>;
  readonly owners: Readonly<Record<string, Readonly<Partial<Record<AccountedResourceKind, number>>>>>
}

export class ResourceAccounting {
  private nextId = 1;
  private currentBytes = 0;
  private peakBytes = 0;
  private readonly resources = new Map<number, ResourceHandle>();

  created(input: ResourceAccountedInput): ResourceHandle {
    validateInput(input);
    const handle = Object.freeze({ ...input, id: this.nextId++ });
    this.resources.set(handle.id, handle);
    this.currentBytes += handle.bytes;
    this.peakBytes = Math.max(this.peakBytes, this.currentBytes);
    return handle;
  }

  destroyed(handle: ResourceHandle): void {
    const current = this.resources.get(handle.id);
    if (current === undefined) throw new Error(`Resource ${handle.id} is already released or unknown`);
    this.resources.delete(handle.id);
    this.currentBytes -= current.bytes;
  }

  snapshot(): ResourceAccountingSnapshot {
    const counts: Record<AccountedResourceKind, number> = {
      buffer: 0, texture: 0, sampler: 0, bindGroup: 0, pipeline: 0
    };
    const ownerBytes: Record<string, Record<AccountedResourceKind, number>> = {};
    for (const resource of this.resources.values()) {
      counts[resource.kind]++;
      const owner = ownerBytes[resource.owner] ??= {
        buffer: 0, texture: 0, sampler: 0, bindGroup: 0, pipeline: 0
      };
      owner[resource.kind] += resource.bytes;
    }
    return Object.freeze({
      totalBytes: this.currentBytes,
      peakBytes: this.peakBytes,
      counts: Object.freeze({ ...counts }),
      owners: Object.freeze(Object.fromEntries(
        Object.entries(ownerBytes).map(([owner, values]) => [
          owner,
          Object.freeze(Object.fromEntries(
            Object.entries(values).filter(([, bytes]) => bytes > 0)
          ))
        ])
      ))
    });
  }
}

const FORMAT_BYTES: Readonly<Record<string, number>> = {
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1,
  rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
  rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
  bgra8unorm: 4, "bgra8unorm-srgb": 4,
  r16float: 2, rg16float: 4, rgba16float: 8,
  r32float: 4, rg32float: 8, rgba32float: 16,
  depth16unorm: 2, depth24plus: 4, "depth24plus-stencil8": 4, depth32float: 4,
  "depth32float-stencil8": 8
};

export function estimateTextureBytes(input: {
  format: string;
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  mipLevelCount?: number;
}): number {
  const bytesPerTexel = FORMAT_BYTES[input.format];
  if (bytesPerTexel === undefined) throw new RangeError(`unsupported texture format '${input.format}'`);
  assertPositiveInteger(input.width, "width");
  assertPositiveInteger(input.height, "height");
  const layers = input.depthOrArrayLayers ?? 1;
  const mipCount = input.mipLevelCount ?? 1;
  assertPositiveInteger(layers, "depthOrArrayLayers");
  assertPositiveInteger(mipCount, "mipLevelCount");
  let total = 0;
  for (let mip = 0; mip < mipCount; mip++) {
    total += Math.max(1, input.width >> mip) * Math.max(1, input.height >> mip) * layers * bytesPerTexel;
  }
  return total;
}

function validateInput(input: ResourceAccountedInput): void {
  if (!input.owner) throw new TypeError("Resource owner is required");
  if (!Number.isFinite(input.bytes) || input.bytes < 0) throw new RangeError("Resource bytes must be finite and non-negative");
  if (!Number.isInteger(input.bytes)) throw new RangeError("Resource bytes must be an integer");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
