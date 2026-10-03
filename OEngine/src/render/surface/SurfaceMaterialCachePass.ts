import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../../gpu/GpuShadingMaterialAbi.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { SURFACE_FIELD_STORE_COMPUTE_WGSL, SURFACE_FIELD_STORE_ENTRY_BYTES } from "../../gpu/GpuSurfaceFieldStoreAbi.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
export interface SurfaceMaterialProducts {
    readonly work: ResourceId;
    readonly fields: ResourceId;
    readonly missQueue: ResourceId;
    readonly orderedMissQueue: ResourceId;
    readonly hitMask: ResourceId;
    readonly counters: ResourceId;
    readonly audit: ResourceId;
    readonly cacheKeys: ResourceId;
    readonly cacheValues: ResourceId;
    readonly geometryKeys: ResourceId;
    readonly dependencyEpoch: ResourceId;
    readonly fieldStore: ResourceId;
}
const CACHE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
struct Settings { width:u32, height:u32, record_count:u32, cache_capacity:u32, frame:u32, sample_offset:u32, program_count:u32, diagnostics_enabled:u32, view_revision:u32, nonlocal_revision:u32, field_store_entry_count:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var visibility:texture_2d<u32>;
@group(0) @binding(2) var<storage,read_write> work:array<u32>;
@group(0) @binding(3) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage,read> field_versions:array<u32>;
@group(0) @binding(5) var<storage,read> residency_epoch:array<u32>;
@group(0) @binding(6) var<storage,read> cache:array<u32>;
@group(0) @binding(7) var<storage,read> cache_values:array<vec2u>;
@group(0) @binding(8) var<storage,read_write> misses:array<vec2u>;
@group(0) @binding(9) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> hit_mask:array<u32>;
@group(0) @binding(12) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(13) var<storage,read> material_lookup:array<u32>;
@group(0) @binding(14) var<storage,read> surface_identity:array<u32>;
@group(0) @binding(15) var<storage,read> materials:array<OEngineShadingMaterialRecord>;
@group(0) @binding(16) var<storage,read> geometry_keys:array<u32>;
@group(0) @binding(17) var<storage,read_write> field_store_entries:array<atomic<u32>>;
fn diagnostic_add(index:u32,value:u32){if settings.diagnostics_enabled!=0u{atomicAdd(&counters[index],value);}}
fn field_store_hit(key_at:u32)->bool {
 if settings.field_store_entry_count<4u{return false;}
 let set_count=settings.field_store_entry_count/4u;
 var hash=2166136261u;
 for(var word=0u;word<12u;word++){hash=(hash^cache[key_at+word])*16777619u;}
 let set_index=hash%set_count;
 for(var way=0u;way<4u;way++){
  let entry=(set_index*4u+way);let at=entry*24u;
  if atomicLoad(&field_store_entries[at])==0xffffffffu{continue;}
  var equal=true;
  for(var word=0u;word<12u;word++){if atomicLoad(&field_store_entries[at+word])!=cache[key_at+word]{equal=false;break;}}
  if equal{return true;}
 }
 return false;
}
@compute @workgroup_size(64) fn lookup(@builtin(global_invocation_id) id:vec3u){
 let record=id.x;if record>=settings.record_count || record>=surface_counts[0u]{return;}
 let at=settings.sample_offset/4u+record*8u;
 let decoded=oengine_visibility_key_resolve(work[at+1u],meshlet_work.header.generation,meshlet_work.header.written_count);
 hit_mask[record]=0u;
 if decoded.valid==0u{diagnostic_add(3u,1u);return;}
 let meshlet=meshlet_work.elements[decoded.meshlet_work_slot];let material=meshlet.material_slot_or_range;
 if material>=arrayLength(&material_lookup) || material>=arrayLength(&materials){diagnostic_add(3u,1u);return;}
 let entry=material_lookup[material];let publication=entry*20u;
 if entry==0xffffffffu || publication+19u>=arrayLength(&surface_identity){diagnostic_add(3u,1u);return;}
 let pixel=work[at];let cached=record*19u;let material_record=materials[material];
 let same=cache[cached]==surface_identity[publication+3u] && cache[cached+1u]==material && field_store_hit(cached);
 let same_geometry=cache[cached+2u]==geometry_keys[record*13u+12u] && (work[at+7u]&4u)!=0u;
 let same_texture=cache[cached+3u]==residency_epoch[0] && residency_epoch[0]!=0xffffffffu;
 // Replacing a publication also clears fields absent from its new program.
 var missing=select(0x7fffu,0u,same);
 for(var field=0u;field<15u;field++){
  let field_index=surface_identity[publication+4u+field];
  if field_index==0xffffffffu{continue;}
  let field_at=(surface_identity[publication+1u]+field_index)*4u;
  let dependency=field_versions[field_at+3u];
  if !same || cache[cached+4u+field]!=field_versions[field_at] ||
     ((dependency&21u)!=0u && !same_geometry) || ((dependency&2u)!=0u && !same_texture) || (dependency&40u)!=0u {
   missing|=1u<<field;
  }
 }
 // Six independent signal bits: Ddirect, Denv, Sdirect, Senv, Cdirect, Cenv.
 // The compact lighting pass can then hit or miss each lobe independently.
 var signals=1u|2u|4u|8u;
 if material_record.family==2u || (material_record.feature_mask&((1u<<7u)|(1u<<8u)|(1u<<9u)))!=0u{signals|=16u|32u;}
 work[at+3u]=signals;work[at+4u]=missing;
 work[at+7u]|=select(0u,2u,(material_record.feature_mask&((1u<<1u)|(1u<<2u)|(1u<<5u)|(1u<<6u)))!=0u);
 if missing==0u{
  hit_mask[record]=1u;diagnostic_add(0u,1u);
  // The Surface-owned fields texture persists with this exact cache cell.
  // Its last publication is already present; a hit performs no field writes.
 }else{
  let program=surface_identity[publication];if program>=settings.program_count{diagnostic_add(3u,1u);return;}
  diagnostic_add(1u,1u);let slot=atomicAdd(&counters[2],1u);
  if slot<settings.record_count{misses[slot]=vec2u(record,program);atomicAdd(&counters[4u+program*8u+4u],1u);}
 }
}
`;
const FINALIZE_WGSL = /* wgsl */ `
struct Settings { program_count:u32, record_count:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read_write> compact_indirect:array<atomic<u32>>;
@compute @workgroup_size(1)
fn finalize(){
  var prefix=0u;
  for(var program=0u;program<settings.program_count;program++){
    let count=min(atomicLoad(&counters[4u+program*8u+4u]),settings.record_count);
    let at=4u+program*8u;
    atomicStore(&counters[at],(count+63u)/64u); atomicStore(&counters[at+1u],1u); atomicStore(&counters[at+2u],1u); atomicStore(&counters[at+3u],count);
    atomicStore(&counters[at+5u],prefix); atomicStore(&counters[at+6u],0u); atomicStore(&counters[at+7u],(count+63u)/64u);
    prefix+=count;
  }
  let queued=min(atomicLoad(&counters[2u]),settings.record_count);
  atomicStore(&compact_indirect[0],(queued+63u)/64u); atomicStore(&compact_indirect[1],1u); atomicStore(&compact_indirect[2],1u); atomicStore(&compact_indirect[3],queued);
}
`;
const COMPACT_WGSL = /* wgsl */ `
struct Settings { program_count:u32, record_count:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> source:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> ordered:array<vec2u>;
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id:vec3u){
  let slot=id.x; let queued=min(atomicLoad(&counters[2u]),settings.record_count);
  if slot>=queued{return;}
  let pair=source[slot]; let program=pair.y;
  if program>=settings.program_count{return;}
  let at=4u+program*8u; let dst=atomicAdd(&counters[at+6u],1u); let count=atomicLoad(&counters[at+4u]);
  if dst<count { ordered[atomicLoad(&counters[at+5u])+dst]=pair; }
}
`;

const FIELD_STORE_PACK_WGSL = /* wgsl */ `
struct Settings { request_count:u32, cache_stride:u32, request_stride:u32, reserved:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> cache:array<u32>;
@group(0) @binding(2) var<storage,read_write> requests:array<u32>;
@group(0) @binding(3) var<storage,read> cache_values:array<u32>;
@compute @workgroup_size(64)
fn pack_field_store_requests(@builtin(global_invocation_id) id:vec3u){
  let record=id.x;if(record>=settings.request_count){return;}
  let source=record*settings.cache_stride;let target=record*settings.request_stride;
  for(var word=0u;word<12u;word++){requests[target+word]=cache[source+word];}
  for(var word=0u;word<4u;word++){requests[target+12u+word]=cache_values[record*12u+word];}
}
`;
export class SurfaceMaterialCachePass {
    private readonly lookupLayout: GPUBindGroupLayout;
    private readonly lookupPipeline: GPUComputePipeline;
    private readonly finalizeLayout: GPUBindGroupLayout;
    private readonly finalizePipeline: GPUComputePipeline;
    private readonly compactLayout: GPUBindGroupLayout;
    private readonly compactPipeline: GPUComputePipeline;
    private readonly fieldStorePackPipeline: GPUComputePipeline;
    private readonly fieldStoreResetPipeline: GPUComputePipeline;
    private readonly fieldStoreLookupPipeline: GPUComputePipeline;
    private readonly fieldStorePublishPipeline: GPUComputePipeline;
    private readonly settings: GPUBuffer;
    private readonly finalizeSettings: GPUBuffer;
    private readonly fieldStoreSettings: GPUBuffer;
    private fieldStoreInitialized = false;
    constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources,
        private readonly fieldStore: GpuSurfaceFieldStore | null = null) {
        this.settings = device.createBuffer({ label: "Surface material lookup settings", size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.finalizeSettings = device.createBuffer({ label: "Surface material miss finalize settings", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.lookupLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } }, ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: (binding === 3 || binding === 4 || binding === 5 || binding === 6 || binding === 7 || binding === 16 || binding === 12 || binding === 13 || binding === 14 || binding === 15 ? "read-only-storage" : "storage") as GPUBufferBindingType } })), { binding: 17, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
        this.lookupPipeline = device.createComputePipeline({ label: "Surface/material publication lookup", layout: device.createPipelineLayout({ bindGroupLayouts: [this.lookupLayout] }), compute: { module: device.createShaderModule({ code: CACHE_WGSL }), entryPoint: "lookup" } });
        this.finalizeLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
        this.finalizePipeline = device.createComputePipeline({ label: "Surface/material miss indirect finalize", layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }), compute: { module: device.createShaderModule({ code: FINALIZE_WGSL }), entryPoint: "finalize" } });
        this.compactLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }, { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
        this.compactPipeline = device.createComputePipeline({ label: "Surface/material miss queue compact", layout: device.createPipelineLayout({ bindGroupLayouts: [this.compactLayout] }), compute: { module: device.createShaderModule({ code: COMPACT_WGSL }), entryPoint: "compact" } });
        this.fieldStoreSettings = device.createBuffer({ label: "Surface/FieldStore settings", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.fieldStorePackPipeline = device.createComputePipeline({ label: "Surface/FieldStore request pack", layout: "auto", compute: { module: device.createShaderModule({ label: "Surface/FieldStore request pack", code: FIELD_STORE_PACK_WGSL }), entryPoint: "pack_field_store_requests" } });
        const fieldStoreModule = device.createShaderModule({ label: "Surface/FieldStore lookup and publish", code: SURFACE_FIELD_STORE_COMPUTE_WGSL });
        this.fieldStoreResetPipeline = device.createComputePipeline({ label: "Surface/FieldStore reset", layout: "auto", compute: { module: fieldStoreModule, entryPoint: "surface_field_store_reset" } });
        this.fieldStoreLookupPipeline = device.createComputePipeline({ label: "Surface/FieldStore lookup", layout: "auto", compute: { module: fieldStoreModule, entryPoint: "surface_field_store_lookup" } });
        this.fieldStorePublishPipeline = device.createComputePipeline({ label: "Surface/FieldStore publish", layout: "auto", compute: { module: fieldStoreModule, entryPoint: "surface_field_store_publish" } });
    }
    addLookupToGraph(graph: FrameGraph, input: {
        geometryKeys: ResourceId;
        dependencyEpoch: ResourceId;
        resourceBinding: SurfaceResourceBinding;
        visibility: ResourceId;
        work: ResourceId;
        meshletWork: ResourceId;
        fieldVersions: ResourceId;
        residencyVersions: ResourceId;
        counts: ResourceId;
        materialLookup: ResourceId;
        surfaceIdentity: ResourceId;
        materials: ResourceId;
        programCount: number;
        width: number;
        height: number;
        recordCount: number;
        sampleOffset: number;
        frame: number;
        diagnosticsEnabled: boolean;
        viewRevision: Readonly<{
            value: number;
        }>;
        nonlocalRevision: Readonly<{
            value: number;
        }>;
    }): SurfaceMaterialProducts {
        let cacheKeys = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/compact field keys", Math.max(4, input.recordCount * 19 * 4), GPUBufferUsage.STORAGE);
        let cacheValues = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/compact field values", Math.max(16, input.recordCount * 48), GPUBufferUsage.STORAGE);
        const fieldStoreBuffer = this.fieldStore === null
            ? this.scratch.importBuffer(graph, input.resourceBinding, "Surface/FieldStore disabled entries", 96, GPUBufferUsage.STORAGE)
            : graph.import_resource("Surface/FieldStore entries", { kind: "imported", label: "Surface/FieldStore entries", domain: "internal-full" }, input.resourceBinding("surface-field-store", () => this.fieldStore!.buffer));
        let fields!: ResourceId, missQueue!: ResourceId, orderedMissQueue!: ResourceId, hitMask!: ResourceId, counters!: ResourceId, audit!: ResourceId, finalizedCounters!: ResourceId, compactedCounters!: ResourceId, compactIndirect!: ResourceId, lookupIndirect!: ResourceId;
        const node = graph.add("Surface/Material publication lookup before geometry", input, (data, resources, context) => { const command = context.encoder as ShadeGPUCommandContext; const settings = new Uint32Array([data.width, data.height, data.recordCount, data.recordCount, data.frame, data.sampleOffset, data.programCount, data.diagnosticsEnabled ? 1 : 0, data.viewRevision.value >>> 0, data.nonlocalRevision.value >>> 0, this.fieldStore === null ? 0 : this.fieldStore.capacity.segmentBytes[0]! / SURFACE_FIELD_STORE_ENTRY_BYTES, 0]); command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength); command.writeBuffer(resources.get(counters) as GPUBuffer, 0, new Uint32Array(4 + data.programCount * 8).buffer, 0, (4 + data.programCount * 8) * 4); command.writeBuffer(resources.get(audit) as GPUBuffer, 0, new Uint32Array(4).buffer, 0, 16); command.gpu_encoder.copyBufferToBuffer(resources.get(data.counts) as GPUBuffer, SURFACE_WORK_INDIRECT_OFFSET, resources.get(lookupIndirect) as GPUBuffer, 0, 16); const group = this.device.createBindGroup({ layout: this.lookupLayout, entries: [{ binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: resolveTextureView(resources.get(data.visibility)) }, { binding: 2, resource: { buffer: resources.get(data.work) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(data.meshletWork) as GPUBuffer } }, { binding: 4, resource: { buffer: resources.get(data.fieldVersions) as GPUBuffer } }, { binding: 5, resource: { buffer: resources.get(data.dependencyEpoch) as GPUBuffer } }, { binding: 6, resource: { buffer: resources.get(cacheKeys) as GPUBuffer } }, { binding: 7, resource: { buffer: resources.get(cacheValues) as GPUBuffer } }, { binding: 8, resource: { buffer: resources.get(missQueue) as GPUBuffer } }, { binding: 9, resource: { buffer: resources.get(counters) as GPUBuffer } }, { binding: 10, resource: { buffer: resources.get(hitMask) as GPUBuffer } }, { binding: 12, resource: { buffer: resources.get(data.counts) as GPUBuffer } }, { binding: 13, resource: { buffer: resources.get(data.materialLookup) as GPUBuffer } }, { binding: 14, resource: { buffer: resources.get(data.surfaceIdentity) as GPUBuffer } }, { binding: 15, resource: { buffer: resources.get(data.materials) as GPUBuffer } }, { binding: 16, resource: { buffer: resources.get(data.geometryKeys) as GPUBuffer } }, { binding: 17, resource: { buffer: resources.get(fieldStoreBuffer) as GPUBuffer } }] }); const pass = command.beginComputePass({ label: "Surface/material publication lookup" }); pass.setPipeline(this.lookupPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroupsIndirect(resources.get(lookupIndirect) as GPUBuffer, 0); pass.end(); });
        for (const id of [input.geometryKeys, input.dependencyEpoch, cacheKeys, cacheValues, input.visibility, input.work, input.meshletWork, input.fieldVersions, input.residencyVersions, input.counts, input.materialLookup, input.surfaceIdentity, input.materials])
            node.read(id);
        node.read(fieldStoreBuffer);
        lookupIndirect = node.create("Surface/material lookup indirect", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, domain: "internal-full" });
        node.write(lookupIndirect);
        const lookupCacheValues = cacheValues;
        fields = cacheValues;
        missQueue = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/material bounded miss queue", Math.max(8, input.recordCount * 8), GPUBufferUsage.STORAGE);
        hitMask = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/material hit mask", Math.max(4, input.recordCount * 4), GPUBufferUsage.STORAGE);
        counters = node.create("Surface/material counters and indirect", { kind: "transient_buffer", size: (4 + input.programCount * 8) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
        audit = node.create("Surface/material evaluator audit", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
        const work = node.write(input.work);
        missQueue = node.write(missQueue);
        if (this.fieldStore !== null) {
            const requestCount = Math.max(1, input.recordCount);
            let requests!: ResourceId, results!: ResourceId, storeCounters!: ResourceId;
            const storeEntries = this.fieldStore.capacity.segmentBytes[0]! / 4;
            let initialization: ReturnType<typeof graph.add> | null = null;
            if (!this.fieldStoreInitialized) {
                initialization = graph.add("Surface/FieldStore initialize", { fieldStoreBuffer, storeEntries }, (data, resources, context) => {
                    const command = context.encoder as ShadeGPUCommandContext;
                    command.writeBuffer(this.fieldStoreSettings, 0, new Uint32Array([0, data.storeEntries / 24, 1, 0]).buffer, 0, 16);
                    const group = this.device.createBindGroup({ layout: this.fieldStoreResetPipeline.getBindGroupLayout(0), entries: [
                        { binding: 0, resource: { buffer: this.fieldStoreSettings } },
                        { binding: 2, resource: { buffer: resources.get(data.fieldStoreBuffer) as GPUBuffer } }
                    ] });
                    const pass = command.beginComputePass({ label: "Surface/FieldStore initialize" }); pass.setPipeline(this.fieldStoreResetPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(data.storeEntries / 24 / 64)); pass.end();
                    command.onFinished.addOne(() => { this.fieldStoreInitialized = true; });
                    command.onAborted?.addOne(() => { this.fieldStoreInitialized = false; });
                });
                initialization.read(fieldStoreBuffer); initialization.write(fieldStoreBuffer); node.dependsOn(initialization);
            }
            const pack = graph.add("Surface/FieldStore request pack", { cacheKeys, cacheValues: lookupCacheValues, requestCount }, (data, resources, context) => {
                const command = context.encoder as ShadeGPUCommandContext;
                command.writeBuffer(this.fieldStoreSettings, 0, new Uint32Array([data.requestCount, 19, 16, 0]).buffer, 0, 16);
                command.gpu_encoder.clearBuffer(resources.get(storeCounters) as GPUBuffer, 0, 32);
                const group = this.device.createBindGroup({ layout: this.fieldStorePackPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: this.fieldStoreSettings } },
                    { binding: 1, resource: { buffer: resources.get(data.cacheKeys) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(requests) as GPUBuffer } },
                    { binding: 3, resource: { buffer: resources.get(data.cacheValues) as GPUBuffer } }
                ] });
                const pass = command.beginComputePass({ label: "Surface/FieldStore request pack" }); pass.setPipeline(this.fieldStorePackPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); pass.end();
            });
            requests = pack.create("Surface/FieldStore requests", { kind: "transient_buffer", size: requestCount * 16 * 4, usage: GPUBufferUsage.STORAGE });
            results = pack.create("Surface/FieldStore lookup results", { kind: "transient_buffer", size: requestCount * 2 * 4, usage: GPUBufferUsage.STORAGE });
            storeCounters = pack.create("Surface/FieldStore counters", { kind: "transient_buffer", size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            pack.read(cacheKeys); pack.read(lookupCacheValues); pack.write(requests); pack.write(results); pack.write(storeCounters); if (initialization !== null) pack.dependsOn(initialization);
            const storeNode = graph.add("Surface/FieldStore lookup", { requests, results, storeCounters, fieldStoreBuffer, requestCount, storeEntries }, (data, resources, context) => {
                const command = context.encoder as ShadeGPUCommandContext;
                command.writeBuffer(this.fieldStoreSettings, 0, new Uint32Array([data.requestCount, data.storeEntries / 24, this.fieldStore!.stats().generation, 0]).buffer, 0, 16);
                const group = this.device.createBindGroup({ layout: this.fieldStoreLookupPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: this.fieldStoreSettings } }, { binding: 1, resource: { buffer: resources.get(data.requests) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(data.fieldStoreBuffer) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(data.results) as GPUBuffer } },
                    { binding: 4, resource: { buffer: resources.get(data.storeCounters) as GPUBuffer } }
                ] });
                const pass = command.beginComputePass({ label: "Surface/FieldStore lookup" }); pass.setPipeline(this.fieldStoreLookupPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); pass.end();
            });
            storeNode.read(requests); storeNode.read(fieldStoreBuffer); storeNode.write(results); storeNode.write(storeCounters); storeNode.dependsOn(pack);
            node.dependsOn(storeNode);
        }
        hitMask = node.write(hitMask);
        const finalize = graph.add("Surface/Material miss indirect finalize", { counters, programCount: input.programCount, recordCount: input.recordCount }, (data, resources, context) => { const command = context.encoder as ShadeGPUCommandContext; command.writeBuffer(this.finalizeSettings, 0, new Uint32Array([data.programCount, data.recordCount, 0, 0]).buffer, 0, 16); const group = this.device.createBindGroup({ layout: this.finalizeLayout, entries: [{ binding: 0, resource: { buffer: this.finalizeSettings } }, { binding: 1, resource: { buffer: resources.get(data.counters) as GPUBuffer } }, { binding: 2, resource: { buffer: resources.get(compactIndirect) as GPUBuffer } }] }); const pass = command.beginComputePass({ label: "Surface/material miss indirect finalize" }); pass.setPipeline(this.finalizePipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end(); });
        finalize.read(counters);
        finalizedCounters = finalize.write(counters);
        compactIndirect = finalize.create("Surface/material compact indirect", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, domain: "internal-full" });
        const compact = graph.add("Surface/Material miss queue compact", { counters: finalizedCounters, missQueue, compactIndirect, recordCount: input.recordCount }, (data, resources, context) => { const command = context.encoder as ShadeGPUCommandContext; const group = this.device.createBindGroup({ layout: this.compactLayout, entries: [{ binding: 0, resource: { buffer: this.finalizeSettings } }, { binding: 1, resource: { buffer: resources.get(data.missQueue) as GPUBuffer } }, { binding: 2, resource: { buffer: resources.get(data.counters) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(orderedMissQueue) as GPUBuffer } }] }); const pass = command.beginComputePass({ label: "Surface/material miss queue compact" }); pass.setPipeline(this.compactPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroupsIndirect(resources.get(data.compactIndirect) as GPUBuffer, 0); pass.end(); });
        compact.dependsOn(finalize);
        compact.read(missQueue);
        compact.read(finalizedCounters);
        compact.read(compactIndirect);
        orderedMissQueue = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/material ordered miss queue", Math.max(8, input.recordCount * 8), GPUBufferUsage.STORAGE);
        orderedMissQueue = compact.write(orderedMissQueue);
        compactedCounters = compact.write(finalizedCounters);
        return { work, fields, missQueue, orderedMissQueue, hitMask, counters: compactedCounters, audit, cacheKeys, cacheValues: fields, geometryKeys: input.geometryKeys, dependencyEpoch: input.dependencyEpoch, fieldStore: fieldStoreBuffer };
    }
    addEvaluateToGraph(graph: FrameGraph, input: SurfaceMaterialProducts & {
        geometry: ResourceId;
        geometryOffset: number;
        work: ResourceId;
        sampleOffset: number;
        fieldVersions: ResourceId;
        residencyVersions: ResourceId;
        counts: ResourceId;
        publication: GpuAppearancePublication;
        textureBanks: readonly (readonly ResourceId[])[];
        width: number;
        height: number;
        recordCount: number;
        frame: number;
        diagnosticsEnabled: boolean;
        viewRevision: Readonly<{
            value: number;
        }>;
        nonlocalRevision: Readonly<{
            value: number;
        }>;
    }): SurfaceMaterialProducts {
        const node = graph.add("Surface/Material miss publication evaluation", input, (data, resources, context) => { const command = context.encoder as ShadeGPUCommandContext; const textureBanks = data.textureBanks.map(set => set.map(id => resources.get(id) as GPUTextureView)); data.publication.encodeSurfaceMissEvaluation(command, { geometry: resources.get(data.geometry) as GPUBuffer, work: resources.get(data.work) as GPUBuffer, misses: resources.get(data.orderedMissQueue) as GPUBuffer, hitMask: resources.get(data.hitMask) as GPUBuffer, counters: resources.get(data.counters) as GPUBuffer, cache: resources.get(data.cacheKeys) as GPUBuffer, cacheValues: resources.get(data.cacheValues) as GPUBuffer, geometryKeys: resources.get(data.geometryKeys) as GPUBuffer, audit: resources.get(data.audit) as GPUBuffer, diagnosticsEnabled: data.diagnosticsEnabled, viewRevision: data.viewRevision.value, nonlocalRevision: data.nonlocalRevision.value, indirect: resources.get(data.counters) as GPUBuffer, fieldVersions: resources.get(data.fieldVersions) as GPUBuffer, residencyVersions: resources.get(data.dependencyEpoch) as GPUBuffer, width: data.width, height: data.height, recordCount: data.recordCount, geometryOffset: data.geometryOffset, cacheCapacity: data.recordCount, sampleOffset: data.sampleOffset, textureBanks }); });
        for (const id of [input.cacheKeys, input.cacheValues, input.geometryKeys, input.dependencyEpoch, input.geometry, input.work, input.orderedMissQueue, input.hitMask, input.counters, input.fields, input.audit, input.fieldVersions, input.residencyVersions])
            node.read(id);
        const fields = node.write(input.fields);
        const audit = node.write(input.audit);
        const cacheKeys = node.write(input.cacheKeys), cacheValues = fields;
        if (this.fieldStore !== null) {
            const requestCount = Math.max(1, input.recordCount);
            const storeEntries = this.fieldStore.capacity.segmentBytes[0]! / 4;
            let requests!: ResourceId, storeCounters!: ResourceId;
            const admit = graph.add("Surface/FieldStore publish after evaluation", { cacheKeys, cacheValues, fieldStore: input.fieldStore, requestCount, storeEntries }, (data, resources, context) => {
                const command = context.encoder as ShadeGPUCommandContext;
                command.writeBuffer(this.fieldStoreSettings, 0, new Uint32Array([data.requestCount, 19, 16, 0]).buffer, 0, 16);
                command.gpu_encoder.clearBuffer(resources.get(storeCounters) as GPUBuffer, 0, 32);
                const packGroup = this.device.createBindGroup({ layout: this.fieldStorePackPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: this.fieldStoreSettings } },
                    { binding: 1, resource: { buffer: resources.get(data.cacheKeys) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(requests) as GPUBuffer } },
                    { binding: 3, resource: { buffer: resources.get(data.cacheValues) as GPUBuffer } }
                ] });
                const packPass = command.beginComputePass({ label: "Surface/FieldStore request pack after evaluation" });
                packPass.setPipeline(this.fieldStorePackPipeline); packPass.setBindGroup(0, packGroup); packPass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); packPass.end();
                command.writeBuffer(this.fieldStoreSettings, 0, new Uint32Array([data.requestCount, data.storeEntries / 24, this.fieldStore!.stats().generation, 0]).buffer, 0, 16);
                const publishGroup = this.device.createBindGroup({ layout: this.fieldStorePublishPipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: this.fieldStoreSettings } },
                    { binding: 1, resource: { buffer: resources.get(requests) as GPUBuffer } },
                    { binding: 2, resource: { buffer: resources.get(data.fieldStore) as GPUBuffer } },
                    { binding: 4, resource: { buffer: resources.get(storeCounters) as GPUBuffer } }
                ] });
                const publishPass = command.beginComputePass({ label: "Surface/FieldStore publish after evaluation" });
                publishPass.setPipeline(this.fieldStorePublishPipeline); publishPass.setBindGroup(0, publishGroup); publishPass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); publishPass.end();
            });
            requests = admit.create("Surface/FieldStore evaluation requests", { kind: "transient_buffer", size: requestCount * 16 * 4, usage: GPUBufferUsage.STORAGE });
            storeCounters = admit.create("Surface/FieldStore evaluation counters", { kind: "transient_buffer", size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            admit.read(cacheKeys); admit.read(cacheValues); admit.read(input.fieldStore); admit.write(requests); admit.write(storeCounters); admit.write(input.fieldStore); admit.dependsOn(node); admit.make_side_effect();
        }
        return { ...input, fields, audit, cacheKeys, cacheValues };
    }
    destroy(): void { this.fieldStoreInitialized = false; this.settings.destroy(); this.finalizeSettings.destroy(); this.fieldStoreSettings.destroy(); }
}
