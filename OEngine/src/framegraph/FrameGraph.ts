/**
 * 帧图：收集渲染通道与资源依赖，编译资源生命周期，并按依赖顺序执行 GPU 命令。
 */

import { Signal } from "../core/Signal.js";
import type {
  ResourceDescriptor,
  ResourceEntry,
  ResourceId,
  ResourceNode
} from "./ResourceHandle.js";
import { isTransientEntry } from "./ResourceHandle.js";
import type {
  GPUBufferAllocator,
  GPUBufferClearEncoder
} from "../gpu/GPUBufferAllocator.js";
import type { GPUTextureAllocator } from "../gpu/GPUTextureAllocator.js";
import type { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { createNativeTexture } from "../gpu/GPUTextureDescriptors.js";

export type FrameGraphCommandEncoder = {
  readonly gpu_encoder: GPUCommandEncoder;
  readonly device?: GPUDevice;
  readonly isGPUCommandContext?: boolean;
  beginRenderPass?(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
  beginComputePass?(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
  clearBuffer?(buffer: GPUBuffer, offset?: number, size?: number): void;
};

export type FrameGraphGraphicsResources = {
  readonly device: GPUDevice;
  readonly buffer_allocator_main: GPUBufferAllocator;
  readonly allocator_textures: GPUTextureAllocator;
};

/** 帧图执行期间共享的设备、命令编码器和资源管理上下文。 */
export class FrameGraphContext {
  encoder: FrameGraphCommandEncoder | GPUCommandEncoder | null;
  device?: GPUDevice;
  graphics?: unknown;
  resource_manager: FrameGraphResourceManager;

  constructor(opts: {
    encoder?: FrameGraphCommandEncoder | GPUCommandEncoder | null;
    device?: GPUDevice;
    graphics?: unknown;
    resource_manager?: FrameGraphResourceManager;
  } = {}) {
    this.encoder = opts.encoder ?? null;
    this.device = opts.device;
    this.graphics = opts.graphics;
    this.resource_manager =
      opts.resource_manager ?? new FrameGraphResourceManager(opts.device ?? null);
    if (isFrameGraphGraphicsResources(opts.graphics)) {
      this.resource_manager.attachGraphics(opts.graphics, this.encoder);
    }
    if (opts.device) {
      this.resource_manager.attach(opts.device);
    }
  }

  get gpu_encoder(): GPUCommandEncoder | undefined {
    return resolveGpuEncoder(this);
  }
}

export type FrameGraphExecuteContext = FrameGraphContext;

export function resolveGpuEncoder(ctx: FrameGraphContext): GPUCommandEncoder | undefined {
  const e = ctx.encoder;
  if (!e) return undefined;
  if (typeof e === "object" && e !== null && "gpu_encoder" in e) {
    const ge = (e as FrameGraphCommandEncoder).gpu_encoder;
    if (ge) return ge;
  }
  if (
    typeof e === "object" &&
    e !== null &&
    "beginRenderPass" in e &&
    !("isGPUCommandContext" in e && (e as FrameGraphCommandEncoder).isGPUCommandContext)
  ) {
    return e as GPUCommandEncoder;
  }
  return undefined;
}

export type PassExecuteFn<TData = unknown> = (
  data: TData,
  resources: PassResources,
  ctx: FrameGraphContext
) => void;

/** 用于声明一个渲染阶段读取、写入或创建哪些资源。 */
export class PassBuilder {
  private graph: FrameGraph;
  private pass: PassNode;

  constructor(graph: FrameGraph, pass: PassNode) {
    this.graph = graph;
    this.pass = pass;
  }

  create(name: string, descriptor: ResourceDescriptor): ResourceId {
    const id = this.graph.create_resource(name, descriptor);
    this.pass.resource_creates.push(id);
    this.pass.resource_writes.push(id);
    return id;
  }

  read(id: ResourceId): ResourceId {
    return this.pass.read(id);
  }

  write(id: ResourceId): ResourceId {
    const entry = this.graph.getResourceEntry(id);
    if (entry.imported) {
      this.pass.has_side_effects = true;
    }
    if (this.pass.creates(id)) {
      return this.pass.write(id);
    }
    this.pass.read(id);
    return this.pass.write(this.graph.clone_resource(id));
  }

  make_side_effect(): void {
    this.pass.has_side_effects = true;
  }
}

/** 在阶段执行时把逻辑资源句柄解析为实际 GPU 资源。 */
export class PassResources {
  private graph: FrameGraph;
  private pass: PassNode;

  constructor(graph: FrameGraph, pass: PassNode) {
    this.graph = graph;
    this.pass = pass;
  }

  get pass_name(): string {
    return this.pass.name;
  }

  get pass_id(): number {
    return this.pass.id;
  }

  get(id: ResourceId): unknown {
    return this.graph.getResourceEntry(id).resource;
  }

  getDescriptor(id: ResourceId): ResourceDescriptor | null {
    return this.graph.getResourceEntry(id).resource_descriptor;
  }
}

class PassNode {
  id = 0;
  name = "";
  version = 0;
  ref_count = 0;
  has_side_effects = false;
  data: unknown = {};
  execute: PassExecuteFn = () => {};
  resource_creates: ResourceId[] = [];
  resource_reads: ResourceId[] = [];
  resource_writes: ResourceId[] = [];

  creates(id: ResourceId): boolean {
    return this.resource_creates.includes(id);
  }
  reads(id: ResourceId): boolean {
    return this.resource_reads.includes(id);
  }
  writes(id: ResourceId): boolean {
    return this.resource_writes.includes(id);
  }
  write(id: ResourceId): ResourceId {
    if (!this.writes(id)) this.resource_writes.push(id);
    return id;
  }
  read(id: ResourceId): ResourceId {
    if (!this.reads(id)) this.resource_reads.push(id);
    return id;
  }
  can_execute(): boolean {
    return this.ref_count > 0 || this.has_side_effects;
  }
}

/** 管理瞬态资源的创建、复用和释放，并接管外部导入资源。 */
export class FrameGraphResourceManager {
  private device: GPUDevice | null = null;
  private graphics: FrameGraphGraphicsResources | null = null;
  private encoder: GPUBufferClearEncoder | null = null;
  private readonly fallbackOwned = new Set<object>();
  private readonly pooledBuffers = new Set<GPUBuffer>();
  private readonly pooledTextures = new Set<GPUTextureContext>();

  constructor(device?: GPUDevice | null) {
    this.device = device ?? null;
  }

  attach(device: GPUDevice | null | undefined): void {
    this.device = device ?? null;
  }

  attachGraphics(
    graphics: FrameGraphGraphicsResources,
    encoder: FrameGraphCommandEncoder | GPUCommandEncoder | null
  ): void {
    this.graphics = graphics;
    this.device = graphics.device;
    this.encoder =
      encoder && typeof encoder.clearBuffer === "function"
        ? (encoder as GPUBufferClearEncoder)
        : null;
  }

  get deviceOrNull(): GPUDevice | null {
    return this.device;
  }

  get(descriptor: ResourceDescriptor | null): unknown {
    if (!descriptor) return null;
    if (descriptor.kind === "imported") return null;

    if (!this.device) {
      return descriptor;
    }

    if (descriptor.kind === "transient_buffer") {
      const size = Math.max(4, descriptor.size | 0);
      let usage =
        descriptor.usage ??
        (GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.UNIFORM);
      if ((descriptor.ensure_cleared?.[1] ?? 0) > 0) {
        usage |= GPUBufferUsage.COPY_DST;
      }
      const buf = this.graphics
        ? this.graphics.buffer_allocator_main.get(
            {
              size,
              usage,
              ensure_cleared: descriptor.ensure_cleared
            },
            this.encoder ?? undefined
          )
        : this.device.createBuffer({
            label: descriptor.label ?? "FrameGraph/transient_buffer",
            size,
            usage
          });
      if (this.graphics) this.pooledBuffers.add(buf);
      else this.fallbackOwned.add(buf);
      return buf;
    }

    if (descriptor.kind === "transient_texture") {
      const w = Math.max(1, descriptor.width | 0);
      const h = Math.max(1, descriptor.height | 0);
      const d = Math.max(1, descriptor.depthOrArrayLayers ?? 1);
      const format = (descriptor.format || "rgba8unorm") as GPUTextureFormat;
      const usage =
        descriptor.usage ??
        (GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST);
      if (this.graphics) {
        const context = this.graphics.allocator_textures.get({
          width: w,
          height: h,
          depthOrArrayLayers: d,
          dimension: descriptor.dimension ?? "2d",
          format,
          usage,
          mipLevelCount: Math.max(1, descriptor.mipLevelCount ?? 1)
        });
        this.pooledTextures.add(context);
        return context;
      }
      const tex = createNativeTexture(this.device, {
        label: descriptor.label ?? "FrameGraph/transient_texture",
        size: { width: w, height: h, depthOrArrayLayers: d },
        dimension: descriptor.dimension ?? "2d",
        format,
        usage,
        mipLevelCount: Math.max(1, descriptor.mipLevelCount ?? 1)
      });
      this.fallbackOwned.add(tex);
      return tex;
    }

    return descriptor;
  }

  release(resource: unknown): void {
    if (!resource || typeof resource !== "object") return;
    if (this.graphics && this.pooledBuffers.has(resource as GPUBuffer)) {
      this.pooledBuffers.delete(resource as GPUBuffer);
      this.graphics.buffer_allocator_main.release(resource as GPUBuffer);
      return;
    }
    if (
      this.graphics &&
      this.pooledTextures.has(resource as GPUTextureContext)
    ) {
      this.pooledTextures.delete(resource as GPUTextureContext);
      this.graphics.allocator_textures.release(resource as GPUTextureContext);
      return;
    }
    if (!this.fallbackOwned.has(resource as object)) {
      return;
    }
    this.fallbackOwned.delete(resource as object);
    const r = resource as { destroy?: () => void };
    if (typeof r.destroy === "function") {
      r.destroy();
    }
  }

  destroy(): void {
    for (const r of this.fallbackOwned) {
      const o = r as { destroy?: () => void };
      o.destroy?.();
    }
    this.fallbackOwned.clear();
  }
}

function isFrameGraphGraphicsResources(
  value: unknown
): value is FrameGraphGraphicsResources {
  return (
    typeof value === "object" &&
    value !== null &&
    "device" in value &&
    "buffer_allocator_main" in value &&
    "allocator_textures" in value
  );
}

/**
 * 以资源依赖为核心组织一帧 GPU 工作。
 * 构建阶段声明读写关系，编译阶段计算引用和生命周期，执行阶段按顺序运行有效阶段。
 */
export class FrameGraph {
  name: string;
  declare readonly isFrameGraph: boolean;
  readonly onExecuted = new Signal<[FrameGraphContext, FrameGraph]>();

  private __pass_nodes: PassNode[] = [];
  private __resource_nodes: ResourceNode[] = [];
  private __resource_registry: ResourceEntry[] = [];

  constructor(name = "") {
    this.name = name;
  }

  get passCount(): number {
    return this.__pass_nodes.length;
  }

  get resourceNodeCount(): number {
    return this.__resource_nodes.length;
  }

  getResourceNode(id: ResourceId): ResourceNode {
    const n = this.__resource_nodes[id];
    if (n === undefined) throw new Error(`Resource Node ${id} not found`);
    return n;
  }

  getResourceEntry(id: ResourceId): ResourceEntry {
    const node = this.getResourceNode(id);
    const entry = this.__resource_registry[node.resource_id];
    if (!entry) throw new Error(`Resource entry missing for node ${id}`);
    return entry;
  }

  getDescriptor(id: ResourceId): ResourceDescriptor | null {
    return this.getResourceEntry(id).resource_descriptor;
  }

  create_resource(name: string, descriptor: ResourceDescriptor): ResourceId {
    const entry = this._createResourceEntry(descriptor);
    return this._createResourceNode(name, entry.resource_id).id;
  }

  import_resource(name: string, descriptor: ResourceDescriptor, resource: unknown): ResourceId {
    const entry = this._createResourceEntry(descriptor);
    entry.resource = resource;
    entry.imported = true;
    return this._createResourceNode(name, entry.resource_id).id;
  }

  clone_resource(id: ResourceId): ResourceId {
    const node = this.getResourceNode(id);
    const entry = this.__resource_registry[node.resource_id]!;
    entry.resource_version++;
    const n: ResourceNode = {
      id: this.__resource_nodes.length,
      name: node.name,
      resource_id: node.resource_id,
      version: entry.resource_version,
      ref_count: 0,
      producer: null,
      isResourceNode: true
    };
    this.__resource_nodes.push(n);
    return n.id;
  }

  is_valid_resource(id: ResourceId): boolean {
    const node = this.getResourceNode(id);
    const entry = this.getResourceEntry(id);
    return node.version === entry.resource_version;
  }

  add<TData>(
    name: string,
    data: TData,
    execute: PassExecuteFn<TData>
  ): PassBuilder {
    const pass = new PassNode();
    pass.id = this.__pass_nodes.length;
    pass.name = name;
    pass.data = data;
    pass.execute = execute as PassExecuteFn;
    this.__pass_nodes.push(pass);
    const builder = new PassBuilder(this, pass);
    return builder;
  }

  validate(_resource: ResourceId, _pass: PassBuilder): boolean {
    return true;
  }

  /** 计算资源引用、剔除无效阶段，并确定瞬态资源的最后使用位置。 */
  compile(): void {
    const passes = this.__pass_nodes;
    const resources = this.__resource_nodes;

    for (const p of passes) {
      p.ref_count = p.resource_writes.length;
      for (const r of p.resource_reads) {
        const node = resources[r];
        if (node) node.ref_count++;
      }
      for (const w of p.resource_writes) {
        const node = resources[w];
        if (node) node.producer = p;
      }
    }

    const stack: ResourceNode[] = [];
    for (const n of resources) {
      if (n.ref_count === 0) stack.push(n);
    }

    while (stack.length > 0) {
      const node = stack.pop()!;
      const producer = node.producer as PassNode | null;
      if (producer !== null && !producer.has_side_effects) {
        producer.ref_count--;
        if (producer.ref_count === 0) {
          for (const r of producer.resource_reads) {
            const rn = resources[r];
            if (!rn) continue;
            rn.ref_count--;
            if (rn.ref_count === 0) stack.push(rn);
          }
        }
      }
    }

    for (const p of passes) {
      if (p.ref_count === 0) continue;
      for (const e of p.resource_creates) {
        const entry = this.getResourceEntry(e);
        entry.producer = p;
        entry.last = p;
      }
      for (const e of p.resource_writes) {
        this.getResourceEntry(e).last = p;
      }
      for (const e of p.resource_reads) {
        this.getResourceEntry(e).last = p;
      }
    }
  }

  /** 按编译结果执行渲染阶段，并在资源最后一次使用后及时回收瞬态资源。 */
  execute(ctx: FrameGraphContext = new FrameGraphContext()): void {
    const rm = ctx.resource_manager ?? new FrameGraphResourceManager(ctx.device ?? null);
    if (ctx.device) rm.attach(ctx.device);
    ctx.resource_manager = rm;

    for (const pass of this.__pass_nodes) {
      if (!pass.can_execute()) continue;

      for (const id of pass.resource_creates) {
        const entry = this.getResourceEntry(id);
        if (!entry.imported) {
          entry.resource = rm.get(entry.resource_descriptor);
        }
      }

      const resources = new PassResources(this, pass);
      try {
        pass.execute(pass.data, resources, ctx);
      } catch (cause) {
        const err = new Error(`RenderPass '${pass.name}' failed to execute`);
        (err as Error & { cause?: unknown }).cause = cause;
        throw err;
      }

      for (const entry of this.__resource_registry) {
        if (entry.last === pass && isTransientEntry(entry)) {
          rm.release(entry.resource);
          entry.resource = null;
        }
      }
    }

    this.onExecuted.emit([ctx, this]);
  }

  debugLastPassName(id: ResourceId): string | null {
    const last = this.getResourceEntry(id).last;
    return last?.name ?? null;
  }

  debugPassRefCount(name: string): number | null {
    const p = this.__pass_nodes.find((x) => x.name === name);
    return p ? p.ref_count : null;
  }

  listExecutablePasses(): { id: number; name: string; culled: boolean }[] {
    return this.__pass_nodes.map((p) => ({
      id: p.id,
      name: p.name,
      culled: !p.can_execute()
    }));
  }

  exportToJson(): {
    passes: { id: number; name: string; culled: boolean; reads: number[]; writes: number[] }[];
    resources: Array<{
      id: number;
      name: string;
      transient: boolean;
      description?: string;
      createdBy?: number;
    }>;
  } {
    const resources: Array<{
      id: number;
      name: string;
      transient: boolean;
      description?: string;
      createdBy?: number;
    }> = [];
    this.__resource_registry.forEach((entry, id) => {
      const resource = {
        id,
        name: this.getResourceNode(entry.resource_id).name,
        transient: isTransientEntry(entry)
      } as {
        id: number;
        name: string;
        transient: boolean;
        description?: string;
        createdBy?: number;
      };
      const description = resourceDescriptorToString(entry.resource_descriptor);
      if (description) resource.description = description;
      if (entry.producer !== null) resource.createdBy = entry.producer.id;
      resources[id] = resource;
    });
    return {
      passes: this.__pass_nodes.map((p) => ({
        id: p.id,
        name: p.name,
        culled: !p.can_execute(),
        reads: [...p.resource_reads],
        writes: [...p.resource_writes]
      })),
      resources
    };
  }

  exportToDot(): string {
    const output = new DotTextBuilder();
    output.add("digraph FrameGraph {");
    output.indent();
    output.add('graph [style=invis, rankdir="TB" ordering=out, splines=spline]');
    output.add('node [shape=record, fontname="helvetica", fontsize=10, margin="0.2,0.03"]');
    output.add("");
    output.add("# Pass Nodes");

    for (const pass of this.__pass_nodes) {
      output.add(
        `P${pass.id} [label=<{ {<B>${pass.name}</B>} | {${pass.has_side_effects ? "&#x2605; " : ""} Refs: ${pass.ref_count}<BR/> Index: ${pass.id}} }> style="rounded,filled", fillcolor=${pass.ref_count > 0 || pass.has_side_effects ? "orange" : "lightgray"}]`
      );
    }

    output.add("");
    output.add("# Resource Nodes");
    for (const node of this.__resource_nodes) {
      const entry = this.__resource_registry[node.resource_id]!;
      const descriptorType = escapeDotRecord(resourceDescriptorType(entry.resource_descriptor));
      const name = `${entry.imported ? "↪" : ""}${node.name}`;
      const tooltip = escapeDotRecord(resourceDescriptorToString(entry.resource_descriptor));
      output.add(
        `R${entry.resource_id}_${node.version} [label=<{ {<B>${name}</B>${node.version > 0 ? ` <FONT>v${node.version + 1}</FONT>` : ""}<BR/>${descriptorType}} | {Index: ${entry.resource_id}<BR/> Refs : ${node.ref_count} } }> style=filled, fillcolor="${frameGraphResourceColor(entry)}" tooltip="${tooltip}"]`
      );
    }

    output.add("");
    output.add("# Resource Writes");
    for (const pass of this.__pass_nodes) {
      output.add(`P${pass.id} -> {`);
      output.indent();
      for (const resourceId of pass.resource_writes) {
        const node = this.__resource_nodes[resourceId]!;
        output.add(`R${node.resource_id}_${node.version} `);
      }
      output.dedent();
      output.add("} [color=orangered]");
    }

    output.add("");
    output.add("# Resource Reads");
    for (const node of this.__resource_nodes) {
      output.add(`R${node.resource_id}_${node.version} -> {`);
      output.indent();
      for (const pass of this.__pass_nodes) {
        for (const resourceId of pass.resource_reads) {
          if (resourceId === node.id) output.add(`P${pass.id} `);
        }
      }
      output.dedent();
      output.add("} [color=olivedrab3]");
    }

    output.dedent();
    output.add("}");
    return output.build();
  }

  private _createResourceEntry(descriptor: ResourceDescriptor): ResourceEntry {
    const entry: ResourceEntry = {
      resource_id: this.__resource_registry.length,
      resource_descriptor: descriptor,
      resource_version: 0,
      resource: null,
      imported: false,
      producer: null,
      last: null
    };
    this.__resource_registry.push(entry);
    return entry;
  }

  private _createResourceNode(name: string, resource_id: number): ResourceNode {
    const node: ResourceNode = {
      id: this.__resource_nodes.length,
      name,
      resource_id,
      version: 0,
      ref_count: 0,
      producer: null,
      isResourceNode: true
    };
    this.__resource_nodes.push(node);
    return node;
  }
}

(FrameGraph.prototype as FrameGraph & { isFrameGraph: boolean }).isFrameGraph = true;

function resourceDescriptorType(descriptor: ResourceDescriptor | null): string {
  if (!descriptor) return "";
  const explicitType = (descriptor as { type?: unknown }).type;
  if (typeof explicitType === "string") return explicitType;
  switch (descriptor.kind) {
    case "transient_texture":
      return "texture";
    case "transient_buffer":
      return "buffer";
    case "imported":
      return "imported";
    case "opaque":
      return "opaque";
  }
}

function resourceDescriptorToString(descriptor: ResourceDescriptor | null): string {
  if (!descriptor) return "";
  const customToString = descriptor.toString;
  if (customToString !== Object.prototype.toString) {
    return customToString.call(descriptor);
  }
  return JSON.stringify(descriptor) ?? resourceDescriptorType(descriptor);
}

function escapeDotRecord(value: string): string {
  return value
    .replace(/([|{}\\])/g, "\\$1")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function hashString(value: string, offset = 0, length = value.length - offset): number {
  let hash = length;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
  }
  return hash >>> 0;
}

function linearMix(min: number, max: number, value: number): number {
  return (max - min) * value + min;
}

function oklabToLinearSrgb(out: number[], l: number, a: number, b: number): void {
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
  const lCube = lRoot * lRoot * lRoot;
  const mCube = mRoot * mRoot * mRoot;
  const sCube = sRoot * sRoot * sRoot;
  out[0] = 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube;
  out[1] = -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube;
  out[2] = -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube;
}

const FRAME_GRAPH_OKLAB_RGB = [0, 0, 0];
const FRAME_GRAPH_CUSP = [0, 0];
const FRAME_GRAPH_GAMUT_RGB = [0, 0, 0];
const FRAME_GRAPH_TOE_SCALE = 1.206 / 1.03;

function frameGraphToe(value: number): number {
  return (value * value + 0.206 * value) / (FRAME_GRAPH_TOE_SCALE * (value + 0.03));
}

function computeMaxSaturation(a: number, b: number): number {
  let k0: number;
  let k1: number;
  let k2: number;
  let k3: number;
  let k4: number;
  let wl: number;
  let wm: number;
  let ws: number;

  if (-1.88170328 * a - 0.80936493 * b > 1) {
    k0 = 1.19086277;
    k1 = 1.76576728;
    k2 = 0.59662641;
    k3 = 0.75515197;
    k4 = 0.56771245;
    wl = 4.0767416621;
    wm = -3.3077115913;
    ws = 0.2309699292;
  } else if (1.81444104 * a - 1.19445276 * b > 1) {
    k0 = 0.73956515;
    k1 = -0.45954404;
    k2 = 0.08285427;
    k3 = 0.1254107;
    k4 = 0.14503204;
    wl = -1.2684380046;
    wm = 2.6097574011;
    ws = -0.3413193965;
  } else {
    k0 = 1.35733652;
    k1 = -0.00915799;
    k2 = -1.1513021;
    k3 = -0.50559606;
    k4 = 0.00692167;
    wl = -0.0041960863;
    wm = -0.7034186147;
    ws = 1.707614701;
  }

  let saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;
  const kl = 0.3963377774 * a + 0.2158037573 * b;
  const km = -0.1055613458 * a - 0.0638541728 * b;
  const ks = -0.0894841775 * a - 1.291485548 * b;
  const lRoot = 1 + saturation * kl;
  const mRoot = 1 + saturation * km;
  const sRoot = 1 + saturation * ks;
  const value =
    wl * lRoot * lRoot * lRoot +
    wm * mRoot * mRoot * mRoot +
    ws * sRoot * sRoot * sRoot;
  const firstDerivative =
    wl * (3 * kl * lRoot * lRoot) +
    wm * (3 * km * mRoot * mRoot) +
    ws * (3 * ks * sRoot * sRoot);
  const secondDerivative =
    wl * (6 * kl * kl * lRoot) +
    wm * (6 * km * km * mRoot) +
    ws * (6 * ks * ks * sRoot);
  saturation -=
    (value * firstDerivative) /
    (firstDerivative * firstDerivative - 0.5 * value * secondDerivative);
  return saturation;
}

function frameGraphOklchToRgb(out: number[], hue: number, chroma: number): void {
  const a = Math.cos(2 * Math.PI * hue);
  const b = Math.sin(2 * Math.PI * hue);
  const saturation = computeMaxSaturation(a, b);
  oklabToLinearSrgb(FRAME_GRAPH_OKLAB_RGB, 1, saturation * a, saturation * b);
  const maxChannel = Math.max(
    FRAME_GRAPH_OKLAB_RGB[0]!,
    FRAME_GRAPH_OKLAB_RGB[1]!,
    FRAME_GRAPH_OKLAB_RGB[2]!
  );
  const lightnessAtCusp = Math.cbrt(1 / maxChannel);
  FRAME_GRAPH_CUSP[0] = lightnessAtCusp;
  FRAME_GRAPH_CUSP[1] = lightnessAtCusp * saturation;

  const slope = FRAME_GRAPH_CUSP[1]! / (1 - FRAME_GRAPH_CUSP[0]!);
  const midpoint = 0.5;
  const intercept = 1 - midpoint / (FRAME_GRAPH_CUSP[1]! / FRAME_GRAPH_CUSP[0]!);
  const lightness = 1 - (chroma * midpoint) / (midpoint + slope - slope * intercept * chroma);
  const mappedChroma =
    (chroma * slope * midpoint) / (midpoint + slope - slope * intercept * chroma);

  let mappedLightness = lightness;
  let mappedSaturation = mappedChroma;
  const toeLightness = frameGraphToe(lightness);
  const toeChroma = (mappedChroma * toeLightness) / lightness;
  const remappedLightness = frameGraphToe(mappedLightness);
  mappedSaturation =
    mappedLightness !== 0 ? (mappedSaturation * remappedLightness) / mappedLightness : 0;
  mappedLightness = remappedLightness;

  oklabToLinearSrgb(FRAME_GRAPH_GAMUT_RGB, toeLightness, a * toeChroma, b * toeChroma);
  const gamutScale = Math.cbrt(
    1 /
      Math.max(
        FRAME_GRAPH_GAMUT_RGB[0]!,
        FRAME_GRAPH_GAMUT_RGB[1]!,
        FRAME_GRAPH_GAMUT_RGB[2]!,
        0
      )
  );
  mappedLightness *= gamutScale;
  mappedSaturation *= gamutScale;
  oklabToLinearSrgb(out, mappedLightness, mappedSaturation * a, mappedSaturation * b);
}

function byteToHex(value: number): string {
  const hex = Math.round(value).toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}

function frameGraphResourceColor(entry: ResourceEntry): string {
  const type = resourceDescriptorType(entry.resource_descriptor);
  const hash = hashString(type);
  const folded = ((hash & 65535) ^ (hash >>> 16)) / 65535;
  const hue = linearMix(0.1, 0.9, folded);
  const rgb: number[] = [];
  frameGraphOklchToRgb(rgb, hue, entry.imported ? 0.2 : 0.07);
  return `#${byteToHex(Math.round(255 * rgb[0]!))}${byteToHex(Math.round(255 * rgb[1]!))}${byteToHex(Math.round(255 * rgb[2]!))}`;
}

class DotTextBuilder {
  private readonly lines: { text: string; indentation: number }[] = [];
  private indentation = 0;
  readonly indentSpaces = 4;

  indent(): this {
    this.indentation++;
    return this;
  }

  dedent(): this {
    this.indentation = Math.max(0, this.indentation - 1);
    return this;
  }

  add(text: string): this {
    this.lines.push({ text, indentation: this.indentation });
    return this;
  }

  build(): string {
    const unit = " ".repeat(this.indentSpaces);
    return this.lines.map((line) => unit.repeat(line.indentation) + line.text).join("\n");
  }
}
