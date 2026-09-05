/**
 * GPUDescriptorCaches：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { HashMap } from "../core/HashMap.js";
import { WeightedCache } from "../core/WeightedCache.js";
import { hashString } from "../core/memoryUtils.js";

export type CachedShaderModuleDescriptor = GPUShaderModuleDescriptor;

export type ShaderCompilationDiagnostic = {
  readonly label: string;
  readonly type: GPUCompilationMessageType;
  readonly message: string;
  readonly lineNum: number;
  readonly linePos: number;
  readonly offset: number;
  readonly length: number;
};

export type CachedPipelineLayoutDescriptor = {
  label?: string;
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[];
};

export type CachedVertexState = Omit<GPUVertexState, "module"> & {
  module: CachedShaderModuleDescriptor;
};

export type CachedFragmentState = Omit<GPUFragmentState, "module"> & {
  module: CachedShaderModuleDescriptor;
};

export type CachedComputeState = Omit<GPUProgrammableStage, "module"> & {
  module: CachedShaderModuleDescriptor;
};

export type CachedRenderPipelineDescriptor = Omit<
  GPURenderPipelineDescriptor,
  "layout" | "vertex" | "fragment"
> & {
  layout: CachedPipelineLayoutDescriptor;
  vertex: CachedVertexState;
  fragment?: CachedFragmentState;
};

export type CachedComputePipelineDescriptor = Omit<
  GPUComputePipelineDescriptor,
  "layout" | "compute"
> & {
  layout: CachedPipelineLayoutDescriptor;
  compute: CachedComputeState;
};

export type CachedBindGroupDescriptor = {
  layout: GPUBindGroupLayoutDescriptor;
  entries: readonly GPUBindingResource[];
};

export interface PipelineCacheObserver {
  onPipelineCacheHit?(kind: "render" | "compute"): void;
  onPipelineCacheMiss?(kind: "render" | "compute"): void;
  onPipelineCreated?(kind: "render" | "compute", hostCallMs: number): void;
  /** First obtain for one cache key. This does not prove native compilation completed. */
  onPipelineFirstUse?(kind: "render" | "compute"): void;
}

class iu implements GPUBindGroupLayoutDescriptor {
  readonly entries: readonly GPUBindGroupLayoutEntry[];
  readonly #label: string;

  constructor(descriptor: GPUBindGroupLayoutDescriptor) {
    this.#label = descriptor.label ?? "";
    this.entries = Array.from(descriptor.entries);
  }

  get label(): string {
    return this.#label;
  }

  get isBindGroupLayoutDescriptor(): true {
    return true;
  }
}

class zu implements GPUPrimitiveState {
  topology: GPUPrimitiveTopology;
  stripIndexFormat: GPUIndexFormat | undefined;
  frontFace: GPUFrontFace;
  cullMode: GPUCullMode;
  unclippedDepth: boolean;

  constructor(descriptor: GPUPrimitiveState = {}) {
    this.topology = descriptor.topology ?? "triangle-list";
    this.stripIndexFormat = descriptor.stripIndexFormat;
    this.frontFace = descriptor.frontFace ?? "ccw";
    this.cullMode = descriptor.cullMode ?? "none";
    this.unclippedDepth = descriptor.unclippedDepth ?? false;
  }
}

class hu implements GPUDepthStencilState {
  format: GPUTextureFormat;
  depthWriteEnabled: boolean;
  depthCompare: GPUCompareFunction;
  stencilFront: GPUStencilFaceState;
  stencilBack: GPUStencilFaceState;
  stencilReadMask: GPUStencilValue;
  stencilWriteMask: GPUStencilValue;
  depthBias: GPUDepthBias;
  depthBiasSlopeScale: number;
  depthBiasClamp: number;

  constructor(descriptor: GPUDepthStencilState) {
    this.format = descriptor.format;
    this.depthWriteEnabled = descriptor.depthWriteEnabled ?? false;
    this.depthCompare = descriptor.depthCompare ?? "always";
    this.stencilFront = nativeStencilFace(descriptor.stencilFront);
    this.stencilBack = nativeStencilFace(descriptor.stencilBack);
    this.stencilReadMask = descriptor.stencilReadMask ?? 0xffffffff;
    this.stencilWriteMask = descriptor.stencilWriteMask ?? 0xffffffff;
    this.depthBias = descriptor.depthBias ?? 0;
    this.depthBiasSlopeScale = descriptor.depthBiasSlopeScale ?? 0;
    this.depthBiasClamp = descriptor.depthBiasClamp ?? 0;
  }
}

class xu implements GPUMultisampleState {
  count: GPUSize32;
  mask: GPUSampleMask;
  alphaToCoverageEnabled: boolean;

  constructor(descriptor: GPUMultisampleState = {}) {
    this.count = descriptor.count ?? 1;
    this.mask = descriptor.mask ?? 0xffffffff;
    this.alphaToCoverageEnabled = descriptor.alphaToCoverageEnabled ?? false;
  }
}

class bu implements GPUColorTargetState {
  label: string;
  format: GPUTextureFormat;
  blend: GPUBlendState | undefined;
  writeMask: GPUColorWriteFlags;

  constructor(descriptor: GPUColorTargetState & { label?: string }) {
    this.label = descriptor.label ?? "";
    this.format = descriptor.format;
    this.blend = descriptor.blend === undefined
      ? undefined
      : {
          color: { ...descriptor.blend.color },
          alpha: { ...descriptor.blend.alpha }
        };
    this.writeMask = descriptor.writeMask ?? GPUColorWrite.ALL;
  }

  get bytesPerSample(): number {
    return colorTargetBytesPerSample(this.format);
  }
}

function nativeStencilFace(
  descriptor: GPUStencilFaceState | undefined
): GPUStencilFaceState {
  return {
    compare: descriptor?.compare ?? "always",
    failOp: descriptor?.failOp ?? "keep",
    depthFailOp: descriptor?.depthFailOp ?? "keep",
    passOp: descriptor?.passOp ?? "keep"
  };
}

function colorTargetBytesPerSample(format: GPUTextureFormat): number {
  switch (format) {
    case "r8unorm":
    case "r8snorm":
    case "r8uint":
    case "r8sint":
      return 1;
    case "r16uint":
    case "r16sint":
    case "r16float":
    case "rg8unorm":
    case "rg8snorm":
    case "rg8uint":
    case "rg8sint":
      return 2;
    case "r32uint":
    case "r32sint":
    case "r32float":
    case "rg16uint":
    case "rg16sint":
    case "rg16float":
    case "rgba8unorm":
    case "rgba8unorm-srgb":
    case "rgba8snorm":
    case "rgba8uint":
    case "rgba8sint":
    case "bgra8unorm":
    case "bgra8unorm-srgb":
    case "rgb9e5ufloat":
    case "rgb10a2uint":
    case "rgb10a2unorm":
    case "rg11b10ufloat":
      return 4;
    case "rg32uint":
    case "rg32sint":
    case "rg32float":
    case "rgba16uint":
    case "rgba16sint":
    case "rgba16float":
      return 8;
    case "rgba32uint":
    case "rgba32sint":
    case "rgba32float":
      return 16;
    default:
      throw new Error(`Unsupported color target format: ${format}`);
  }
}

class DescriptorKey<T> {
  readonly stable_key: string;
  readonly hash_value: number;

  constructor(readonly descriptor: T) {
    this.stable_key = gpuDescriptorKey(descriptor);
    this.hash_value = hashString(this.stable_key);
  }

  hash(): number {
    return this.hash_value;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof DescriptorKey &&
      this.stable_key === other.stable_key
    );
  }
}

export class ShaderModuleCache {
  private readonly cache = new HashMap<
    DescriptorKey<CachedShaderModuleDescriptor>,
    GPUShaderModule
  >();
  private readonly compilationDiagnostics: ShaderCompilationDiagnostic[] = [];

  constructor(private readonly device: GPUDevice) {}

  obtain(descriptor: CachedShaderModuleDescriptor): GPUShaderModule {
    const key = new DescriptorKey(descriptor);
    return this.cache.getOrCompute(key, () => this.create(descriptor));
  }

  clear(): void {
    this.cache.clear();
    this.compilationDiagnostics.length = 0;
  }

  get diagnostics(): readonly ShaderCompilationDiagnostic[] {
    return [...this.compilationDiagnostics];
  }

  private create(descriptor: CachedShaderModuleDescriptor): GPUShaderModule {
    this.device.pushErrorScope("validation");
    const module = this.device.createShaderModule(descriptor);
    void module.getCompilationInfo().then((info) => {
      const label = descriptor.label ?? "";
      for (const message of info.messages) {
        this.compilationDiagnostics.push({
          label,
          type: message.type,
          message: message.message,
          lineNum: message.lineNum,
          linePos: message.linePos,
          offset: message.offset,
          length: message.length
        });
      }
      for (const message of info.messages) {
        const level = message.type === "error" ? "error" : "warn";
        console[level](
          "[ShaderModule " + (label || "unnamed") + "] " + message.type +
          " at " + message.lineNum + ":" + message.linePos + ": " + message.message
        );
      }
    }).catch((error: unknown) => {
      console.error("Shader compilation diagnostics failed", error);
    });
    void this.device.popErrorScope().then((error) => {
      if (error === null) return;
      const label = descriptor.label ?? "";
      const source = String(descriptor.code);
      const lines = source
        .split(/\r?\n/)
        .map((line, index) => `${index + 1}: ${line}`)
        .join("\n");
      console.warn(
        [
          "Error during device.createShaderModule:",
          error.message,
          label === "" ? "" : `Descriptor Label: ${label}`,
          "Shader source:",
          lines
        ]
          .filter((line) => line !== "")
          .join("\n")
      );
    });
    return module;
  }
}

export class PipelineLayoutCache {
  private readonly bindGroupLayouts = new HashMap<
    DescriptorKey<GPUBindGroupLayoutDescriptor>,
    GPUBindGroupLayout
  >();
  private readonly pipelineLayouts = new HashMap<
    DescriptorKey<CachedPipelineLayoutDescriptor>,
    GPUPipelineLayout
  >();
  private readonly originatingDescriptors = new WeakMap<
    GPUBindGroupLayout,
    GPUBindGroupLayoutDescriptor
  >();

  constructor(private readonly device: GPUDevice) {}

  debugGetOriginatingDescriptor(
    layout: GPUBindGroupLayout
  ): GPUBindGroupLayoutDescriptor | undefined {
    return this.originatingDescriptors.get(layout);
  }

  obtainBindGroupLayout(
    descriptor: GPUBindGroupLayoutDescriptor
  ): GPUBindGroupLayout {
    const normalized = normalizeBindGroupLayoutDescriptor(descriptor);
    const key = new DescriptorKey(normalized);
    return this.bindGroupLayouts.getOrCompute(key, () => {
      const originalDescriptor = new iu(normalized);
      const layout = this.device.createBindGroupLayout(originalDescriptor);
      this.originatingDescriptors.set(layout, originalDescriptor);
      return layout;
    });
  }

  obtainPipelineLayout(
    descriptor: CachedPipelineLayoutDescriptor
  ): GPUPipelineLayout {
    const normalized = normalizePipelineLayoutDescriptor(descriptor);
    const key = new DescriptorKey(normalized);
    return this.pipelineLayouts.getOrCompute(key, () => {
      const bindGroupLayouts = normalized.bindGroupLayouts.map((layout) =>
        this.obtainBindGroupLayout(layout)
      );
      return this.device.createPipelineLayout({
        label: normalized.label,
        bindGroupLayouts
      });
    });
  }

  clear(): void {
    this.bindGroupLayouts.clear();
    this.pipelineLayouts.clear();
  }
}

export class BindGroupCache {
  private readonly reverse = new WeakMap<
    GPUBindGroup,
    CachedBindGroupDescriptor
  >();
  private readonly frequent = new WeightedCache<
    DescriptorKey<CachedBindGroupDescriptor>,
    GPUBindGroup
  >({ maxWeight: 4096 });
  private readonly probation = new WeightedCache<
    DescriptorKey<CachedBindGroupDescriptor>,
    { group: GPUBindGroup; access_count: number }
  >({ maxWeight: 32 });
  private requestCount = 0;
  private creationCount = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly layouts: PipelineLayoutCache
  ) {}

  get current_cycle_creation_count(): number {
    return this.creationCount;
  }

  reverse_lookup(
    group: GPUBindGroup
  ): CachedBindGroupDescriptor | undefined {
    return this.reverse.get(group);
  }

  obtain(descriptor: CachedBindGroupDescriptor): GPUBindGroup {
    this.requestCount++;
    const normalized: CachedBindGroupDescriptor = {
      layout: normalizeBindGroupLayoutDescriptor(descriptor.layout),
      entries: descriptor.entries
    };
    const key = new DescriptorKey(normalized);
    let group = this.frequent.get(key);
    if (group !== null) return group;

    const candidate = this.probation.get(key);
    if (candidate !== null) {
      if (candidate.access_count >= 8) {
        this.frequent.put(key, candidate.group);
        this.probation.remove(key);
      } else {
        candidate.access_count++;
      }
      return candidate.group;
    }

    group = this.create(normalized);
    this.probation.put(key, { group, access_count: 1 });
    return group;
  }

  create(descriptor: CachedBindGroupDescriptor): GPUBindGroup {
    const entries = descriptor.entries.map((resource, binding) => ({
      binding,
      resource
    }));
    this.creationCount++;
    const group = this.device.createBindGroup({
      label: descriptor.layout.label,
      layout: this.layouts.obtainBindGroupLayout(descriptor.layout),
      entries
    });
    this.reverse.set(group, descriptor);
    return group;
  }

  update(): void {
    const current = this.probation.maxWeight;
    const target = Math.max(
      this.requestCount,
      Math.ceil(4 * this.creationCount)
    );
    if (current < target) {
      this.probation.maxWeight = target;
    } else if (current > 32 && 0.5 * current > target) {
      this.probation.maxWeight = Math.max(Math.ceil(0.5 * current), 32);
    }
    this.requestCount = 0;
    this.creationCount = 0;
  }

  clear(): void {
    this.frequent.clear();
    this.probation.clear();
    this.requestCount = 0;
    this.creationCount = 0;
  }
}

export class RenderPipelineCache {
  private readonly cache = new HashMap<
    DescriptorKey<CachedRenderPipelineDescriptor>,
    GPURenderPipeline
  >();

  constructor(
    private readonly device: GPUDevice,
    readonly layouts: PipelineLayoutCache,
    private readonly shaders: ShaderModuleCache,
    private readonly observer?: PipelineCacheObserver
  ) {}

  obtain(
    descriptor: CachedRenderPipelineDescriptor,
    primitive?: GPUPrimitiveState
  ): GPURenderPipeline {
    const resolved = normalizeRenderPipelineDescriptor(primitive
      ? { ...descriptor, primitive }
      : descriptor);
    const key = new DescriptorKey(resolved);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.observer?.onPipelineCacheHit?.("render");
      return cached;
    }
    this.observer?.onPipelineCacheMiss?.("render");
    const started = typeof performance === "undefined" ? 0 : performance.now();
    const pipeline = this.create(resolved);
    this.observer?.onPipelineCreated?.(
      "render",
      Math.max(0, (typeof performance === "undefined" ? 0 : performance.now()) - started)
    );
    this.cache.set(key, pipeline);
    this.observer?.onPipelineFirstUse?.("render");
    return pipeline;
  }

  clear(): void {
    this.cache.clear();
  }

  private create(
    descriptor: CachedRenderPipelineDescriptor
  ): GPURenderPipeline {
    const native: GPURenderPipelineDescriptor = {
      label: descriptor.label,
      layout: this.layouts.obtainPipelineLayout(descriptor.layout),
      primitive: descriptor.primitive === undefined
        ? undefined
        : new zu(descriptor.primitive),
      depthStencil: descriptor.depthStencil === undefined
        ? undefined
        : new hu(descriptor.depthStencil),
      vertex: {
        ...descriptor.vertex,
        module: this.shaders.obtain(descriptor.vertex.module)
      },
      multisample: descriptor.multisample === undefined
        ? undefined
        : new xu(descriptor.multisample)
    };
    if (descriptor.fragment !== undefined) {
      native.fragment = {
        ...descriptor.fragment,
        module: this.shaders.obtain(descriptor.fragment.module),
        targets: Array.from(descriptor.fragment.targets, (target) =>
          target == null ? target : new bu(target)
        )
      };
    }
    this.device.pushErrorScope("validation");
    this.device.pushErrorScope("internal");
    const pipeline = this.device.createRenderPipeline(native);
    const report = (error: GPUError | null): void => {
      if (error !== null) {
        console.error(
          `Failed to create "${descriptor.label ?? ""}" pipeline: `,
          error.message,
          native
        );
      }
    };
    void this.device.popErrorScope().then(report);
    void this.device.popErrorScope().then(report);
    return pipeline;
  }
}

export class ComputePipelineCache {
  private readonly cache = new HashMap<
    DescriptorKey<CachedComputePipelineDescriptor>,
    GPUComputePipeline
  >();

  constructor(
    private readonly device: GPUDevice,
    readonly layouts: PipelineLayoutCache,
    private readonly shaders: ShaderModuleCache,
    private readonly observer?: PipelineCacheObserver
  ) {}

  obtain(descriptor: CachedComputePipelineDescriptor): GPUComputePipeline {
    const normalized = normalizeComputePipelineDescriptor(descriptor);
    const key = new DescriptorKey(normalized);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.observer?.onPipelineCacheHit?.("compute");
      return cached;
    }
    this.observer?.onPipelineCacheMiss?.("compute");
    const started = typeof performance === "undefined" ? 0 : performance.now();
    const pipeline = this.device.createComputePipeline({
        label: normalized.label,
        layout: this.layouts.obtainPipelineLayout(normalized.layout),
        compute: {
          ...normalized.compute,
          module: this.shaders.obtain(normalized.compute.module)
        }
      });
    this.observer?.onPipelineCreated?.(
      "compute",
      Math.max(0, (typeof performance === "undefined" ? 0 : performance.now()) - started)
    );
    this.cache.set(key, pipeline);
    this.observer?.onPipelineFirstUse?.("compute");
    return pipeline;
  }

  clear(): void {
    this.cache.clear();
  }
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;

export function gpuDescriptorKey(value: unknown): string {
  return encodeDescriptorValue(value);
}

function normalizeBindGroupLayoutDescriptor(
  descriptor: GPUBindGroupLayoutDescriptor
): GPUBindGroupLayoutDescriptor {
  return {
    label: descriptor.label,
    entries: Array.from(descriptor.entries).sort(
      (left, right) => left.binding - right.binding
    )
  };
}

function normalizePipelineLayoutDescriptor(
  descriptor: CachedPipelineLayoutDescriptor
): CachedPipelineLayoutDescriptor {
  return {
    label: descriptor.label,
    bindGroupLayouts: descriptor.bindGroupLayouts.map(
      normalizeBindGroupLayoutDescriptor
    )
  };
}

function normalizeRenderPipelineDescriptor(
  descriptor: CachedRenderPipelineDescriptor
): CachedRenderPipelineDescriptor {
  return {
    ...descriptor,
    layout: normalizePipelineLayoutDescriptor(descriptor.layout),
    vertex: {
      ...descriptor.vertex,
      constants: descriptor.vertex.constants ?? {}
    },
    ...(descriptor.fragment === undefined
      ? {}
      : {
          fragment: {
            ...descriptor.fragment,
            constants: descriptor.fragment.constants ?? {}
          }
        })
  };
}

function normalizeComputePipelineDescriptor(
  descriptor: CachedComputePipelineDescriptor
): CachedComputePipelineDescriptor {
  return {
    ...descriptor,
    layout: normalizePipelineLayoutDescriptor(descriptor.layout),
    compute: {
      ...descriptor.compute,
      constants: descriptor.compute.constants ?? {}
    }
  };
}

function encodeDescriptorValue(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  const type = typeof value;
  if (type === "string") return `s:${value}`;
  if (type === "number") return `d:${String(value)}`;
  if (type === "boolean") return value ? "b:1" : "b:0";
  if (type === "bigint") return `i:${String(value)}`;
  if (Array.isArray(value)) {
    return `[${value.map(encodeDescriptorValue).join(",")}]`;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return `${view.constructor.name}:${Array.from(bytes).join(".")}`;
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer:${Array.from(new Uint8Array(value)).join(".")}`;
  }
  if (type !== "object") return `${type}:${String(value)}`;

  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    let id = objectIds.get(object);
    if (id === undefined) {
      id = nextObjectId++;
      objectIds.set(object, id);
    }
    return `o:${id}`;
  }

  const keys = Object.keys(object).sort();
  return `{${keys
    .map((key) => `${key}=${encodeDescriptorValue(object[key])}`)
    .join(",")}}`;
}
