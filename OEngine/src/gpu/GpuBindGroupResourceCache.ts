/**
 * Revision-local bind-group cache keyed by the actual GPU resources and buffer
 * ranges in binding order. It deliberately does not hash labels or wrapper
 * objects, so a stable FrameGraph resource tuple reuses the same native group.
 */

type PrimitiveKey = string | number | boolean | bigint | symbol | null | undefined;

interface CachedDescriptor {
  readonly entries: readonly GPUBindGroupEntry[];
  readonly group: GPUBindGroup;
}

/** Owner-local, bounded binding reuse. Layout, binding numbers and buffer ranges
 * are part of identity. Eviction drops references, never destroys borrowed GPU
 * resources or groups still referenced by already encoded commands. */
export class GpuBindGroupCache {
  private layouts = new WeakMap<GPUBindGroupLayout, CachedDescriptor[]>();

  constructor(private readonly capacity = 16) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Bind group cache capacity must be a positive integer");
    }
  }

  create(device: GPUDevice, descriptor: GPUBindGroupDescriptor): GPUBindGroup {
    const entries = Array.from(descriptor.entries);
    let cached = this.layouts.get(descriptor.layout);
    if (cached === undefined) {
      cached = [];
      this.layouts.set(descriptor.layout, cached);
    }
    for (let index = 0; index < cached.length; index++) {
      const candidate = cached[index]!;
      if (entries.length !== candidate.entries.length) {
        continue;
      }
      let equal = true;
      for (let binding = 0; binding < entries.length; binding++) {
        const a = entries[binding]!,
          b = candidate.entries[binding]!;
        if (a.binding !== b.binding || !equalBindingResource(a.resource, b.resource)) {
          equal = false;
          break;
        }
      }
      if (equal) {
        if (index > 0) {
          cached.splice(index, 1);
          cached.unshift(candidate);
        }
        return candidate.group;
      }
    }
    const group = device.createBindGroup(descriptor);
    const snapshot = entries.map(({ binding, resource }) => ({
      binding,
      resource: isGpuBufferBinding(resource) ? { ...resource } : resource,
    }));
    cached.unshift({ entries: snapshot, group });
    if (cached.length > this.capacity) {
      cached.pop();
    }
    return group;
  }

  clear(): void {
    this.layouts = new WeakMap();
  }
}

function equalBindingResource(a: GPUBindingResource, b: GPUBindingResource): boolean {
  if (isGpuBufferBinding(a)) {
    return (
      isGpuBufferBinding(b) &&
      a.buffer === b.buffer &&
      (a.offset ?? 0) === (b.offset ?? 0) &&
      (a.size ?? -1) === (b.size ?? -1)
    );
  }
  return a === b;
}

interface TupleNode<TValue extends object> {
  readonly objects: WeakMap<object, TupleNode<TValue>>;
  readonly primitives: Map<PrimitiveKey, TupleNode<TValue>>;
  value: TValue | undefined;
}

export interface GpuBindGroupResourceCacheEvidence {
  readonly requestCount: number;
  readonly creationCount: number;
}

export class GpuBindGroupResourceCache {
  private root = createNode<GPUBindGroup>();
  private requestCount = 0;
  private creationCount = 0;
  private lastResources: readonly GPUBindingResource[] = [];
  private lastValue: GPUBindGroup | undefined;

  obtain(resources: readonly GPUBindingResource[], create: () => GPUBindGroup): GPUBindGroup {
    if (resources.length === 0) {
      throw new RangeError("Bind-group resource cache requires at least one resource");
    }
    this.requestCount++;
    if (this.lastValue !== undefined && equalResourceTuples(resources, this.lastResources)) {
      return this.lastValue;
    }
    let node = childNode(this.root, resources.length);
    for (const resource of resources) {
      if (isGpuBufferBinding(resource)) {
        node = childNode(node, "buffer");
        node = childNode(node, resource.buffer);
        node = childNode(node, resource.offset ?? 0);
        node = childNode(node, resource.size ?? -1);
      } else {
        node = childNode(node, "resource");
        node = childNode(node, resource);
      }
    }
    let value = node.value;
    if (value === undefined) {
      value = create();
      node.value = value;
      this.creationCount++;
    }
    this.lastResources = resources.map((resource) =>
      isGpuBufferBinding(resource)
        ? { buffer: resource.buffer, offset: resource.offset ?? 0, size: resource.size }
        : resource,
    );
    this.lastValue = value;
    return value;
  }

  evidence(): Readonly<GpuBindGroupResourceCacheEvidence> {
    return Object.freeze({
      requestCount: this.requestCount,
      creationCount: this.creationCount,
    });
  }

  clear(): void {
    this.root = createNode<GPUBindGroup>();
    this.lastResources = [];
    this.lastValue = undefined;
  }
}

function equalResourceTuples(
  first: readonly GPUBindingResource[],
  second: readonly GPUBindingResource[],
): boolean {
  if (first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index++) {
    const a = first[index]!,
      b = second[index]!;
    if (isGpuBufferBinding(a)) {
      if (
        !isGpuBufferBinding(b) ||
        a.buffer !== b.buffer ||
        (a.offset ?? 0) !== (b.offset ?? 0) ||
        (a.size ?? -1) !== (b.size ?? -1)
      ) {
        return false;
      }
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

function isGpuBufferBinding(resource: GPUBindingResource): resource is GPUBufferBinding {
  return (
    typeof resource === "object" &&
    resource !== null &&
    "buffer" in resource &&
    typeof resource.buffer === "object" &&
    resource.buffer !== null
  );
}

function childNode<TValue extends object>(
  node: TupleNode<TValue>,
  key: object | PrimitiveKey,
): TupleNode<TValue> {
  if (typeof key === "object" && key !== null) {
    let child = node.objects.get(key);
    if (child === undefined) {
      child = createNode<TValue>();
      node.objects.set(key, child);
    }
    return child;
  }
  let child = node.primitives.get(key);
  if (child === undefined) {
    child = createNode<TValue>();
    node.primitives.set(key, child);
  }
  return child;
}

function createNode<TValue extends object>(): TupleNode<TValue> {
  return {
    objects: new WeakMap<object, TupleNode<TValue>>(),
    primitives: new Map<PrimitiveKey, TupleNode<TValue>>(),
    value: undefined,
  };
}
