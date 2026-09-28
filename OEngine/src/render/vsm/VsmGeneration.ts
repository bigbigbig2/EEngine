/**
 * CPU-owned lifecycle facts for one VSM device epoch.  This object publishes
 * only bounded control facts to the FrameGraph; it never reads GPU demand or
 * decides which virtual pages are resident.
 */
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
  readonly sunRevision: number;
  readonly sunDirection: readonly [number, number, number];
  readonly cameraCut: boolean;
  readonly clipOriginExtent: readonly (readonly [number, number, number, number])[];
  readonly width: number;
  readonly height: number;
}

export interface VsmGenerationState {
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly sceneRevision: number;
  readonly casterRevision: number;
  readonly sunRevision: number;
  readonly reason: VsmInvalidationReason;
  readonly reasonMask: number;
  readonly fullInvalidate: boolean;
  readonly temporalInvalidate: boolean;
  readonly pageQuantumChanged: boolean;
  readonly resized: boolean;
  readonly clipSignature: string;
}

const REASON_MASK: Record<VsmInvalidationReason, number> = {
  initial: 1 << 0,
  "device-epoch": 1 << 1,
  scene: 1 << 2,
  "camera-cut": 1 << 3,
  sun: 1 << 4,
  "caster-publication": 1 << 5,
  resize: 1 << 6,
  "page-quantum": 1 << 7,
  none: 0
};

function finiteRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`VSM ${label} must be a uint32`);
  }
  return value;
}

function clipSignature(levels: readonly (readonly [number, number, number, number])[]): string {
  return levels.map(level => level.map(value => Math.round(value * 1e5) / 1e5).join(",")).join(";");
}

function sameDirection(left: readonly [number, number, number], right: readonly [number, number, number]): boolean {
  return Math.abs(left[0] - right[0]) < 1e-5 &&
    Math.abs(left[1] - right[1]) < 1e-5 && Math.abs(left[2] - right[2]) < 1e-5;
}

/** Monotonic, non-zero generation state. It is reset by constructing a new owner after device loss. */
export class VsmGeneration {
  private generation = 1;
  private previous: {
    readonly deviceEpoch: number;
    readonly scene: object;
    readonly sceneRevision: number;
    readonly casterRevision: number;
    readonly sunRevision: number;
    readonly sunDirection: readonly [number, number, number];
    readonly clipSignature: string;
    readonly width: number;
    readonly height: number;
  } | null = null;

  get currentGeneration(): number { return this.generation; }

  /** Force the next active shadow frame to rebuild page contents. */
  invalidate(): void { this.previous = null; }

  begin(input: VsmGenerationInput): VsmGenerationState {
    finiteRevision(input.deviceEpoch, "device epoch");
    finiteRevision(input.sceneRevision, "scene revision");
    finiteRevision(input.casterRevision, "caster revision");
    finiteRevision(input.sunRevision, "sun revision");
    if (!Number.isSafeInteger(input.width) || input.width < 1 ||
        !Number.isSafeInteger(input.height) || input.height < 1) {
      throw new RangeError("VSM render extent is invalid");
    }
    const signature = clipSignature(input.clipOriginExtent);
    const previous = this.previous;
    let reason: VsmInvalidationReason = "none";
    let fullInvalidate = false;
    let temporalInvalidate = false;
    let pageQuantumChanged = false;
    let resized = false;

    if (previous === null) {
      reason = "initial";
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (previous.deviceEpoch !== input.deviceEpoch) {
      reason = "device-epoch";
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (previous.scene !== input.scene || previous.sceneRevision !== input.sceneRevision) {
      reason = "scene";
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (input.cameraCut) {
      reason = "camera-cut";
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (previous.sunRevision !== input.sunRevision ||
      !sameDirection(previous.sunDirection, input.sunDirection)) {
      reason = "sun";
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (previous.casterRevision !== input.casterRevision) {
      reason = "caster-publication";
      // A caster publication can affect any receiver page. Keep this bounded
      // by invalidating the generation; GPU demand repopulates only visible
      // pages and no CPU page loop is introduced.
      fullInvalidate = true;
      temporalInvalidate = true;
    } else if (previous.width !== input.width || previous.height !== input.height) {
      reason = "resize";
      resized = true;
      temporalInvalidate = true;
    } else if (previous.clipSignature !== signature) {
      reason = "page-quantum";
      pageQuantumChanged = true;
      // The current page-table ABI has no toroidal remap metadata. Until a
      // proven wrapped-page remap is added, a page-quantum shift must not
      // reuse a slot under a new world origin; use the bounded generation
      // fallback and let GPU demand repopulate visible pages.
      fullInvalidate = true;
      temporalInvalidate = true;
    }

    if (fullInvalidate) {
      this.generation = this.generation >= 0xfffffffe ? 1 : this.generation + 1;
    }
    this.previous = {
      deviceEpoch: input.deviceEpoch,
      scene: input.scene,
      sceneRevision: input.sceneRevision,
      casterRevision: input.casterRevision,
      sunRevision: input.sunRevision,
      sunDirection: [...input.sunDirection] as [number, number, number],
      clipSignature: signature,
      width: input.width,
      height: input.height
    };
    return Object.freeze({
      generation: this.generation,
      deviceEpoch: input.deviceEpoch,
      sceneRevision: input.sceneRevision,
      casterRevision: input.casterRevision,
      sunRevision: input.sunRevision,
      reason,
      reasonMask: REASON_MASK[reason],
      fullInvalidate,
      temporalInvalidate,
      pageQuantumChanged,
      resized,
      clipSignature: signature
    });
  }
}

export function vsmInvalidationReasonMask(reason: VsmInvalidationReason): number {
  return REASON_MASK[reason];
}
