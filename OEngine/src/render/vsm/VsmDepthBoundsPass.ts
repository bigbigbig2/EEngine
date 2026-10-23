import {
  VSM_DIMENSIONS_WORD,
  VSM_CONTROL_WORD,
  VSM_PROJECTION_CONSTANT_BYTES as VSM_ABI_BYTES
} from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import type { FrameProfiler } from "../../debug/FrameProfiler.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  VSM_DEPTH_BOUNDS_WGSL,
  VSM_CASTER_SNAPSHOT_BYTES,
  VSM_CASTER_DAMAGE_RECORD_BYTES,
  VSM_CASTER_DAMAGE_HEADER_BYTES,
  VSM_RESIDENCY_INFLUENCE_WORDS
} from "../../shaders/vsm_depth_bounds.js";
import { VSM_CASTER_INVALIDATION_WGSL } from "../../shaders/vsm_caster_invalidation.js";
import { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import type { VirtualGeometryResidency } from "../../gpu/VirtualGeometryResidency.js";
import type { VsmResources } from "./VsmResources.js";
import { packVsmProjection, type VsmDirectionalFrameConstants } from "./VsmProjection.js";
import type { VsmGenerationState } from "./VsmGeneration.js";

/** Exact float32 bit pattern, allocation-free on the per-frame upload path. */
const bitcastScratch = new Float32Array(1);
const bitcastWords = new Uint32Array(bitcastScratch.buffer);
function f32Bits(value: number): number {
  bitcastScratch[0] = value;
  return bitcastWords[0]!;
}

export class VsmDepthBoundsPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([
      this.boundsPipeline.prepare(),
      this.publishPipeline.prepare(),
      this.dirtyPipeline.prepare()
    ]);
  }

  private readonly constants: GPUBuffer;
  private scratch: GPUBuffer;
  private snapshots: GPUBuffer;
  private sources: GPUBuffer;
  private influences: GPUBuffer;
  private damages: GPUBuffer;
  private sourceWords = new Uint32Array(4);
  private influenceWords = new Uint32Array(VSM_RESIDENCY_INFLUENCE_WORDS);
  private sourceHeaderCount = 0;
  private submittedSourceWords = new Uint32Array(0);
  private submittedInfluenceWords = new Uint32Array(0);
  private sourceUploadRevision = 0;
  private submittedUploadRevision = -1;
  private submittedInstanceCount = -1;
  private readonly dirtyConstants: GPUBuffer;
  private readonly dirtyLayout: GPUBindGroupLayout;
  private readonly dirtyPipeline: PreparedComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly boundsPipeline: PreparedComputePipeline;
  private readonly publishPipeline: PreparedComputePipeline;
  constructor(
    private readonly device: GPUDevice,
    /** Optional sampled GPU-counter owner. Without it this pass still produces
     * damage, but publication amplification is not observable. */
    private readonly profiler?: FrameProfiler
  ) {
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
    this.influences = this.createStorage(
      "VSM/residency influences",
      VSM_RESIDENCY_INFLUENCE_WORDS * Uint32Array.BYTES_PER_ELEMENT
    );
    this.damages = this.createStorage(
      "VSM/caster damages",
      VSM_CASTER_DAMAGE_HEADER_BYTES + VSM_CASTER_DAMAGE_RECORD_BYTES
    );
    this.dirtyConstants = device.createBuffer({
      label: "VSM/caster invalidation constants",
      size: VSM_ABI_BYTES,
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
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
      ]
    });
    const module = device.createShaderModule({
      label: "VSM/stable depth bounds",
      code: VSM_DEPTH_BOUNDS_WGSL
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.boundsPipeline = new PreparedComputePipeline(device, {
      layout,
      compute: { module, entryPoint: "instance_bounds" }
    });
    this.publishPipeline = new PreparedComputePipeline(device, {
      layout,
      compute: { module, entryPoint: "publish_depth" }
    });
    this.dirtyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[1, 2, 3, 4, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType }
        }))
      ]
    });
    this.dirtyPipeline = new PreparedComputePipeline(device, {
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
        this.submittedSourceWords = new Uint32Array(0);
        this.sourceWords = new Uint32Array(words);
      }
      const influenceWordCount = words * VSM_RESIDENCY_INFLUENCE_WORDS;
      if (influenceWordCount * 4 > this.influences.size) {
        const next = this.createStorage("VSM/residency influences", influenceWordCount * 4);
        command.destroyAfterGpuDone(this.influences);
        this.influences = next;
        this.submittedInfluenceWords = new Uint32Array(0);
        this.influenceWords = new Uint32Array(influenceWordCount);
      }
      this.sourceUploadRevision++;
      this.sourceWords.fill(0);
      this.influenceWords.fill(0);
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
        const changes = residency.residencyInfluences();
        command.onFinished.addOne(() => residency.acknowledgeResidencyInfluences(changes));
        const fallback = new Set<number>();
        const written = new Set<number>();
        for (const change of changes) {
          const index = offset + change.assetIndex;
          if (change.assetIndex < 0 || change.assetIndex >= revisions.length) {
            throw new RangeError("VSM residency influence exceeds its asset domain");
          }
          const base = index * VSM_RESIDENCY_INFLUENCE_WORDS;
          if (change.fullAsset || change.revision !== revisions[change.assetIndex]) {
            fallback.add(index);
            this.influenceWords.fill(0, base, base + VSM_RESIDENCY_INFLUENCE_WORDS);
          }
          if (fallback.has(index)) continue;
          const prior = new Float32Array(this.influenceWords.buffer, base * 4, VSM_RESIDENCY_INFLUENCE_WORDS);
          const hasPrior = written.has(index);
          for (let axis = 0; axis < 3; axis++) {
            this.influenceWords[base + axis] = f32Bits(
              hasPrior ? Math.min(prior[axis]!, change.min[axis]!) : change.min[axis]!
            );
            this.influenceWords[base + 4 + axis] = f32Bits(
              hasPrior ? Math.max(prior[4 + axis]!, change.max[axis]!) : change.max[axis]!
            );
          }
          this.influenceWords[base + 3] = change.revision;
          this.influenceWords[base + 7] = residency.productGeneration;
          written.add(index);
        }
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
    const mutation = graph.import_resource(
      "VSM/caster descriptor mutations",
      { kind: "imported" },
      input.resources.getBuffer("descriptorMutations")!
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
      const rebuildRange = data.state.rebuildDepthRange || data.instanceCount !== this.submittedInstanceCount;
      new Uint32Array(packed).set(
        [Number(data.state.invalidateMask), this.sourceHeaderCount, Number(rebuildRange), 0],
        20
      );
      command.writeBuffer(this.constants, 0, packed, 0, 96);
      if (this.sourceUploadRevision !== this.submittedUploadRevision) {
        const revision = this.sourceUploadRevision;
        const uploadChanges = (buffer: GPUBuffer, current: Uint32Array, submitted: Uint32Array) => {
          const ranges: number[] = [];
          for (let word = 0; word < current.length; word++) {
            if (word < submitted.length && current[word] === submitted[word]) {
              continue;
            }
            const previous = ranges.length - 1;
            if (previous >= 0 && word - ranges[previous]! <= 16) {
              ranges[previous] = word + 1;
            } else {
              ranges.push(word, word + 1);
            }
          }
          // Many tiny upload/copy commands cost more than one sequential write.
          // Coalescing changes transfer granularity, never the committed values.
          if (ranges.length > 64) {
            command.writeBuffer(buffer, 0, current.buffer as ArrayBuffer, 0, current.byteLength);
          } else {
            for (let range = 0; range < ranges.length; range += 2) {
              const begin = ranges[range]!,
                end = ranges[range + 1]!;
              command.writeBuffer(
                buffer,
                begin * 4,
                current.buffer as ArrayBuffer,
                begin * 4,
                (end - begin) * 4
              );
            }
          }
        };
        uploadChanges(this.sources, this.sourceWords, this.submittedSourceWords);
        uploadChanges(this.influences, this.influenceWords, this.submittedInfluenceWords);
        const submittedSources = this.sourceWords.slice();
        const submittedInfluences = this.influenceWords.slice();
        command.onFinished.addOne(() => {
          this.submittedSourceWords = submittedSources;
          this.submittedInfluenceWords = submittedInfluences;
          this.submittedUploadRevision = revision;
        });
      }
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
          { binding: 6, resource: { buffer: this.damages } },
          { binding: 7, resource: { buffer: this.influences } }
        ]
      });
      const bounds = command.beginComputePass({ label: "VSM/complete caster bounds" });
      bounds.setPipeline(this.boundsPipeline.requirePrepared());
      bounds.setBindGroup(0, group);
      bounds.dispatchWorkgroups(groups);
      bounds.end();
      if (rebuildRange) {
        const publish = command.beginComputePass({ label: "VSM/publish stable depth" });
        publish.setPipeline(this.publishPipeline.requirePrepared());
        publish.setBindGroup(0, group);
        publish.dispatchWorkgroups(1);
        publish.end();
      }
      const projection = packVsmProjection(data.frame);
      const caps = data.resources.capabilities;
      new Uint32Array(projection).set(
        [caps.virtualPagesPerAxis, caps.atlasPagesPerAxis, caps.pageSize, caps.border],
        VSM_DIMENSIONS_WORD
      );
      new Uint32Array(projection).set(
        [data.frame.generation, caps.residentSlots, data.state.frameSerial, 0],
        VSM_CONTROL_WORD
      );
      command.writeBuffer(this.dirtyConstants, 0, projection, 0, projection.byteLength);
      const dirty = command.beginComputePass({ label: "VSM/dirty changed caster slots" });
      dirty.setPipeline(this.dirtyPipeline.requirePrepared());
      dirty.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.dirtyLayout,
          entries: [
            { binding: 0, resource: { buffer: this.dirtyConstants } },
            { binding: 1, resource: { buffer: resolved.get(pages) as GPUBuffer } },
            { binding: 2, resource: { buffer: resolved.get(metas) as GPUBuffer } },
            { binding: 3, resource: { buffer: resolved.get(data.contentVersion) as GPUBuffer } },
            { binding: 4, resource: { buffer: this.damages } },
            { binding: 5, resource: { buffer: data.resources.getBuffer("descriptorMutations")! } }
          ]
        })
      );
      dirty.dispatchWorkgroups(Math.ceil(caps.residentSlots / 64));
      dirty.end();
      // Publication amplification numerator: pages invalidated by caster damage.
      // Caster invalidation writes word 3 of the damage header in this pass.
      this.profiler?.copyGpuCounter(command, "vsmDirtyPagesInvalidated", this.damages, 12);
    });
    produce.read(input.instances);
    produce.write(mutation);
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
    this.influences.destroy();
    this.damages.destroy();
    this.dirtyConstants.destroy();
  }
}
