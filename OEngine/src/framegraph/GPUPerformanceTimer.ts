/**
 * GPUPerformanceTimer：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

import { ChangeSignal } from "../core/Signal.js";
import type { ShadeGPUCommandContext } from "./ShadeGPUCommandContext.js";

export class GPUPerformanceTimerData {
  start = 0n;
  end = 0n;

  get duration(): number {
    return Number(this.end - this.start);
  }
}

export class GPUStatisticsHistory {
  #history = new Uint32Array(64);
  #cursor = 0;
  #average = 0;
  #sum = 0;

  get history_length(): number {
    return this.#history.length;
  }

  set history_length(value: number) {
    if (this.#history.length !== value) {
      this.#history = new Uint32Array(value);
    }
  }

  get average(): number {
    return this.#average;
  }

  get last(): number {
    return this.#history[this.#cursor]!;
  }

  record(value: number): void {
    const length = this.#history.length;
    const next = (this.#cursor + 1) % length;
    this.#cursor = next;
    this.#sum -= this.#history[next]!;
    this.#sum += value;
    this.#average = this.#sum / length;
    this.#history[next] = value;
  }
}

export class GPUPerformanceTimer {
  readonly onResults = new ChangeSignal();

  #name = "";
  #lastReadSubmission = -1;
  #submissionCount = 0;
  #querySet: GPUQuerySet | undefined;
  #resolveBuffer: GPUBuffer | undefined;
  #buffers: GPUBuffer[] = [];
  #eventCount = 0;
  #data = new GPUPerformanceTimerData();
  #stats = new GPUStatisticsHistory();

  constructor(
    readonly device: GPUDevice,
    name = "Timer"
  ) {
    this.#name = name;
    if (!device.features.has("timestamp-query")) {
      throw new Error("Timestamp query feature is not enabled on this device");
    }
    this.#createResources();
  }

  get name(): string {
    return this.#name;
  }

  get event_count(): number {
    return this.#eventCount;
  }

  get data(): GPUPerformanceTimerData {
    return this.#data;
  }

  get stats(): GPUStatisticsHistory {
    return this.#stats;
  }

  destroy(): void {
    if (this.#querySet !== undefined) {
      this.#querySet.destroy();
      this.#resolveBuffer!.destroy();
      for (const buffer of this.#buffers) buffer.destroy();
    }
    this.#querySet = undefined;
    this.#resolveBuffer = undefined;
    this.#buffers = [];
  }

  async getResults(): Promise<GPUPerformanceTimerData> {
    const unreadCount = this.#submissionCount - this.#lastReadSubmission;
    if (unreadCount === 0) return this.#data;
    this.#lastReadSubmission = this.#submissionCount;
    const pending = this.#buffers.splice(
      this.#buffers.length - unreadCount,
      unreadCount
    );
    await this.#readResults(pending);
    return this.#data;
  }

  buildLogTextAverage(): string {
    const average = this.#stats.average;
    const text = average > 1e6
      ? `${(1e-6 * average).toFixed(2)} ms`
      : average > 1e3
        ? `${(0.001 * average).toFixed(2)} µs`
        : `${average.toFixed(2)} ns`;
    return `${this.#name} : ${text}`;
  }

  resolve(command: ShadeGPUCommandContext): void {
    if (this.#querySet === undefined) return;
    let readback = this.#buffers.shift();
    if (readback === undefined) {
      readback = this.device.createBuffer({
        label: "",
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
    }
    this.#buffers.push(readback);
    command.insertDebugMarker(`GPUTimer[${this.#name}] / Resolve`);
    command.resolveQuerySet(
      this.#querySet,
      0,
      this.#querySet.count,
      this.#resolveBuffer!,
      0
    );
    command.copyBufferToBuffer(
      this.#resolveBuffer!,
      0,
      readback,
      0,
      this.#resolveBuffer!.size
    );
    this.#submissionCount++;
  }

  update(command: ShadeGPUCommandContext): void {
    if (!command.onFinished.contains(this.getResults, this)) {
      command.onFinished.addOne(this.getResults, this);
    }
    this.resolve(command);
  }

  getComputeWrites(): GPUComputePassTimestampWrites {
    return {
      querySet: this.#querySet!,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1
    };
  }

  getRenderWrites(): GPURenderPassTimestampWrites {
    return {
      querySet: this.#querySet!,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1
    };
  }

  #createResources(): void {
    this.#querySet = this.device.createQuerySet({
      type: "timestamp",
      count: 2
    });
    this.#resolveBuffer = this.device.createBuffer({
      label: "",
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
  }

  async #readResults(buffers: GPUBuffer[]): Promise<void> {
    const count = buffers.length;
    for (let index = 0; index < count; index++) {
      const buffer = buffers.pop();
      if (buffer === undefined) break;
      await buffer.mapAsync(GPUMapMode.READ);
      const values = new BigInt64Array(buffer.getMappedRange());
      this.#data.start = values[0]!;
      this.#data.end = values[1]!;
      buffer.unmap();
      this.#stats.record(this.#data.duration);
      this.#buffers.unshift(buffer);
      this.#eventCount++;
      this.onResults.send1(this);
    }
  }
}
