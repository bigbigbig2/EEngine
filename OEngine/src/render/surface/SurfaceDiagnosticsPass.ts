import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
  SURFACE_DIAGNOSTICS_HEADER_WORDS,
  SURFACE_DIAGNOSTICS_COUNTERS as C,
  writeSurfaceDiagnosticsHeader,
  type SurfaceDiagnosticsIdentity
} from "../../gpu/SurfaceDiagnosticsAbi.js";
import { SURFACE_WORK_QUERY_COUNTERS as Q, type SurfaceWorkCapacity } from "../../gpu/GpuSurfaceWorkAbi.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
export type SurfaceDiagnosticsSnapshotEncoder = (
  command: ShadeGPUCommandContext,
  source: GPUBuffer,
  frameId: number
) => void;

/** One immutable, sampled snapshot after all actual producers/consumers. No
 * retired proof counters are exposed as measured zeroes. Timing/off modes do
 * not construct this pass, payload scans, atomics or readback. */
export class SurfaceDiagnosticsPass {
  private readonly pipeline: GPUComputePipeline;
  private readonly header = new Uint32Array(SURFACE_DIAGNOSTICS_HEADER_WORDS);
  constructor(
    private readonly device: GPUDevice,
    private readonly scratch: SurfaceFrameResources,
    private readonly encodeSnapshot?: SurfaceDiagnosticsSnapshotEncoder
  ) {
    const counter = (index: number) => "control[" + index + "u]";
    const packets = Array.from({ length: 6 }, (_, index) => counter(276 + index)).join(" + ");
    const fields: Partial<Record<keyof typeof C, string>> = {
      totalTiles: "settings.tiles",
      emptyTiles: counter(225),
      uniformTiles: counter(226),
      mixedTiles: counter(227),
      visiblePixels: counter(224),
      geometryRecordsRequested: counter(239),
      geometryMissCompleted: counter(229),
      geometryRejected: counter(228),
      geometryRecordStrideWords: "select(0u, settings.hot_words, settings.hot_words > 2u)",
      geometryHotWriteBytes: counter(243) + " * settings.hot_words * 4u",
      materialEvaluatorEntered: counter(240),
      materialEvaluatorCompleted: counter(230),
      fieldValuesProduced: counter(241),
      fieldScalarWrites: counter(242),
      lightingRecordsProcessed: counter(261),
      diffuseEvaluations: counter(256),
      specularEvaluations: counter(257),
      coatEvaluations: counter(258),
      iblEvaluations: counter(259) + " + " + counter(260) + " + " + counter(262),
      lightLoopIterations: counter(264),
      diffusePacketWrites: counter(276) + " + " + counter(277),
      specularPacketWrites: counter(278) + " + " + counter(279),
      coatPacketWrites: counter(280) + " + " + counter(281),
      iblPacketWrites: counter(277) + " + " + counter(279) + " + " + counter(281),
      packetWriteBytes: "(" + packets + ") * 12u + " + counter(261) + " * 4u",
      signalValuesProduced: packets,
      reconstructOutputPixels: counter(233),
      reconstructUncoveredPixels: counter(234),
      outputPixels: "settings.pixels",
      transientBytes: "settings.bytes",
      diagnosticsFlags: "select(0u, 16u, control[228u] != 0u)",
      domainDescriptions: "settings.domains",
      coverageReferences: "control[32u] + control[33u] + control[34u] + control[35u]",
      promotedTiles: counter(232),
      geometrySetupEvaluations: counter(244),
      sampleTextureQueries: counter(Q.texture),
      sampleProductQueries: counter(Q.product),
      uniformScalarReads: counter(Q.uniformRead)
    };
    const available = new Uint32Array(4);
    const lines: string[] = [];
    for (const [name, expression] of Object.entries(fields)) {
      const index = C[name as keyof typeof C];
      available[index >>> 5] = (available[index >>> 5]! | (1 << (index & 31))) >>> 0;
      lines.push("  snapshot[" + (SURFACE_DIAGNOSTICS_HEADER_WORDS + index) + "u] = " + expression + ";");
    }
    for (let word = 0; word < 4; word++) {
      lines.push("  snapshot[" + (8 + word) + "u] = " + available[word] + "u;");
    }
    const code = /* wgsl */ `
struct Settings { tiles: u32, pixels: u32, domains: u32, bytes: u32,
  hot_words: u32, reserved0: u32, reserved1: u32, reserved2: u32, }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> control: array<u32>;
@group(0) @binding(2) var<storage, read_write> snapshot: array<u32>;
@compute @workgroup_size(1)
fn publish_snapshot() {
${lines.join("\n")}
}
`;
    this.pipeline = device.createComputePipeline({
      label: "Surface/diagnostic snapshot",
      layout: "auto",
      compute: { module: device.createShaderModule({ code }), entryPoint: "publish_snapshot" }
    });
  }
  addToGraph(
    graph: FrameGraph,
    input: {
      readonly control: ResourceId;
      readonly after: ResourceId;
      readonly capacity: SurfaceWorkCapacity;
      readonly domains: number;
      readonly frameId: Readonly<{ value: number }>;
      readonly identity: Omit<SurfaceDiagnosticsIdentity, "frameId">;
      readonly bind: SurfaceResourceBinding;
    }
  ): { snapshot: ResourceId } {
    let snapshot = this.scratch.importBuffer(
      graph,
      input.bind,
      "Surface/diagnostic snapshot",
      SURFACE_DIAGNOSTICS_BYTE_SIZE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    );
    const settings = this.scratch.importBuffer(
      graph,
      input.bind,
      "Surface/diagnostic settings",
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    const previous = snapshot;
    const node = graph.add("Surface/diagnostic snapshot", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      writeSurfaceDiagnosticsHeader(
        this.header,
        { ...data.identity, frameId: data.frameId.value },
        "detailed"
      );
      command.writeBuffer(
        resources.get(previous) as GPUBuffer,
        0,
        this.header.buffer,
        0,
        this.header.byteLength
      );
      command.writeBuffer(
        resources.get(settings) as GPUBuffer,
        0,
        new Uint32Array([
          data.capacity.bankTiles * 4,
          data.capacity.width * data.capacity.height,
          data.domains,
          this.scratch.physicalBytes().active,
          data.capacity.hotWords,
          0,
          0,
          0
        ]).buffer,
        0,
        32
      );
      const group = this.scratch.obtainBindGroup(this.pipeline, 0, [
        { binding: 0, resource: { buffer: resources.get(settings) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(data.control) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(previous) as GPUBuffer } }
      ]);
      const pass = command.beginComputePass({ label: "Surface/diagnostic snapshot" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      this.encodeSnapshot?.(command, resources.get(previous) as GPUBuffer, data.frameId.value);
    });
    node.read(input.control);
    node.read(input.after);
    node.write(settings);
    snapshot = node.write(snapshot);
    return { snapshot };
  }
  destroy(): void {
    /* Pipeline lifetime belongs to the GPUDevice. */
  }
}
