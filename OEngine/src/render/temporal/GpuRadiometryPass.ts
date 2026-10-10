import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const BIN_COUNT = 1024;
const HISTOGRAM_BYTES = BIN_COUNT * 4;

export interface RadiometryProducts {
  readonly previousExposure: ResourceId;
  readonly adaptedExposure: ResourceId;
}

const WGSL = /* wgsl */ `
const BIN_COUNT:u32 = 1024u;
const MIN_LOG:f32 = -10.0;
const MAX_LOG:f32 = 2.0;
struct Histogram { bins: array<atomic<u32>, 1024>, };
struct Exposure { value:f32, luminance:f32, _pad:vec2f, };
struct Settings { width:u32, height:u32, dt:f32, history_valid:u32, };
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram:Histogram;
@group(0) @binding(2) var<uniform> settings:Settings;
@group(0) @binding(3) var<storage,read> pre_exposure:array<f32>;
var<workgroup> local_bins:array<atomic<u32>,1024>;
fn luminance(c:vec3f)->f32 { return dot(max(c,vec3f(0.0)),vec3f(0.2627,0.6780,0.0593)); }
@compute @workgroup_size(16,16)
fn histogram_main(@builtin(global_invocation_id) id:vec3u,
  @builtin(local_invocation_index) li:u32) {
  for(var part=0u;part<4u;part++){atomicStore(&local_bins[li+part*256u],0u);}
  workgroupBarrier();
  let source=id.xy*2u;
  if(source.x<settings.width && source.y<settings.height){
    let value=luminance(textureLoad(scene,vec2i(source),0).rgb)/max(pre_exposure[0],1e-6);
    var bin=0u;
    if(value>0.001 && value<=65504.0){
      let t=clamp((log2(value)-MIN_LOG)/(MAX_LOG-MIN_LOG),0.0,1.0);
      bin=min(BIN_COUNT-1u,u32(t*f32(BIN_COUNT-2u))+1u);
    }else if(value>65504.0){bin=BIN_COUNT-1u;}
    atomicAdd(&local_bins[bin],1u);
  }
  workgroupBarrier();
  for(var part=0u;part<4u;part++){
    let bin=li+part*256u;
    atomicAdd(&histogram.bins[bin],atomicLoad(&local_bins[bin]));
  }
}
@group(1) @binding(0) var<storage, read_write> reduce_histogram:Histogram;
@group(1) @binding(1) var<storage, read> previous:Exposure;
@group(1) @binding(2) var<storage, read_write> next:Exposure;
@group(1) @binding(3) var<uniform> reduce_settings:Settings;
var<workgroup> weighted_bins:array<f32,256>;
var<workgroup> pixel_bins:array<u32,256>;
@compute @workgroup_size(256)
fn reduce_main(@builtin(local_invocation_index) li:u32) {
  var weighted=0.0;
  var count=0u;
  for(var part=0u;part<4u;part++){
    let bin=li+part*256u;
    let amount=atomicLoad(&reduce_histogram.bins[bin]);
    weighted+=f32(amount)*f32(bin);
    count+=amount;
  }
  weighted_bins[li]=weighted;
  pixel_bins[li]=count;
  workgroupBarrier();
  var stride=128u;
  loop {
    if(li<stride){weighted_bins[li]+=weighted_bins[li+stride];pixel_bins[li]+=pixel_bins[li+stride];}
    workgroupBarrier();
    if(stride==1u){break;}
    stride=stride/2u;
  }
  if(li==0u){
    let usable=pixel_bins[0]-atomicLoad(&reduce_histogram.bins[0]);
    let log_average=weighted_bins[0]/max(f32(usable),1.0)-1.0;
    let target_luminance=exp2(log_average/f32(BIN_COUNT-2u)*(MAX_LOG-MIN_LOG)+MIN_LOG);
    let prior=select(0.18,clamp(previous.luminance,1e-4,1e4),reduce_settings.history_valid!=0u);
    var adapted=prior+(target_luminance-prior)*(1.0-exp(-max(reduce_settings.dt,0.01)*1.5));
    if(usable==0u){adapted=prior;}
    next.luminance=clamp(adapted,1e-4,1e4);
    next.value=clamp(0.18/next.luminance,1e-4,1e4);
  }
  workgroupBarrier();
  for(var part=0u;part<4u;part++){atomicStore(&reduce_histogram.bins[li+part*256u],0u);}
}
`;

type Pair = readonly [GPUBuffer, GPUBuffer];
type RadiometryResourceBinder = (
  name: string,
  resolve: (runtime: GpuRadiometryPass) => GPUBuffer,
) => ResourceId;

export class GpuRadiometryPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly layout0: GPUBindGroupLayout;
  private readonly layout1: GPUBindGroupLayout;
  private readonly histogramPipeline: GPUComputePipeline;
  private readonly reducePipeline: GPUComputePipeline;
  private readonly buffers: Pair;
  private prepared = false;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private historyValid = false;
  private deltaTime = 1 / 60;
  private lastGpuDone: Promise<void> | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly autoExposure = true,
    private readonly fixedExposure = 1,
  ) {
    if (!Number.isFinite(fixedExposure) || fixedExposure <= 0) {
      throw new RangeError("GPU radiometry fixed exposure must be positive");
    }
    if (device.limits.maxStorageBuffersPerShaderStage < 3) {
      throw new RangeError("GPU radiometry requires three storage buffers");
    }
    this.layout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.layout1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const module = device.createShaderModule({ label: "Radiometry GPU P/E", code: WGSL });
    this.histogramPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout0] }),
      compute: { module, entryPoint: "histogram_main" },
    });
    this.reducePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }), this.layout1],
      }),
      compute: { module, entryPoint: "reduce_main" },
    });
    this.buffers = [0, 1].map((index) => {
      // Both exposure and adapted scene luminance survive in the device epoch.
      const buffer = device.createBuffer({
        label: `Radiometry/P-E/${index}`,
        size: 32,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set([this.fixedExposure, 0.18 / this.fixedExposure]);
      buffer.unmap();
      return buffer;
    }) as unknown as Pair;
  }

  prepareFrame(readIndex: 0 | 1, writeIndex: 0 | 1, historyValid: boolean, deltaTime = 1 / 60): void {
    if (this.prepared) throw new Error("GPU radiometry frame already prepared");
    if (readIndex === writeIndex) throw new Error("GPU radiometry read/write slots alias");
    this.readIndex = readIndex;
    this.writeIndex = writeIndex;
    this.historyValid = historyValid;
    this.prepared = true;
    this.deltaTime = Number.isFinite(deltaTime) ? Math.max(0, Math.min(1, deltaTime)) : 1 / 60;
    if (!historyValid) {
      // Reset P_0 on the device queue; the subsequent frame encoder consumes it.
      this.device.queue.writeBuffer(
        this.readBuffer(),
        0,
        new Float32Array([this.fixedExposure, 0.18 / this.fixedExposure]),
      );
    }
  }
  readBuffer(): GPUBuffer {
    return this.buffers[this.readIndex];
  }
  writeBuffer(): GPUBuffer {
    return this.buffers[this.writeIndex];
  }
  importPreviousExposure(graph: FrameGraph, bind: RadiometryResourceBinder): ResourceId {
    void graph;
    return bind("previous-exposure", (runtime) => runtime.readBuffer());
  }
  importPriorExposure(graph: FrameGraph, bind: RadiometryResourceBinder): ResourceId {
    void graph;
    return bind("prior-exposure", (runtime) => runtime.writeBuffer());
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      scene: ResourceId;
      width: number;
      height: number;
      previousExposure?: ResourceId;
      priorExposure?: ResourceId;
    },
    bind: RadiometryResourceBinder,
  ): RadiometryProducts {
    if (!this.prepared) throw new Error("GPU radiometry must be prepared before graph build");
    const previousExposure = input.previousExposure ?? this.importPreviousExposure(graph, bind);
    // Both history slots start at 1x and remain constant without an adaptation writer.
    // Reuse the same exposure for pre-exposure and display, including after history resets.
    if (!this.autoExposure) return { previousExposure, adaptedExposure: previousExposure };
    const priorExposure = input.priorExposure ?? this.importPriorExposure(graph, bind);
    const makeSettings = () => {
      const values = new Uint32Array([input.width, input.height, 0, Number(this.historyValid)]);
      new DataView(values.buffer).setFloat32(8, this.deltaTime, true);
      return values.buffer;
    };
    let histogram = -1;
    const meter = graph.add("Radiometry/Wicked histogram", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(makeSettings(), GPUBufferUsage.UNIFORM);
      const group = this.bindGroups.create(this.device, {
        layout: this.layout0,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.scene)) },
          { binding: 1, resource: { buffer: resources.get(histogram) as GPUBuffer } },
          { binding: 2, resource: { buffer: constants } },
          { binding: 3, resource: { buffer: resources.get(previousExposure) as GPUBuffer } },
        ],
      });
      const pass = command.beginComputePass({ label: "Radiometry/Wicked histogram" });
      pass.setPipeline(this.histogramPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.width / 32), Math.ceil(data.height / 32));
      pass.end();
    });
    histogram = meter.create("Radiometry/histogram", {
      kind: "transient_buffer",
      size: HISTOGRAM_BYTES,
      usage: GPUBufferUsage.STORAGE,
      ensure_cleared: [0, HISTOGRAM_BYTES],
    });
    meter.read(input.scene);
    meter.read(previousExposure);
    const reduce = graph.add("Radiometry/adapt exposure", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(makeSettings(), GPUBufferUsage.UNIFORM);
      const group = this.bindGroups.create(this.device, {
        layout: this.layout1,
        entries: [
          { binding: 0, resource: { buffer: resources.get(histogram) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(previousExposure) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(priorExposure) as GPUBuffer } },
          { binding: 3, resource: { buffer: constants } },
        ],
      });
      const pass = command.beginComputePass({ label: "Radiometry/adapt exposure" });
      pass.setPipeline(this.reducePipeline);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    reduce.read(histogram);
    reduce.read(previousExposure);
    const adaptedExposure = reduce.write(priorExposure);
    return { previousExposure, adaptedExposure };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("GPU radiometry commit without prepare");
    this.prepared = false;
    this.lastGpuDone = gpuDone;
  }
  abort(): void {
    this.prepared = false;
  }
  destroy(): void {
    this.bindGroups.clear();
    for (const buffer of this.buffers) buffer.destroy();
  }
}

export const GPU_RADIOMETRY_WGSL = WGSL;
