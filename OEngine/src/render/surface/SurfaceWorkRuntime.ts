import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceWorkLayout, writeSurfaceWorkHeader, SURFACE_WORK_HEADER_WGSL,
  SURFACE_WORK_COUNTER_BYTES, SURFACE_WORK_INDIRECT_OFFSET, type SurfaceWorkBudget, type SurfaceWorkLayout } from "../../gpu/GpuSurfaceWorkAbi.js";
import { SurfaceGeometryPass, type SurfaceGeometryProducts } from "./SurfaceGeometryPass.js";
import { SurfaceMaterialCachePass, type SurfaceMaterialProducts } from "./SurfaceMaterialCachePass.js";
import { SurfaceLightingWorkPass } from "./SurfaceLightingWorkPass.js";
import type { SurfaceLightingInput } from "./SurfaceLightingWorkPass.js";
import { SurfaceReconstructionPass } from "./SurfaceReconstructionPass.js";
import { SurfaceDiagnosticsPass } from "./SurfaceDiagnosticsPass.js";
import { SURFACE_DIAGNOSTICS_BYTE_SIZE, type SurfaceDiagnosticsMode, type SurfaceDiagnosticsIdentity } from "../../gpu/SurfaceDiagnosticsAbi.js";
import type { SurfaceDiagnosticsCapture } from "../../debug/SurfaceDiagnosticsCapture.js";
import { SurfaceCacheIdentityPass } from "./SurfaceCacheIdentityPass.js";
import { SurfaceDependencyEpochPass } from "./SurfaceDependencyEpochPass.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceCellClassifierPass } from "./SurfaceCellClassifierPass.js";
import type { ResourceAccounting } from "../../debug/profiling/ResourceAccounting.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";

export interface SurfaceWorkFrame {
  readonly generation: number;
  readonly arenaHeaderOffset: number;
  readonly directoryOffset: number;
}

export interface SurfaceSignalRevisions {
  readonly environment: number;
  readonly light: number;
  readonly shadow: number;
  readonly ao?: number;
}

export interface SurfaceWorkProducts extends SurfaceGeometryProducts, SurfaceMaterialProducts {
  readonly work: ResourceId;
  readonly sampleMap: ResourceId;
  readonly counts: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly diagnostics?: ResourceId;
}

/*
 * The production classifier is SurfaceCellClassifierPass. The former
 * winner/pixel classifier was removed from the runtime source so there is no
 * second production scheduling model left to accidentally instantiate.
 */
const FINALIZE_WGSL = /* wgsl */ `
${SURFACE_WORK_HEADER_WGSL}
struct Settings { max_samples: u32, max_exceptions: u32, indirect_offset: u32, reserved: u32 }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> work: array<u32>;
@compute @workgroup_size(1)
fn finalize() {
  let requested_samples = atomicLoad(&counts[0]);
  let requested_exceptions = atomicLoad(&counts[1]);
  atomicStore(&counts[12], requested_samples);
  atomicStore(&counts[13], requested_exceptions + atomicLoad(&counts[13]));
  let samples = min(atomicLoad(&counts[0]), settings.max_samples);
  let exceptions = min(atomicLoad(&counts[1]), settings.max_exceptions);
  work[4] = samples;
  work[5] = 0u;
  work[6] = 0u;
  work[11] = atomicLoad(&counts[2]);
  atomicStore(&counts[8], (samples + 63u) / 64u);
  atomicStore(&counts[9], select(0u, 1u, samples != 0u));
  atomicStore(&counts[10], select(0u, 1u, samples != 0u));
  atomicStore(&counts[0], samples);
  atomicStore(&counts[1], exceptions);
}
`;

export class SurfaceWorkRuntime {
  private readonly cacheIdentity: SurfaceCacheIdentityPass;
  private readonly dependencyEpoch: SurfaceDependencyEpochPass;
  private readonly scratch: SurfaceFrameResources;
  private readonly cellClassifier: SurfaceCellClassifierPass;
  private readonly geometry: SurfaceGeometryPass;
  private readonly material: SurfaceMaterialCachePass;
  private readonly lighting: SurfaceLightingWorkPass;
  private readonly reconstruction: SurfaceReconstructionPass;
  private readonly diagnostics: SurfaceDiagnosticsPass;
  private diagnosticsMode: SurfaceDiagnosticsMode = "off";
  private diagnosticsCapture: SurfaceDiagnosticsCapture | null = null;
  private diagnosticsIdentity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 };
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly finalizePipeline: GPUComputePipeline;
  private readonly finalizeSettings: GPUBuffer;
  private prepared = false;
  private destroyed = false;
  private layout: SurfaceWorkLayout | null = null;

  constructor(private readonly device: GPUDevice, private readonly budget: SurfaceWorkBudget = {
    maxTiles: 262144, maxSamples: 262144, maxExceptions: 65536, maxGeometryRecords: 262144, maxBytes: 128 * 1024 * 1024
  }, accounting?: ResourceAccounting, fieldStore: GpuSurfaceFieldStore | null = null, signalStore: GpuSurfaceSignalStore | null = null) {
    this.scratch = new SurfaceFrameResources(device, accounting);
    this.cellClassifier = new SurfaceCellClassifierPass(device, this.scratch);
    this.cacheIdentity = new SurfaceCacheIdentityPass(device,this.scratch);
    this.dependencyEpoch = new SurfaceDependencyEpochPass(device,this.scratch);
    this.geometry = new SurfaceGeometryPass(device, this.scratch);
    this.material = new SurfaceMaterialCachePass(device, this.scratch, fieldStore);
    this.lighting = new SurfaceLightingWorkPass(device, this.scratch, signalStore);
    this.reconstruction = new SurfaceReconstructionPass(device);
    this.diagnostics = new SurfaceDiagnosticsPass(device, (command, source, frameId) => {
      const capture = this.diagnosticsCapture;
      if (capture === null || this.diagnosticsMode !== "detailed" || command.gpu_encoder === undefined) return;
      const identity = { ...this.diagnosticsIdentity, frameId };
      const ticket = capture.encodeReadback(command.gpu_encoder, source, identity);
      if (ticket === null) return;
      command.recordReadback("surface-diagnostics", SURFACE_DIAGNOSTICS_BYTE_SIZE);
      command.onFinished.addOne(() => capture.markSubmitted(ticket));
      command.onAborted?.addOne((_context: ShadeGPUCommandContext, cause: unknown) => capture.cancel(ticket, cause));
    });
    this.finalizeSettings = device.createBuffer({ label: "SurfaceWork/finalize settings", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.finalizeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.finalizePipeline = device.createComputePipeline({ label: "SurfaceWork/finalize", layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }),
      compute: { module: device.createShaderModule({ code: FINALIZE_WGSL }), entryPoint: "finalize" } });
  }

  prepareFrame(width: number, height: number): void {
    if (this.destroyed || this.prepared) throw new Error("SurfaceWork frame is already prepared");
    this.layout = surfaceWorkLayout(width, height, this.budget, this.device.limits);
    this.scratch.prepare(width, height);
    this.reconstruction.prepareFrame(width, height); this.prepared = true;
  }

  setDiagnosticsMode(mode: SurfaceDiagnosticsMode): void {
    if (this.prepared) throw new Error("Cannot change Surface diagnostics mode during a frame");
    this.diagnosticsMode = mode;
  }

  setDiagnosticsCapture(
    capture: SurfaceDiagnosticsCapture | null,
    identity: Omit<SurfaceDiagnosticsIdentity, "frameId"> = { runId: "default", deviceEpoch: 0 }
  ): void {
    if (this.prepared) throw new Error("Cannot change Surface diagnostics capture during a frame");
    this.diagnosticsCapture = capture;
    this.diagnosticsIdentity = identity;
  }

  addToGraph(graph: FrameGraph, input: { visibility: ResourceId; arena: ResourceId; meshletWork: ResourceId;
    sourceHeap: ResourceId; vertexPayload: ResourceId; frameInstances: ResourceId; frameAttributes: ResourceId;
    camera: ResourceId; textureVariation: ResourceId; appearanceMetadata: ResourceId; fieldVersions: ResourceId; residencyVersions: ResourceId; materialLookup: ResourceId; surfaceIdentity: ResourceId; materials: ResourceId;
    textureBanks: readonly (readonly ResourceId[])[]; publication: GpuAppearancePublication;
    product: Readonly<{ heap: ResourceId; banks: readonly ResourceId[] }> | null;
    lightRecords: ResourceId; clusters: SurfaceLightingInput["clusters"];
    shadow: SurfaceLightingInput["shadow"]; scalarAo: ResourceId | null;
    environment: SurfaceLightingInput["environment"];
    physicalSun: SurfaceLightingInput["physicalSun"];
    factsMask: ResourceId; factsIdentity: ResourceId; factsMotion: ResourceId; preExposure: ResourceId; width: number; height: number;
    historyBinding: SurfaceResourceBinding;
    revisions: SurfaceSignalRevisions; viewRevision: Readonly<{value:number}>; nonlocalRevision: Readonly<{value:number}>; diagnosticFrame: Readonly<{value:number}>;
    frame: SurfaceWorkFrame & { sourceGeometry: number; sourceMeshlet: number; sourceMeshletVertices: number;
      sourceMeshletTriangles: number; sourceVertexData: number } }): SurfaceWorkProducts {
    if (!this.layout) this.layout = surfaceWorkLayout(input.width, input.height, this.budget, this.device.limits);
    const layout = this.layout;
    const cells = this.cellClassifier.addToGraph(graph, { resourceBinding: input.historyBinding, geometryPass: this.geometry,
      visibility: input.visibility, meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload,
      frameInstances: input.frameInstances, camera: input.camera, textureVariation: input.textureVariation,
      appearanceMetadata: input.appearanceMetadata, width: input.width, height: input.height,
      generation: input.frame.generation, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4,
      sourceGeometry: input.frame.sourceGeometry, sourceMeshlet: input.frame.sourceMeshlet, sourceMeshletVertices: input.frame.sourceMeshletVertices,
      sourceMeshletTriangles: input.frame.sourceMeshletTriangles, sourceVertexData: input.frame.sourceVertexData,
      publication: input.publication, product: input.product, lightRecords: input.lightRecords,
      clusters: input.clusters, shadowEnabled: input.shadow !== null, physicalSunEnabled: input.physicalSun !== null,
      workLayout: layout, diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null });
    let work = cells.work;
    let sampleMap = cells.sampleMap;
    let counts = cells.counts;
    const finalize = graph.add("SurfaceWork/finalize counters", { work, counts }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.finalizeSettings, 0, new Uint32Array([layout.sampleCapacity, layout.exceptionCapacity, SURFACE_WORK_INDIRECT_OFFSET, 0]).buffer, 0, 16);
      const group = this.device.createBindGroup({ layout: this.finalizeLayout, entries: [
        { binding: 0, resource: { buffer: this.finalizeSettings } },
        { binding: 1, resource: { buffer: resources.get(counts) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(work) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "SurfaceWork/finalize counters" });
      pass.setPipeline(this.finalizePipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    });
    finalize.read(work); work = finalize.write(work); finalize.read(counts); counts = finalize.write(counts);
    const recordCount = layout.sampleCapacity;
    const witness=this.cacheIdentity.addToGraph(graph,{camera:input.camera,work,counts,meshlets:input.meshletWork,instances:input.frameInstances,
      sampleOffset:layout.sampleOffset,capacity:recordCount,
      view:input.viewRevision,scene:input.nonlocalRevision,bind:input.historyBinding});
    work=witness.work;
    const dependencyEpoch=this.dependencyEpoch.addToGraph(graph,input.residencyVersions,input.historyBinding);
    const material = this.material.addLookupToGraph(graph, { geometryKeys:witness.keys,dependencyEpoch,visibility: input.visibility, work,
      meshletWork: input.meshletWork, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions,
      counts, materialLookup: input.materialLookup, surfaceIdentity: input.surfaceIdentity, materials: input.materials,
      resourceBinding: input.historyBinding, programCount: input.publication.surfaceProgramCount, width: input.width, height: input.height,
      recordCount, sampleOffset: layout.sampleOffset, frame: input.frame.generation,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null,
      viewRevision: input.viewRevision, nonlocalRevision: input.nonlocalRevision });
    work=material.work;
    const geometry = this.geometry.addToGraph(graph, { resourceBinding: input.historyBinding, visibility: input.visibility, work, arena: input.arena,
      meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload,
      frameInstances: input.frameInstances, frameAttributes: input.frameAttributes, camera: input.camera,
      width: input.width,
      height: input.height, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4,
      sourceGeometry: input.frame.sourceGeometry, sourceMeshlet: input.frame.sourceMeshlet,
      sourceMeshletVertices: input.frame.sourceMeshletVertices, sourceMeshletTriangles: input.frame.sourceMeshletTriangles,
      sourceVertexData: input.frame.sourceVertexData, materialHitMask: material.hitMask,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null,
      sampleOffset: layout.sampleOffset, geometryOffset: 0, recordCount, geometryCapacity: layout.geometryCapacity, counts });
    const evaluatedMaterial = this.material.addEvaluateToGraph(graph, { ...material, geometry: geometry.records, geometryOffset: 0, width: input.width, height: input.height,
      recordCount, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions, frame: input.frame.generation, counts,
      publication: input.publication, textureBanks: input.textureBanks, work, sampleOffset: layout.sampleOffset,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null,
      viewRevision: input.viewRevision, nonlocalRevision: input.nonlocalRevision });
    const lighting = this.lighting.addToGraph(graph, { geometryKeys:witness.keys,fieldIdentity: material.cacheKeys,revisions:input.revisions,diagnosticFrame:input.diagnosticFrame,resourceBinding: input.historyBinding, geometry: geometry.records, fields: evaluatedMaterial.fields,
      work, sampleOffset: layout.sampleOffset, geometryOffset: 0, width: input.width, height: input.height,
      recordCount, frame: input.frame.generation, counts, camera: input.camera,
      lightRecords: input.lightRecords, clusters: input.clusters, shadow: input.shadow,
      scalarAo: input.scalarAo, environment: input.environment, physicalSun: input.physicalSun,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null });
    const reconstruction = this.reconstruction.addToGraph(graph, { packets: lighting.packets, reactive: input.factsMask,
      identity: input.factsIdentity, motion: input.factsMotion, historyBinding: input.historyBinding,
      preExposure: input.preExposure, revisions: input.revisions,
      width: input.width, height: input.height, recordCount:input.width*input.height, sampleMap,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null });
    const diagnostics = this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null ? this.diagnostics.addToGraph(graph, {
      work, counts, materialCounters: evaluatedMaterial.counters, materialAudit: evaluatedMaterial.audit, geometryCount: geometry.count,
      geometryMissCounters: geometry.missCounters, lightingCounters: lighting.counters,
      reconstructCounters: reconstruction.counters,
      width: input.width, height: input.height, frameId: input.diagnosticFrame,
      geometryOffset: 0
    }) : null;
    return { counts, sampleMap, ...geometry, ...evaluatedMaterial, ...lighting, ...reconstruction,
      ...(diagnostics === null ? {} : diagnostics) };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("SurfaceWork commit without prepare");
    this.reconstruction.commit(gpuDone); this.scratch.commit(gpuDone); this.prepared = false;
  }
  abort(): void { this.reconstruction.abort(); this.prepared = false; }
  invalidate(): void { this.reconstruction.invalidate(); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.scratch.destroy(); this.cellClassifier.destroy(); this.cacheIdentity.destroy(); this.geometry.destroy(); this.material.destroy(); this.lighting.destroy(); this.reconstruction.destroy(); this.diagnostics.destroy(); this.finalizeSettings.destroy(); }
}
