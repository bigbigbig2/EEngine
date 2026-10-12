import {
  planFinalPixelLightingDirectory,
  type FinalPixelLightingDirectoryPlan,
} from "../../gpu/FinalPixelAbi.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";

export interface FinalPixelLightingFrame {
  readonly plan: FinalPixelLightingDirectoryPlan;
  readonly buffer: GPUBuffer;
  readonly ranges: GPUBuffer;
}

interface Allocation extends FinalPixelLightingFrame {
  state: "free" | "prepared" | "submitted" | "destroyed";
  readonly handles: readonly ResourceHandle[];
  readonly filterData?: Uint8Array<ArrayBuffer>;
  retired?: boolean;
  command?: ShadeGPUCommandContext;
}

/** Bounded frame scratch, shared physically by three independent logical owners.
 * Every producer writes its own complete segment; no VSM/local capacity copy.
 * Three submitted frames retain distinct allocations through their last consumer
 * fence. Abort releases only the unsubmitted candidate, never an active history. */
export class FinalPixelLightingPublication {
  private readonly allocations: Allocation[] = [];
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly graphics?: GraphicsContext,
  ) {
    void device.lost.then(() => this.destroy());
  }

  prepare(
    lookupCount: number,
    descriptorCount: number,
    command: ShadeGPUCommandContext,
    filterData?: Uint8Array<ArrayBuffer>,
  ): FinalPixelLightingFrame {
    if (this.destroyed || command.closed || command.device !== this.device) {
      throw new Error("Final lighting publication requires a live frame command on its device");
    }
    const plan = planFinalPixelLightingDirectory(
      this.device.limits,
      lookupCount,
      descriptorCount,
      filterData?.byteLength ?? 0,
    );
    let allocation = this.allocations.find(
      (value) =>
        value.state === "free" &&
        value.plan.lookupCount === lookupCount &&
        value.plan.descriptorCount === descriptorCount &&
        value.filterData === filterData,
    );
    if (!allocation) {
      for (const previous of [...this.allocations]) {
        if (previous.state === "free") {
          this.release(previous);
        }
      }
      if (this.allocations.length >= 3) {
        throw new Error("Final lighting publication has three unresolved frame fences");
      }
      const buffer = this.device.createBuffer({
        label: "Final Pixel/lighting directory",
        size: plan.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      let ranges: GPUBuffer;
      try {
        ranges = this.device.createBuffer({
          label: "Final Pixel/lighting ranges",
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      } catch (error) {
        buffer.destroy();
        throw error;
      }
      const handles: ResourceHandle[] = [];
      try {
        this.device.queue.writeBuffer(ranges, 0, plan.words);
        if (filterData) {
          // Immutable VSM segment; no command-dependent data and no per-frame copy.
          this.device.queue.writeBuffer(buffer, plan.filterNoiseOffset, filterData);
        }
      } catch (error) {
        ranges.destroy();
        buffer.destroy();
        throw error;
      }
      for (const resource of [buffer, ranges]) {
        const handle = this.graphics?.resource_accounting.created(
          {
            kind: "buffer",
            category: "transient",
            owner: "FinalPixelLighting",
            bytes: resource.size,
            label: resource.label,
          },
          resource,
        );
        if (handle) {
          handles.push(handle);
        }
      }
      allocation = { plan, buffer, ranges, handles, filterData, state: "free" };
      this.allocations.push(allocation);
    }
    const current = allocation;
    current.state = "prepared";
    current.command = command;
    command.onAborted.addOne(() => {
      if (current.state === "prepared") {
        current.state = "free";
        current.command = undefined;
        if (this.destroyed || current.retired) {
          this.release(current);
        }
      }
    });
    command.onFinished.addOne(() => {
      current.state = "submitted";
      current.command = undefined;
      const completed = (): void => {
        current.state = "free";
        if (this.destroyed || current.retired) {
          this.release(current);
        }
      };
      void command.gpuDone.then(completed, completed);
    });
    return current;
  }

  get allocatedBytes(): number {
    return this.allocations.reduce((bytes, value) => bytes + value.plan.bytes + 16, 0);
  }

  /** Called only after an empty/unlit replacement successfully submits. */
  releaseFrameResources(): void {
    if (this.allocations.some((value) => value.state === "prepared")) {
      throw new Error("Final lighting release requires a frame boundary");
    }
    for (const allocation of [...this.allocations]) {
      allocation.retired = true;
      for (const handle of allocation.handles) {
        this.graphics?.resource_accounting.setRetired(handle, true);
      }
      if (allocation.state === "free") {
        this.release(allocation);
      }
    }
  }

  private release(allocation: Allocation): void {
    if (allocation.state === "destroyed") {
      return;
    }
    allocation.state = "destroyed";
    allocation.buffer.destroy();
    allocation.ranges.destroy();
    for (const handle of allocation.handles) {
      this.graphics?.resource_accounting.destroyed(handle);
    }
    const index = this.allocations.indexOf(allocation);
    if (index >= 0) {
      this.allocations.splice(index, 1);
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const allocation of [...this.allocations]) {
      if (allocation.state === "prepared") {
        allocation.command!.abort(new Error("Final lighting publication owner stopped"));
      }
      if (allocation.state === "free") {
        this.release(allocation);
      }
    }
  }
}
