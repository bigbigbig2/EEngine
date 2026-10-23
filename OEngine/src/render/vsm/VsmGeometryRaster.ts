import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import type { NativeSurfaceGeometry } from "../surface/SurfaceV4.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_PROJECTION_CONSTANT_BYTES } from "../../gpu/GpuVsmProjectionAbi.js";
import { planVsmGeometryChunks } from "../../gpu/GpuVsmGeometryAbi.js";
import { vsmSourcePrepareWgsl, vsmTriangleStreamWgsl } from "../../shaders/vsm_geometry.js";
import {
  vsmCoverageAttributes,
  vsmAttributeLayout,
  vsmPreparedRasterShader
} from "../../shaders/vsm_prepared_raster.js";
import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";

const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.COMPUTE,
  buffer: { type }
});
const uniform = (binding: number, size: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.COMPUTE,
  buffer: { type: "uniform", minBindingSize: size }
});

export function vsmGeometryProfile(
  publication: GpuNativeMaterialPublication,
  product: boolean,
  clipDistances: boolean,
  pageWords: number
) {
  const flags = publication.rasterClasses.map((route) => vsmCoverageAttributes(route.program));
  const attributes = vsmAttributeLayout(flags.reduce((all, mask) => all | mask, 0));
  const sourceLayouts = [
    {
      entries: [
        uniform(0, 64),
        ...[1, 2, 3, 7, ...(product ? [8, 9, 10, 11, 12] : [])].map((binding) =>
          storage(binding, "read-only-storage")
        ),
        storage(13, "storage"),
        storage(14, "read-only-storage"),
        storage(15, "storage"),
        uniform(16, VSM_PROJECTION_CONSTANT_BYTES)
      ]
    },
    {
      entries: [
        storage(0, "read-only-storage"),
        storage(1, "read-only-storage"),
        storage(2, "read-only-storage")
      ]
    }
  ];
  const streamLayouts = [
    {
      entries: [
        uniform(0, 64),
        uniform(1, VSM_PROJECTION_CONSTANT_BYTES),
        ...[2, 4].map((binding) => storage(binding, "read-only-storage")),
        ...[3, 5, 6, 7, 8].map((binding) => storage(binding, "storage"))
      ]
    },
    { entries: [storage(0, "storage")] }
  ];
  const sourceCode = vsmSourcePrepareWgsl(product, attributes);
  const streamCode = vsmTriangleStreamWgsl(attributes.vectors, pageWords, clipDistances);
  const compute = (entryPoint: string): CachedComputePipelineDescriptor => ({
    label: `VSM geometry/${entryPoint}`,
    layout: {
      bindGroupLayouts:
        entryPoint === "prepare_source"
          ? sourceLayouts
          : [
              streamLayouts[0]!,
              ["emit_triangles", "count_bins", "scatter_bins"].includes(entryPoint)
                ? { entries: [] }
                : streamLayouts[1]!
            ]
    },
    compute: { module: { code: entryPoint === "prepare_source" ? sourceCode : streamCode }, entryPoint }
  });
  const raster = publication.rasterClasses.flatMap((route) => {
    const shader = vsmPreparedRasterShader(
      route.program,
      route.layoutEntries,
      attributes,
      pageWords,
      clipDistances
    );
    return (["back", "none"] as const).map((cullMode): CachedRenderPipelineDescriptor => ({
      label: "VSM/prepared triangle-page raster",
      layout: { bindGroupLayouts: shader.groups.map((entries) => ({ entries })) },
      vertex: { module: { code: shader.source }, entryPoint: shader.vertexEntryPoint },
      ...(route.program
        ? {
            fragment: { module: { code: shader.source }, entryPoint: shader.fragmentEntryPoint, targets: [] }
          }
        : {}),
      primitive: { topology: "triangle-list", frontFace: "ccw", cullMode },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" }
    }));
  });
  return { flags, attributes, compute, raster };
}

export async function prepareVsmGeometryProfile(
  graphics: GraphicsContext,
  publication: GpuNativeMaterialPublication,
  product: boolean,
  pageCapacity = 64
): Promise<void> {
  const profile = vsmGeometryProfile(
    publication,
    product,
    graphics.device.features.has("clip-distances"),
    Math.ceil(pageCapacity / 32)
  );
  await Promise.all([
    ...[
      "prepare_source",
      "begin_frame",
      "begin_chunk",
      "emit_triangles",
      "count_bins",
      "prefix_bins",
      "scatter_bins",
      "finish_chunk"
    ].map((entry) => graphics.compute_pipelines.prepare(profile.compute(entry))),
    ...profile.raster.map((descriptor) => graphics.render_pipelines.prepare(descriptor))
  ]);
}

interface SharedVsmScratch {
  readonly key: string;
  readonly buffers: GPUBuffer[];
  readonly handles: ResourceHandle[];
  references: number;
  bytes: number;
}

/** One bounded scratch set reused by source chunks, all pages and native bins.
 * Clear once -> every source chunk -> commit once, in the ordinary encoder.
 * The capacity-derived empty indirect/encoding tax is explicit, never hidden by
 * a readback or a partially published page. */
export class VsmGeometryRaster {
  private readonly buffers: GPUBuffer[] = [];
  private readonly handles: ResourceHandle[] = [];
  private readonly routes: readonly { pipeline: GPURenderPipeline; groups: readonly GPUBindGroup[] }[];
  private readonly compute: ReadonlyMap<string, GPUComputePipeline>;
  private readonly sourceGroups: readonly GPUBindGroup[];
  private readonly streamGroups: readonly GPUBindGroup[];
  private readonly sourceAttributes: GPUBindGroup;
  private readonly dispatchGroup: GPUBindGroup;
  private readonly passiveGroup: GPUBindGroup;
  private readonly coverageView: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly plan: ReturnType<typeof planVsmGeometryChunks>;
  readonly allocatedBytes: number;
  private destroyed = false;
  private scratch: SharedVsmScratch | undefined;

  constructor(
    private readonly graphics: GraphicsContext,
    readonly input: Readonly<{
      geometry: NativeSurfaceGeometry;
      publication: GpuNativeMaterialPublication;
      constants: GPUBuffer;
      allocation: GPUBuffer;
      bounds: GPUBuffer;
      status: GPUBuffer;
      workCapacity: number;
      pageCapacity: number;
      maxBytes: number;
    }>,
    reuse?: VsmGeometryRaster
  ) {
    const device = graphics.device;
    const profile = vsmGeometryProfile(
      input.publication,
      !!input.geometry.productHeap,
      device.features.has("clip-distances"),
      Math.ceil(input.pageCapacity / 32)
    );
    const bins = input.publication.rasterClasses.length * 2;
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const fixedBytes =
      bins * 16 +
      16 +
      (bins + 4) * 16 +
      Math.max(16, profile.flags.length * 4) +
      80 +
      profile.raster.reduce(
        (bytes, _route, bin) =>
          bytes +
          16 +
          (input.publication.rasterClasses[Math.floor(bin / 2)]!.program
            ? Math.max(16, input.publication.rasterClasses[Math.floor(bin / 2)]!.frameInputs.byteLength)
            : 0),
        0
      );
    let settingsBytes = alignment;
    let plan;
    for (;;) {
      plan = planVsmGeometryChunks(
        input.workCapacity,
        input.pageCapacity,
        input.maxBytes - fixedBytes - settingsBytes,
        profile.attributes.vectors
      );
      const required = plan.chunkCount * alignment;
      if (required <= settingsBytes) {
        break;
      }
      settingsBytes = required;
    }
    this.plan = plan;
    if (
      plan.chunkSize > device.limits.maxComputeWorkgroupsPerDimension ||
      bins > device.limits.maxComputeWorkgroupsPerDimension ||
      device.limits.maxStorageBuffersPerShaderStage < (input.geometry.productHeap ? 15 : 10) ||
      [plan.sourceBytes, plan.streamBytes, plan.indexBytes].some(
        (bytes) => bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize
      ) ||
      settingsBytes > device.limits.maxBufferSize
    ) {
      throw new RangeError("VSM shared geometry exceeds negotiated source/bin/dispatch limits");
    }
    const scratchKey = `${plan.sourceBytes}/${plan.streamBytes}/${plan.indexBytes}/${bins}`;
    const previous = reuse?.scratch;
    this.scratch =
      previous?.key === scratchKey && !reuse?.destroyed
        ? previous
        : { key: scratchKey, buffers: [], handles: [], references: 0, bytes: 0 };
    this.scratch.references++;
    let scratchIndex = 0;
    try {
      const buffer = (
        label: string,
        size: number,
        usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        data?: ArrayBufferView<ArrayBuffer>,
        shared = false
      ) => {
        const existing = shared ? this.scratch!.buffers[scratchIndex++] : undefined;
        if (existing) {
          return existing;
        }
        if (
          size > device.limits.maxBufferSize ||
          ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
        ) {
          throw new RangeError(`VSM ${label} exceeds device limits`);
        }
        const result = device.createBuffer({
          label: `VSM/${label}`,
          size: Math.max(16, size),
          usage,
          mappedAtCreation: data !== undefined
        });
        if (data) {
          new Uint8Array(result.getMappedRange()).set(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          );
          result.unmap();
        }
        const handle = graphics.resource_accounting.created(
          {
            kind: "buffer",
            category: "transient",
            owner: "VsmGeometryRaster",
            bytes: result.size,
            label: result.label
          },
          result
        );
        if (shared) {
          this.scratch!.buffers.push(result);
          this.scratch!.handles.push(handle);
          this.scratch!.bytes += result.size;
        } else {
          this.buffers.push(result);
          this.handles.push(handle);
        }
        return result;
      };
      const prepared = buffer(
        "shared light vertices and active coverage",
        this.plan.sourceBytes,
        undefined,
        undefined,
        true
      );
      const records = buffer("triangle-page stream", this.plan.streamBytes, undefined, undefined, true);
      const indices = buffer("triangle bin indices", this.plan.indexBytes, undefined, undefined, true);
      const states = buffer("triangle bin counts and prefixes", bins * 16 + 16, undefined, undefined, true);
      this.indirect = buffer(
        "chunk and bin indirect",
        (bins + 4) * 16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        undefined,
        true
      );
      const attributeFlags = buffer(
        "active coverage dependencies",
        profile.flags.length * 4,
        GPUBufferUsage.STORAGE,
        new Uint32Array(profile.flags)
      );
      this.coverageView = buffer("coverage camera", 80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const chunkData = new Uint32Array((this.plan.chunkCount * alignment) / 4);
      for (let chunk = 0; chunk < this.plan.chunkCount; chunk++) {
        const word = (chunk * alignment) / 4;
        chunkData.set(
          [chunk * this.plan.chunkSize, this.plan.chunkSize, input.pageCapacity, this.plan.pageWords],
          word
        );
        chunkData.set(input.geometry.source, word + 4);
        chunkData.set(input.geometry.sourcePayload, word + 8);
        chunkData.set([bins, input.workCapacity, 0, 0], word + 12);
      }
      const chunks = buffer(
        "immutable chunk settings",
        chunkData.byteLength,
        GPUBufferUsage.UNIFORM,
        chunkData
      );
      const entries = (buffers: readonly (readonly [number, GPUBuffer])[]) =>
        buffers.map(([binding, value]) => ({ binding, resource: { buffer: value } }));
      const makeGroup = (layout: GPUBindGroupLayout, bindings: GPUBindGroupEntry[]) =>
        device.createBindGroup({ layout, entries: bindings });
      this.compute = new Map(
        [
          "prepare_source",
          "begin_frame",
          "begin_chunk",
          "emit_triangles",
          "count_bins",
          "prefix_bins",
          "scatter_bins",
          "finish_chunk"
        ].map((entry) => [entry, graphics.compute_pipelines.requirePrepared(profile.compute(entry))])
      );
      const sourcePipeline = this.compute.get("prepare_source")!;
      const streamPipeline = this.compute.get("begin_frame")!;
      this.sourceAttributes = makeGroup(
        sourcePipeline.getBindGroupLayout(1),
        entries([
          [0, attributeFlags],
          [1, input.bounds],
          [2, input.allocation]
        ])
      );
      this.dispatchGroup = makeGroup(streamPipeline.getBindGroupLayout(1), entries([[0, this.indirect]]));
      this.passiveGroup = makeGroup(this.compute.get("emit_triangles")!.getBindGroupLayout(1), []);
      this.sourceGroups = Array.from({ length: this.plan.chunkCount }, (_, chunk) =>
        makeGroup(sourcePipeline.getBindGroupLayout(0), [
          { binding: 0, resource: { buffer: chunks, offset: chunk * alignment, size: 64 } },
          ...entries([
            [1, input.geometry.instances],
            [2, input.geometry.meshletWork],
            [3, input.geometry.arena],
            [7, input.geometry.vertexPayload],
            ...(input.geometry.productHeap
              ? [
                  [8, input.geometry.productHeap] as const,
                  ...input.geometry.productBanks!.map((bank, i) => [9 + i, bank] as const)
                ]
              : []),
            [13, prepared],
            [14, input.publication.rasterDirectory],
            [15, input.status],
            [16, input.constants]
          ])
        ])
      );
      this.streamGroups = Array.from({ length: this.plan.chunkCount }, (_, chunk) =>
        makeGroup(streamPipeline.getBindGroupLayout(0), [
          { binding: 0, resource: { buffer: chunks, offset: chunk * alignment, size: 64 } },
          ...entries([
            [1, input.constants],
            [2, input.geometry.meshletWork],
            [3, prepared],
            [4, input.allocation],
            [5, input.status],
            [6, records],
            [7, states],
            [8, indices]
          ])
        ])
      );
      this.routes = profile.raster.map((descriptor, bin) => {
        const pipeline = graphics.render_pipelines.requirePrepared(descriptor);
        const route = input.publication.rasterClasses[Math.floor(bin / 2)]!;
        const routeBuffer = buffer("raster bin", 16, GPUBufferUsage.UNIFORM, new Uint32Array([bin, 0, 0, 0]));
        const group0 = makeGroup(
          pipeline.getBindGroupLayout(0),
          entries([
            [0, prepared],
            [1, records],
            [2, indices],
            [3, states],
            [4, input.allocation],
            [5, input.constants],
            [6, routeBuffer]
          ])
        );
        const frameInputs = route.program
          ? buffer(
              "coverage frame inputs",
              Math.max(16, route.frameInputs.byteLength),
              GPUBufferUsage.UNIFORM,
              route.frameInputs
            )
          : null;
        const group1 = makeGroup(
          pipeline.getBindGroupLayout(1),
          frameInputs
            ? entries([
                [0, input.publication.rasterConstants],
                [1, input.publication.rasterDirectory],
                [2, frameInputs],
                [3, this.coverageView]
              ])
            : []
        );
        const group2 = makeGroup(pipeline.getBindGroupLayout(2), [...route.materialEntries]);
        return { pipeline, groups: [group0, group1, group2] };
      });
      this.allocatedBytes = this.scratch.bytes + this.buffers.reduce((total, value) => total + value.size, 0);
      if (this.allocatedBytes > input.maxBytes) {
        throw new RangeError("VSM source/bin/scratch total exceeds its explicit budget");
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  encode(
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    beginRaster: () => GPURenderPassEncoder,
    clear: (pass: GPURenderPassEncoder, indirect: GPUBuffer) => void
  ): void {
    if (this.destroyed) {
      throw new Error("VSM geometry raster is destroyed");
    }
    command.clearBuffer(this.input.status);
    command.copyBufferToBuffer(camera, 128, this.coverageView, 0, 64);
    command.copyBufferToBuffer(camera, 240, this.coverageView, 64, 12);
    let computePass = command.beginComputePass({ label: "VSM/source and triangle/page scheduling" });
    const dispatch = (entry: string, chunk: number, indirectOffset?: number) => {
      const pass = computePass;
      pass.setPipeline(this.compute.get(entry)!);
      pass.setBindGroup(
        0,
        entry === "prepare_source" ? this.sourceGroups[chunk]! : this.streamGroups[chunk]!
      );
      pass.setBindGroup(
        1,
        entry === "prepare_source"
          ? this.sourceAttributes
          : indirectOffset !== undefined
            ? this.passiveGroup
            : this.dispatchGroup
      );
      if (indirectOffset === undefined) {
        pass.dispatchWorkgroups(1);
      } else {
        pass.dispatchWorkgroupsIndirect(this.indirect, indirectOffset);
      }
    };
    dispatch("begin_frame", 0);
    computePass.end();
    const clearPass = beginRaster();
    clear(clearPass, this.indirect);
    clearPass.end();
    for (let chunk = 0; chunk < this.plan.chunkCount; chunk++) {
      computePass = command.beginComputePass({ label: "VSM/source and triangle/page scheduling" });
      if (chunk !== 0) {
        dispatch("finish_chunk", chunk - 1);
      }
      dispatch("begin_chunk", chunk);
      dispatch("prepare_source", chunk, 0);
      dispatch("emit_triangles", chunk, 16);
      dispatch("count_bins", chunk, 32);
      dispatch("prefix_bins", chunk);
      dispatch("scatter_bins", chunk, 32);
      computePass.end();
      const pass = beginRaster();
      this.routes.forEach((route, bin) => {
        pass.setPipeline(route.pipeline);
        route.groups.forEach((group, index) => pass.setBindGroup(index, group));
        pass.drawIndirect(this.indirect, (bin + 4) * 16);
      });
      pass.end();
    }
    computePass = command.beginComputePass({ label: "VSM/finish source chunks" });
    dispatch("finish_chunk", this.plan.chunkCount - 1);
    computePass.end();
    // No submit, map, per-page encoder loop or CPU-visible work selection.
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.buffers.forEach((buffer) => buffer.destroy());
    this.handles.forEach((handle) => this.graphics.resource_accounting.destroyed(handle));
    if (this.scratch && --this.scratch.references === 0) {
      this.scratch.buffers.forEach((buffer) => buffer.destroy());
      this.scratch.handles.forEach((handle) => this.graphics.resource_accounting.destroyed(handle));
    }
  }
}
