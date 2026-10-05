import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
  SURFACE_DIAGNOSTICS_HEADER_WORDS,
  SURFACE_DIAGNOSTICS_MAGIC,
  SURFACE_DIAGNOSTICS_SCHEMA_VERSION,
  SURFACE_DIAGNOSTICS_COUNTER_WORDS,
  SURFACE_DIAGNOSTICS_COUNTERS as C,
} from "../../gpu/SurfaceDiagnosticsAbi.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl } from "../../gpu/GpuSurfaceDemandAbi.js";
import {
  SURFACE_GEOMETRY_RECORD_VECTORS,
  SURFACE_GEOMETRY_RECORD_BYTES,
} from "../../gpu/GpuSurfaceGeometryRecordAbi.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";
export type SurfaceDiagnosticsSnapshotEncoder = (
  command: ShadeGPUCommandContext,
  source: GPUBuffer,
  frameId: number,
) => void;
/** Accumulate actual batch products; publish/read back exactly once after the
 * final consumer. Timing mode never constructs this graph or diagnostic atomics. */
export class SurfaceDiagnosticsPass {
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  constructor(
    private readonly device: GPUDevice,
    private readonly encodeSnapshot?: SurfaceDiagnosticsSnapshotEncoder,
  ) {}
  addToGraph(
    graph: FrameGraph,
    input: {
      demand: SurfaceDemandProducts;
      reconstruct: ResourceId;
      after: ResourceId;
      width: number;
      height: number;
      firstTile: number;
      tileCount: number;
      last: boolean;
      frameId: Readonly<{
        value: number;
      }>;
      previous?: ResourceId;
    },
  ): {
    snapshot: ResourceId;
  } {
    const { targets, programs } = input.demand.layout;
    const key = `${targets}:${programs}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline === undefined) {
      const add = (counter: number, expression: string): string =>
        `atomicAdd(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + counter}u],${expression});`;
      const code = /* wgsl */ `
${surfaceCellWorkspaceWgsl(targets / 64)}
${surfaceDemandArenaWgsl(targets, programs)}
struct Settings {width:u32,height:u32,frame:u32,tiles:u32,last:u32,pad:vec3u}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read_write> workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read_write> demand:SurfaceDemandArena;
@group(0) @binding(3) var<storage,read> reconstruct:array<u32>;
@group(0) @binding(4) var<storage,read_write> snapshot:array<atomic<u32>>;
@compute @workgroup_size(1)
fn publish_snapshot() {
 atomicStore(&snapshot[0u],${SURFACE_DIAGNOSTICS_MAGIC}u);
 atomicStore(&snapshot[1u],${SURFACE_DIAGNOSTICS_SCHEMA_VERSION}u);
 atomicStore(&snapshot[4u],settings.frame);
 atomicStore(&snapshot[6u],${SURFACE_DIAGNOSTICS_COUNTER_WORDS}u);
 var visible=0u;var empty=0u;var uniform=0u;var mixed=0u;
 for(var tile=0u;tile<atomicLoad(&workspace.counters[127u]);tile++) {
  var count=0u;var material=0xffffffffu;var same=true;
  for(var lane=0u;lane<64u;lane++) {
   let fact=workspace.facts[tile*64u+lane];
   if fact.x!=0xffffffffu && fact.z!=0xffffffffu { count++;if material==0xffffffffu {material=fact.z;}else {same=same&&material==fact.z;} }
  }
  visible+=count;
  if count==0u {empty++;} else if same {uniform++;} else {mixed++;}
 }
 ${add(C.totalTiles, "atomicLoad(&workspace.counters[127u])")}
 ${add(C.emptyTiles, "empty")}${add(C.uniformTiles, "uniform")}${add(C.mixedTiles, "mixed")}${add(C.visiblePixels, "visible")}
 let fields=atomicLoad(&demand.control[49u]);
 let misses=atomicLoad(&workspace.counters[115u]);
 let geometry=atomicLoad(&demand.control[0u]);let materials=atomicLoad(&demand.control[5u]);let lighting=atomicLoad(&demand.control[6u]);
 ${add(C.sampleRequested, "geometry")}${add(C.sampleAccepted, "geometry")}
 ${add(C.materialLookup, "misses+atomicLoad(&workspace.counters[113u])")}
 ${add(C.materialHit, "atomicLoad(&workspace.counters[113u])")}${add(C.materialMissRequested, "misses")}${add(C.materialMissQueued, "materials")}
 ${add(C.materialEvaluatorEntered, "materials")}${add(C.materialEvaluatorCompleted, "materials")}${add(C.materialFieldsPublished, "fields")}
 ${add(C.geometryRecordsRequested, "geometry")}${add(C.geometryMissQueued, "geometry")}${add(C.geometryMissCompleted, "geometry")}${add(C.geometryRecordsValid, "geometry")}
 ${add(C.geometryRecordWriteBytes, `geometry*128u+atomicLoad(&demand.control[46u])*4u`)}
 ${add(C.lightingRecordsProcessed, "lighting")}
 ${add(C.diffuseEvaluations, "atomicLoad(&demand.control[64u])")}${add(C.specularEvaluations, "atomicLoad(&demand.control[65u])")}${add(C.coatEvaluations, "atomicLoad(&demand.control[66u])")}
 ${add(C.iblEvaluations, "atomicLoad(&demand.control[67u])")}
 ${add(C.diffusePacketWrites, "atomicLoad(&demand.control[84u])+atomicLoad(&demand.control[85u])")}
 ${add(C.specularPacketWrites, "atomicLoad(&demand.control[86u])+atomicLoad(&demand.control[87u])")}
 ${add(C.coatPacketWrites, "atomicLoad(&demand.control[88u])+atomicLoad(&demand.control[89u])")}
 ${add(C.iblPacketWrites, "atomicLoad(&demand.control[85u])+atomicLoad(&demand.control[87u])+atomicLoad(&demand.control[89u])")}
 ${add(C.packetWriteBytes, "atomicLoad(&demand.control[50u])*16u")}
 ${add(C.fieldCacheRequests, "atomicLoad(&demand.control[1u])")}
 ${add(C.fieldCacheProbes, "atomicLoad(&demand.control[53u])")}
 ${add(C.fieldCacheUnique, "atomicLoad(&demand.control[3u])")}
 ${add(C.fieldCacheAdmissions, "atomicLoad(&demand.control[51u])")}
 ${add(C.fieldCacheQueueRejected, "atomicLoad(&demand.control[47u])")}
 ${add(C.signalCacheRequests, "atomicLoad(&demand.control[2u])")}
 ${add(C.signalCacheProbes, "atomicLoad(&demand.control[54u])")}
 ${add(C.signalCacheUnique, "atomicLoad(&demand.control[4u])")}
 ${add(C.signalCacheAdmissions, "atomicLoad(&demand.control[52u])")}
 ${add(C.signalCacheQueueRejected, "atomicLoad(&demand.control[48u])")}
 ${add(C.fieldValuesProduced, "fields")}${add(C.signalValuesProduced, "atomicLoad(&demand.control[50u])")}
 ${add(C.candidateLeaves, "atomicLoad(&workspace.counters[84u])")}
 ${add(C.uvWitnessGroups, "atomicLoad(&workspace.counters[85u])")}
 ${add(C.uvWitnessWriteBytes, "atomicLoad(&workspace.counters[86u])")}
 ${add(C.signalWitnessLeaves, "atomicLoad(&workspace.counters[87u])")}
 ${add(C.signalWitnessWriteBytes, "atomicLoad(&workspace.counters[88u])")}
 ${add(C.proofResultWriteBytes, "atomicLoad(&workspace.counters[89u])")}
 ${add(C.proofAdmitted, "atomicLoad(&workspace.counters[120u])")}
 ${add(C.proofRejected, "atomicLoad(&workspace.counters[122u])")}
 ${add(C.geometryHotWriteBytes, "geometry*128u")}
 ${add(C.geometryColdWriteBytes, "atomicLoad(&demand.control[46u])*4u")}
 ${add(C.explicitStoreRefWriteBytes, "atomicLoad(&workspace.counters[90u])")}
 ${add(C.fullDirectLightEvaluations, "atomicLoad(&demand.control[96u])")}
 ${add(C.sharedDirectTransportEvaluations, "atomicLoad(&demand.control[97u])")}
 ${add(C.transportOnlyLightEvaluations, "atomicLoad(&demand.control[98u])")}
 ${add(C.fieldLookupCandidates, "atomicLoad(&workspace.counters[91u])")}
 ${add(C.nonPublicationFields, "atomicLoad(&workspace.counters[92u])")}
 ${add(C.fieldLookupProbes, "atomicLoad(&workspace.counters[93u])")}
 ${add(C.transportEligibleLeaves, "atomicLoad(&workspace.counters[94u])")}
 ${add(C.residualLeaves, "atomicLoad(&workspace.counters[95u])")}
 if settings.last!=0u {
  let all_tiles=((settings.width+7u)/8u)*((settings.height+7u)/8u);
  let active_tiles=atomicLoad(&workspace.counters[125u]);
  ${add(C.totalTiles, "all_tiles-active_tiles")}
  ${add(C.emptyTiles, "all_tiles-active_tiles")}

  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.reconstructOutputPixels}u],reconstruct[0u]);
  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.reconstructUncoveredPixels}u],reconstruct[1u]);
  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.reconstructMappedPixels}u],reconstruct[7u]);
  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.outputPixels}u],settings.width*settings.height);
  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.reconstructWriteBytes}u],settings.width*settings.height*12u);
  atomicStore(&snapshot[${SURFACE_DIAGNOSTICS_HEADER_WORDS + C.geometryRecordStrideWords}u],${SURFACE_GEOMETRY_RECORD_VECTORS}u);
 }
}
`;
      pipeline = this.device.createComputePipeline({
        label: "Surface/actual batch diagnostic snapshot",
        layout: "auto",
        compute: { module: this.device.createShaderModule({ code }), entryPoint: "publish_snapshot" },
      });
      this.pipelines.set(key, pipeline);
    }
    let snapshot!: ResourceId;
    const node = graph.add(
      "Surface/actual batch diagnostic snapshot",
      { ...input },
      (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const settings = command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 48);
        command.writeBuffer(
          settings,
          0,
          new Uint32Array([
            data.width,
            data.height,
            data.frameId.value,
            data.tileCount,
            data.last ? 1 : 0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
          ]).buffer,
          0,
          48,
        );
        const buffer = resources.get(snapshot) as GPUBuffer;
        if (data.previous === undefined) {
          command.gpu_encoder.clearBuffer(buffer);
        }
        const group = this.device.createBindGroup({
          layout: pipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: settings } },
            { binding: 1, resource: { buffer: resources.get(data.demand.workspace) as GPUBuffer } },
            { binding: 2, resource: { buffer: resources.get(data.demand.arena) as GPUBuffer } },
            { binding: 3, resource: { buffer: resources.get(data.reconstruct) as GPUBuffer } },
            { binding: 4, resource: { buffer } },
          ],
        });
        const pass = command.beginComputePass({ label: "Surface/actual batch diagnostic snapshot" });
        pass.setPipeline(pipeline!);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        if (data.last) {
          this.encodeSnapshot?.(command, buffer, data.frameId.value);
        }
      },
    );
    for (const resource of [input.demand.workspace, input.demand.arena, input.reconstruct, input.after]) {
      node.read(resource);
    }
    if (input.previous !== undefined) {
      node.read(input.previous);
      snapshot = node.write(input.previous);
    } else {
      snapshot = node.create("Surface/diagnostic snapshot", {
        kind: "transient_buffer",
        size: SURFACE_DIAGNOSTICS_BYTE_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        domain: "internal-full",
      });
      node.write(snapshot);
    }
    node.make_side_effect();
    return { snapshot };
  }
  destroy(): void {
    this.pipelines.clear();
  }
}
