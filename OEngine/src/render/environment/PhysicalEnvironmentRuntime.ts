import { AtmosphereLutResources } from "./AtmosphereLutResources.js";
import { PhysicalEnvironmentState, type EnvironmentPublication, type PhysicalEnvironmentSnapshot } from "./PhysicalEnvironmentState.js";

/** Production owner for the pinned Takram Earth profile. It never submits. */
export class PhysicalEnvironmentRuntime {
  readonly state = new PhysicalEnvironmentState();
  readonly luts: AtmosphereLutResources;
  readonly parameters: GPUBuffer;
  private ticket: number | null = null;
  private pendingGeneration: number | null = null;
  private pendingParameters: ArrayBuffer | null = null;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    this.luts = new AtmosphereLutResources(device);
    this.parameters = device.createBuffer({ label: "PhysicalEnvironment/parameters", size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  record(encoder: GPUCommandEncoder, snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">): number | null {
    if (this.destroyed) throw new Error("Physical environment runtime is destroyed");
    if (this.ticket !== null) throw new Error("Physical environment submission is already recorded");
    const active = this.state.active?.snapshot;
    if (active !== undefined && this.luts.ready && sameEnvironment(active, snapshot)) return null;
    this.ticket = this.luts.record(encoder) ?? 0;
    const generation = this.state.stage(snapshot, true);
    this.pendingParameters = new Float32Array([
      snapshot.sunDirectionWorld[0], snapshot.sunDirectionWorld[1], snapshot.sunDirectionWorld[2],
      snapshot.worldToUnit,
      snapshot.sunIrradiance[0], snapshot.sunIrradiance[1], snapshot.sunIrradiance[2],
      generation
    ]).buffer;
    this.pendingGeneration = generation;
    return generation;
  }

  /** Uploads staged environment parameters through the owning frame encoder. */
  writeParameters(writeBuffer: (buffer: GPUBuffer, data: ArrayBuffer) => void): void {
    if (this.pendingParameters === null) throw new Error("Physical environment parameters are not staged");
    writeBuffer(this.parameters, this.pendingParameters);
  }

  commit(generation: number): EnvironmentPublication {
    if (this.pendingGeneration !== generation || this.ticket === null) throw new Error("Stale physical environment generation");
    if (this.ticket !== 0) this.luts.commit(this.ticket);
    this.ticket = null;
    this.pendingGeneration = null;
    this.pendingParameters = null;
    return this.state.commit(generation);
  }

  abort(generation: number): void {
    if (this.pendingGeneration !== generation || this.ticket === null) throw new Error("Stale physical environment generation");
    if (this.ticket !== 0) this.luts.abort(this.ticket);
    this.ticket = null;
    this.pendingGeneration = null;
    this.pendingParameters = null;
    this.state.abort(generation);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ticket !== null && this.ticket !== 0) this.luts.abort(this.ticket);
    this.pendingParameters = null;
    this.luts.destroy();
    this.parameters.destroy();
  }
}

function sameEnvironment(
  active: PhysicalEnvironmentSnapshot,
  next: Omit<PhysicalEnvironmentSnapshot, "generation">
): boolean {
  return active.lutGeneration === next.lutGeneration && active.worldToUnit === next.worldToUnit &&
    active.skyLuminanceScale === next.skyLuminanceScale &&
    active.sunDirectionWorld.every((value, index) => value === next.sunDirectionWorld[index]) &&
    active.sunIrradiance.every((value, index) => value === next.sunIrradiance[index]) &&
    active.shadowLength.every((value, index) => value === next.shadowLength[index]);
}
