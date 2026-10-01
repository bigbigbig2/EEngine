import { appearancePageLayout, APPEARANCE_CACHE_CONTROL_BYTES, type AppearanceCacheBudget, DEFAULT_APPEARANCE_CACHE_BUDGET } from "./GpuAppearanceCacheAbi.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { writeGpuBuffer } from "./GpuQueueEvidence.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

const CACHE_WGSL = /* wgsl */ `
struct Settings { pages: u32, samples: u32, stride: u32, max_age: u32, frame: u32, reserved: vec3u }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> cells: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> control: array<atomic<u32>>;
@compute @workgroup_size(64)
fn reset(@builtin(global_invocation_id) id: vec3u) {
  let sample = id.x + id.y * 64u * 65535u;
  if sample >= settings.samples { return; }
  let at = sample * settings.stride;
  atomicStore(&cells[at], 0u); atomicStore(&cells[at + 1u], 0xffffffffu);
  atomicStore(&cells[at + 2u], 0xffffffffu); atomicStore(&cells[at + 3u], 0u);
  atomicStore(&cells[at + 4u], 0xffffffffu);
}
@compute @workgroup_size(1)
fn begin() { atomicStore(&control[0], 0u); atomicStore(&control[1], 0u); atomicStore(&control[2], settings.frame); }
@compute @workgroup_size(64)
fn evict(@builtin(global_invocation_id) id: vec3u) {
  let sample = id.x + id.y * 64u * 65535u;
  if sample >= settings.samples { return; }
  let at = sample * settings.stride;
  let state = atomicLoad(&cells[at]);
  let age = atomicLoad(&cells[at + 3u]);
  if state == 2u && settings.frame - age > settings.max_age { atomicStore(&cells[at], 0u); atomicAdd(&control[1], 1u); }
}
`;
export interface PreparedAppearanceCache {
  readonly settings: GPUBuffer; readonly cells: GPUBuffer; readonly control: GPUBuffer;
  readonly pages: number; readonly fieldCount: number; readonly sampleStride: number; readonly allocatedBytes: number;
}

/** Persistent GPU owner for field pages. Request/evaluate/publish consumers own
 * task buffers; this owner owns only page state and bounded eviction. Every
 * write is published between dispatches, so consumers never see half a value. */
export class GpuAppearanceCache {
  readonly ready: Promise<void>;
  private readonly states = new Set<PreparedAppearanceCache>();
  private readonly pipelines: Promise<readonly GPUComputePipeline[]>;
  private compiled: readonly GPUComputePipeline[] | null = null;
  private destroyed = false;
  constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting,
    private readonly budget: AppearanceCacheBudget = DEFAULT_APPEARANCE_CACHE_BUDGET) {
    if (!Number.isInteger(budget.pages) || budget.pages < 1 || (budget.pages & (budget.pages - 1)) !== 0) throw new RangeError("Appearance cache pages must be a power of two");
    const module = device.createShaderModule({ label: "Appearance cache pages", code: CACHE_WGSL });
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.pipelines = Promise.all(["reset", "begin", "evict"].map(entryPoint => device.createComputePipelineAsync({
      label: `Appearance cache/${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint }
    })));
    this.ready = this.pipelines.then(pipelines => { this.compiled = pipelines; });
    void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number { let total = 0; for (const state of this.states) total += state.allocatedBytes; return total; }
  prepare(inputVectors: number, width: number, fieldCount = 1): PreparedAppearanceCache {
    if (this.destroyed) throw new Error("Appearance cache owner is destroyed");
    const layout = appearancePageLayout(inputVectors, width, this.budget.pages);
    if (!Number.isInteger(fieldCount) || fieldCount < 1 || fieldCount > 64) throw new RangeError("Appearance cache field count is invalid");
    const stride = layout.strideWords, cells = layout.samples * fieldCount;
    const bytes = cells * stride * 4 + APPEARANCE_CACHE_CONTROL_BYTES + 32;
    if (bytes > this.budget.maxBytes || bytes > Number(this.device.limits.maxStorageBufferBindingSize)) throw new RangeError("Appearance cache exceeds negotiated budget");
    const make = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => this.device.createBuffer({ label, size, usage });
    const settings = make("Appearance cache settings", 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const cellsBuffer = make("Appearance cache pages", cells * stride * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const control = make("Appearance cache control", APPEARANCE_CACHE_CONTROL_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    writeGpuBuffer(this.device.queue, "Appearance/cache-settings", settings, 0, new Uint32Array([this.budget.pages, cells, stride, this.budget.maxAge, 0, 0, 0, 0]));
    const prepared = Object.freeze({ settings, cells: cellsBuffer, control, pages: this.budget.pages, fieldCount, sampleStride: stride, allocatedBytes: bytes });
    this.states.add(prepared); return prepared;
  }
  encode(command: ShadeGPUCommandContext, cache: PreparedAppearanceCache, frame: number): void {
    if (command.device !== this.device || command.closed) throw new Error("Appearance cache requires an open frame command");
    const pipelines = this.compiled;
    if (pipelines === null) throw new Error("Appearance cache pipelines are not ready");
    command.writeBuffer(cache.settings, 16, new Uint32Array([frame]).buffer, 0, 4);
    {
      const group = this.device.createBindGroup({ layout: pipelines[0]!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: cache.settings } }, { binding: 1, resource: { buffer: cache.cells } }, { binding: 2, resource: { buffer: cache.control } }
      ] });
      const pass = command.gpu_encoder.beginComputePass({ label: "Appearance cache state" });
      pass.setBindGroup(0, group); pass.setPipeline(pipelines[1]!); pass.dispatchWorkgroups(1);
      pass.setPipeline(pipelines[2]!); pass.dispatchWorkgroups(Math.ceil(cache.pages * cache.fieldCount)); pass.end();
    }
  }
  release(cache: PreparedAppearanceCache): void { if (!this.states.delete(cache)) throw new Error("Appearance cache allocation is stale"); cache.settings.destroy(); cache.cells.destroy(); cache.control.destroy(); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; for (const cache of this.states) this.release(cache); }
}
