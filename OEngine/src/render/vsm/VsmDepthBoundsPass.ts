import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  VSM_DEPTH_BOUNDS_WGSL,
  VSM_CASTER_SNAPSHOT_BYTES,
  VSM_CASTER_DAMAGE_RECORD_BYTES,
  VSM_CASTER_DAMAGE_HEADER_BYTES
} from "../../shaders/vsm_depth_bounds.js";
import { VSM_CASTER_INVALIDATION_WGSL } from "../../shaders/vsm_caster_invalidation.js";
import { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import type { VirtualGeometryResidency } from "../../gpu/VirtualGeometryResidency.js";
import type { VsmResources } from "./VsmResources.js";
import { packVsmProjection, type VsmDirectionalFrameConstants } from "./VsmProjection.js";
import type { VsmGenerationState } from "./VsmGeneration.js";

export class VsmDepthBoundsPass {
  private readonly constants: GPUBuffer;
  private scratch: GPUBuffer;
  private snapshots: GPUBuffer;
  private sources: GPUBuffer;
  private damages: GPUBuffer;
  private sourceWords = new Uint32Array(4);
  private sourceHeaderCount = 0;
  private submittedInstanceCount = -1;
  private readonly dirtyConstants: GPUBuffer;
  private readonly dirtyLayout: GPUBindGroupLayout;
  private readonly dirtyPipeline: GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly boundsPipeline: GPUComputePipeline;
  private readonly publishPipeline: GPUComputePipeline;
  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/depth bounds constants",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.scratch = device.createBuffer({
      label: "VSM/depth bounds partial",
      size: 16,
      usage: GPUBufferUsage.STORAGE
    });
    this.snapshots = this.createStorage("VSM/caster snapshot", VSM_CASTER_SNAPSHOT_BYTES);
    this.sources = this.createStorage("VSM/caster source stamps", 16);
    this.damages = this.createStorage(
      "VSM/caster damages",
      VSM_CASTER_DAMAGE_HEADER_BYTES + VSM_CASTER_DAMAGE_RECORD_BYTES
    );
    this.dirtyConstants = device.createBuffer({
      label: "VSM/caster invalidation constants",
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    const module = device.createShaderModule({
      label: "VSM/stable depth bounds",
      code: VSM_DEPTH_BOUNDS_WGSL
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.boundsPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: "instance_bounds" }
    });
    this.publishPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: "publish_depth" }
    });
    this.dirtyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[1, 2, 3, 4].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType }
        }))
      ]
    });
    this.dirtyPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dirtyLayout] }),
      compute: {
        module: device.createShaderModule({ code: VSM_CASTER_INVALIDATION_WGSL }),
        entryPoint: "main"
      }
    });
  }
  private createStorage(label: string, size: number): GPUBuffer {
    if (
      !Number.isSafeInteger(size) ||
      size > this.device.limits.maxStorageBufferBindingSize ||
      size > this.device.limits.maxBufferSize
    ) {
      throw new RangeError(`${label} exceeds negotiated capacity`);
    }
    return this.device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
  }
  prepareFrame(
    instanceCount: number,
    command: ShadeGPUCommandContext,
    state: VsmGenerationState,
    source?: GeometryPageStreamingRuntimeV1 | VirtualGeometryResidency
  ): void {
    const groups = Math.max(1, Math.ceil(instanceCount / 64));
    const bytes = groups * 16;
    if (
      !Number.isSafeInteger(instanceCount) ||
      instanceCount < 0 ||
      groups > this.device.limits.maxComputeWorkgroupsPerDimension ||
      bytes > this.device.limits.maxStorageBufferBindingSize ||
      bytes > this.device.limits.maxBufferSize
    ) {
      throw new RangeError("VSM complete caster bounds exceed the supported reduction domain");
    }
    if (bytes > this.scratch.size) {
      const next = this.device.createBuffer({
        label: "VSM/depth bounds partial",
        size: bytes,
        usage: GPUBufferUsage.STORAGE
      });
      command.destroyAfterGpuDone(this.scratch);
      this.scratch = next;
    }
    if (instanceCount * VSM_CASTER_SNAPSHOT_BYTES > this.snapshots.size) {
      const previous = this.snapshots;
      const next = this.createStorage("VSM/caster snapshot", instanceCount * VSM_CASTER_SNAPSHOT_BYTES);
      let submitted = false;
      command.onFinished.addOne(() => {
        submitted = true;
      });
      command.destroyAfterGpuDone({
        destroy: () => {
          if (submitted) {
            previous.destroy();
          }
        }
      });
      command.onAborted.addOne(() => {
        this.snapshots = previous;
        next.destroy();
      });
      this.snapshots = next;
    }
    const damageBytes =
      VSM_CASTER_DAMAGE_HEADER_BYTES + Math.max(1, instanceCount) * VSM_CASTER_DAMAGE_RECORD_BYTES;
    if (damageBytes > this.damages.size) {
      const next = this.createStorage("VSM/caster damages", damageBytes);
      command.destroyAfterGpuDone(this.damages);
      this.damages = next;
    }
    if (state.rebuildDepth || instanceCount !== this.submittedInstanceCount) {
      const visit = (callback: (residency: VirtualGeometryResidency) => void): void => {
        if (source instanceof GeometryPageStreamingRuntimeV1) {
          source.forEachResidency(callback);
        } else if (source !== undefined) {
          callback(source);
        }
      };
      let headers = 0;
      let assets = 0;
      visit((residency) => {
        if (!residency.publicationActive) {
          return;
        }
        headers = Math.max(headers, residency.productTableSlot + 1);
        assets += residency.assetContentRevisions.length;
      });
      const words = Math.max(4, headers * 4 + assets);
      if (words * 4 > this.sources.size) {
        const next = this.createStorage("VSM/caster source stamps", words * 4);
        command.destroyAfterGpuDone(this.sources);
        this.sources = next;
        this.sourceWords = new Uint32Array(words);
      }
      this.sourceWords.fill(0);
      let offset = headers * 4;
      visit((residency) => {
        if (!residency.publicationActive) {
          return;
        }
        const revisions = residency.assetContentRevisions;
        this.sourceWords.set(
          [residency.productGeneration, residency.assetReferenceBegin, offset, revisions.length],
          residency.productTableSlot * 4
        );
        this.sourceWords.set(revisions, offset);
        offset += revisions.length;
      });
      this.sourceHeaderCount = headers;
    }
    command.onFinished.addOne(() => {
      this.submittedInstanceCount = instanceCount;
    });
  }
  addToGraph(
    graph: FrameGraph,
    input: {
      resources: VsmResources;
      frame: VsmDirectionalFrameConstants;
      state: VsmGenerationState;
      instances: ResourceId;
      instanceBegin: number;
      instanceCount: number;
      contentVersion: ResourceId;
    }
  ): { depthRange: ResourceId; contentVersion: ResourceId } {
    const product = graph.import_resource(
      "VSM/stable depth range",
      { kind: "imported" },
      input.resources.depthRange!
    );
    const pages = graph.import_resource(
      "VSM/caster invalidation pages",
      { kind: "imported" },
      input.resources.pageTable!
    );
    const metas = graph.import_resource(
      "VSM/caster invalidation slots",
      { kind: "imported" },
      input.resources.metaTable!
    );
    const produce = graph.add("VSM/caster content invalidation", input, (data, resolved, context) => {
      if (!data.state.rebuildDepth && data.instanceCount === this.submittedInstanceCount) {
        return;
      }
      const command = context.encoder as ShadeGPUCommandContext;
      const groups = Math.max(1, Math.ceil(data.instanceCount / 64));
      const packed = new ArrayBuffer(96);
      new Float32Array(packed).set(data.frame.lightView);
      new Uint32Array(packed).set(
        [
          data.instanceBegin,
          data.instanceCount,
          groups,
          Number(data.state.fullInvalidate || data.instanceCount !== this.submittedInstanceCount)
        ],
        16
      );
      new Uint32Array(packed).set([Number(data.state.invalidateMask), this.sourceHeaderCount, 0, 0], 20);
      command.writeBuffer(this.constants, 0, packed, 0, 96);
      command.writeBuffer(this.sources, 0, this.sourceWords.buffer, 0, this.sourceWords.byteLength);
      command.clearBuffer(this.damages, 0, VSM_CASTER_DAMAGE_HEADER_BYTES);
      const group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.constants } },
          { binding: 1, resource: { buffer: resolved.get(data.instances) as GPUBuffer } },
          { binding: 2, resource: { buffer: this.scratch } },
          { binding: 3, resource: { buffer: resolved.get(product) as GPUBuffer } },
          { binding: 4, resource: { buffer: this.snapshots } },
          { binding: 5, resource: { buffer: this.sources } },
          { binding: 6, resource: { buffer: this.damages } }
        ]
      });
      const bounds = command.beginComputePass({ label: "VSM/complete caster bounds" });
      bounds.setPipeline(this.boundsPipeline);
      bounds.setBindGroup(0, group);
      bounds.dispatchWorkgroups(groups);
      bounds.end();
      const publish = command.beginComputePass({ label: "VSM/publish stable depth" });
      publish.setPipeline(this.publishPipeline);
      publish.setBindGroup(0, group);
      publish.dispatchWorkgroups(1);
      publish.end();
      const projection = packVsmProjection(data.frame);
      const caps = data.resources.capabilities;
      new Uint32Array(projection).set(
        [caps.virtualPagesPerAxis, caps.atlasPagesPerAxis, caps.pageSize, caps.border],
        40
      );
      new Uint32Array(projection).set([data.frame.generation, caps.residentSlots, 0, 0], 44);
      command.writeBuffer(this.dirtyConstants, 0, projection, 0, projection.byteLength);
      const dirty = command.beginComputePass({ label: "VSM/dirty changed caster slots" });
      dirty.setPipeline(this.dirtyPipeline);
      dirty.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.dirtyLayout,
          entries: [
            { binding: 0, resource: { buffer: this.dirtyConstants } },
            { binding: 1, resource: { buffer: resolved.get(pages) as GPUBuffer } },
            { binding: 2, resource: { buffer: resolved.get(metas) as GPUBuffer } },
            { binding: 3, resource: { buffer: resolved.get(data.contentVersion) as GPUBuffer } },
            { binding: 4, resource: { buffer: this.damages } }
          ]
        })
      );
      dirty.dispatchWorkgroups(Math.ceil(caps.residentSlots / 64));
      dirty.end();
    });
    produce.read(input.instances);
    produce.write(pages);
    produce.write(metas);
    produce.make_side_effect();
    return { depthRange: produce.write(product), contentVersion: produce.write(input.contentVersion) };
  }
  destroy(): void {
    this.constants.destroy();
    this.scratch.destroy();
    this.snapshots.destroy();
    this.sources.destroy();
    this.damages.destroy();
    this.dirtyConstants.destroy();
  }
}
