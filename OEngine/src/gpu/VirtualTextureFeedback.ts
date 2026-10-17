import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  virtualTextureFeedbackLayout,
  VT_PAGE_CAPACITY,
  VT_FEEDBACK_HEADER_WORDS,
  VT_WANTED,
  VT_USED,
  VT_PAGE_MASK
} from "./VirtualTextureAbi.js";
import { VIRTUAL_TEXTURE_FINALIZE_WGSL } from "../shaders/virtual_texture.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

interface Slot<T> {
  readonly gpu: GPUBuffer;
  readonly readback: GPUBuffer;
  readonly group: GPUBindGroup;
  readonly indirect: GPUBuffer;
  state: "free" | "encoded" | "submitted" | "mapping" | "recovery" | "recovering";
  frame: number;
  view: number;
  snapshot: T | null;
}
export interface VirtualTextureObservation<T> {
  readonly frame: number;
  readonly view: number;
  readonly snapshot: T;
  readonly wanted: readonly number[];
  readonly used: readonly number[];
}

/** Three exclusive GPU/CPU slots. Mirrored geometry's first-union-hit append,
 * with separate wanted/used bits and a retained overflow snapshot. No submit. */
export class VirtualTextureFeedback<T> {
  readonly ready: Promise<void>;
  readonly disabled: GPUBuffer;
  readonly layout = virtualTextureFeedbackLayout(VT_PAGE_CAPACITY);
  private readonly slots: Slot<T>[] = [];
  private readonly bindLayout: GPUBindGroupLayout;
  private prepare!: GPUComputePipeline;
  private finalize!: GPUComputePipeline;
  private stopped = false;
  private active: Slot<T> | undefined;
  private gaps = 0;
  private overflows = 0;
  private recoveries = 0;
  private lastGapFrame = -1;
  private lastFrame = -1;
  private readonly accountingHandles: ResourceHandle[] = [];
  /** Cold pipeline/binding preparation only; frame selection stays in begin. */
  get gpuBuffers(): readonly GPUBuffer[] {
    return [this.disabled, ...this.slots.map((slot) => slot.gpu)];
  }
  constructor(
    private readonly device: GPUDevice,
    private readonly observe: (value: VirtualTextureObservation<T>) => void,
    private readonly fail: (error: unknown) => void,
    private readonly accounting?: ResourceAccounting
  ) {
    const maximum = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (this.layout.bytes > maximum) {
      throw new RangeError("VT feedback exceeds negotiated buffer limits");
    }
    this.bindLayout = device.createBindGroupLayout({
      label: "VT/feedback finalize layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }]
    });
    this.disabled = device.createBuffer({
      label: "VT/disabled feedback",
      size: VT_FEEDBACK_HEADER_WORDS * 4,
      usage: GPUBufferUsage.STORAGE
    });
    const readbackBytes = Math.max(
      VT_FEEDBACK_HEADER_WORDS * 4 + this.layout.capacity * 4,
      this.layout.words * 8
    );
    for (let i = 0; i < 3; i++) {
      const gpu = device.createBuffer({
        label: `VT/feedback ${i}`,
        size: this.layout.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      const readback = device.createBuffer({
        label: `VT/feedback readback ${i}`,
        size: readbackBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const group = device.createBindGroup({
        label: `VT/feedback finalize ${i}`,
        layout: this.bindLayout,
        entries: [{ binding: 0, resource: { buffer: gpu } }]
      });
      const indirect = device.createBuffer({
        label: `VT/feedback indirect ${i}`,
        size: 12,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      });
      this.slots.push({ gpu, readback, group, indirect, state: "free", frame: -1, view: -1, snapshot: null });
    }
    for (const buffer of [
      this.disabled,
      ...this.slots.flatMap((slot) => [slot.gpu, slot.readback, slot.indirect])
    ]) {
      const handle = accounting?.created(
        {
          kind: "buffer",
          category: "resident",
          owner: "VirtualTextureFeedback",
          bytes: buffer.size,
          label: buffer.label
        },
        buffer
      );
      if (handle) {
        this.accountingHandles.push(handle);
      }
    }
    const module = device.createShaderModule({
      label: "VT/feedback finalize",
      code: VIRTUAL_TEXTURE_FINALIZE_WGSL
    });
    const layout = device.createPipelineLayout({
      label: "VT/feedback pipeline layout",
      bindGroupLayouts: [this.bindLayout]
    });
    this.ready = Promise.all([
      PipelineCompilationQueue.forDevice(device).run(() =>
        device.createComputePipelineAsync({
          label: "VT/feedback arguments",
          layout,
          compute: { module, entryPoint: "prepare" }
        })
      ),
      PipelineCompilationQueue.forDevice(device).run(() =>
        device.createComputePipelineAsync({
          label: "VT/feedback flags",
          layout,
          compute: { module, entryPoint: "finalize" }
        })
      ),
      module.getCompilationInfo().then((info) => {
        const errors = info.messages.filter((message) => message.type === "error");
        if (errors.length) {
          throw new Error(errors.map((message) => message.message).join("\n"));
        }
      })
    ]).then(([prepare, finalize]) => {
      this.prepare = prepare;
      this.finalize = finalize;
    });
    void this.ready.catch(fail);
  }

  begin(command: ShadeGPUCommandContext, frame: number, view: number, snapshot: T, pages: number): GPUBuffer {
    if (this.stopped || this.active) {
      throw new Error("VT feedback owner is stopped or has an unclosed frame");
    }
    this.lastFrame = frame;
    for (const slot of this.slots) {
      if (slot.state !== "recovery") {
        continue;
      }
      slot.state = "recovering";
      command.copyBufferToBuffer(slot.gpu, this.layout.wanted * 4, slot.readback, 0, this.layout.words * 8);
      command.onAborted.addOne(() => {
        slot.state = "recovery";
      });
      command.onFinished.addOne(() => {
        slot.state = "submitted";
        void command.gpuDone.then(() => this.map(slot, true)).catch((error) => this.report(error));
      });
    }
    const slot = this.slots.find((value) => value.state === "free");
    if (!slot) {
      this.gaps++;
      this.lastGapFrame = frame;
      return this.disabled;
    }
    this.active = slot;
    slot.state = "encoded";
    slot.frame = frame;
    slot.view = view;
    slot.snapshot = snapshot;
    command.clearBuffer(slot.gpu);
    const header = this.device.createBuffer({
      label: "VT/feedback frame header",
      size: VT_FEEDBACK_HEADER_WORDS * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    new Uint32Array(header.getMappedRange()).set([
      1,
      pages,
      this.layout.words,
      this.layout.capacity,
      0,
      0,
      this.layout.wanted,
      this.layout.used,
      this.layout.union,
      this.layout.queue
    ]);
    header.unmap();
    command.copyBufferToBuffer(header, 0, slot.gpu, 0, header.size);
    command.onAborted.addOne(() => {
      header.destroy();
      this.active = undefined;
      slot.state = "free";
      slot.snapshot = null;
    });
    command.onFinished.addOne(() => {
      this.active = undefined;
      slot.state = "submitted";
      void command.gpuDone.then(() => this.map(slot, false)).catch((error) => this.report(error));
      void command.gpuDone.then(
        () => header.destroy(),
        () => header.destroy()
      );
    });
    return slot.gpu;
  }

  end(command: ShadeGPUCommandContext): void {
    const slot = this.active;
    if (!slot) {
      return;
    }
    const argumentsPass = command.gpu_encoder.beginComputePass({ label: "VT/feedback actual count" });
    argumentsPass.setPipeline(this.prepare);
    argumentsPass.setBindGroup(0, slot.group);
    argumentsPass.dispatchWorkgroups(1);
    argumentsPass.end();
    // A writable-storage buffer cannot also be an indirect source in the
    // same usage scope. Keep arguments in a separate 12-byte resource.
    command.copyBufferToBuffer(slot.gpu, 12 * 4, slot.indirect, 0, 12);
    const flagPass = command.gpu_encoder.beginComputePass({ label: "VT/feedback wanted and used" });
    flagPass.setPipeline(this.finalize);
    flagPass.setBindGroup(0, slot.group);
    flagPass.dispatchWorkgroupsIndirect(slot.indirect, 0);
    flagPass.end();
    command.copyBufferToBuffer(slot.gpu, 0, slot.readback, 0, VT_FEEDBACK_HEADER_WORDS * 4);
    command.copyBufferToBuffer(
      slot.gpu,
      this.layout.queue * 4,
      slot.readback,
      VT_FEEDBACK_HEADER_WORDS * 4,
      this.layout.capacity * 4
    );
  }

  private async map(slot: Slot<T>, recovery: boolean): Promise<void> {
    if (this.stopped) {
      return;
    }
    slot.state = "mapping";
    await slot.readback.mapAsync(GPUMapMode.READ);
    let wanted: number[] = [],
      used: number[] = [];
    let overflow = false;
    try {
      if (this.stopped) {
        return;
      }
      const words = new Uint32Array(slot.readback.getMappedRange());
      if (recovery) {
        for (let word = 0; word < this.layout.words; word++) {
          let remaining = (words[word]! | words[this.layout.words + word]!) >>> 0;
          while (remaining) {
            const bit = 31 - Math.clz32(remaining & -remaining);
            const mask = 1 << bit;
            const id = word * 32 + bit;
            if (words[word]! & mask) wanted.push(id);
            if (words[this.layout.words + word]! & mask) used.push(id);
            remaining = (remaining & ~mask) >>> 0;
          }
        }
        this.recoveries++;
      } else {
        overflow = words[5] !== 0;
        if (!overflow) {
          const count = Math.min(words[4]!, this.layout.capacity);
          for (let i = 0; i < count; i++) {
            const item = words[VT_FEEDBACK_HEADER_WORDS + i]!;
            if (item & VT_WANTED) wanted.push(item & VT_PAGE_MASK);
            if (item & VT_USED) used.push(item & VT_PAGE_MASK);
          }
        }
      }
    } finally {
      slot.readback.unmap();
      slot.state = overflow ? "recovery" : "free";
    }
    if (overflow) {
      this.overflows++;
      return;
    }
    const snapshot = slot.snapshot!;
    slot.snapshot = null;
    this.observe({ frame: slot.frame, view: slot.view, snapshot, wanted, used });
  }
  evidence() {
    let oldestFrame = this.lastFrame;
    let outstanding = 0;
    for (const slot of this.slots) {
      if (slot.state !== "free") {
        outstanding++;
        oldestFrame = Math.min(oldestFrame, slot.frame);
      }
    }
    return {
      gaps: this.gaps,
      overflows: this.overflows,
      recoveries: this.recoveries,
      lastGapFrame: this.lastGapFrame,
      outstanding,
      oldestOutstandingAgeFrames: this.lastFrame - oldestFrame,
      allocatedBytes:
        this.disabled.size +
        this.slots.reduce((sum, slot) => sum + slot.gpu.size + slot.readback.size + slot.indirect.size, 0)
    };
  }
  private report(error: unknown): void {
    if (!this.stopped) this.fail(error);
  }
  destroy(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.disabled.destroy();
    for (const slot of this.slots) {
      slot.snapshot = null;
      slot.gpu.destroy();
      slot.readback.destroy();
      slot.indirect.destroy();
    }
    this.active = undefined;
    for (const handle of this.accountingHandles) {
      this.accounting?.destroyed(handle);
    }
    this.accountingHandles.length = 0;
  }
}
