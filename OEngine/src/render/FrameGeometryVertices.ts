import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { PreparedFrameGeometryArena } from "./FrameGeometryArena.js";
import type { PreparedFrameInstances } from "./FrameInstanceTransforms.js";
import type { GeometryProductGpuBindingsV1 } from "../gpu/VirtualGeometryResidency.js";
import { gpuStorageRange, requireDisjointStorageRanges } from "../gpu/GpuStorageRange.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import {
  frameGeometryVerticesWgsl,
  FRAME_VERTEX_SETTINGS_SIZE,
  FRAME_VERTEX_CONTROL_SIZE,
  FRAME_VERTEX_WORKGROUP_SIZE,
} from "../shaders/frame_geometry_vertices.js";

export interface PreparedFrameVertices {
  readonly control: GPUBuffer;
  readonly rasterSettings: GPUBuffer;
  readonly filteredRasterSettings: GPUBuffer;
  readonly byteLength: number;
  readonly arena: PreparedFrameGeometryArena;
}
interface State {
  readonly prepared: PreparedFrameVertices;
  readonly product: boolean;
  readonly group: GPUBindGroup;
  readonly publicationGroup: GPUBindGroup;
  readonly indirect: GPUBuffer;
  readonly indirectGroup: GPUBindGroup;
  readonly buffers: readonly GPUBuffer[];
  readonly handles: readonly ResourceHandle[];
}
const ENTRIES = [
  "frame_vertices_begin",
  "frame_vertices_build",
  "frame_vertices_finalize",
  "frame_vertices_recovery_begin",
  "frame_vertices_recovery_build",
] as const;

/** Device owner for selected frame geometry preparation; publication awaits
 * asynchronous PSOs. Arena storage is borrowed and owned/accounted separately. */
export class FrameGeometryVertices {
  readonly ready: Promise<void>;
  private readonly states = new Map<PreparedFrameVertices, State>();
  private readonly layouts: readonly GPUBindGroupLayout[];
  private readonly publicationLayout: GPUBindGroupLayout;
  private readonly indirectLayout: GPUBindGroupLayout;
  private readonly recoveryLayout: GPUBindGroupLayout;
  private readonly recoveryGroups = new WeakMap<GPUBuffer, GPUBindGroup>();
  private pipelines: readonly (readonly GPUComputePipeline[])[] | null = null;
  private destroyed = false;
  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting,
    observe = false,
    private readonly maxBytes = 97 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new RangeError("Invalid frame vertex owner budget");
    const l = device.limits;
    if (
      l.maxStorageBuffersPerShaderStage < 14 ||
      l.maxBindingsPerBindGroup < 17 ||
      l.maxBindGroups < 3 ||
      l.maxComputeInvocationsPerWorkgroup < FRAME_VERTEX_WORKGROUP_SIZE ||
      l.maxComputeWorkgroupSizeX < FRAME_VERTEX_WORKGROUP_SIZE
    ) {
      throw new RangeError(
        "Frame vertices require fourteen storage bindings for mixed ordinary/Product geometry and 128 lanes",
      );
    }
    const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    });
    const uniform: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", minBindingSize: FRAME_VERTEX_SETTINGS_SIZE },
    };
    this.layouts = [false, true].map((product) =>
      device.createBindGroupLayout({
        label: `Geometry frame vertices/${product ? "Product" : "ordinary"}`,
        entries: [
          uniform,
          ...[1, 2, 3, 7, ...(product ? [8, 9, 10, 11, 12] : [])].map((binding) =>
            entry(binding, "read-only-storage"),
          ),
          ...[13, 14, 15, 16].map((binding) => entry(binding, "storage")),
        ],
      }),
    );
    this.publicationLayout = device.createBindGroupLayout({
      entries: [uniform, entry(2, "read-only-storage"), entry(13, "storage"), entry(16, "storage")],
    });
    this.indirectLayout = device.createBindGroupLayout({ entries: [entry(0, "storage")] });
    this.recoveryLayout = device.createBindGroupLayout({ entries: [entry(0, "read-only-storage")] });
    const empty = device.createBindGroupLayout({ entries: [] });
    const beginLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.publicationLayout, this.indirectLayout],
    });
    const finalizeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.publicationLayout] });
    this.ready = Promise.all(
      [false, true].map(async (product, profile) => {
        const source = frameGeometryVerticesWgsl(product, observe);
        const module = device.createShaderModule({
          label: `Geometry selected shared vertices/${product}`,
          code: source,
        });
        const compilation = await module.getCompilationInfo();
        const diagnostics = compilation.messages.filter((message) => message.type === "error");
        if (diagnostics.length !== 0) {
          throw new Error(
            `Frame geometry WGSL compilation failed: ${diagnostics.map((message) => `${message.lineNum}:${message.linePos} ${message.message} [${source.split("\n")[message.lineNum - 1]?.trim() ?? ""}]`).join(" | ")}`,
          );
        }
        const buildLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layouts[profile]!] });
        const recoveryBegin = device.createPipelineLayout({
          bindGroupLayouts: [this.publicationLayout, this.indirectLayout, this.recoveryLayout],
        });
        const recoveryBuild = device.createPipelineLayout({
          bindGroupLayouts: [this.layouts[profile]!, empty, this.recoveryLayout],
        });
        return Promise.all(
          ENTRIES.map((entryPoint, i) =>
            device.createComputePipelineAsync({
              label: `Geometry/${entryPoint}/${product}`,
              layout: [beginLayout, buildLayout, finalizeLayout, recoveryBegin, recoveryBuild][i]!,
              compute: { module, entryPoint },
            }),
          ),
        );
      }),
    ).then((pipelines) => {
      if (this.destroyed) throw new Error("Frame vertices stopped during preparation");
      this.pipelines = pipelines;
    });
    void this.ready.catch(() => undefined);
    void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number {
    let bytes = 0;
    for (const p of this.states.keys()) bytes += p.byteLength;
    return bytes;
  }
  prepare(input: {
    readonly arena: PreparedFrameGeometryArena;
    readonly instances: PreparedFrameInstances;
    readonly work: GPUBuffer;
    readonly assets: GpuAssetBindings;
    readonly product?: GeometryProductGpuBindingsV1;
    readonly productBanks?: readonly GPUBuffer[];
  }): PreparedFrameVertices {
    this.requireReady();
    const { arena, instances, work, assets } = input,
      product = input.product !== undefined,
      l = this.device.limits;
    const fixedBytes =
      FRAME_VERTEX_SETTINGS_SIZE +
      FRAME_VERTEX_CONTROL_SIZE +
      32 +
      ((arena.budget.filteredWorkCapacity ?? 0) > 0 ? 16 : 0);
    if (
      arena.budget.workCapacity > l.maxComputeWorkgroupsPerDimension ** 2 ||
      work.size <
        GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE +
          arena.budget.workCapacity * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE ||
      (product && input.productBanks?.length !== 4) ||
      this.allocatedBytes + fixedBytes > this.maxBytes
    ) {
      throw new RangeError("Frame vertices input capacity, Product banks or cumulative budget is invalid");
    }
    for (const [name, b] of [
      ["instances", instances.records],
      ["work", work],
      ["asset metadata", assets.sparseShading.assetMetadataHeap],
      ["vertex payload", assets.sparseShading.vertexPayloadHeap],
      ...(product
        ? [
            ["Product metadata", input.product!.metadata],
            ...input.productBanks!.map((b) => ["Product bank", b]),
          ]
        : []),
    ] as [string, GPUBuffer][]) {
      gpuStorageRange(b, l, 4, `Frame vertex ${name}`);
    }
    requireDisjointStorageRanges([], [arena.sourceDirectory, arena.clips, arena.triangles]);
    const buffers: GPUBuffer[] = [],
      handles: ResourceHandle[] = [];
    const make = (label: string, size: number, usage: GPUBufferUsageFlags) => {
      const b = this.device.createBuffer({ label, size, usage });
      buffers.push(b);
      const h = this.accounting?.created({
        kind: "buffer",
        category: "work-cache",
        owner: "Geometry/FrameGeometryVertices",
        bytes: size,
        label,
      });
      if (h) handles.push(h);
      return b;
    };
    try {
      const settings = make(
        "Geometry frame vertex settings",
        FRAME_VERTEX_SETTINGS_SIZE,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      const control = make(
        "Geometry frame vertex control",
        FRAME_VERTEX_CONTROL_SIZE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const indirect = make(
        "Geometry frame vertex indirect",
        16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
      );
      const rasterSettings = make(
        "Geometry frame raster addressing",
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      const filteredRasterSettings =
        (arena.budget.filteredWorkCapacity ?? 0) > 0
          ? make(
              "Geometry filtered frame raster addressing",
              16,
              GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            )
          : rasterSettings;
      const addressing = (directory: number) =>
        new Uint32Array([directory / 4, arena.clips.offset / 4, arena.triangles.offset / 4, 0]);
      writeGpuBuffer(
        this.device.queue,
        "Geometry/frame-raster-addressing",
        rasterSettings,
        0,
        addressing(arena.sourceDirectory.offset),
      );
      if (filteredRasterSettings !== rasterSettings)
        writeGpuBuffer(
          this.device.queue,
          "Geometry/filtered-raster-addressing",
          filteredRasterSettings,
          0,
          addressing(arena.filteredDirectory.offset),
        );
      writeGpuBuffer(
        this.device.queue,
        "Geometry/frame-vertex-settings",
        settings,
        0,
        new Uint32Array([
          arena.budget.workCapacity,
          arena.budget.vertexCapacity,
          arena.budget.triangleCapacity,
          l.maxComputeWorkgroupsPerDimension,
          0,
          0,
          0,
          0,
          assets.sparseShading.geometryWordBase,
          assets.sparseShading.meshletWordBase,
          assets.sparseShading.meshletVertexWordBase,
          assets.sparseShading.meshletTriangleWordBase,
          assets.sparseShading.vertexDataWordBase,
          0,
          0,
          0,
        ]),
      );
      const outputs = [
        { binding: 13, resource: arena.sourceDirectory },
        { binding: 14, resource: arena.clips },
        { binding: 15, resource: arena.triangles },
        { binding: 16, resource: { buffer: control } },
      ];
      const group = this.device.createBindGroup({
        layout: this.layouts[product ? 1 : 0]!,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: instances.records } },
          { binding: 2, resource: { buffer: work } },
          { binding: 3, resource: { buffer: assets.sparseShading.assetMetadataHeap } },
          { binding: 7, resource: { buffer: assets.sparseShading.vertexPayloadHeap } },
          ...(product
            ? [input.product!.metadata, ...input.productBanks!].map((buffer, i) => ({
                binding: i + 8,
                resource: { buffer },
              }))
            : []),
          ...outputs,
        ],
      });
      const publicationGroup = this.device.createBindGroup({
        layout: this.publicationLayout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 2, resource: { buffer: work } },
          outputs[0]!,
          outputs[3]!,
        ],
      });
      const indirectGroup = this.device.createBindGroup({
        layout: this.indirectLayout,
        entries: [{ binding: 0, resource: { buffer: indirect } }],
      });
      const prepared = Object.freeze({
        arena,
        control,
        rasterSettings,
        filteredRasterSettings,
        byteLength: buffers.reduce((sum, b) => sum + b.size, 0),
      });
      this.states.set(prepared, {
        prepared,
        product,
        group,
        publicationGroup,
        indirect,
        indirectGroup,
        buffers,
        handles,
      });
      return prepared;
    } catch (error) {
      for (const b of buffers) b.destroy();
      for (const h of handles) this.accounting?.destroyed(h);
      throw error;
    }
  }
  encode(encoder: GPUCommandEncoder, p: PreparedFrameVertices): void {
    const pipelines = this.requireReady(),
      s = this.require(p);
    for (let stage = 0; stage < 3; stage++) {
      const pass = encoder.beginComputePass({ label: `Geometry/${ENTRIES[stage]}` });
      pass.setPipeline(pipelines[s.product ? 1 : 0]![stage]!);
      pass.setBindGroup(0, stage === 1 ? s.group : s.publicationGroup);
      if (stage === 0) {
        pass.setBindGroup(1, s.indirectGroup);
        pass.dispatchWorkgroups(1);
      } else if (stage === 1) pass.dispatchWorkgroupsIndirect(s.indirect, 0);
      else pass.dispatchWorkgroups(1);
      pass.end();
    }
  }
  encodeRecovery(encoder: GPUCommandEncoder, p: PreparedFrameVertices, deferred: GPUBuffer): void {
    const pipelines = this.requireReady(),
      s = this.require(p);
    gpuStorageRange(deferred, this.device.limits, 36, "Frame geometry recovery indices");
    let group = this.recoveryGroups.get(deferred);
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.recoveryLayout,
        entries: [{ binding: 0, resource: { buffer: deferred } }],
      });
      this.recoveryGroups.set(deferred, group);
    }
    for (const stage of [3, 4, 2]) {
      const pass = encoder.beginComputePass({ label: `Geometry/${ENTRIES[stage]}` });
      pass.setPipeline(pipelines[s.product ? 1 : 0]![stage]!);
      pass.setBindGroup(0, stage === 4 ? s.group : s.publicationGroup);
      if (stage !== 2) pass.setBindGroup(2, group);
      if (stage === 3) {
        pass.setBindGroup(1, s.indirectGroup);
        pass.dispatchWorkgroups(1);
      } else if (stage === 4) pass.dispatchWorkgroupsIndirect(s.indirect, 0);
      else pass.dispatchWorkgroups(1);
      pass.end();
    }
  }
  release(p: PreparedFrameVertices): void {
    if (this.destroyed) return;
    const s = this.require(p);
    this.states.delete(p);
    for (const b of s.buffers) b.destroy();
    for (const h of s.handles) this.accounting?.destroyed(h);
  }
  destroy(): void {
    if (this.destroyed) return;
    for (const p of this.states.keys()) this.release(p);
    this.destroyed = true;
    this.pipelines = null;
  }
  private require(p: PreparedFrameVertices): State {
    const s = this.states.get(p);
    if (!s) throw new Error("Frame vertex allocation is stale or foreign");
    return s;
  }
  private requireReady(): readonly (readonly GPUComputePipeline[])[] {
    if (this.destroyed || !this.pipelines)
      throw new Error("Frame vertices require completed scene preparation");
    return this.pipelines;
  }
}
