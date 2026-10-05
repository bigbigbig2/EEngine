import { AtmosphereLutResources } from "./AtmosphereLutResources.js";
import {
  PhysicalEnvironmentState,
  type EnvironmentPublication,
  type PhysicalEnvironmentSnapshot,
} from "./PhysicalEnvironmentState.js";
import { PhysicalSkyIblResources } from "./PhysicalSkyIblResources.js";

/** Production owner for the pinned Takram Earth profile. It never submits. */
export class PhysicalEnvironmentRuntime {
  readonly state = new PhysicalEnvironmentState();
  readonly luts: AtmosphereLutResources;
  readonly ibl: PhysicalSkyIblResources;
  readonly parameters: GPUBuffer;
  private ticket: number | null = null;
  private pendingGeneration: number | null = null;
  private pendingParameters: ArrayBuffer | null = null;
  private activeSkyKey: string | null = null;
  private pendingSkyKey: string | null = null;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    this.luts = new AtmosphereLutResources(device);
    this.ibl = new PhysicalSkyIblResources(device);
    this.parameters = device.createBuffer({
      label: "PhysicalEnvironment/parameters",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  record(
    encoder: GPUCommandEncoder,
    snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">,
    cameraPosition: readonly [number, number, number],
  ): number | null {
    if (this.destroyed) throw new Error("Physical environment runtime is destroyed");
    if (this.ticket !== null) throw new Error("Physical environment submission is already recorded");
    const active = this.state.active?.snapshot;
    const probePosition = cameraPosition.map((value) => Math.round(value / 25) * 25) as unknown as readonly [
      number,
      number,
      number,
    ];
    const skyKey = JSON.stringify([
      snapshot.lutGeneration,
      snapshot.worldToUnit,
      snapshot.sunDirectionWorld.map((value) => Math.round(value / 0.002)),
      Math.round(snapshot.skyLuminanceScale / 0.001),
      probePosition,
    ]);
    if (
      active !== undefined &&
      this.luts.ready &&
      this.ibl.ready &&
      sameEnvironment(active, snapshot) &&
      skyKey === this.activeSkyKey
    )
      return null;
    // The Earth LUT depends on the pinned atmospheric profile, not the sun,
    // scene scale or shadow inputs. Rebuild it only when that profile changes.
    this.ticket =
      this.luts.record(encoder, active !== undefined && active.lutGeneration !== snapshot.lutGeneration) ?? 0;
    try {
      if (!this.ibl.ready || skyKey !== this.activeSkyKey) {
        this.ibl.record(encoder, this.luts.views, this.luts.sampler, snapshot, probePosition);
        this.pendingSkyKey = skyKey;
      }
    } catch (error) {
      this.ibl.abortIfPending();
      if (this.ticket !== 0) this.luts.abort(this.ticket);
      this.ticket = null;
      throw error;
    }
    const generation = this.state.stage(snapshot, true);
    this.pendingParameters = new Float32Array([
      snapshot.sunDirectionWorld[0],
      snapshot.sunDirectionWorld[1],
      snapshot.sunDirectionWorld[2],
      snapshot.worldToUnit,
      snapshot.sunIrradiance[0],
      snapshot.sunIrradiance[1],
      snapshot.sunIrradiance[2],
      generation,
      snapshot.skyLuminanceScale,
    ]).buffer;
    this.pendingGeneration = generation;
    return generation;
  }

  /** Uploads staged environment parameters through the owning frame encoder. */
  writeParameters(writeBuffer: (buffer: GPUBuffer, data: ArrayBuffer) => void): void {
    if (this.pendingParameters === null) throw new Error("Physical environment parameters are not staged");
    writeBuffer(this.parameters, this.pendingParameters);
  }

  commit(generation: number, gpuDone: Promise<unknown>): EnvironmentPublication {
    if (this.pendingGeneration !== generation || this.ticket === null)
      throw new Error("Stale physical environment generation");
    if (this.ticket !== 0) {
      this.luts.commit(this.ticket);
      if (this.luts.hasRetired) this.luts.retireCompleted(this.device.queue.onSubmittedWorkDone());
    }
    if (this.ibl.hasPending) {
      this.ibl.commit(gpuDone);
      this.activeSkyKey = this.pendingSkyKey;
    }
    this.pendingSkyKey = null;
    this.ticket = null;
    this.pendingGeneration = null;
    this.pendingParameters = null;
    return this.state.commit(generation);
  }

  abort(generation: number): void {
    if (this.pendingGeneration !== generation || this.ticket === null)
      throw new Error("Stale physical environment generation");
    if (this.ticket !== 0) this.luts.abort(this.ticket);
    this.ibl.abortIfPending();
    this.pendingSkyKey = null;
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
    this.ibl.destroy();
    this.parameters.destroy();
  }
}

function sameEnvironment(
  active: PhysicalEnvironmentSnapshot,
  next: Omit<PhysicalEnvironmentSnapshot, "generation">,
): boolean {
  return (
    active.lutGeneration === next.lutGeneration &&
    active.worldToUnit === next.worldToUnit &&
    active.skyLuminanceScale === next.skyLuminanceScale &&
    active.sunDirectionWorld.every((value, index) => value === next.sunDirectionWorld[index]) &&
    active.sunIrradiance.every((value, index) => value === next.sunIrradiance[index]) &&
    active.shadowLength.every((value, index) => value === next.shadowLength[index])
  );
}
