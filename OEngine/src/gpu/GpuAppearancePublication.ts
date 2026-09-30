import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { AppearanceProgramRegistry, type AppearanceProgramLease, type AppearanceProgramDescriptor } from "./AppearanceProgramRegistry.js";
import { appearanceResidentKernel, APPEARANCE_ROUTE_STRIDE, type AppearanceResidentKernel,
  type AppearanceSampleResourceProfile } from "../shaders/appearance_resident_kernel.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";

export interface AppearancePublicationSource {
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly program: CompiledAppearanceGraph;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
}

export interface AppearancePublishedEntry {
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly programIndex: number;
  readonly kernel: AppearanceResidentKernel;
  readonly program: CompiledAppearanceGraph;
}

/** Immutable, actual-sized scene publication. Owns buffers and program leases. */
export class GpuAppearancePublication {
  readonly entries: readonly AppearancePublishedEntry[];
  readonly constants: GPUBuffer;
  readonly routes: GPUBuffer;
  /** material slot, program index, constant base, route base; one row per association. */
  readonly directory: GPUBuffer;
  readonly allocatedBytes: number;
  readonly ready: Promise<void>;
  private readonly leases: readonly AppearanceProgramLease[];
  private readonly buffers: GPUBuffer[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private pipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private readonly cancelReadiness: (reason: Error) => void;
  private unwatchRegistry: (() => void) | null = null;
  private readonly destroyedListeners = new Set<() => void>();
  private releasing: ShadeGPUCommandContext | null = null;
  private state: "staging" | "ready" | "resident" | "retiring" | "destroyed" = "staging";

  constructor(private readonly device: GPUDevice, registry: AppearanceProgramRegistry,
    sources: readonly AppearancePublicationSource[], command: ShadeGPUCommandContext,
    mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    private readonly accounting?: ResourceAccounting) {
    if (command.device !== device || command.closed) throw new Error("Appearance requires an open command on its GPUDevice");
    const entries: AppearancePublishedEntry[] = [];
    const leaseList: AppearanceProgramLease[] = [];
    const descriptors: AppearanceProgramDescriptor[] = [];
    const leaseIndices = new Map<string, number>();
    const constants: number[] = [];
    const routes: ArrayBuffer[] = [];
    const directory = new Uint32Array(sources.length * 4);
    try {
      for (const [index, source] of sources.entries()) {
        if (!Number.isInteger(source.materialSlot) || source.materialSlot < 0 || source.materialSlot > 0xffffffff) {
          throw new RangeError("Appearance material slot is not u32");
        }
        const resources: AppearanceSampleResourceProfile[] = [];
        const routeBase = routes.length;
        for (const sample of source.program.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const decoded = decodeGpuTextureRef(ref);
          // Invalid references preserve the published role's semantic fallback;
          // bank 0 exists in every TextureResidency binding set.
          const publication = texturePublications.get(sample.binding.texture);
          const route = packRoute(sample.binding, ref, mipRanges.get(sample.binding.texture), publication);
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          const sampler = (samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3;
          resources.push({ bank: decoded?.bankClass ?? 0, sampler: sampler + (address === 0 ? 0 : address === 2 ? 1 : 2) });
          routes.push(route);
        }
        // A named parameter's numeric values never enter the compiled source.
        const candidate = appearanceResidentKernel(source.program, resources);
        const kernelKey = candidate.lowered.templateKey + ":resident-linear:" + JSON.stringify(resources);
        // Metadata (output names and parameter provenance) belongs to each
        // material program even when its WGSL topology shares the same PSO.
        const kernel = candidate;
        let programIndex = leaseIndices.get(kernelKey);
        if (programIndex === undefined) {
          programIndex = descriptors.length;
          descriptors.push(kernel.descriptor);
          leaseIndices.set(kernelKey, programIndex);
        }
        const constantBase = constants.length;
        // Values must come from this instance even when its topology reuses a kernel.
        constants.push(...candidate.lowered.constants);
        entries.push(Object.freeze({ materialSlot: source.materialSlot, textureBindingSetId: source.textureBindingSetId,
          constantBase, routeBase, programIndex, kernel, program: source.program }));
        directory.set([source.materialSlot, programIndex, constantBase, routeBase], index * 4);
      }
      const constantData = new Float32Array(Math.max(constants.length, 1));
      constantData.set(constants);
      const routeData = new Uint8Array(Math.max(routes.length, 1) * APPEARANCE_ROUTE_STRIDE);
      routes.forEach((route, index) => routeData.set(new Uint8Array(route), index * APPEARANCE_ROUTE_STRIDE));
      const directoryData = sources.length === 0 ? new Uint32Array(4) : directory;
      const maximum = Math.min(Number(device.limits.maxBufferSize), Number(device.limits.maxStorageBufferBindingSize));
      for (const data of [constantData, routeData, directoryData]) if (data.byteLength > maximum) {
        throw new RangeError(`Appearance publication ${data.byteLength} bytes exceed negotiated storage limit ${maximum}`);
      }
      // Publication byte admission precedes every shader/layout/pipeline/buffer creation.
      for (const descriptor of descriptors) leaseList.push(registry.acquire(descriptor));
      this.constants = this.upload(device, command, "constants", constantData);
      this.routes = this.upload(device, command, "routes", routeData);
      this.directory = this.upload(device, command, "directory", directoryData);
      this.allocatedBytes = constantData.byteLength + routeData.byteLength + directoryData.byteLength;
      this.entries = Object.freeze(entries);
      this.leases = Object.freeze(leaseList);
      let cancel!: (reason: Error) => void;
      const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
      this.cancelReadiness = cancel;
      this.ready = Promise.race([cancellation, Promise.all(leaseList.map(lease => lease.ready)).then(pipelines => {
        if (this.state !== "staging") throw new Error("Appearance publication cancelled before program readiness");
        this.pipelines = Object.freeze(pipelines);
        this.state = "ready";
      })]);
      void this.ready.catch(() => undefined);
      command.onBeforeFinish.addOne(() => {
        if (this.state !== "ready") throw new Error("Appearance programs must be ready before scene submission");
      });
      command.onFinished.addOne(() => { if (this.state === "ready") this.state = "resident"; });
      command.onAborted.addOne(() => this.destroy());
      this.unwatchRegistry = registry.onStopped(() => this.destroy());
    } catch (error) {
      for (const lease of leaseList) lease.release();
      for (const buffer of this.buffers) buffer.destroy();
      for (const handle of this.accountingHandles) accounting?.destroyed(handle);
      throw error;
    }
  }

  program(index: number): Awaited<AppearanceProgramLease["ready"]> {
    if (this.state !== "ready" && this.state !== "resident") throw new Error("Appearance publication is not consumable");
    const value = this.pipelines?.[index];
    if (value === undefined) throw new RangeError("Appearance program index is outside this publication");
    return value;
  }

  evidence(): Readonly<{ allocatedBytes: number; residentBytes: number; retiringBytes: number; stagingBytes: number }> {
    const bytes = this.state === "destroyed" ? 0 : this.allocatedBytes;
    return Object.freeze({ allocatedBytes: bytes,
      residentBytes: this.state === "resident" ? bytes : 0,
      retiringBytes: this.state === "retiring" ? bytes : 0,
      stagingBytes: this.state === "staging" || this.state === "ready" ? bytes : 0 });
  }

  onDestroyed(callback: () => void): void {
    if (this.state === "destroyed") callback(); else this.destroyedListeners.add(callback);
  }

  /** Abort preserves the old publication; committed release retires after GPU completion. */
  release(command: ShadeGPUCommandContext): void {
    if (this.state !== "resident" || this.releasing !== null || command.closed || command.device !== this.device) {
      throw new Error("Appearance release requires one open resident transaction on its GPUDevice");
    }
    this.releasing = command;
    command.onAborted.addOne(() => { this.releasing = null; });
    command.onFinished.addOne(() => {
      this.state = "retiring";
      void command.gpuDone.then(() => this.destroy(), () => this.destroy());
    });
  }

  destroy(): void {
    if (this.state === "destroyed") return;
    this.state = "destroyed";
    this.unwatchRegistry?.();
    this.unwatchRegistry = null;
    this.cancelReadiness(new Error("Appearance publication cancelled or destroyed"));
    this.pipelines = null;
    for (const buffer of this.buffers) buffer.destroy();
    for (const handle of this.accountingHandles) this.accounting?.destroyed(handle);
    for (const lease of this.leases) lease.release();
    for (const callback of this.destroyedListeners) callback();
    this.destroyedListeners.clear();
  }

  private upload(device: GPUDevice, command: ShadeGPUCommandContext, name: string, data: Float32Array | Uint8Array | Uint32Array): GPUBuffer {
    const label = `GpuAppearancePublication/${name}`;
    const buffer = device.createBuffer({ label, size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.buffers.push(buffer);
    if (this.accounting !== undefined) this.accountingHandles.push(this.accounting.created({
      kind: "buffer", category: "resident", owner: "GpuAppearancePublication", label, bytes: data.byteLength }));
    command.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buffer;
  }
}

function packRoute(binding: CompiledAppearanceGraph["samples"][number]["binding"], ref: number,
  mipRange: readonly [number, number] | undefined, publication: TextureSurfacePublication | undefined): ArrayBuffer {
  // Sampling author state is the compilation snapshot, not a later mutable texture.
  const samplerSnapshot = { wrapS: binding.sampler[4], wrapT: binding.sampler[5],
    minFilter: binding.sampler[1], magFilter: binding.sampler[2],
    runtime_asset_package_v2: binding.texture.runtime_asset_package_v2 } as ShadeTexture;
  const sampler = encodeSamplerClass(samplerSnapshot, mipRange);
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE);
  const view = new DataView(data);
  [ref, sampler.value, publication?.slot ?? 0, publication?.revision ?? 0]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  const values = [...binding.offset, ...binding.scale, Math.cos(binding.rotation), Math.sin(binding.rotation), 0, 0,
    ...binding.fallback];
  values.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  return data;
}
