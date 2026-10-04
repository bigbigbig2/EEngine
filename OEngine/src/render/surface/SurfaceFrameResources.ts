import { SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES } from "../../gpu/SurfaceOptimizationCapacity.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
export type SurfaceResourceBinding = <T extends object>(name: string, resolve: () => T) => T;
/** Queue-ordered scratch owned by Surface. Scratch is produced before consumption;
 * persistent cache cells are published by their sole producer and carry exact witnesses. GPU queue order permits reuse while two CPU
 * frames are in flight. Uploads must be encoder copies, never out-of-band writes.
 * Graph imports are late-bound so returning to a cached resize recipe is safe. */
export class SurfaceFrameResources {
    private buffers = new Map<string, {
        buffer: GPUBuffer;
        size: number;
        usage: number;
        handle?: ResourceHandle;
    }>();
    private extent = "";
    private activeBytes = 0;
    private retiredBytes = 0;
    private done: Promise<void> = Promise.resolve();
    constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting, private readonly budgetBytes = SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES) { }
    prepare(width: number, height: number): void {
        const extent = `${width}x${height}`;
        if (this.extent !== extent) {
            this.retire();
            this.extent = extent;
        }
    }
    importBuffer(graph: FrameGraph, bind: SurfaceResourceBinding, name: string, size: number, usage: number): ResourceId {
        if (!Number.isSafeInteger(size) || size < 4 || size > this.device.limits.maxBufferSize ||
            ((usage & GPUBufferUsage.STORAGE) !== 0 && size > this.device.limits.maxStorageBufferBindingSize)) {
            throw new RangeError(`${name} exceeds negotiated Surface resource limits`);
        }
        return graph.import_resource(name, { kind: "imported", label: name, domain: "internal-full" }, bind(`surface-scratch/${name}`, () => {
            let entry = this.buffers.get(name);
            if (entry && (entry.size !== size || entry.usage !== usage))
                throw new Error(`Surface scratch shape changed without prepare: ${name}`);
            if (!entry) {
                if (this.activeBytes + this.retiredBytes + size > this.budgetBytes) {
                    throw new RangeError(`Surface scratch including in-flight retirement exceeds ${this.budgetBytes} bytes`);
                }
                const buffer = this.device.createBuffer({ label: name, size, usage });
                const handle = this.accounting?.created({ kind: "buffer", category: "transient", owner: "Surface/scratch", bytes: size, label: name });
                entry = { buffer, size, usage, ...(handle === undefined ? {} : { handle }) };
                this.buffers.set(name, entry);
                this.activeBytes += size;
            }
            return entry.buffer;
        }));
    }
    physicalBytes(): Readonly<{ active: number; retired: number; budget: number }> { return { active: this.activeBytes, retired: this.retiredBytes, budget: this.budgetBytes }; }
    commit(done: Promise<void>): void { this.done = done; }
    private retire(): void {
        const retired = [...this.buffers.values()];
        this.buffers.clear();
        const bytes = this.activeBytes;
        this.retiredBytes += bytes;
        this.activeBytes = 0;
        const destroy = () => {
            this.retiredBytes -= bytes;
            for (const entry of retired) {
                entry.buffer.destroy();
                if (entry.handle)
                    this.accounting!.destroyed(entry.handle);
            }
        };
        void this.done.then(destroy, destroy);
    }
    destroy(): void { this.retire(); }
}
