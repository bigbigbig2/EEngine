/**
 * GPUStatisticsHistory：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export class GPUStatisticsHistory {
  private history = new Uint32Array(64);
  private cursor = 0;
  private averageValue = 0;
  private sum = 0;

  get history_length(): number {
    return this.history.length;
  }

  set history_length(value: number) {
    if (this.history.length !== value) this.history = new Uint32Array(value);
  }

  get average(): number {
    return this.averageValue;
  }

  get last(): number {
    return this.history[this.cursor]!;
  }

  record(value: number): void {
    const length = this.history.length;
    const next = (this.cursor + 1) % length;
    this.cursor = next;
    this.sum -= this.history[next]!;
    this.sum += value;
    this.averageValue = this.sum / length;
    this.history[next] = value;
  }
}
