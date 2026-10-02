import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "../../shaders/working_color.js";

export const SURFACE_RECONSTRUCT_COUNTER_WORDS = 8;
export const SURFACE_RECONSTRUCT_COUNTER_BYTES = SURFACE_RECONSTRUCT_COUNTER_WORDS * 4;
export interface SurfaceReconstructionProducts { readonly radiance: ResourceId; readonly reactiveMask: ResourceId; readonly counters: ResourceId; }

const RECONSTRUCT_WGSL = /* wgsl */ `
${LINEAR_REC709_TO_REC2020_WGSL}
struct Settings {
  width:u32, height:u32, record_count:u32, history_valid:u32,
  pre_exposure:f32, history_feedback:f32, history_max_age:u32, revision_mask:u32,
  diagnostics_enabled:u32, _reserved0:u32, _reserved1:u32, _reserved2:u32
}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> diffuse:array<vec4f>;
@group(0) @binding(2) var<storage,read> specular:array<vec4f>;
@group(0) @binding(3) var<storage,read> coat:array<vec4f>;
@group(0) @binding(4) var<storage,read> ibl:array<vec4f>;
@group(0) @binding(6) var source_reactive:texture_2d<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(9) var<storage,read> pre_exposure:array<f32>;
@group(0) @binding(10) var sample_map:texture_2d<u32>;
@group(0) @binding(11) var diffuse_history_read:texture_2d<f32>;
@group(0) @binding(12) var diffuse_history_write:texture_storage_2d<rgba16float,write>;
@group(0) @binding(13) var specular_history_read:texture_2d<f32>;
@group(0) @binding(14) var specular_history_write:texture_storage_2d<rgba16float,write>;
@group(0) @binding(15) var coat_history_read:texture_2d<f32>;
@group(0) @binding(16) var coat_history_write:texture_storage_2d<rgba16float,write>;
@group(0) @binding(17) var ibl_history_read:texture_2d<f32>;
@group(0) @binding(18) var ibl_history_write:texture_storage_2d<rgba16float,write>;
@group(0) @binding(19) var current_identity:texture_2d<u32>;
@group(0) @binding(20) var history_identity_read:texture_2d<u32>;
@group(0) @binding(21) var history_identity_write:texture_storage_2d<rgba32uint,write>;
@group(0) @binding(22) var history_age_read:texture_2d<u32>;
@group(0) @binding(23) var history_age_write:texture_storage_2d<r32uint,write>;
@group(0) @binding(24) var<storage,read_write> diagnostics:array<atomic<u32>>;
@group(0) @binding(25) var motion:texture_2d<f32>;

fn diagnostic_add(index:u32, value:u32) {
  if settings.diagnostics_enabled != 0u { atomicAdd(&diagnostics[index], value); }
}

@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id:vec3u){
  if id.x>=settings.width||id.y>=settings.height{return;}
  let pixel=vec2i(id.xy); let record=textureLoad(sample_map,pixel,0).x;
  let facts=textureLoad(source_reactive,pixel,0);
  let identity=textureLoad(current_identity,pixel,0);
  let previous_uv=(vec2f(id.xy)+0.5)/vec2f(f32(settings.width),f32(settings.height))-textureLoad(motion,pixel,0).xy;
  let previous_inside=all(previous_uv>=vec2f(0.0)) && all(previous_uv<vec2f(1.0));
  let previous_pixel=clamp(vec2i(previous_uv*vec2f(f32(settings.width),f32(settings.height))),vec2i(0),vec2i(i32(settings.width)-1,i32(settings.height)-1));
  let previous_identity=textureLoad(history_identity_read,previous_pixel,0);
  let previous_age=textureLoad(history_age_read,previous_pixel,0).x;
  // Motion validity and disocclusion reject history, never current radiance.
  var valid=record<settings.record_count && record!=0xffffffffu;
  if valid { diagnostic_add(7u,1u); }
  if valid { valid=diffuse[record].w>0.5; }
  let identity_match=all(identity==previous_identity);
  var current_diffuse=vec3f(0.0); var current_specular=vec3f(0.0);
  var current_coat=vec3f(0.0); var current_ibl=vec3f(0.0);
  if valid { current_diffuse=diffuse[record].xyz; current_specular=specular[record].xyz; current_coat=coat[record].xyz; current_ibl=ibl[record].xyz; }
  let can_reuse=settings.history_valid!=0u && valid && previous_inside && facts.y>0.5 && facts.z<0.5 && facts.x<0.5 && identity_match && previous_age<settings.history_max_age;
  let feedback=clamp(settings.history_feedback+facts.w*0.1,0.05,0.35);
  let reuse_diffuse=can_reuse && (settings.revision_mask & 1u)==0u;
  let reuse_specular=can_reuse && (settings.revision_mask & 2u)==0u;
  let reuse_coat=can_reuse && (settings.revision_mask & 4u)==0u;
  let reuse_ibl=can_reuse && (settings.revision_mask & 8u)==0u;
  diagnostic_add(6u,u32(reuse_diffuse)+u32(reuse_specular)+u32(reuse_coat)+u32(reuse_ibl));
  var resolved_diffuse=current_diffuse; var resolved_specular=current_specular;
  var resolved_coat=current_coat; var resolved_ibl=current_ibl;
  if reuse_diffuse { resolved_diffuse=mix(textureLoad(diffuse_history_read,previous_pixel,0).xyz,current_diffuse,feedback); }
  if reuse_specular { resolved_specular=mix(textureLoad(specular_history_read,previous_pixel,0).xyz,current_specular,feedback); }
  if reuse_coat { resolved_coat=mix(textureLoad(coat_history_read,previous_pixel,0).xyz,current_coat,feedback); }
  if reuse_ibl { resolved_ibl=mix(textureLoad(ibl_history_read,previous_pixel,0).xyz,current_ibl,feedback); }
  let resolved=resolved_diffuse+resolved_specular+resolved_coat+resolved_ibl;
  let exposure=max(pre_exposure[0],1e-4);
  textureStore(diffuse_history_write,pixel,vec4f(resolved_diffuse,1.0));
  textureStore(specular_history_write,pixel,vec4f(resolved_specular,1.0));
  textureStore(coat_history_write,pixel,vec4f(resolved_coat,1.0));
  textureStore(ibl_history_write,pixel,vec4f(resolved_ibl,1.0));
  textureStore(history_identity_write,pixel,select(vec4u(0u),identity,valid));
  textureStore(history_age_write,pixel,vec4u(select(0u, min(previous_age + 1u, 255u), can_reuse)));
  textureStore(output,pixel,vec4f(oengine_linear_rec709_to_rec2020(resolved)*exposure,select(0.0,1.0,valid)));
  textureStore(reactive,pixel,vec4f(max(facts.x,select(0.0,0.35,!valid || !identity_match)),facts.yzw));
  if valid { diagnostic_add(0u, 1u); } else { diagnostic_add(1u, 1u); }
  if can_reuse { diagnostic_add(2u, 1u); } else { diagnostic_add(3u, 1u); }
  if valid && !identity_match { diagnostic_add(4u, 1u); }
  diagnostic_add(5u, 1u);
}
`;

type HistoryPair = readonly [GPUTexture, GPUTexture];
type SignalHistories = readonly [HistoryPair, HistoryPair, HistoryPair, HistoryPair];
type RetiredHistories = { signal: SignalHistories; identity: HistoryPair; age: HistoryPair; done: Promise<void> };
type SurfaceHistoryRevisions = Readonly<{ environment: number; light: number; shadow: number }>;

export class SurfaceReconstructionPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private histories: SignalHistories | null = null;
  private identityHistories: HistoryPair | null = null;
  private ageHistories: HistoryPair | null = null;
  private size: readonly [number, number] = [0, 0];
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private historyValid = false;
  private historyRevisions: SurfaceHistoryRevisions | null = null;
  private prepared = false;
  private lastGpuDone: Promise<void> | null = null;
  private readonly retired: RetiredHistories[] = [];

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface reconstruct settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      ...[1, 2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as GPUBufferBindingType } })),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      ...[11, 13, 15, 17].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d" as GPUTextureViewDimension } })),
      ...[12, 14, 16, 18].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only" as const, format: "rgba16float" as GPUTextureFormat } })),
      { binding: 19, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 20, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 21, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba32uint" } },
      { binding: 22, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 23, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } },
      { binding: 24, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 25, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } }
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
      this.histories = ["diffuse", "specular", "coat", "ibl"].map(signal => [0, 1].map(index => this.device.createTexture({
        label: `Surface ${signal} history/${index}`, size: [width, height], format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair) as unknown as SignalHistories;
      this.identityHistories = [0, 1].map(index => this.device.createTexture({
        label: `Surface signal identity history/${index}`, size: [width, height], format: "rgba32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair;
      this.ageHistories = [0, 1].map(index => this.device.createTexture({
        label: `Surface signal age history/${index}`, size: [width, height], format: "r32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as HistoryPair;
      this.size = [width, height]; this.historyValid = false; this.historyRevisions = null;
    }
    this.prepared = true;
    this.retireCompleted();
  }

  private retireCompleted(): void {
    while (this.retired.length > 0) {
      const item = this.retired.shift()!;
      void item.done.then(() => {
        for (const pair of item.signal) { pair[0].destroy(); pair[1].destroy(); }
        item.identity[0].destroy(); item.identity[1].destroy();
        item.age[0].destroy(); item.age[1].destroy();
      });
    }
  }

  addToGraph(graph: FrameGraph, input: {
    diffuse: ResourceId; specular: ResourceId; coat: ResourceId; ibl: ResourceId;
    reactive: ResourceId; identity: ResourceId; motion: ResourceId; preExposure: ResourceId; sampleMap: ResourceId;
    historyBinding: (name: string, resolve: () => GPUTexture) => GPUTexture;
    revisions: SurfaceHistoryRevisions;
    width: number; height: number; recordCount: number; diagnosticsEnabled: boolean
  }): SurfaceReconstructionProducts {
    if (!this.prepared || this.histories === null) throw new Error("Surface reconstruction frame is not prepared");
    const historyRead = this.histories.map((pair, index) => graph.import_resource(`Surface ${["diffuse", "specular", "coat", "ibl"][index]} history/read`,
      { kind: "imported", label: `Surface ${["diffuse", "specular", "coat", "ibl"][index]} history read`, domain: "internal-full" }, input.historyBinding(`surface-history-${index}-read`, () => this.histories![index]![this.readIndex])));
    const historyWrite = this.histories.map((pair, index) => graph.import_resource(`Surface ${["diffuse", "specular", "coat", "ibl"][index]} history/write`,
      { kind: "imported", label: `Surface ${["diffuse", "specular", "coat", "ibl"][index]} history write`, domain: "internal-full" }, input.historyBinding(`surface-history-${index}-write`, () => this.histories![index]![this.writeIndex])));
    const identityRead = graph.import_resource("Surface signal identity history/read",
      { kind: "imported", label: "Surface signal identity history read", domain: "internal-full" }, input.historyBinding("surface-history-identity-read", () => this.identityHistories![this.readIndex]));
    const identityWrite = graph.import_resource("Surface signal identity history/write",
      { kind: "imported", label: "Surface signal identity history write", domain: "internal-full" }, input.historyBinding("surface-history-identity-write", () => this.identityHistories![this.writeIndex]));
    const ageRead = graph.import_resource("Surface signal age history/read",
      { kind: "imported", label: "Surface signal age history read", domain: "internal-full" }, input.historyBinding("surface-history-age-read", () => this.ageHistories![this.readIndex]));
    const ageWrite = graph.import_resource("Surface signal age history/write",
      { kind: "imported", label: "Surface signal age history write", domain: "internal-full" }, input.historyBinding("surface-history-age-write", () => this.ageHistories![this.writeIndex]));
    let radiance!: ResourceId, reactiveMask!: ResourceId, counters!: ResourceId;
    const node = graph.add("Surface/cheap full-resolution reconstruct", { ...input, historyRead, historyWrite, identityRead, identityWrite, ageRead, ageWrite },
      (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        // FrameGraph bindings are late-bound. Read revisions while encoding the
        // frame so a light/environment/VSM update invalidates the next history
        // use even when the graph recipe is reused.
        const previousRevisions = this.historyRevisions;
        const revisionMask = previousRevisions === null ? 15 :
          (previousRevisions.environment === data.revisions.environment ? 0 : 15) |
          (previousRevisions.light === data.revisions.light ? 0 : 7) |
          (previousRevisions.shadow === data.revisions.shadow ? 0 : 7);
        this.historyRevisions = { ...data.revisions };
        const settings = new ArrayBuffer(48); const view = new DataView(settings);
        view.setUint32(0, data.width, true); view.setUint32(4, data.height, true);
        view.setUint32(8, data.recordCount, true); view.setUint32(12, this.historyValid ? 1 : 0, true);
        view.setFloat32(16, 1, true); view.setFloat32(20, 0.18, true);
        view.setUint32(24, 8, true); view.setUint32(28, revisionMask, true);
        view.setUint32(32, data.diagnosticsEnabled ? 1 : 0, true);
        if (data.diagnosticsEnabled) {
          command.writeBuffer(resources.get(counters) as GPUBuffer, 0,
            new Uint32Array(SURFACE_RECONSTRUCT_COUNTER_WORDS).buffer, 0, SURFACE_RECONSTRUCT_COUNTER_BYTES);
        }
        command.writeBuffer(this.settings, 0, settings, 0, settings.byteLength);
        const group = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.diffuse) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.specular) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.coat) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(data.ibl) as GPUBuffer } },
          { binding: 6, resource: resolveTextureView(resources.get(data.reactive)) },
          { binding: 7, resource: resolveTextureView(resources.get(radiance)) },
          { binding: 8, resource: resolveTextureView(resources.get(reactiveMask)) },
          { binding: 9, resource: { buffer: resources.get(data.preExposure) as GPUBuffer } },
          { binding: 10, resource: resolveTextureView(resources.get(data.sampleMap)) },
          { binding: 11, resource: resolveTextureView(resources.get(data.historyRead[0]!)) },
          { binding: 12, resource: resolveTextureView(resources.get(data.historyWrite[0]!)) },
          { binding: 13, resource: resolveTextureView(resources.get(data.historyRead[1]!)) },
          { binding: 14, resource: resolveTextureView(resources.get(data.historyWrite[1]!)) },
          { binding: 15, resource: resolveTextureView(resources.get(data.historyRead[2]!)) },
          { binding: 16, resource: resolveTextureView(resources.get(data.historyWrite[2]!)) },
          { binding: 17, resource: resolveTextureView(resources.get(data.historyRead[3]!)) },
          { binding: 18, resource: resolveTextureView(resources.get(data.historyWrite[3]!)) },
          { binding: 19, resource: resolveTextureView(resources.get(data.identity)) },
          { binding: 20, resource: resolveTextureView(resources.get(data.identityRead)) },
          { binding: 21, resource: resolveTextureView(resources.get(data.identityWrite)) },
          { binding: 22, resource: resolveTextureView(resources.get(data.ageRead)) },
          { binding: 23, resource: resolveTextureView(resources.get(data.ageWrite)) },
          { binding: 24, resource: { buffer: resources.get(counters) as GPUBuffer } },
          { binding: 25, resource: resolveTextureView(resources.get(data.motion)) }
        ] });
        const pass = command.beginComputePass({ label: "Surface/reconstruct" });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8)); pass.end();
      });
    for (const id of [input.diffuse, input.specular, input.coat, input.ibl,
      input.reactive, input.identity, input.motion, input.preExposure, input.sampleMap, ...historyRead, identityRead, ageRead]) node.read(id);
    for (const id of historyWrite) node.write(id); node.write(identityWrite); node.write(ageWrite);
    radiance = node.create("Surface/HDR reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, domain: "internal-full" });
    reactiveMask = node.create("Surface/reactive reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    counters = node.create("Surface/reconstruct diagnostics", { kind: "transient_buffer", size: SURFACE_RECONSTRUCT_COUNTER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    node.write(counters);
    node.write(radiance); node.write(reactiveMask);
    return { radiance, reactiveMask, counters };
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
    if (this.histories !== null) for (const pair of this.histories) { pair[0].destroy(); pair[1].destroy(); }
    if (this.identityHistories !== null) { this.identityHistories[0].destroy(); this.identityHistories[1].destroy(); }
    if (this.ageHistories !== null) { this.ageHistories[0].destroy(); this.ageHistories[1].destroy(); }
    for (const item of this.retired) {
      for (const pair of item.signal) { pair[0].destroy(); pair[1].destroy(); }
      item.identity[0].destroy(); item.identity[1].destroy();
      item.age[0].destroy(); item.age[1].destroy();
    }
    this.retired.length = 0;
  }
}
