import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { frameGeometryArenaHeader, frameGeometryArenaLayout, type FrameGeometryArenaBudget,
  type FrameGeometryArenaLayout, type FrameGeometryArenaRegion } from "../gpu/GpuFrameGeometryArenaAbi.js";
import type { GpuStorageRange } from "../gpu/GpuStorageRange.js";

export interface PreparedFrameGeometryArena {
  readonly buffer: GPUBuffer;
  readonly layout: FrameGeometryArenaLayout;
  readonly budget: FrameGeometryArenaBudget;
  readonly sourceDirectory: GpuStorageRange;
  readonly filteredDirectory: GpuStorageRange;
  readonly clips: GpuStorageRange;
  readonly triangles: GpuStorageRange;
  readonly dictionary: GpuStorageRange;
  readonly coefficients: GpuStorageRange;
  readonly work: GpuStorageRange;
  readonly control: GpuStorageRange;
}
interface State { readonly metadata: GPUBuffer; readonly handle?: ResourceHandle; metadataPublished: boolean; }

/** Sole physical owner. Borrowers never destroy subrange storage. Immutable
 * metadata is copied once per committed asset/workset publication, with the
 * same encoder as its consumers; aborted publication remains retryable. */
export class FrameGeometryArena {
  private readonly states = new Map<PreparedFrameGeometryArena, State>();
  private destroyed = false;
  constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting,
    private readonly maxBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("Invalid frame geometry owner budget");
    void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number {
    let bytes = 0; for (const p of this.states.keys()) bytes += p.layout.byteLength; return bytes;
  }
  prepare(metadata: GPUBuffer, metadataBytes: number, budget: FrameGeometryArenaBudget): PreparedFrameGeometryArena {
    if (this.destroyed) throw new Error("Frame geometry arena owner is destroyed");
    const layout = frameGeometryArenaLayout(metadataBytes, budget, this.device.limits);
    if ((metadata.usage & GPUBufferUsage.COPY_SRC) === 0 || metadata.size < metadataBytes ||
      this.allocatedBytes + layout.byteLength > this.maxBytes) {
      throw new RangeError("Frame geometry metadata source or cumulative owner budget is invalid");
    }
    const buffer = this.device.createBuffer({ label: "Geometry shared frame arena", size: layout.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    let handle: ResourceHandle | undefined;
    try {
      new Uint32Array(buffer.getMappedRange(), layout.header.offset, 16).set(frameGeometryArenaHeader(layout, budget));
      buffer.unmap();
      handle = this.accounting?.created({ kind: "buffer", category: "work-cache", owner: "Geometry/FrameGeometryArena", bytes: layout.byteLength,
        label: "Geometry shared frame arena" });
      const range = (r: FrameGeometryArenaRegion): GpuStorageRange => Object.freeze({ buffer, ...r });
      const p = Object.freeze({ buffer, layout, budget: Object.freeze({ ...budget }), sourceDirectory: range(layout.sourceDirectory),
        filteredDirectory: range(layout.filteredDirectory), clips: range(layout.clips), triangles: range(layout.triangles),
        dictionary: range(layout.dictionary), coefficients: range(layout.coefficients), work: range(layout.work), control: range(layout.control) });
      this.states.set(p, { metadata, handle, metadataPublished: false }); return p;
    } catch (error) {
      buffer.destroy(); if (handle) this.accounting?.destroyed(handle); throw error;
    }
  }
  /** Invoke the returned commit only after successful submission of this
   * encoder. Discard it on abort. Zero copies on committed stable frames. */
  encodeMetadataPublication(encoder: GPUCommandEncoder, p: PreparedFrameGeometryArena): () => void {
    const s = this.require(p);
    if (s.metadataPublished) return () => undefined;
    encoder.copyBufferToBuffer(s.metadata, 0, p.buffer, 0, p.layout.metadataBytes);
    return () => { if (this.states.get(p) === s) s.metadataPublished = true; };
  }
  release(p: PreparedFrameGeometryArena): void {
    if (this.destroyed) return;
    const s = this.require(p); this.states.delete(p); p.buffer.destroy();
    if (s.handle) this.accounting?.destroyed(s.handle);
  }
  destroy(): void {
    if (this.destroyed) return;
    for (const p of this.states.keys()) this.release(p);
    this.destroyed = true;
  }
  private require(p: PreparedFrameGeometryArena): State {
    const s = this.states.get(p); if (!s) throw new Error("Frame geometry arena is stale or foreign"); return s;
  }
}
