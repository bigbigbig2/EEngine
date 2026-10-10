/** CPU transaction for VSM content/projection epochs. Page work stays on GPU. */
export type VsmInvalidationReason =
  | "initial"
  | "device-epoch"
  | "scene"
  | "camera-cut"
  | "sun"
  | "caster-publication"
  | "resize"
  | "page-quantum"
  | "none";
export interface VsmGenerationInput {
  readonly deviceEpoch: number;
  readonly scene: object;
  readonly sceneRevision: number;
  readonly casterRevision: number;
  readonly sourceRevision?: number;
  readonly sunDirection: readonly [number, number, number];
  readonly cameraCut: boolean;
  readonly clipOriginExtent: readonly (readonly [number, number, number, number])[];
  readonly width: number;
  readonly height: number;
}
export interface VsmGenerationState {
  readonly generation: number;
  readonly projectionEpoch: number;
  readonly frameSerial: number;
  readonly deviceEpoch: number;
  readonly sceneRevision: number;
  readonly casterRevision: number;
  readonly reason: VsmInvalidationReason;
  readonly reasonMask: number;
  readonly fullInvalidate: boolean;
  readonly temporalInvalidate: boolean;
  readonly pageQuantumChanged: boolean;
  readonly resized: boolean;
  readonly rebuildDepth: boolean;
}
const REASONS: VsmInvalidationReason[] = [
  "initial",
  "device-epoch",
  "scene",
  "camera-cut",
  "sun",
  "caster-publication",
  "resize",
  "page-quantum"
];
export function vsmInvalidationReasonMask(reason: VsmInvalidationReason): number {
  const index = REASONS.indexOf(reason);
  return index < 0 ? 0 : 1 << index;
}
function advance(value: number): number {
  if (value >= 0xfffffffe) {
    throw new RangeError("VSM epoch exhausted; recreate the device owner namespace");
  }
  return value + 1;
}
/** prepare has no submitted side effects; abort retains the previous epoch/window. */
export class VsmGeneration {
  private generation = 1;
  private projectionEpoch = 1;
  private frameSerial = 0;
  private previous: VsmGenerationInput | null = null;
  private pending: { state: VsmGenerationState; input: VsmGenerationInput } | null = null;
  private forced = true;
  private invalidationSerial = 0;
  private preparedInvalidationSerial = 0;
  get currentGeneration(): number {
    return this.generation;
  }
  get currentProjectionEpoch(): number {
    return this.projectionEpoch;
  }
  invalidate(): void {
    this.forced = true;
    this.invalidationSerial = advance(this.invalidationSerial);
  }
  prepare(input: VsmGenerationInput): VsmGenerationState {
    if (this.pending !== null) {
      throw new Error("VSM already has a pending frame");
    }
    for (const value of [
      input.deviceEpoch,
      input.sceneRevision,
      input.casterRevision,
      input.sourceRevision ?? 0
    ]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError("VSM revision must be uint32");
      }
    }
    if (
      ![input.width, input.height].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !input.sunDirection.every(Number.isFinite) ||
      !input.clipOriginExtent.every((level) => level.every(Number.isFinite))
    ) {
      throw new RangeError("VSM frame inputs must be finite with positive render extent");
    }
    const previous = this.previous;
    const deviceChanged = previous !== null && previous.deviceEpoch !== input.deviceEpoch;
    const sceneChanged =
      previous !== null && (previous.scene !== input.scene || previous.sceneRevision !== input.sceneRevision);
    const sunChanged =
      previous !== null &&
      input.sunDirection.some((value, i) => Math.fround(value) !== Math.fround(previous.sunDirection[i]!));
    const casterChanged =
      previous !== null &&
      (previous.casterRevision !== input.casterRevision || previous.sourceRevision !== input.sourceRevision);
    const profileChanged =
      previous !== null &&
      (previous.clipOriginExtent.length !== input.clipOriginExtent.length ||
        input.clipOriginExtent.some((level, i) => level[2] !== previous.clipOriginExtent[i]?.[2]));
    const pageQuantumChanged =
      previous !== null &&
      input.clipOriginExtent.some(
        (level, i) =>
          level[0] !== previous.clipOriginExtent[i]?.[0] || level[1] !== previous.clipOriginExtent[i]?.[1]
      );
    const resized = previous !== null && (previous.width !== input.width || previous.height !== input.height);
    const fullInvalidate =
      this.forced ||
      previous === null ||
      deviceChanged ||
      sceneChanged ||
      sunChanged ||
      casterChanged ||
      profileChanged;
    const reason: VsmInvalidationReason =
      this.forced || previous === null
        ? "initial"
        : deviceChanged
          ? "device-epoch"
          : sceneChanged
            ? "scene"
            : sunChanged || profileChanged
              ? "sun"
              : casterChanged
                ? "caster-publication"
                : pageQuantumChanged
                  ? "page-quantum"
                  : resized
                    ? "resize"
                    : input.cameraCut
                      ? "camera-cut"
                      : "none";
    const state: VsmGenerationState = Object.freeze({
      generation: fullInvalidate ? advance(this.generation) : this.generation,
      projectionEpoch: fullInvalidate ? advance(this.projectionEpoch) : this.projectionEpoch,
      frameSerial: advance(this.frameSerial),
      deviceEpoch: input.deviceEpoch,
      sceneRevision: input.sceneRevision,
      casterRevision: input.casterRevision,
      reason,
      reasonMask: vsmInvalidationReasonMask(reason),
      fullInvalidate,
      rebuildDepth: fullInvalidate,
      temporalInvalidate: fullInvalidate || input.cameraCut || resized,
      pageQuantumChanged,
      resized,
    });
    this.pending = {
      state,
      input: {
        ...input,
        sunDirection: [...input.sunDirection],
        clipOriginExtent: input.clipOriginExtent.map(
          (level) => [...level] as [number, number, number, number]
        )
      }
    };
    this.preparedInvalidationSerial = this.invalidationSerial;
    return state;
  }
  commit(state: VsmGenerationState): void {
    if (this.pending?.state !== state) {
      throw new Error("VSM commit does not own the pending frame");
    }
    this.previous = this.pending.input;
    this.generation = state.generation;
    this.projectionEpoch = state.projectionEpoch;
    this.frameSerial = state.frameSerial;
    this.pending = null;
    this.forced = this.preparedInvalidationSerial !== this.invalidationSerial;
  }
  abort(): void {
    this.pending = null;
  }
}
