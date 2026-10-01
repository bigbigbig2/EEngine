import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { APPEARANCE_SURFACE_LAYER_COUNT } from "../../gpu/GpuAppearanceCacheAbi.js";

export interface SurfaceMaterialProducts {
  readonly fields: ResourceId;
  readonly missQueue: ResourceId;
  readonly hitMask: ResourceId;
  readonly counters: ResourceId;
}

const MATERIAL_WGSL = /* wgsl */ `
struct Settings { width:u32, height:u32, record_count:u32, cache_capacity:u32, field_versions:u32, miss_capacity:u32, frame:u32, reserved:u32 }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage,read> geometry: array<vec4f>;
@group(0) @binding(2) var<storage,read> field_versions: array<u32>;
@group(0) @binding(3) var<storage,read_write> cache: array<vec4u>;
@group(0) @binding(4) var<storage,read_write> misses: array<u32>;
@group(0) @binding(5) var<storage,read_write> counters: array<atomic<u32>>;
@group(0) @binding(6) var<storage,read_write> hit_mask: array<u32>;
@group(0) @binding(7) var fields: texture_storage_2d_array<rgba16float,write>;
fn hash(v:u32)->u32 { var x=v^(v>>16u); x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; return x^(x>>16u); }
@compute @workgroup_size(64)
fn lookup(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count { return; }
  let base=record*12u; let identity=bitcast<u32>(geometry[base+8u].x); let signature=bitcast<u32>(geometry[base+10u].x);
  let version=select(0u,field_versions[0u],arrayLength(&field_versions)>0u); let key=hash(identity^signature^version);
  let cell=key&(settings.cache_capacity-1u); let old=cache[cell];
  if old.x==key && old.y==version { hit_mask[record]=1u; atomicAdd(&counters[0],1u); }
  else {
    hit_mask[record]=0u; atomicAdd(&counters[1],1u);
    let slot=atomicAdd(&counters[2],1u); if slot<settings.miss_capacity { misses[slot]=record; }
    cache[cell]=vec4u(key,version,settings.frame,record);
  }
  let x=record%settings.width; let y=record/settings.width;
  textureStore(fields,vec2i(x,y),0,vec4f(0.8,0.8,0.8,1.0));
  textureStore(fields,vec2i(x,y),1,vec4f(0.5,0.5,0.5,1.0));
  textureStore(fields,vec2i(x,y),2,vec4f(0.0,0.0,0.0,1.0));
  textureStore(fields,vec2i(x,y),3,vec4f(1.0,0.0,0.0,0.0));
  textureStore(fields,vec2i(x,y),4,vec4f(0.0)); textureStore(fields,vec2i(x,y),5,vec4f(0.0));
}
`;

export class SurfaceMaterialCachePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly cache: GPUBuffer;
  private readonly cacheCapacity: number;
  constructor(private readonly device: GPUDevice, cacheCapacity = 1 << 16) {
    if ((cacheCapacity & (cacheCapacity - 1)) !== 0) throw new RangeError("Surface material cache capacity must be a power of two");
    this.cacheCapacity = cacheCapacity;
    this.settings = device.createBuffer({ label: "Surface material cache settings", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cache = device.createBuffer({ label: "Surface material stable cache", size: cacheCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/material cache lookup", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: MATERIAL_WGSL }), entryPoint: "lookup" } });
  }
  addToGraph(graph: FrameGraph, input: { geometry: ResourceId; width: number; height: number; recordCount: number; fieldVersions: ResourceId; frame: number }): SurfaceMaterialProducts {
    let fields!: ResourceId, missQueue!: ResourceId, hitMask!: ResourceId, counters!: ResourceId;
    const node = graph.add("Surface/Material cache lookup and miss compact", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = new Uint32Array([data.width, data.height, data.recordCount, this.cacheCapacity, 1, data.recordCount, data.frame, 0]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      const zero = new Uint32Array(4); command.writeBuffer(resources.get(counters) as GPUBuffer, 0, zero.buffer, 0, zero.byteLength);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: { buffer: resources.get(data.geometry) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(data.fieldVersions) as GPUBuffer } }, { binding: 3, resource: { buffer: this.cache } },
        { binding: 4, resource: { buffer: resources.get(missQueue) as GPUBuffer } }, { binding: 5, resource: { buffer: resources.get(counters) as GPUBuffer } },
        { binding: 6, resource: { buffer: resources.get(hitMask) as GPUBuffer } }, { binding: 7, resource: resolveTextureView(resources.get(fields)) }
      ] });
      const pass = command.beginComputePass({ label: "Surface/material cache" }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.recordCount / 64)); pass.end();
    });
    node.read(input.geometry); node.read(input.fieldVersions);
    fields = node.create("Surface/material fields", { kind: "transient_texture", width: input.width, height: input.height,
      depthOrArrayLayers: APPEARANCE_SURFACE_LAYER_COUNT, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" }); node.write(fields);
    missQueue = node.create("Surface/material miss queue", { kind: "transient_buffer", size: Math.max(4, input.recordCount * 4), usage: GPUBufferUsage.STORAGE, domain: "internal-full" }); node.write(missQueue);
    hitMask = node.create("Surface/material hit mask", { kind: "transient_buffer", size: Math.max(4, input.recordCount * 4), usage: GPUBufferUsage.STORAGE, domain: "internal-full" }); node.write(hitMask);
    counters = node.create("Surface/material counters", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, domain: "internal-full" }); node.write(counters);
    return { fields, missQueue, hitMask, counters };
  }
  destroy(): void { this.settings.destroy(); this.cache.destroy(); }
}
