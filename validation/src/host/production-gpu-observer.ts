import { reflectWgslStruct } from "../shared/wgsl-layout.ts";

export type ProductionFault = "reservation-overflow" | "layout-revision" | "consumer-identity" | "aborted-submit";
/** Validation-owned native API seam. Product rendering still enters via Renderer. */
export class ProductionGpuObserver {
  readonly buffers = new Map<string, GPUBuffer>();
  readonly liveBuffers = new Set<GPUBuffer>();
  readonly liveTextures = new Set<GPUTexture>();
  readonly passes: string[] = [];
  readonly submissions: { commandBuffers: number; labels: string[] }[] = [];
  readonly compilation: { label: string; messages: GPUCompilationMessage[] }[] = [];
  readonly compilationPending: Promise<void>[] = [];
  creations = { buffers: 0, textures: 0, pipelines: 0, groups: 0, samplers: 0 };
  fault: ProductionFault | null = null;
  faultApplications = 0;
  private classifierSource = "";
  private resolveSource = "";
  private readonly mappedHeaders = new Map<GPUBuffer, Uint8Array<ArrayBuffer>>();
  private readonly labels = new WeakMap<GPUCommandBuffer, string>();
  private displayCapture: { context: GPUCanvasContext; resolve: (pixels: Uint8Array) => void; reject: (error: unknown) => void } | null = null;

  requestDisplayCapture(context: GPUCanvasContext): Promise<Uint8Array> {
    if (this.displayCapture !== null) throw new Error("A display capture is already armed");
    return new Promise((resolve, reject) => { this.displayCapture = { context, resolve, reject }; });
  }

  constructor(readonly device: GPUDevice) {
    const replace = <T extends object, K extends keyof T>(owner: T, key: K, value: T[K]) => Object.defineProperty(owner, key, { configurable: true, value });
    const createBuffer = device.createBuffer.bind(device);
    replace(device, "createBuffer", (descriptor) => {
      const buffer = createBuffer(descriptor); this.creations.buffers++; this.liveBuffers.add(buffer);
      this.buffers.set(descriptor.label ?? "", buffer);
      if (descriptor.label === "ADR-0013 ShadingBin heap") this.mappedHeaders.set(buffer, new Uint8Array(2304));
      const destroy = buffer.destroy.bind(buffer);
      replace(buffer, "destroy", () => { this.liveBuffers.delete(buffer); destroy(); });
      if (descriptor.mappedAtCreation && descriptor.label === "ADR-0013 ShadingBin heap") {
        const unmap = buffer.unmap.bind(buffer);
        replace(buffer, "unmap", () => { this.mappedHeaders.set(buffer, new Uint8Array(buffer.getMappedRange()).slice(0, 2304)); unmap(); });
      }
      return buffer;
    });
    const createTexture = device.createTexture.bind(device);
    replace(device, "createTexture", (descriptor) => {
      const texture = createTexture(descriptor); this.creations.textures++; this.liveTextures.add(texture);
      const destroy = texture.destroy.bind(texture);
      replace(texture, "destroy", () => { this.liveTextures.delete(texture); destroy(); }); return texture;
    });
    const createShader = device.createShaderModule.bind(device);
    replace(device, "createShaderModule", (descriptor) => {
      if (descriptor.code.includes("fn classify_shading_bins")) this.classifierSource = descriptor.code;
      if (descriptor.code.includes("var<uniform> shading_view: OEngineSparseShadingView")) this.resolveSource = descriptor.code;
      const module = createShader(descriptor);
      this.compilationPending.push(module.getCompilationInfo().then((info) => { this.compilation.push({ label: descriptor.label ?? "", messages: [...info.messages] }); }));
      return module;
    });
    const group = device.createBindGroup.bind(device);
    replace(device, "createBindGroup", (descriptor) => { this.creations.groups++; return group(descriptor); });
    const sampler = device.createSampler.bind(device);
    replace(device, "createSampler", (descriptor) => { this.creations.samplers++; return sampler(descriptor); });
    const compute = device.createComputePipeline.bind(device);
    replace(device, "createComputePipeline", (descriptor) => { this.creations.pipelines++; return compute(descriptor); });
    const render = device.createRenderPipeline.bind(device);
    replace(device, "createRenderPipeline", (descriptor) => { this.creations.pipelines++; return render(descriptor); });
    const asyncCompute = device.createComputePipelineAsync.bind(device);
    replace(device, "createComputePipelineAsync", (descriptor) => { this.creations.pipelines++; return asyncCompute(descriptor); });
    const asyncRender = device.createRenderPipelineAsync.bind(device);
    replace(device, "createRenderPipelineAsync", (descriptor) => { this.creations.pipelines++; return asyncRender(descriptor); });
    const encoder = device.createCommandEncoder.bind(device);
    replace(device, "createCommandEncoder", (descriptor) => {
      const command = encoder(descriptor);
      const begin = command.beginComputePass.bind(command);
      replace(command, "beginComputePass", (passDescriptor) => {
        const label = passDescriptor?.label ?? ""; this.passes.push(label);
        this.inject(command, label); return begin(passDescriptor);
      });
      const finish = command.finish.bind(command);
      replace(command, "finish", (finishDescriptor) => { const buffer = finish(finishDescriptor); this.labels.set(buffer, descriptor?.label ?? ""); return buffer; });
      return command;
    });
    const submit = device.queue.submit.bind(device.queue);
    const writeBuffer = device.queue.writeBuffer.bind(device.queue);
    replace(device.queue, "writeBuffer", (buffer, offset, data, dataOffset, size) => {
      writeBuffer(buffer, offset, data, dataOffset, size);
      const header = this.mappedHeaders.get(buffer);
      if (header !== undefined && offset < header.length) {
        const view = ArrayBuffer.isView(data);
        const bytes = view ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const stride = view ? (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1 : 1;
        const start = (dataOffset ?? 0) * stride;
        const length = Math.min(size === undefined ? bytes.length - start : size * stride, header.length - offset);
        header.set(bytes.subarray(start, start + length), offset);
      }
    });
    replace(device.queue, "submit", (commandBuffers) => {
      const buffers = [...commandBuffers];
      if (this.fault === "aborted-submit") {
        this.fault = null;
        this.faultApplications++;
        throw new DOMException("ADR-0013 intentional aborted-submit fault", "AbortError");
      }
      const capture = this.displayCapture;
      this.displayCapture = null;
      let displayBuffer: GPUBuffer | null = null;
      if (capture !== null) {
        const texture = capture.context.getCurrentTexture();
        displayBuffer = device.createBuffer({ label: "Validation/bounded Final Output capture", size: 9 * 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const copy = device.createCommandEncoder({ label: "Validation/Final Output copy in main submit" });
        for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
          copy.copyTextureToBuffer({ texture, origin: [Math.floor(texture.width * (column + 0.5) / 3), Math.floor(texture.height * (row + 0.5) / 3)] },
            { buffer: displayBuffer, offset: (row * 3 + column) * 256, bytesPerRow: 256 }, [1, 1, 1]);
        }
        buffers.push(copy.finish());
      }
      this.submissions.push({ commandBuffers: buffers.length, labels: buffers.map((buffer) => this.labels.get(buffer) ?? "") });
      submit(buffers);
      if (capture !== null && displayBuffer !== null) {
        const buffer = displayBuffer;
        void device.queue.onSubmittedWorkDone().then(() => buffer.mapAsync(GPUMapMode.READ)).then(() => {
          const data = new Uint8Array(buffer.getMappedRange());
          const pixels = new Uint8Array(9 * 4);
          for (let index = 0; index < 9; index++) pixels.set(data.subarray(index * 256, index * 256 + 4), index * 4);
          buffer.unmap(); capture.resolve(pixels);
        }, capture.reject).finally(() => buffer.destroy());
      }
    });
  }

  restoreHeapLayout(): void {
    const heap = this.buffers.get("ADR-0013 ShadingBin heap");
    const original = heap === undefined ? undefined : this.mappedHeaders.get(heap);
    if (!heap || !original) throw new Error("Production heap mapped publication was not observed");
    const layout = reflectWgslStruct(this.classifierSource, "OEngineShadingBinHeap").fields.layouts!;
    this.device.queue.writeBuffer(heap, layout.offset, original.subarray(layout.offset, layout.offset + layout.size));
  }

  private inject(command: GPUCommandEncoder, label: string): void {
    if ((this.fault === "reservation-overflow" || this.fault === "layout-revision") && label === "ADR-0013 ShadingBin classifier") {
      const heap = this.buffers.get("ADR-0013 ShadingBin heap");
      if (!heap) throw new Error("Production classifier heap was not observed");
      const heapLayout = reflectWgslStruct(this.classifierSource, "OEngineShadingBinHeap").fields.layouts!;
      const bin = reflectWgslStruct(this.classifierSource, "OEngineShadingBinLayout");
      const field = bin.fields[this.fault === "reservation-overflow" ? "capacity" : "revision"]!;
      for (let offset = heapLayout.offset; offset < heapLayout.offset + heapLayout.size; offset += bin.size) {
        command.clearBuffer(heap, offset + field.offset, field.size);
      }
      this.fault = null; this.faultApplications++;
    } else if (this.fault === "consumer-identity" && label === "ADR-0013 Sparse shading resolve") {
      const view = this.buffers.get("ADR-0013 production sparse shading view");
      if (!view) throw new Error("Production consumer view was not observed");
      const field = reflectWgslStruct(this.resolveSource, "OEngineSparseShadingView").fields.material_generation!;
      command.clearBuffer(view, field.offset, field.size);
      this.fault = null; this.faultApplications++;
    }
  }
}
