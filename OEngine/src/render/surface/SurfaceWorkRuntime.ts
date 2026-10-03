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

export interface SurfaceWorkFrame {
  readonly generation: number;
  readonly arenaHeaderOffset: number;
  readonly directoryOffset: number;
}

export interface SurfaceSignalRevisions {
  readonly environment: number;
  readonly light: number;
  readonly shadow: number;
}

export interface SurfaceWorkProducts extends SurfaceGeometryProducts, SurfaceMaterialProducts {
  readonly work: ResourceId;
  readonly sampleMap: ResourceId;
  readonly counts: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly diagnostics?: ResourceId;
}

const CLASSIFY_WGSL = /* wgsl */ `
${SURFACE_WORK_HEADER_WGSL}
struct Settings {
  width: u32, height: u32, tiles_x: u32, tiles_y: u32,
  tile_offset: u32, sample_offset: u32, exception_offset: u32,
  generation: u32, tile_capacity: u32, sample_capacity: u32,
  exception_capacity: u32, exception_stride: u32
}
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read_write> work: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(4) var sample_map: texture_storage_2d<r32uint, write>;

var<workgroup> keys: array<u32, 64>;
var<workgroup> valid: array<u32, 64>;
var<workgroup> tile_class: u32;
var<workgroup> uniform_key: u32;
var<workgroup> uniform_lane: u32;
var<workgroup> tile_base:u32;
var<workgroup> lane_offset:array<u32,64>;
var<workgroup> tile_samples: atomic<u32>;
var<workgroup> overflow_lo: atomic<u32>;
var<workgroup> overflow_hi: atomic<u32>;

fn write_sample(slot: u32, pixel: u32, key: u32, tile: u32, lane: u32) {
  let at = settings.sample_offset + slot * 8u;
  work[at + 0u] = pixel;
  work[at + 1u] = key;
  work[at + 2u] = key;
  work[at + 3u] = 15u;
  work[at + 4u] = 0xffffffffu;
  work[at + 5u] = tile | (lane << 16u);
  work[at + 6u] = slot;
  work[at + 7u] = 1u;
  textureStore(sample_map, vec2i(i32(pixel % settings.width), i32(pixel / settings.width)), vec4u(pixel));
}

@compute @workgroup_size(64)
fn classify(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let tile = wg.x;
  let lane = lid.x;
  let tile_count = settings.tiles_x * settings.tiles_y;
  if tile >= tile_count || tile >= settings.tile_capacity { return; }
  if lane == 0u {
    atomicStore(&tile_samples, 0u);
    atomicStore(&overflow_lo, 0u);
    atomicStore(&overflow_hi, 0u);
  }
  workgroupBarrier();
  let tx = tile % settings.tiles_x;
  let ty = tile / settings.tiles_x;
  let px = tx * 8u + (lane % 8u);
  let py = ty * 8u + (lane / 8u);
  let inside = px < settings.width && py < settings.height;
  let sample_x = min(px, settings.width - 1u);
  let sample_y = min(py, settings.height - 1u);
  let key = select(0xffffffffu, textureLoad(visibility, vec2i(i32(sample_x), i32(sample_y)), 0).x, inside);
  keys[lane] = key;
  valid[lane] = select(0u, 1u, key != 0xffffffffu && inside);
  if inside { textureStore(sample_map, vec2i(i32(px), i32(py)), vec4u(0xffffffffu)); }
  workgroupBarrier();
  if lane == 0u {
    var visible = 0u;
    var first = 0xffffffffu;
    var same = true;
    for (var i = 0u; i < 64u; i++) {
      if valid[i] != 0u {
        visible += 1u;
        if first == 0xffffffffu { first = keys[i]; uniform_lane = i; }
        else if keys[i] != first { same = false; }
      }
    }
    var prefix=0u;
    for(var i=0u;i<64u;i++){lane_offset[i]=prefix;prefix+=valid[i];}
    uniform_key = first;
    tile_class = 0u;
    if visible != 0u { tile_class = select(2u, 1u, same); }
    if tile_class==2u {tile_base=atomicAdd(&counts[0],visible);}
    let tile_at = settings.tile_offset + tile * 12u;
    let origin_x = tx * 8u;
    let origin_y = ty * 8u;
    let tile_w = min(8u, settings.width - origin_x);
    let tile_h = min(8u, settings.height - origin_y);
    work[tile_at + 0u] = origin_x | (tile_w << 16u);
    work[tile_at + 1u] = origin_y | (tile_h << 16u);
    work[tile_at + 2u] = tile_class | (visible << 8u);
    work[tile_at + 3u] = 1u;
    work[tile_at + 4u] = 1u;
    work[tile_at + 5u] = 1u;
    work[tile_at + 6u] = 1u;
    work[tile_at + 7u] = tile * settings.exception_stride;
    work[tile_at + 8u] = 0u;
    work[tile_at + 9u] = tile;
    work[tile_at + 10u] = 0u;
    work[tile_at + 11u] = 0u;
    atomicAdd(&counts[3], visible);
    if tile_class == 0u { atomicAdd(&counts[4], 1u); }
    else if tile_class == 1u { atomicAdd(&counts[5], 1u); }
    else { atomicAdd(&counts[6], 1u); }
  }
  workgroupBarrier();
  if tile_class == 1u && lane == 0u && uniform_key != 0xffffffffu {
    atomicStore(&tile_samples, 1u);
    let slot = atomicAdd(&counts[0], 1u);
    if slot < settings.sample_capacity {
      // A partially covered uniform tile can have background at its origin.
      // Geometry must resolve a covered representative and publish only covered pixels.
      let representative=(ty*8u+uniform_lane/8u)*settings.width+tx*8u+uniform_lane%8u;
      write_sample(slot, representative, uniform_key, tile, uniform_lane);
      for (var i = 0u; i < 64u; i++) {
        let sx = tx * 8u + (i % 8u); let sy = ty * 8u + (i / 8u);
        if sx < settings.width && sy < settings.height && valid[i] != 0u {
          textureStore(sample_map, vec2i(i32(sx), i32(sy)), vec4u(representative));
        }
      }
    } else {
      atomicAdd(&counts[14], 1u);
      atomicOr(&overflow_lo, 1u);
    }
  }
  if tile_class == 2u && valid[lane] != 0u {
    atomicAdd(&tile_samples, 1u);
    let slot = tile_base+lane_offset[lane];
    if slot < settings.sample_capacity {
      write_sample(slot, py * settings.width + px, key, tile, lane);
    } else if lane < 32u { atomicAdd(&counts[14], 1u); atomicOr(&overflow_lo, 1u << lane); }
    else { atomicAdd(&counts[14], 1u); atomicOr(&overflow_hi, 1u << (lane - 32u)); }
  }
  workgroupBarrier();
  if lane == 0u {
    let tile_at = settings.tile_offset + tile * 12u;
    work[tile_at + 8u] = atomicLoad(&tile_samples);
    let lo = atomicLoad(&overflow_lo); let hi = atomicLoad(&overflow_hi);
    if lo != 0u || hi != 0u {
      atomicAdd(&counts[13], 1u);
      atomicOr(&counts[2], 2u);
      if settings.exception_stride > 0u && tile * settings.exception_stride < settings.exception_capacity {
        let e = settings.exception_offset + tile * settings.exception_stride * 4u;
        work[e + 0u] = lo; work[e + 1u] = 1u; work[e + 2u] = 15u; work[e + 3u] = 1u;
        if settings.exception_stride > 1u {
          work[e + 4u] = hi; work[e + 5u] = 1u; work[e + 6u] = 15u; work[e + 7u] = 1u;
          atomicAdd(&counts[1], 2u);
        } else { atomicAdd(&counts[1], 1u); }
      }
    }
  }
}
`;

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
  }, accounting?: ResourceAccounting) {
    this.scratch = new SurfaceFrameResources(device, accounting);
    this.cellClassifier = new SurfaceCellClassifierPass(device, this.scratch);
    this.cacheIdentity = new SurfaceCacheIdentityPass(device,this.scratch);
    this.dependencyEpoch = new SurfaceDependencyEpochPass(device,this.scratch);
    this.geometry = new SurfaceGeometryPass(device, this.scratch);
    this.material = new SurfaceMaterialCachePass(device, this.scratch);
    this.lighting = new SurfaceLightingWorkPass(device, this.scratch);
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
      sampleOffset:layout.sampleOffset,capacity:recordCount,pixelCount:input.width*input.height,
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
    const lighting = this.lighting.addToGraph(graph, { geometryKeys:witness.keys,revisions:input.revisions,diagnosticFrame:input.diagnosticFrame,resourceBinding: input.historyBinding, geometry: geometry.records, fields: evaluatedMaterial.fields,
      work, sampleOffset: layout.sampleOffset, geometryOffset: 0, width: input.width, height: input.height,
      recordCount, frame: input.frame.generation, counts, camera: input.camera,
      lightRecords: input.lightRecords, clusters: input.clusters, shadow: input.shadow,
      scalarAo: input.scalarAo, environment: input.environment, physicalSun: input.physicalSun,
      diagnosticsEnabled: this.diagnosticsMode === "detailed" && this.diagnosticsCapture !== null });
    const reconstruction = this.reconstruction.addToGraph(graph, { diffuse: lighting.diffusePackets, specular: lighting.specularPackets,
      coat: lighting.coatPackets, ibl: lighting.iblPackets, reactive: input.factsMask,
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
