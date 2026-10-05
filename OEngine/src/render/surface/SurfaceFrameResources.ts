import { SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES } from "../../gpu/SurfaceOptimizationCapacity.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import { GpuBindGroupResourceCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { resolveTextureView } from "../RenderTargetViews.js";
export type SurfaceResourceBinding = <T extends object>(name: string, resolve: () => T) => T;
/** Queue-ordered scratch owned by Surface. Scratch is produced before consumption;
 * persistent cache cells are published by their sole producer and carry exact witnesses. GPU queue order permits reuse while two CPU
 * frames are in flight. Uploads must be encoder copies, never out-of-band writes.
 * Graph imports are late-bound so returning to a cached resize recipe is safe. */
export class SurfaceFrameResources {
  private buffers = new Map<
    string,
    {
      buffer: GPUBuffer;
      size: number;
      usage: number;
      handle?: ResourceHandle;
    }
  >();
  private extent = "";
  private activeBytes = 0;
  private retiredBytes = 0;
  private done: Promise<void> = Promise.resolve();
  private doneSettled = true;
  private bindings = new WeakMap<
    GPUComputePipeline,
    Map<
      number,
      {
        layout: GPUBindGroupLayout;
        shapes: Map<string, GpuBindGroupResourceCache>;
      }
    >
  >();
  private bindingRequests = 0;
  private bindingCreations = 0;
  private textureViews = new WeakMap<object, GPUTextureView>();
  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting,
    private readonly budgetBytes = SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES,
  ) {}
  canPrepare(width: number, height: number, requiredBytes: number): boolean {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > this.budgetBytes) {
      throw new RangeError("Surface replacement scratch cannot fit its complete profile");
    }
    if (this.extent === `${width}x${height}`) {
      return true;
    }
    const pendingActiveBytes = this.doneSettled ? 0 : this.activeBytes;
    return pendingActiveBytes + this.retiredBytes + requiredBytes <= this.budgetBytes;
  }
  prepare(width: number, height: number): void {
    const extent = `${width}x${height}`;
    if (this.extent !== extent) {
      this.retire();
      this.extent = extent;
    }
  }
  importBuffer(
    graph: FrameGraph,
    bind: SurfaceResourceBinding,
    name: string,
    size: number,
    usage: number,
  ): ResourceId {
    if (
      !Number.isSafeInteger(size) ||
      size < 4 ||
      size > this.device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > this.device.limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError(`${name} exceeds negotiated Surface resource limits`);
    }
    return graph.import_resource(
      name,
      { kind: "imported", label: name, domain: "internal-full" },
      bind(`surface-scratch/${name}`, () => {
        let entry = this.buffers.get(name);
        if (entry && (entry.size !== size || entry.usage !== usage))
          throw new Error(`Surface scratch shape changed without prepare: ${name}`);
        if (!entry) {
          if (this.activeBytes + this.retiredBytes + size > this.budgetBytes) {
            throw new RangeError(
              `Surface scratch including in-flight retirement exceeds ${this.budgetBytes} bytes`,
            );
          }
          const buffer = this.device.createBuffer({ label: name, size, usage });
          const handle = this.accounting?.created({
            kind: "buffer",
            category: "transient",
            owner: "Surface/scratch",
            bytes: size,
            label: name,
          });
          entry = { buffer, size, usage, ...(handle === undefined ? {} : { handle }) };
          this.buffers.set(name, entry);
          this.activeBytes += size;
        }
        return entry.buffer;
      }),
    );
  }
  obtainBindGroup(
    pipeline: GPUComputePipeline,
    index: number,
    entries: readonly GPUBindGroupEntry[],
  ): GPUBindGroup {
    this.bindingRequests++;
    let pipelineBindings = this.bindings.get(pipeline);
    if (pipelineBindings === undefined) {
      pipelineBindings = new Map();
      this.bindings.set(pipeline, pipelineBindings);
    }
    let binding = pipelineBindings.get(index);
    if (binding === undefined) {
      binding = { layout: pipeline.getBindGroupLayout(index), shapes: new Map() };
      pipelineBindings.set(index, binding);
    }
    const shape = entries.map((entry) => entry.binding).join(",");
    let cache = binding.shapes.get(shape);
    if (cache === undefined) {
      cache = new GpuBindGroupResourceCache();
      binding.shapes.set(shape, cache);
    }
    const layout = binding.layout;
    return cache.obtain(
      entries.map((entry) => entry.resource),
      () => {
        this.bindingCreations++;
        return this.device.createBindGroup({ layout, entries });
      },
    );
  }
  resolveTextureView(resource: unknown): GPUTextureView {
    if (
      resource === null ||
      typeof resource !== "object" ||
      !("createView" in resource) ||
      ("isGPUTextureContext" in resource && resource.isGPUTextureContext)
    ) {
      return resolveTextureView(resource);
    }
    let view = this.textureViews.get(resource);
    if (view === undefined) {
      view = resolveTextureView(resource);
      this.textureViews.set(resource, view);
    }
    return view;
  }
  bindingEvidence(): Readonly<{ requests: number; creations: number }> {
    return { requests: this.bindingRequests, creations: this.bindingCreations };
  }
  physicalBytes(): Readonly<{ active: number; retired: number; budget: number }> {
    return { active: this.activeBytes, retired: this.retiredBytes, budget: this.budgetBytes };
  }
  commit(done: Promise<void>): void {
    this.done = done;
    this.doneSettled = false;
    const settled = () => {
      if (this.done === done) {
        this.doneSettled = true;
      }
    };
    void done.then(settled, settled);
  }
  private retire(): void {
    this.bindings = new WeakMap();
    this.textureViews = new WeakMap();
    const retired = [...this.buffers.values()];
    this.buffers.clear();
    const bytes = this.activeBytes;
    this.retiredBytes += bytes;
    this.activeBytes = 0;
    const destroy = () => {
      this.retiredBytes -= bytes;
      for (const entry of retired) {
        entry.buffer.destroy();
        if (entry.handle) this.accounting!.destroyed(entry.handle);
      }
    };
    if (this.doneSettled) {
      destroy();
    } else {
      void this.done.then(destroy, destroy);
    }
  }
  destroy(): void {
    this.retire();
  }
}
