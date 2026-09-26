/** Device-local ping-pong history owned by Temporal infrastructure. */
export class TemporalGpuHistory {
  private color: [GPUTexture, GPUTexture] | null = null;
  private depth: [GPUTexture, GPUTexture] | null = null;
  private motion: [GPUTexture, GPUTexture] | null = null;
  private size: [number, number] = [0, 0];
  private index = 0;
  readonly parameters: GPUBuffer;
  constructor(private readonly device: GPUDevice) {
    this.parameters = device.createBuffer({ label: "Temporal/frame parameters", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  writeParameters(writeBuffer: (buffer: GPUBuffer, data: ArrayBuffer) => void,
    width: number, height: number, valid: boolean): void {
    writeBuffer(this.parameters, new Uint32Array([width, height, Number(valid), 0]).buffer);
  }
  ensure(width: number, height: number): void {
    if (this.size[0] === width && this.size[1] === height && this.color) return;
    this.destroyTextures(); this.size = [width, height];
    const make = (format: GPUTextureFormat) => [0, 1].map(i => this.device.createTexture({ label: `Temporal/${format}/${i}`, size: [width, height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT })) as [GPUTexture, GPUTexture];
    this.color = make("rgba16float"); this.depth = make("r32float"); this.motion = make("rg16float");
  }
  get readIndex(): number { return this.index; }
  get writeIndex(): number { return 1 - this.index; }
  get width(): number { return this.size[0]; }
  get height(): number { return this.size[1]; }
  getTexture(kind: "color" | "depth" | "motion", index: 0 | 1): GPUTexture {
    const pair = this[kind];
    if (pair === null) throw new Error("Temporal GPU history has not been allocated");
    return pair[index];
  }
  commit(): void { this.index = 1 - this.index; }
  invalidate(): void { this.index = 0; }
  destroy(): void { this.destroyTextures(); this.parameters.destroy(); }
  private destroyTextures(): void { for (const pair of [this.color, this.depth, this.motion]) pair?.forEach(texture => texture.destroy()); this.color = this.depth = this.motion = null; }
}
