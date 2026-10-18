import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryQueryGeometryLease } from "../../gpu/VirtualGeometryResidency.js";
import type { ScgiBvhPlan } from "./ScgiBvhLayout.js";

interface BlasCut {
  readonly key: string;
  readonly cuts: Map<string, BlasCut>;
  readonly entries: Map<string, ScgiQueryBlas>;
  liveEntries: number;
}

interface BlasDevice {
  readonly products: WeakMap<object, Map<string, BlasCut>>;
  readonly leases: WeakMap<GeometryQueryGeometryLease, BlasCut>;
}

/** Immutable static BLAS sharing, scoped to a device and immutable Product
 * descriptor. Every scene still owns its current decoder/page lease. Object
 * space nodes contain no physical page addresses, so relocation can share
 * bounds while rebinding the new Product directory. No idle cache allocation
 * survives the last scene fence. Preparing/aborted builds never enter reuse. */
export class ScgiQueryBlas {
  private static readonly devices = new WeakMap<GPUDevice, BlasDevice>();
  private references = 1;
  private submitted = false;
  private poisoned = false;
  private released = false;
  private readonly handles: ResourceHandle[] = [];

  private constructor(
    readonly buffer: GPUBuffer,
    readonly triangles: GPUBuffer,
    readonly plan: ScgiBvhPlan,
    private readonly cut: BlasCut,
    private readonly key: string,
    private readonly accounting?: ResourceAccounting,
  ) {
    if (accounting !== undefined) {
      for (const resource of [buffer, triangles]) {
        this.handles.push(
          accounting.created(
            {
              kind: "buffer",
              category: "resident",
              owner: "SCGI/static BLAS",
              label: resource.label,
              bytes: resource.size,
            },
            resource,
          ),
        );
      }
    }
  }

  static acquire(
    device: GPUDevice,
    plan: ScgiBvhPlan,
    lease: GeometryQueryGeometryLease,
    segmentIndex: number,
    asset: number,
    offset: number,
    count: number,
    accounting?: ResourceAccounting,
  ): { entry: ScgiQueryBlas; build: boolean } {
    let state = this.devices.get(device);
    if (state === undefined) {
      state = { products: new WeakMap(), leases: new WeakMap() };
      this.devices.set(device, state);
    }
    let cut = state.leases.get(lease);
    if (cut === undefined || cut.liveEntries === 0) {
      let cuts = state.products.get(lease.cut.descriptor);
      if (cuts === undefined) {
        cuts = new Map();
        state.products.set(lease.cut.descriptor, cuts);
      }
      // Compute/hash the complete logical cut once per lease, not once per
      // cluster shard. Otherwise large cuts produce quadratic cold CPU work.
      const cutKey = `${lease.segments.map((segment) => segment.metadata.size).join(",")}/${lease.cut.clusters.join(",")}`;
      cut = cuts.get(cutKey);
      if (cut === undefined) {
        cut = { key: cutKey, cuts, entries: new Map(), liveEntries: 0 };
        cuts.set(cutKey, cut);
      }
      state.leases.set(lease, cut);
    }
    const key = `${plan.primitiveCapacity}/${segmentIndex}/${asset}/${offset}/${count}`;
    const existing = cut.entries.get(key);
    if (existing !== undefined && existing.submitted && !existing.poisoned && !existing.released) {
      existing.references++;
      return { entry: existing, build: false };
    }
    const buffer = device.createBuffer({
      label: "SCGI/shared static BLAS",
      size: plan.hierarchy.bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    let triangles: GPUBuffer;
    try {
      triangles = device.createBuffer({
        label: "SCGI/shared intersection positions",
        size: Math.max(48, count * 48),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
    } catch (error) {
      buffer.destroy();
      throw error;
    }
    const entry = new ScgiQueryBlas(buffer, triangles, plan, cut, key, accounting);
    cut.liveEntries++;
    // A concurrently prepared candidate may build separately. Only a submitted
    // entry replaces this index; that does not change any retained old entry.
    return { entry, build: true };
  }

  observeBuild(command: ShadeGPUCommandContext): void {
    command.observeSubmission({
      submitted: (fence) => {
        this.submitted = true;
        this.cut.entries.set(this.key, this);
        void fence.catch(() => {
          this.poisoned = true;
        });
      },
      aborted: () => {},
      failed: () => {
        this.poisoned = true;
      },
    });
  }

  /** Each holder calls this only after its complete scene retirement/abort. */
  release(): void {
    if (this.released) {
      return;
    }
    if (--this.references !== 0) {
      return;
    }
    this.released = true;
    if (this.cut.entries.get(this.key) === this) {
      this.cut.entries.delete(this.key);
    }
    if (--this.cut.liveEntries === 0) {
      this.cut.cuts.delete(this.cut.key);
    }
    this.buffer.destroy();
    this.triangles.destroy();
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
