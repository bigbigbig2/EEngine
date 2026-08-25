/**
 * ReusableResourceManager：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

export interface ReusableResourceOwner<Descriptor, Resource extends object> {
  createResource(descriptor: Descriptor): Resource;
  destroyResource(resource: Resource, descriptor: Descriptor): void;
}

type CacheEntry<Descriptor, Resource extends object> = {
  key: string;
  descriptor: Descriptor;
  resource: Resource;
};

export class ReusableResourceManager<Descriptor, Resource extends object> {
  private owner: ReusableResourceOwner<Descriptor, Resource> | null = null;
  private readonly live = new Map<Resource, Descriptor>();
  private readonly byKey = new Map<string, CacheEntry<Descriptor, Resource>[]>();
  private readonly order: CacheEntry<Descriptor, Resource>[] = [];

  constructor(
    private readonly keyOf: (descriptor: Descriptor) => string,
    readonly capacity = 100,
    readonly perKeyCapacity = 10
  ) {}

  attach(owner: ReusableResourceOwner<Descriptor, Resource>): void {
    this.owner = owner;
  }

  get(descriptor: Descriptor): Resource {
    const owner = this.requireOwner();
    const key = this.keyOf(descriptor);
    const bucket = this.byKey.get(key);
    let entry: CacheEntry<Descriptor, Resource> | undefined;
    if (bucket && bucket.length > 0) {
      entry = bucket.length > 1 ? bucket.pop() : bucket[0];
      if (bucket.length <= 1 && entry === bucket[0]) {
        this.byKey.delete(key);
      }
      const orderIndex = this.order.indexOf(entry!);
      if (orderIndex >= 0) this.order.splice(orderIndex, 1);
    }
    const resource = entry?.resource ?? owner.createResource(descriptor);
    if (this.live.has(resource)) {
      throw new Error("Resource is already associated with a live descriptor");
    }
    this.live.set(resource, descriptor);
    return resource;
  }

  release(resource: Resource): void {
    const descriptor = this.live.get(resource);
    if (descriptor === undefined) throw new Error("Resource is not managed");
    this.live.delete(resource);
    const key = this.keyOf(descriptor);
    let bucket = this.byKey.get(key);
    if (!bucket) {
      bucket = [];
      this.byKey.set(key, bucket);
    } else if (bucket.length >= this.perKeyCapacity) {
      return;
    }
    if (this.order.length >= this.capacity) this.removeOldest();
    const entry = { key, descriptor, resource };
    bucket.push(entry);
    this.order.push(entry);
  }

  destroy(): void {
    while (this.order.length > 0) this.removeOldest();
    const owner = this.requireOwner();
    for (const [resource, descriptor] of this.live) {
      owner.destroyResource(resource, descriptor);
    }
    this.live.clear();
  }

  private removeOldest(): void {
    const entry = this.order.shift();
    if (!entry) return;
    const bucket = this.byKey.get(entry.key);
    if (bucket) {
      const index = bucket.indexOf(entry);
      if (index >= 0) bucket.splice(index, 1);
      if (bucket.length === 0) this.byKey.delete(entry.key);
    }
    this.requireOwner().destroyResource(entry.resource, entry.descriptor);
  }

  private requireOwner(): ReusableResourceOwner<Descriptor, Resource> {
    if (!this.owner) throw new Error("ReusableResourceManager is not attached");
    return this.owner;
  }
}

export abstract class ReusableResourceContext<
  Descriptor,
  Resource extends object
> implements ReusableResourceOwner<Descriptor, Resource> {
  readonly resource_manager: ReusableResourceManager<Descriptor, Resource>;

  protected constructor(keyOf: (descriptor: Descriptor) => string) {
    this.resource_manager = new ReusableResourceManager(keyOf);
    this.resource_manager.attach(this);
  }

  abstract createResource(descriptor: Descriptor): Resource;
  abstract destroyResource(resource: Resource, descriptor: Descriptor): void;

  destroy(): void {
    this.resource_manager.destroy();
  }
}

export function stableResourceDescriptorKey(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}
