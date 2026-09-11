import type { PreExposureContract } from "./pipeline/FrameProducts.js";

export type TemporalHistoryInvalidationReason =
  | "initial"
  | "camera-cut"
  | "output-resize"
  | "internal-resize"
  | "render-scale"
  | "feature-toggle"
  | "format-change"
  | "view-switch"
  | "scene-replace"
  | "lighting-change"
  | "representation-change"
  | "device-loss"
  | "exposure-discontinuity"
  | "explicit"
  | "abort";

export type TemporalHistoryResolutionDomain =
  | "output-full"
  | "internal-full"
  | "effect-resolution"
  | "scalar";

export type TemporalHistoryPreExposureConvention =
  | "none"
  | "working-linear-rescale"
  | "invalidate-on-change";

/** Immutable logical declaration; GPU allocation remains with the effect owner. */
export interface TemporalHistoryDescriptor {
  readonly name: string;
  readonly semantic: string;
  readonly resolutionDomain: TemporalHistoryResolutionDomain;
  readonly format: string;
  readonly bufferCount: number;
  readonly preExposure: TemporalHistoryPreExposureConvention;
}

export interface TemporalHistoryRevision {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly camera: number;
  readonly renderScale: number;
  /** Whole-frame topology generation; catches downstream semantic changes. */
  readonly feature: number;
  readonly format: number;
  readonly light: number;
  readonly scene: number;
  readonly representation: number;
  readonly device: number;
  readonly preExposureGeneration: number;
  readonly view: string;
}

export interface TemporalHistoryState {
  readonly name: string;
  readonly descriptor: TemporalHistoryDescriptor;
  readonly active: boolean;
  readonly valid: boolean;
  /** Validity observed by the most recently begun frame before it wrote back. */
  readonly readValid: boolean;
  readonly readIndex: 0 | 1;
  readonly writeIndex: 0 | 1;
  readonly revision: number;
  readonly invalidationCount: number;
  readonly lastInvalidationReason: TemporalHistoryInvalidationReason;
  /** Current/committed multiplier for scalable HDR histories; zero rejects. */
  readonly preExposureScale: number;
}

type MutableHistoryState = {
  descriptor: TemporalHistoryDescriptor;
  active: boolean;
  valid: boolean;
  committedIndex: 0 | 1;
  produced: boolean;
  revision: number;
  invalidationCount: number;
  lastInvalidationReason: TemporalHistoryInvalidationReason;
  committedPreExposure: PreExposureContract | null;
  lastReadValid: boolean;
  lastReadPreExposureScale: number;
};

/**
 * Submission-aware lifecycle registry shared by every persistent frame history.
 *
 * Logical identity, validity, ping-pong advancement and pre-exposure metadata
 * live here. Effect owners still allocate their own typed GPU textures/buffers;
 * matching descriptors never authorize cross-semantic history reuse.
 */
export class TemporalHistoryRegistry {
  private readonly histories = new Map<string, MutableHistoryState>();
  private previousRevision: TemporalHistoryRevision | null = null;
  private activeFrame: number | null = null;
  private activePreExposure: PreExposureContract | null = null;

  constructor(descriptors: readonly TemporalHistoryDescriptor[]) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: TemporalHistoryDescriptor): void {
    validateDescriptor(descriptor);
    if (this.histories.has(descriptor.name)) {
      throw new Error(`Temporal history '${descriptor.name}' is already registered`);
    }
    this.histories.set(descriptor.name, {
      descriptor: Object.freeze({ ...descriptor }),
      active: false,
      valid: false,
      committedIndex: 0,
      produced: false,
      revision: 0,
      invalidationCount: 0,
      lastInvalidationReason: "initial",
      committedPreExposure: null,
      lastReadValid: false,
      lastReadPreExposureScale: 0
    });
  }

  beginFrame(
    frameIndex: number,
    revision: TemporalHistoryRevision,
    activeNames: readonly string[],
    preExposure: PreExposureContract
  ): void {
    assertFrameIndex(frameIndex);
    if (this.activeFrame !== null) {
      throw new Error(`Temporal history frame ${this.activeFrame} is still active`);
    }
    validateRevision(revision);
    validatePreExposure(preExposure);
    const nextActive = new Set(activeNames);
    for (const name of nextActive) {
      if (!this.histories.has(name)) throw new Error(`Unknown temporal history '${name}'`);
    }

    const firstFrame = this.previousRevision === null;
    const globalReason = invalidationReason(this.previousRevision, revision);
    if (globalReason !== null) this.invalidateForReason(globalReason);

    this.activeFrame = frameIndex;
    this.activePreExposure = Object.freeze({ ...preExposure });

    for (const [name, state] of this.histories) {
      const next = nextActive.has(name);
      // The initial global invalidation establishes every declaration once.
      // Do not immediately overwrite its evidence with a second toggle reset.
      if (
        !firstFrame &&
        globalReason !== "feature-toggle" &&
        state.active !== next
      ) invalidateState(state, "feature-toggle");
      state.active = next;
      state.produced = false;
      state.lastReadValid = next && state.valid;
      state.lastReadPreExposureScale = next ? this.currentPreExposureScale(state) : 0;
    }

    this.previousRevision = { ...revision };
  }

  markProduced(name: string): void {
    if (this.activeFrame === null) throw new Error("Temporal history has no active frame");
    const state = this.require(name);
    if (!state.active) throw new Error(`Temporal history '${name}' is not active in this frame`);
    state.produced = true;
  }

  commitFrame(frameIndex: number): boolean {
    this.assertActiveFrame(frameIndex);
    let committed = false;
    for (const state of this.histories.values()) {
      if (state.active && state.produced) {
        state.committedIndex = otherIndex(state.committedIndex);
        state.valid = true;
        state.produced = false;
        state.committedPreExposure = state.descriptor.preExposure === "none"
          ? null
          : Object.freeze({ ...this.activePreExposure! });
        committed = true;
      }
    }
    this.activeFrame = null;
    this.activePreExposure = null;
    return committed;
  }

  abortFrame(frameIndex: number): void {
    this.assertActiveFrame(frameIndex);
    for (const state of this.histories.values()) {
      if (state.active) invalidateState(state, "abort");
    }
    this.activeFrame = null;
    this.activePreExposure = null;
  }

  invalidate(reason: TemporalHistoryInvalidationReason = "explicit"): void {
    for (const state of this.histories.values()) invalidateState(state, reason);
  }

  invalidateNames(
    names: readonly string[],
    reason: TemporalHistoryInvalidationReason = "explicit"
  ): void {
    const unique = new Set(names);
    for (const name of unique) invalidateState(this.require(name), reason);
  }

  state(name: string): TemporalHistoryState {
    const state = this.require(name);
    return Object.freeze({
      name,
      descriptor: state.descriptor,
      active: state.active,
      valid: state.valid,
      readValid: state.lastReadValid,
      readIndex: state.committedIndex,
      writeIndex: otherIndex(state.committedIndex),
      revision: state.revision,
      invalidationCount: state.invalidationCount,
      lastInvalidationReason: state.lastInvalidationReason,
      preExposureScale: !state.valid
        ? 0
        : this.activeFrame === null
          ? state.lastReadPreExposureScale
          : this.currentPreExposureScale(state)
    });
  }

  descriptors(): readonly TemporalHistoryDescriptor[] {
    return Object.freeze([...this.histories.values()].map((state) => state.descriptor));
  }

  private currentPreExposureScale(state: MutableHistoryState): number {
    if (!state.valid) return 0;
    if (state.descriptor.preExposure === "none") return 1;
    if (state.descriptor.preExposure === "invalidate-on-change") return 1;
    const current = this.activePreExposure;
    const committed = state.committedPreExposure;
    if (current === null || committed === null ||
        current.generation !== committed.generation) return 0;
    return current.multiplier / committed.multiplier;
  }

  private invalidateForReason(reason: TemporalHistoryInvalidationReason): void {
    for (const state of this.histories.values()) {
      if (
        reason === "exposure-discontinuity" &&
        state.descriptor.preExposure === "none"
      ) continue;
      invalidateState(state, reason);
    }
  }

  private require(name: string): MutableHistoryState {
    const state = this.histories.get(name);
    if (state === undefined) throw new Error(`Unknown temporal history '${name}'`);
    return state;
  }

  private assertActiveFrame(frameIndex: number): void {
    assertFrameIndex(frameIndex);
    if (this.activeFrame !== frameIndex) {
      throw new Error(
        `Temporal history frame ${frameIndex} does not match active frame ${this.activeFrame}`
      );
    }
  }
}

function invalidationReason(
  previous: TemporalHistoryRevision | null,
  next: TemporalHistoryRevision
): TemporalHistoryInvalidationReason | null {
  if (previous === null) return "initial";
  if (previous.device !== next.device) return "device-loss";
  if (previous.scene !== next.scene) return "scene-replace";
  if (previous.view !== next.view) return "view-switch";
  if (previous.camera !== next.camera) return "camera-cut";
  if (previous.outputWidth !== next.outputWidth || previous.outputHeight !== next.outputHeight) {
    return "output-resize";
  }
  if (previous.internalWidth !== next.internalWidth || previous.internalHeight !== next.internalHeight) {
    return "internal-resize";
  }
  if (previous.renderScale !== next.renderScale) return "render-scale";
  if (previous.format !== next.format) return "format-change";
  // A topology change can alter an otherwise still-active downstream color
  // history (for example SSR on -> off while TAA stays enabled).  Treat the
  // whole frame product generation as changed; active-name diffs alone are
  // insufficient to detect that dependency.
  if (previous.feature !== next.feature) return "feature-toggle";
  if (previous.light !== next.light) return "lighting-change";
  if (previous.representation !== next.representation) return "representation-change";
  if (previous.preExposureGeneration !== next.preExposureGeneration) {
    return "exposure-discontinuity";
  }
  return null;
}

function invalidateState(
  state: MutableHistoryState,
  reason: TemporalHistoryInvalidationReason
): void {
  state.valid = false;
  state.produced = false;
  state.committedPreExposure = null;
  state.lastReadValid = false;
  state.lastReadPreExposureScale = 0;
  state.revision++;
  state.invalidationCount++;
  state.lastInvalidationReason = reason;
}

function validateDescriptor(descriptor: TemporalHistoryDescriptor): void {
  if (descriptor.name.length === 0 || descriptor.semantic.length === 0) {
    throw new Error("Temporal history name and semantic must not be empty");
  }
  if (descriptor.format.length === 0) throw new Error("Temporal history format must not be empty");
  if (!Number.isInteger(descriptor.bufferCount) || descriptor.bufferCount <= 0) {
    throw new RangeError("Temporal history bufferCount must be a positive integer");
  }
}

function otherIndex(index: 0 | 1): 0 | 1 {
  return index === 0 ? 1 : 0;
}

function assertFrameIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("frameIndex must be a non-negative integer");
  }
}

function validateRevision(revision: TemporalHistoryRevision): void {
  const integerFields: ReadonlyArray<readonly [string, number]> = [
    ["outputWidth", revision.outputWidth],
    ["outputHeight", revision.outputHeight],
    ["internalWidth", revision.internalWidth],
    ["internalHeight", revision.internalHeight],
    ["camera", revision.camera],
    ["feature", revision.feature],
    ["format", revision.format],
    ["light", revision.light],
    ["scene", revision.scene],
    ["representation", revision.representation],
    ["device", revision.device],
    ["preExposureGeneration", revision.preExposureGeneration]
  ];
  for (const [name, value] of integerFields) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Temporal history revision '${name}' must be a non-negative integer`);
    }
  }
  if (!Number.isFinite(revision.renderScale) || revision.renderScale <= 0) {
    throw new RangeError("Temporal history renderScale must be finite and positive");
  }
  if (revision.view.length === 0) throw new Error("Temporal history view identity must not be empty");
}

function validatePreExposure(value: PreExposureContract): void {
  if (!Number.isFinite(value.multiplier) || value.multiplier <= 0 ||
      !Number.isInteger(value.generation) || value.generation < 0 ||
      value.colorSpace !== "working-linear") {
    throw new Error("Temporal history pre-exposure contract is invalid");
  }
}
