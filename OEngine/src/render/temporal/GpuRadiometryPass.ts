import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const BIN_COUNT = 128;
const HISTOGRAM_BYTES = BIN_COUNT * 4;

export interface RadiometryProducts {
  readonly preExposure: ResourceId;
  readonly adaptedExposure: ResourceId;
}

const WGSL = /* wgsl */ `
const BIN_COUNT:u32 = 128u;
const MIN_LOG:f32 = -10.0;
const MAX_LOG:f32 = 15.0;
struct Histogram { bins: array<atomic<u32>, 128>, };
struct Exposure { value:f32, _pad:vec3f, };
struct Settings { width:u32, height:u32, dt:f32, history_valid:u32, };
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram:Histogram;
@group(0) @binding(2) var<uniform> settings:Settings;
@group(0) @binding(3) var<storage,read> pre_exposure:array<f32>;
var<workgroup> local_bins:array<atomic<u32>,128>;
fn luminance(c:vec3f)->f32 { return dot(max(c,vec3f(0.0)),vec3f(0.2627,0.6780,0.0593)); }
@compute @workgroup_size(8,8)
fn histogram_main(@builtin(global_invocation_id) id:vec3u,
  @builtin(local_invocation_index) li:u32) {
  if (li < 64u) {
    atomicStore(&local_bins[li],0u);
    atomicStore(&local_bins[li + 64u],0u);
  }
  workgroupBarrier();
  let source = id.xy * 2u;
  if (source.x < settings.width && source.y < settings.height) {
    let value = luminance(textureLoad(scene,vec2i(source),0).rgb) / max(pre_exposure[0],1e-6);
    if (value >= 0.0009765625 && value <= 32768.0) {
      let t=clamp((log2(value)-MIN_LOG)/(MAX_LOG-MIN_LOG),0.0,1.0);
      atomicAdd(&local_bins[min(BIN_COUNT-1u,u32(t*f32(BIN_COUNT-1u)))],1u);
    }
  }
  workgroupBarrier();
  if (li < BIN_COUNT) { atomicAdd(&histogram.bins[li],atomicLoad(&local_bins[li])); }
}
@group(1) @binding(0) var<storage, read> reduce_histogram:array<u32,128>;
@group(1) @binding(1) var<storage, read> previous:Exposure;
@group(1) @binding(2) var<storage, read_write> next:Exposure;
@group(1) @binding(3) var<uniform> reduce_settings:Settings;
@compute @workgroup_size(1)
fn reduce_main() {
  var total=0u; for(var i=0u;i<BIN_COUNT;i++){ total += reduce_histogram[i]; }
  var cursor=0.0; var weighted=0.0; var accepted=0.0;
  if(total>0u){ for(var i=0u;i<BIN_COUNT;i++){
    let count=f32(reduce_histogram[i]);
    let begin=cursor/f32(total); let end=(cursor+count)/f32(total);
    let overlap=max(0.0,min(end,0.95)-max(begin,0.70));
    weighted += (MIN_LOG+(f32(i)/f32(BIN_COUNT-1u))*(MAX_LOG-MIN_LOG))*overlap*f32(total);
    accepted += overlap*f32(total); cursor += count;
  }}
  let target_luminance=select(exp2(MIN_LOG),exp2(weighted/max(accepted,1.0)),total>0u);
  let target_exposure=0.18/max(target_luminance,1e-7);
  let old=select(target_exposure, max(previous.value,1e-7), reduce_settings.history_valid != 0u);
  let delta=log2(max(target_exposure,1e-7))-log2(old);
  let speed=select(1.2,3.0,delta>0.0);
  let step=min(abs(delta),speed*clamp(reduce_settings.dt,0.0,1.0));
  next.value=exp2(log2(max(old,1e-7))+sign(delta)*step);
}
`;

type Pair = readonly [GPUBuffer, GPUBuffer];
type RadiometryResourceBinder =
  (name: string, resolve: (runtime: GpuRadiometryPass) => GPUBuffer) => ResourceId;

export class GpuRadiometryPass {
  private readonly layout0: GPUBindGroupLayout;
  private readonly layout1: GPUBindGroupLayout;
  private readonly histogramPipeline: GPUComputePipeline;
  private readonly reducePipeline: GPUComputePipeline;
  private readonly buffers: Pair;
  private prepared = false;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private historyValid = false;
  private lastGpuDone: Promise<void> | null = null;

  constructor(private readonly device: GPUDevice) {
    if (device.limits.maxStorageBuffersPerShaderStage < 3) {
      throw new RangeError("GPU radiometry requires three storage buffers");
    }
    this.layout0 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.layout1 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ] });
    const module = device.createShaderModule({ label: "Radiometry GPU P/E", code: WGSL });
    this.histogramPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout0] }),
      compute: { module, entryPoint: "histogram_main" }
    });
    this.reducePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout1] }),
      compute: { module, entryPoint: "reduce_main" }
    });
    this.buffers = [0, 1].map(index => {
      const buffer = device.createBuffer({ label: `Radiometry/P-E/${index}`, size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true });
      new Float32Array(buffer.getMappedRange())[0] = 1;
      buffer.unmap(); return buffer;
    }) as unknown as Pair;
  }

  prepareFrame(readIndex: 0 | 1, writeIndex: 0 | 1, historyValid: boolean): void {
    if (this.prepared) throw new Error("GPU radiometry frame already prepared");
    if (readIndex === writeIndex) throw new Error("GPU radiometry read/write slots alias");
    this.readIndex = readIndex; this.writeIndex = writeIndex;
    this.historyValid = historyValid; this.prepared = true;
  }
  readBuffer(): GPUBuffer { return this.buffers[this.readIndex]; }
  writeBuffer(): GPUBuffer { return this.buffers[this.writeIndex]; }
  importPreExposure(graph: FrameGraph,
    bind: RadiometryResourceBinder): ResourceId {
    void graph;
    return bind("pre-exposure", runtime => runtime.readBuffer());
  }

  addToGraph(graph: FrameGraph, input: { scene: ResourceId; width: number; height: number; deltaTime: number; preExposure?: ResourceId },
    bind: RadiometryResourceBinder): RadiometryProducts {
    if (!this.prepared) throw new Error("GPU radiometry must be prepared before graph build");
    const pre = input.preExposure ?? this.importPreExposure(graph, bind);
    const next = bind("adapted-exposure", runtime => runtime.writeBuffer());
    let histogram = -1;
    const settings = new Uint32Array([input.width, input.height, 0, Number(this.historyValid)]);
    const dtView = new DataView(settings.buffer); dtView.setFloat32(8, Math.max(0, input.deltaTime), true);
    const meter = graph.add("Radiometry/Wicked histogram", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(settings.buffer, GPUBufferUsage.UNIFORM);
      const group = this.device.createBindGroup({ layout: this.layout0, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(data.scene)) },
        { binding: 1, resource: { buffer: resources.get(histogram) as GPUBuffer } },
        { binding: 2, resource: { buffer: constants } },
        { binding: 3, resource: { buffer: resources.get(pre) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Radiometry/Wicked histogram" });
      pass.setPipeline(this.histogramPipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.width / 16), Math.ceil(data.height / 16)); pass.end();
    });
    histogram = meter.create("Radiometry/histogram", { kind: "transient_buffer", size: HISTOGRAM_BYTES,
      usage: GPUBufferUsage.STORAGE, ensure_cleared: [0, HISTOGRAM_BYTES] });
    meter.read(input.scene);
    const reduce = graph.add("Radiometry/adapt exposure", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(settings.buffer, GPUBufferUsage.UNIFORM);
      const group = this.device.createBindGroup({ layout: this.layout1, entries: [
        { binding: 0, resource: { buffer: resources.get(histogram) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(pre) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(next) as GPUBuffer } },
        { binding: 3, resource: { buffer: constants } }
      ] });
      const pass = command.beginComputePass({ label: "Radiometry/adapt exposure" });
      pass.setPipeline(this.reducePipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    });
    reduce.read(histogram); reduce.read(pre); reduce.write(next);
    return { preExposure: pre, adaptedExposure: next };
  }

  commit(gpuDone: Promise<void>): void { if (!this.prepared) throw new Error("GPU radiometry commit without prepare"); this.prepared = false; this.lastGpuDone = gpuDone; }
  abort(): void { this.prepared = false; }
  destroy(): void { for (const buffer of this.buffers) buffer.destroy(); }
}

export const GPU_RADIOMETRY_WGSL = WGSL;
