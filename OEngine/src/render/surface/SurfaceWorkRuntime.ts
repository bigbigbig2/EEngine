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
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";

export interface SurfaceWorkFrame {
  readonly generation: number;
  readonly arenaHeaderOffset: number;
  readonly directoryOffset: number;
}

export interface SurfaceWorkProducts extends SurfaceGeometryProducts, SurfaceMaterialProducts {
  readonly work: ResourceId;
  readonly sampleMap: ResourceId;
  readonly counts: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
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
  textureStore(sample_map, vec2i(pixel % settings.width, pixel / settings.width), vec4u(slot));
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
  let key = select(0xffffffffu, textureLoad(visibility, vec2i(sample_x, sample_y), 0).x, inside);
  keys[lane] = key;
  valid[lane] = select(0u, 1u, key != 0xffffffffu && inside);
  if inside { textureStore(sample_map, vec2i(px, py), vec4u(0xffffffffu)); }
  workgroupBarrier();
  if lane == 0u {
    var visible = 0u;
    var first = 0xffffffffu;
    var same = true;
    for (var i = 0u; i < 64u; i++) {
      if valid[i] != 0u {
        visible += 1u;
        if first == 0xffffffffu { first = keys[i]; }
        else if keys[i] != first { same = false; }
      }
    }
    uniform_key = first;
    tile_class = 0u;
    if visible != 0u { tile_class = select(2u, 1u, same); }
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
      write_sample(slot, (ty * 8u) * settings.width + tx * 8u, uniform_key, tile, lane);
      for (var i = 0u; i < 64u; i++) {
        let sx = tx * 8u + (i % 8u); let sy = ty * 8u + (i / 8u);
        if sx < settings.width && sy < settings.height {
          textureStore(sample_map, vec2i(sx, sy), vec4u(slot));
        }
      }
    } else {
      atomicOr(&overflow_lo, 1u);
    }
  }
  if tile_class == 2u && valid[lane] != 0u {
    let local_slot = atomicAdd(&tile_samples, 1u);
    let slot = atomicAdd(&counts[0], 1u);
    if slot < settings.sample_capacity {
      write_sample(slot, py * settings.width + px, key, tile, lane);
    } else if lane < 32u { atomicOr(&overflow_lo, 1u << lane); }
    else { atomicOr(&overflow_hi, 1u << (lane - 32u)); }
    if local_slot >= settings.sample_capacity { atomicOr(&counts[2], 1u); }
  }
  workgroupBarrier();
  if lane == 0u {
    let tile_at = settings.tile_offset + tile * 12u;
    work[tile_at + 8u] = atomicLoad(&tile_samples);
    let lo = atomicLoad(&overflow_lo); let hi = atomicLoad(&overflow_hi);
    if lo != 0u || hi != 0u {
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
  private readonly geometry: SurfaceGeometryPass;
  private readonly material: SurfaceMaterialCachePass;
  private readonly lighting: SurfaceLightingWorkPass;
  private readonly reconstruction: SurfaceReconstructionPass;
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly classifyPipeline: GPUComputePipeline;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly finalizePipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly finalizeSettings: GPUBuffer;
  private prepared = false;
  private destroyed = false;
  private layout: SurfaceWorkLayout | null = null;

  constructor(private readonly device: GPUDevice, private readonly budget: SurfaceWorkBudget = {
    maxTiles: 262144, maxSamples: 262144, maxExceptions: 65536, maxGeometryRecords: 262144, maxBytes: 128 * 1024 * 1024
  }) {
    this.geometry = new SurfaceGeometryPass(device);
    this.material = new SurfaceMaterialCachePass(device);
    this.lighting = new SurfaceLightingWorkPass(device);
    this.reconstruction = new SurfaceReconstructionPass(device);
    this.settings = device.createBuffer({ label: "SurfaceWork/classify settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.finalizeSettings = device.createBuffer({ label: "SurfaceWork/finalize settings", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.classifyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } }
    ] });
    this.classifyPipeline = device.createComputePipeline({ label: "SurfaceWork/classify", layout: device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] }),
      compute: { module: device.createShaderModule({ code: CLASSIFY_WGSL }), entryPoint: "classify" } });
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
    this.reconstruction.prepareFrame(width, height); this.prepared = true;
  }

  addToGraph(graph: FrameGraph, input: { visibility: ResourceId; arena: ResourceId; meshletWork: ResourceId;
    sourceHeap: ResourceId; vertexPayload: ResourceId; frameInstances: ResourceId; frameAttributes: ResourceId;
    camera: ResourceId; fieldVersions: ResourceId; residencyVersions: ResourceId; materialLookup: ResourceId; surfaceIdentity: ResourceId;
    textureBanks: readonly (readonly ResourceId[])[]; publication: GpuAppearancePublication;
    lightRecords: ResourceId; clusters: SurfaceLightingInput["clusters"];
    shadow: SurfaceLightingInput["shadow"]; scalarAo: ResourceId | null;
    environment: SurfaceLightingInput["environment"];
    factsMask: ResourceId; factsIdentity: ResourceId; preExposure: ResourceId; width: number; height: number;
    frame: SurfaceWorkFrame & { sourceGeometry: number; sourceMeshlet: number; sourceMeshletVertices: number;
      sourceMeshletTriangles: number; sourceVertexData: number } }): SurfaceWorkProducts {
    if (!this.layout) this.layout = surfaceWorkLayout(input.width, input.height, this.budget, this.device.limits);
    const layout = this.layout;
    let work!: ResourceId;
    let sampleMap!: ResourceId;
    let counts!: ResourceId;
    const classify = graph.add("SurfaceWork/classify implicit-uniform-mixed", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const header = new Uint32Array(16); writeSurfaceWorkHeader(header, layout, data.width, data.height, data.frame.generation);
      header[4] = 0; header[5] = 0; header[6] = 0;
      const tilesX = Math.ceil(data.width / 8);
      const tilesY = Math.ceil(data.height / 8);
      const tileCount = tilesX * tilesY;
      const exceptionStride = Math.max(1, Math.floor(layout.exceptionCapacity / Math.max(1, tileCount)));
      const settings = new Uint32Array([data.width, data.height, tilesX, tilesY,
        layout.tileOffset / 4, layout.sampleOffset / 4, layout.exceptionOffset / 4,
        data.frame.generation >>> 0, layout.tileCapacity, layout.sampleCapacity,
        layout.exceptionCapacity, exceptionStride]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      command.writeBuffer(resources.get(work) as GPUBuffer, 0, header.buffer, 0, header.byteLength);
      command.writeBuffer(resources.get(counts) as GPUBuffer, 0, new Uint32Array(16).buffer, 0, 64);
      const group = this.device.createBindGroup({ layout: this.classifyLayout, entries: [
        { binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: resolveTextureView(resources.get(data.visibility)) },
        { binding: 2, resource: { buffer: resources.get(work) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(counts) as GPUBuffer } },
        { binding: 4, resource: resolveTextureView(resources.get(sampleMap)) }
      ] });
      const pass = command.beginComputePass({ label: "SurfaceWork/classify" }); pass.setPipeline(this.classifyPipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(tileCount); pass.end();
    });
    classify.read(input.visibility);
    work = classify.create("SurfaceWork frame partitions", { kind: "transient_buffer", size: layout.geometryOffset,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" }); classify.write(work);
    counts = classify.create("SurfaceWork counters and indirect", { kind: "transient_buffer", size: SURFACE_WORK_COUNTER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" }); classify.write(counts);
    sampleMap = classify.create("SurfaceWork sample map", { kind: "transient_texture", width: input.width, height: input.height,
      format: "r32uint", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" }); classify.write(sampleMap);
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
    finalize.read(work); finalize.write(work); finalize.read(counts); finalize.write(counts);
    const recordCount = layout.sampleCapacity;
    const material = this.material.addLookupToGraph(graph, { visibility: input.visibility, work,
      meshletWork: input.meshletWork, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions,
      counts, materialLookup: input.materialLookup, surfaceIdentity: input.surfaceIdentity,
      programCount: input.publication.surfaceProgramCount, width: input.width, height: input.height,
      recordCount, sampleOffset: layout.sampleOffset, frame: input.frame.generation });
    const geometry = this.geometry.addToGraph(graph, { visibility: input.visibility, work, arena: input.arena,
      meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload,
      frameInstances: input.frameInstances, frameAttributes: input.frameAttributes, camera: input.camera,
      width: input.width,
      height: input.height, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4,
      sourceGeometry: input.frame.sourceGeometry, sourceMeshlet: input.frame.sourceMeshlet,
      sourceMeshletVertices: input.frame.sourceMeshletVertices, sourceMeshletTriangles: input.frame.sourceMeshletTriangles,
      sourceVertexData: input.frame.sourceVertexData, materialHitMask: material.hitMask,
      sampleOffset: layout.sampleOffset, geometryOffset: layout.geometryOffset, recordCount, geometryCapacity: layout.geometryCapacity, counts });
    this.material.addEvaluateToGraph(graph, { ...material, geometry: geometry.records, width: input.width, height: input.height,
      recordCount, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions, frame: input.frame.generation, counts,
      publication: input.publication, textureBanks: input.textureBanks, work, sampleOffset: layout.sampleOffset });
    const lighting = this.lighting.addToGraph(graph, { geometry: geometry.records, fields: material.fields,
      work, sampleOffset: layout.sampleOffset, width: input.width, height: input.height,
      recordCount, frame: input.frame.generation, counts, camera: input.camera,
      lightRecords: input.lightRecords, clusters: input.clusters, shadow: input.shadow,
      scalarAo: input.scalarAo, environment: input.environment });
    const reconstruction = this.reconstruction.addToGraph(graph, { diffuse: lighting.diffusePackets, specular: lighting.specularPackets,
      coat: lighting.coatPackets, ibl: lighting.iblPackets, reactive: input.factsMask,
      identity: input.factsIdentity, preExposure: input.preExposure, width: input.width, height: input.height, recordCount, sampleMap });
    return { work, counts, sampleMap, records: geometry.records, count: geometry.count, ...material, ...lighting, ...reconstruction };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("SurfaceWork commit without prepare");
    this.reconstruction.commit(gpuDone); this.prepared = false;
  }
  abort(): void { this.reconstruction.abort(); this.prepared = false; }
  invalidate(): void { this.reconstruction.invalidate(); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.geometry.destroy(); this.material.destroy(); this.lighting.destroy(); this.reconstruction.destroy(); this.settings.destroy(); this.finalizeSettings.destroy(); }
}
