/**
 * Revision-local bind-group cache keyed by the actual GPU resources and buffer
 * ranges in binding order. It deliberately does not hash labels or wrapper
 * objects, so a stable FrameGraph resource tuple reuses the same native group.
 */

type PrimitiveKey = string | number | boolean | bigint | symbol | null | undefined;

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

  obtain(
    resources: readonly GPUBindingResource[],
    create: () => GPUBindGroup
  ): GPUBindGroup {
    if (resources.length === 0) {
      throw new RangeError("Bind-group resource cache requires at least one resource");
    }
    this.requestCount++;
    let node = this.root;
    for (const key of resourceTupleKeys(resources)) {
      node = childNode(node, key);
    }
    if (node.value !== undefined) return node.value;
    const value = create();
    node.value = value;
    this.creationCount++;
    return value;
  }

  evidence(): Readonly<GpuBindGroupResourceCacheEvidence> {
    return Object.freeze({
      requestCount: this.requestCount,
      creationCount: this.creationCount
    });
  }

  clear(): void {
    this.root = createNode<GPUBindGroup>();
  }
}

function resourceTupleKeys(
  resources: readonly GPUBindingResource[]
): readonly (object | PrimitiveKey)[] {
  const keys: (object | PrimitiveKey)[] = [resources.length];
  for (const resource of resources) {
    if (isGpuBufferBinding(resource)) {
      keys.push("buffer", resource.buffer as object, resource.offset ?? 0, resource.size ?? -1);
    } else {
      keys.push("resource", resource as object);
    }
  }
  return keys;
}

function isGpuBufferBinding(resource: GPUBindingResource): resource is GPUBufferBinding {
  return typeof resource === "object" && resource !== null &&
    "buffer" in resource && typeof resource.buffer === "object" && resource.buffer !== null;
}

function childNode<TValue extends object>(
  node: TupleNode<TValue>,
  key: object | PrimitiveKey
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
    value: undefined
  };
}
