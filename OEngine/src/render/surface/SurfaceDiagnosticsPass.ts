import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
  SURFACE_DIAGNOSTICS_HEADER_WORDS,
  SURFACE_DIAGNOSTICS_MAGIC,
  SURFACE_DIAGNOSTICS_SCHEMA_VERSION,
  SURFACE_DIAGNOSTICS_COUNTER_WORDS,
  SURFACE_DIAGNOSTICS_COUNTERS,
  SURFACE_DIAGNOSTIC_FLAGS
} from "../../gpu/SurfaceDiagnosticsAbi.js";

export interface SurfaceDiagnosticsProducts {
  readonly snapshot: ResourceId;
}

export interface SurfaceDiagnosticsInput {
  readonly work: ResourceId;
  readonly counts: ResourceId;
  readonly materialCounters: ResourceId;
  readonly materialAudit: ResourceId;
  readonly geometryCount: ResourceId;
  readonly geometryMissCounters: ResourceId;
  readonly lightingCounters: ResourceId;
  readonly width: number;
  readonly height: number;
  readonly frameId: number;
  readonly geometryOffset: number;
}

export type SurfaceDiagnosticsSnapshotEncoder =
  (command: ShadeGPUCommandContext, source: GPUBuffer, frameId: number) => void;

const COUNTER_BASE = SURFACE_DIAGNOSTICS_HEADER_WORDS;
const C = SURFACE_DIAGNOSTICS_COUNTERS;

const SNAPSHOT_WGSL = /* wgsl */ `
struct Settings { width:u32, height:u32, frame:u32, producer_base:u32, consumer_base:u32, stride:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(2) var<storage,read> material_counts:array<u32>;
@group(0) @binding(3) var<storage,read> material_audit:array<u32>;
@group(0) @binding(4) var<storage,read> geometry_count:array<u32>;
@group(0) @binding(5) var<storage,read> geometry_miss:array<u32>;
@group(0) @binding(6) var<storage,read> lighting_counts:array<u32>;
@group(0) @binding(7) var<storage,read_write> snapshot:array<u32>;
@compute @workgroup_size(1)
fn snapshot_frame() {
  let tile_count = ((settings.width + 7u) / 8u) * ((settings.height + 7u) / 8u);
  snapshot[0u] = ${SURFACE_DIAGNOSTICS_MAGIC}u;
  snapshot[1u] = ${SURFACE_DIAGNOSTICS_SCHEMA_VERSION}u;
  snapshot[4u] = settings.frame;
  snapshot[6u] = ${SURFACE_DIAGNOSTICS_COUNTER_WORDS}u;
  snapshot[${COUNTER_BASE + C.totalTiles}u] = tile_count;
  snapshot[${COUNTER_BASE + C.emptyTiles}u] = surface_counts[4u];
  snapshot[${COUNTER_BASE + C.uniformTiles}u] = surface_counts[5u];
  snapshot[${COUNTER_BASE + C.mixedTiles}u] = surface_counts[6u];
  snapshot[${COUNTER_BASE + C.visiblePixels}u] = surface_counts[3u];
  snapshot[${COUNTER_BASE + C.sampleRequested}u] = surface_counts[12u];
  snapshot[${COUNTER_BASE + C.sampleAccepted}u] = surface_counts[0u];
  snapshot[${COUNTER_BASE + C.sampleOverflow}u] = surface_counts[14u];
  snapshot[${COUNTER_BASE + C.exceptionRequested}u] = surface_counts[13u];
  snapshot[${COUNTER_BASE + C.exceptionAccepted}u] = surface_counts[1u];
  snapshot[${COUNTER_BASE + C.materialLookup}u] = material_counts[0u] + material_counts[1u] + material_counts[3u];
  snapshot[${COUNTER_BASE + C.materialHit}u] = material_counts[0u];
  snapshot[${COUNTER_BASE + C.materialMissRequested}u] = material_counts[1u];
  snapshot[${COUNTER_BASE + C.materialMissQueued}u] = material_counts[2u];
  snapshot[${COUNTER_BASE + C.materialRejected}u] = material_counts[3u];
  snapshot[${COUNTER_BASE + C.materialEvaluatorEntered}u] = material_audit[0u];
  snapshot[${COUNTER_BASE + C.materialEvaluatorCompleted}u] = material_audit[1u];
  snapshot[${COUNTER_BASE + C.materialFieldsPublished}u] = material_audit[2u];
  snapshot[${COUNTER_BASE + C.materialEvaluatorSkippedOrRejected}u] = material_audit[3u];
  snapshot[${COUNTER_BASE + C.geometryRecordsRequested}u] = surface_counts[0u];
  snapshot[${COUNTER_BASE + C.geometryMissQueued}u] = geometry_miss[0u];
  snapshot[${COUNTER_BASE + C.geometryCacheHit}u] = geometry_count[3u];
  snapshot[${COUNTER_BASE + C.geometryMissCompleted}u] = geometry_count[1u];
  snapshot[${COUNTER_BASE + C.geometryRecordsValid}u] = geometry_count[4u];
  snapshot[${COUNTER_BASE + C.geometryRejected}u] = geometry_count[5u];
  snapshot[${COUNTER_BASE + C.geometryProducerBaseWords}u] = settings.producer_base;
  snapshot[${COUNTER_BASE + C.geometryConsumerBaseWords}u] = settings.consumer_base;
  snapshot[${COUNTER_BASE + C.geometryRecordStrideWords}u] = settings.stride;
  snapshot[${COUNTER_BASE + C.lightingRecordsProcessed}u] = lighting_counts[12u];
  snapshot[${COUNTER_BASE + C.lightingRecordsRejected}u] = lighting_counts[13u];
  snapshot[${COUNTER_BASE + C.diffuseEvaluations}u] = lighting_counts[0u];
  snapshot[${COUNTER_BASE + C.specularEvaluations}u] = lighting_counts[1u];
  snapshot[${COUNTER_BASE + C.coatEvaluations}u] = lighting_counts[2u];
  snapshot[${COUNTER_BASE + C.iblEvaluations}u] = lighting_counts[3u];
  // The production kernel writes all four packet planes for every accepted
  // record, but it does not publish per-plane write counters. Keep these
  // fields zero and flag them unknown instead of presenting signal-evaluation
  // counts as packet-write measurements.
  snapshot[${COUNTER_BASE + C.diffusePacketWrites}u] = 0u;
  snapshot[${COUNTER_BASE + C.specularPacketWrites}u] = 0u;
  snapshot[${COUNTER_BASE + C.coatPacketWrites}u] = 0u;
  snapshot[${COUNTER_BASE + C.iblPacketWrites}u] = 0u;
  snapshot[${COUNTER_BASE + C.outputPixels}u] = settings.width * settings.height;
  snapshot[${COUNTER_BASE + C.validPacketPixels}u] = lighting_counts[12u];
  var diagnostic_flags = ${SURFACE_DIAGNOSTIC_FLAGS.incompleteProducerCounters | SURFACE_DIAGNOSTIC_FLAGS.lightingPacketWritesUnknown}u;
  if surface_counts[14u] != 0u { diagnostic_flags = diagnostic_flags | ${SURFACE_DIAGNOSTIC_FLAGS.sampleOverflow}u; }
  if geometry_miss[1u] != 0u { diagnostic_flags = diagnostic_flags | ${SURFACE_DIAGNOSTIC_FLAGS.geometryOverflow}u; }
  if material_counts[1u] > material_counts[2u] { diagnostic_flags = diagnostic_flags | ${SURFACE_DIAGNOSTIC_FLAGS.materialOverflow}u; }
  snapshot[${COUNTER_BASE + C.queueOverflowFlags}u] = diagnostic_flags & (${SURFACE_DIAGNOSTIC_FLAGS.sampleOverflow | SURFACE_DIAGNOSTIC_FLAGS.geometryOverflow | SURFACE_DIAGNOSTIC_FLAGS.materialOverflow}u);
  snapshot[${COUNTER_BASE + C.diagnosticsFlags}u] = diagnostic_flags;
}
`;

export class SurfaceDiagnosticsPass {
  private readonly settings: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(
    private readonly device: GPUDevice,
    private readonly encodeSnapshot?: SurfaceDiagnosticsSnapshotEncoder
  ) {
    this.settings = device.createBuffer({ label: "Surface diagnostics settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      ...[1, 2, 3, 4, 5, 6, 7].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 7 ? "storage" as GPUBufferBindingType : "read-only-storage" as GPUBufferBindingType } }))
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface diagnostics snapshot",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: SNAPSHOT_WGSL }), entryPoint: "snapshot_frame" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceDiagnosticsInput): SurfaceDiagnosticsProducts {
    let snapshotId!: ResourceId;
    const node = graph.add("Surface/diagnostics snapshot", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.settings, 0, new Uint32Array([
        data.width, data.height, data.frameId, data.geometryOffset / 16, data.geometryOffset / 16, 12, 0, 0
      ]).buffer, 0, 32);
      const snapshot = resources.get(snapshotId) as GPUBuffer;
      command.writeBuffer(snapshot, 0, new Uint32Array(SURFACE_DIAGNOSTICS_BYTE_SIZE / 4).buffer, 0, SURFACE_DIAGNOSTICS_BYTE_SIZE);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } },
        { binding: 1, resource: { buffer: resources.get(data.counts) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(data.materialCounters) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(data.materialAudit) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(data.geometryCount) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(data.geometryMissCounters) as GPUBuffer } },
        { binding: 6, resource: { buffer: resources.get(data.lightingCounters) as GPUBuffer } },
        { binding: 7, resource: { buffer: snapshot } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/diagnostics snapshot" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
      this.encodeSnapshot?.(command, snapshot, data.frameId);
    });
    for (const resource of [input.work, input.counts, input.materialCounters, input.materialAudit,
      input.geometryCount, input.geometryMissCounters, input.lightingCounters]) node.read(resource);
    snapshotId = node.create("Surface diagnostics snapshot buffer", { kind: "transient_buffer",
      size: SURFACE_DIAGNOSTICS_BYTE_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      domain: "internal-full" });
    node.write(snapshotId);
    node.make_side_effect();
    return { snapshot: snapshotId };
  }

  destroy(): void { this.settings.destroy(); }
}
