import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface SurfaceReconstructionProducts { readonly radiance: ResourceId; readonly reactiveMask: ResourceId; }

const RECONSTRUCT_WGSL = /* wgsl */ `
struct Settings {
  width:u32, height:u32, record_count:u32, history_valid:u32,
  pre_exposure:f32, history_feedback:f32, history_max_age:u32, _pad:u32
}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> diffuse:array<vec4f>;
@group(0) @binding(2) var<storage,read> specular:array<vec4f>;
@group(0) @binding(3) var<storage,read> coat:array<vec4f>;
@group(0) @binding(4) var<storage,read> ibl:array<vec4f>;
@group(0) @binding(5) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(6) var<storage,read> source_reactive:texture_2d<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(9) var<storage,read> pre_exposure:array<f32>;
@group(0) @binding(10) var sample_map:texture_2d<u32>;
@group(0) @binding(11) var history_read:texture_2d<f32>;
@group(0) @binding(12) var history_write:texture_storage_2d<rgba16float,write>;
@group(0) @binding(13) var current_identity:texture_2d<u32>;
@group(0) @binding(14) var history_identity_read:texture_2d<u32>;
@group(0) @binding(15) var history_identity_write:texture_storage_2d<rgba32uint,write>;
@group(0) @binding(16) var history_age_read:texture_2d<u32>;
@group(0) @binding(17) var history_age_write:texture_storage_2d<r32uint,write>;

@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id:vec3u){
  if id.x>=settings.width||id.y>=settings.height{return;}
  let pixel=vec2i(id.xy); let record=textureLoad(sample_map,pixel,0).x;
  let facts=textureLoad(source_reactive,pixel,0);
  let identity=textureLoad(current_identity,pixel,0);
  let previous_identity=textureLoad(history_identity_read,pixel,0);
  let previous_age=textureLoad(history_age_read,pixel,0).x;
  let valid=record<settings.record_count && record!=0xffffffffu && facts.y>0.5 && facts.z<0.5;
  let identity_match=all(identity==previous_identity);
  var current=vec3f(0.0);
  if valid { current=diffuse[record].xyz+specular[record].xyz+coat[record].xyz+ibl[record].xyz; }
  let can_reuse=settings.history_valid!=0u && valid && identity_match && previous_age<settings.history_max_age;
  var resolved=current;
  if can_reuse {
    let previous=textureLoad(history_read,pixel,0).xyz;
    let feedback=clamp(settings.history_feedback+facts.w*0.1,0.05,0.35);
    resolved=mix(previous,current,feedback);
  }
  let exposure=max(pre_exposure[0],1e-4);
  textureStore(history_write,pixel,vec4f(resolved,1.0));
  textureStore(history_identity_write,pixel,select(vec4u(0u),identity,valid));
  textureStore(history_age_write,pixel,vec4u(select(0u, min(previous_age + 1u, 255u), valid && identity_match)));
  textureStore(output,pixel,vec4f(resolved*exposure,select(0.0,1.0,valid)));
  textureStore(reactive,pixel,vec4f(max(facts.x,select(0.0,0.35,!valid || !identity_match)),facts.yzw));
}
`;

type HistoryPair = readonly [GPUTexture, GPUTexture];
type RetiredHistories = { signal: HistoryPair; identity: HistoryPair; age: HistoryPair; done: Promise<void> };

export class SurfaceReconstructionPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private histories: HistoryPair | null = null;
  private identityHistories: HistoryPair | null = null;
  private ageHistories: HistoryPair | null = null;
  private size: readonly [number, number] = [0, 0];
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private historyValid = false;
  private prepared = false;
  private lastGpuDone: Promise<void> | null = null;
  private readonly retired: RetiredHistories[] = [];

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface reconstruct settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      ...[1, 2, 3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as GPUBufferBindingType } })),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 14, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 15, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba32uint" } },
      { binding: 16, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 17, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/cheap reconstruct",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: RECONSTRUCT_WGSL }), entryPoint: "reconstruct" } });
  }

  prepareFrame(width: number, height: number): void {
    if (this.prepared) throw new Error("Surface reconstruction frame is already prepared");
    if (this.histories === null || this.size[0] !== width || this.size[1] !== height) {
      if (this.histories !== null) {
        this.retired.push({ signal: this.histories, identity: this.identityHistories!, age: this.ageHistories!,
          done: this.lastGpuDone ?? Promise.resolve() });
      }
      this.histories = [0, 1].map(index => this.device.createTexture({
        label: `Surface signal history/${index}`, size: [width, height], format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair;
      this.identityHistories = [0, 1].map(index => this.device.createTexture({
        label: `Surface signal identity history/${index}`, size: [width, height], format: "rgba32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair;
      this.ageHistories = [0, 1].map(index => this.device.createTexture({
        label: `Surface signal age history/${index}`, size: [width, height], format: "r32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair;
      this.size = [width, height]; this.historyValid = false;
    }
    this.prepared = true;
    this.retireCompleted();
  }

  private retireCompleted(): void {
    while (this.retired.length > 0) {
      const item = this.retired.shift()!;
      void item.done.then(() => {
        item.signal[0].destroy(); item.signal[1].destroy();
        item.identity[0].destroy(); item.identity[1].destroy();
        item.age[0].destroy(); item.age[1].destroy();
      });
    }
  }

  addToGraph(graph: FrameGraph, input: {
    diffuse: ResourceId; specular: ResourceId; coat: ResourceId; ibl: ResourceId; geometry: ResourceId;
    reactive: ResourceId; identity: ResourceId; preExposure: ResourceId; sampleMap: ResourceId;
    width: number; height: number; recordCount: number
  }): SurfaceReconstructionProducts {
    if (!this.prepared || this.histories === null) throw new Error("Surface reconstruction frame is not prepared");
    const historyRead = graph.import_resource("Surface signal history/read",
      { kind: "imported", label: "Surface signal history read", domain: "internal-full" }, this.histories[this.readIndex]);
    const historyWrite = graph.import_resource("Surface signal history/write",
      { kind: "imported", label: "Surface signal history write", domain: "internal-full" }, this.histories[this.writeIndex]);
    const identityRead = graph.import_resource("Surface signal identity history/read",
      { kind: "imported", label: "Surface signal identity history read", domain: "internal-full" }, this.identityHistories![this.readIndex]);
    const identityWrite = graph.import_resource("Surface signal identity history/write",
      { kind: "imported", label: "Surface signal identity history write", domain: "internal-full" }, this.identityHistories![this.writeIndex]);
    const ageRead = graph.import_resource("Surface signal age history/read",
      { kind: "imported", label: "Surface signal age history read", domain: "internal-full" }, this.ageHistories![this.readIndex]);
    const ageWrite = graph.import_resource("Surface signal age history/write",
      { kind: "imported", label: "Surface signal age history write", domain: "internal-full" }, this.ageHistories![this.writeIndex]);
    let radiance!: ResourceId, reactiveMask!: ResourceId;
    const node = graph.add("Surface/cheap full-resolution reconstruct", { ...input, historyRead, historyWrite, identityRead, identityWrite, ageRead, ageWrite },
      (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const settings = new ArrayBuffer(32); const view = new DataView(settings);
        view.setUint32(0, data.width, true); view.setUint32(4, data.height, true);
        view.setUint32(8, data.recordCount, true); view.setUint32(12, this.historyValid ? 1 : 0, true);
        view.setFloat32(16, 1, true); view.setFloat32(20, 0.18, true);
        view.setUint32(24, 8, true);
        command.writeBuffer(this.settings, 0, settings, 0, settings.byteLength);
        const group = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.diffuse) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.specular) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.coat) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(data.ibl) as GPUBuffer } },
          { binding: 5, resource: { buffer: resources.get(data.geometry) as GPUBuffer } },
          { binding: 6, resource: resolveTextureView(resources.get(data.reactive)) },
          { binding: 7, resource: resolveTextureView(resources.get(radiance)) },
          { binding: 8, resource: resolveTextureView(resources.get(reactiveMask)) },
          { binding: 9, resource: { buffer: resources.get(data.preExposure) as GPUBuffer } },
          { binding: 10, resource: resolveTextureView(resources.get(data.sampleMap)) },
          { binding: 11, resource: resolveTextureView(resources.get(data.historyRead)) },
          { binding: 12, resource: resolveTextureView(resources.get(data.historyWrite)) },
          { binding: 13, resource: resolveTextureView(resources.get(data.identity)) },
          { binding: 14, resource: resolveTextureView(resources.get(data.identityRead)) },
          { binding: 15, resource: resolveTextureView(resources.get(data.identityWrite)) },
          { binding: 16, resource: resolveTextureView(resources.get(data.ageRead)) },
          { binding: 17, resource: resolveTextureView(resources.get(data.ageWrite)) }
        ] });
        const pass = command.beginComputePass({ label: "Surface/reconstruct" });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8)); pass.end();
      });
    for (const id of [input.diffuse, input.specular, input.coat, input.ibl, input.geometry,
      input.reactive, input.identity, input.preExposure, input.sampleMap, historyRead, identityRead, ageRead]) node.read(id);
    node.write(historyWrite); node.write(identityWrite); node.write(ageWrite);
    radiance = node.create("Surface/HDR reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    reactiveMask = node.create("Surface/reactive reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    node.write(radiance); node.write(reactiveMask);
    return { radiance, reactiveMask };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("Surface reconstruction commit without prepare");
    this.lastGpuDone = gpuDone; this.historyValid = true;
    [this.readIndex, this.writeIndex] = [this.writeIndex, this.readIndex];
    this.prepared = false;
  }

  abort(): void { this.prepared = false; }

  invalidate(): void { if (!this.prepared) this.historyValid = false; }

  destroy(): void {
    this.settings.destroy();
    if (this.histories !== null) { this.histories[0].destroy(); this.histories[1].destroy(); }
    if (this.identityHistories !== null) { this.identityHistories[0].destroy(); this.identityHistories[1].destroy(); }
    if (this.ageHistories !== null) { this.ageHistories[0].destroy(); this.ageHistories[1].destroy(); }
    for (const item of this.retired) {
      item.signal[0].destroy(); item.signal[1].destroy();
      item.identity[0].destroy(); item.identity[1].destroy();
      item.age[0].destroy(); item.age[1].destroy();
    }
    this.retired.length = 0;
  }
}
