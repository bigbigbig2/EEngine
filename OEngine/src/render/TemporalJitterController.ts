/**
 * TemporalJitterController：负责渲染管线编排、视图状态或渲染目标管理。
 */

export class TemporalJitterController {
  readonly Jitter: [number, number] = [0, 0];
  readonly JitterDelta: [number, number] = [0, 0];
  reset_history = false;
  private sequence = new Float64Array(32);
  private sequenceSize = 16;

  constructor() {
    this.rebuild();
  }

  set jitter_sequence_size(value: number) {
    this.sequenceSize = Math.max(1, Math.ceil(value));
    this.rebuild();
  }

  get jitter_sequence_size(): number {
    return this.sequenceSize;
  }

  set frame_index(value: number) {
    const offset = (value % this.sequenceSize) * 2;
    const x = this.sequence[offset]!;
    const y = this.sequence[offset + 1]!;
    this.JitterDelta[0] = this.Jitter[0] - x;
    this.JitterDelta[1] = this.Jitter[1] - y;
    this.Jitter[0] = x;
    this.Jitter[1] = y;
  }

  private rebuild(): void {
    const sequence = new Float64Array(this.sequenceSize * 2);
    for (let index = 0; index < this.sequenceSize; index++) {
      sequence[index * 2] = radicalInverse(2, index + 1) - 0.5;
      sequence[index * 2 + 1] = radicalInverse(3, index + 1) - 0.5;
    }
    this.sequence = sequence;
  }
}

export function recommendedTaaJitterSequenceSize(
  renderWidth: number,
  renderHeight: number,
  outputWidth: number,
  outputHeight: number
): number {
  const ratio = Math.max(1, outputWidth / Math.max(1, renderWidth));
  const normalized = Math.min(1, Math.max(0, ratio - 1));
  const base = 16 + (4 - 16) * normalized;
  const areaRatio = Math.max(
    1,
    (outputWidth / Math.max(1, renderWidth)) *
      (outputHeight / Math.max(1, renderHeight))
  );
  return Math.ceil(base * areaRatio);
}

export function radicalInverse(base: number, index: number): number {
  let value = 0;
  let inverse = 1;
  let cursor = index >>> 0;
  while (cursor > 0) {
    inverse /= base;
    value += inverse * (cursor % base);
    cursor = (cursor / base) >>> 0;
  }
  return value;
}
