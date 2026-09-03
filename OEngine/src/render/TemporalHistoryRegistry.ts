export type TemporalHistoryInvalidationReason =
  | "initial"
  | "camera-cut"
  | "output-resize"
  | "internal-resize"
  | "render-scale"
  | "feature-toggle"
  | "format-change"
  | "view-switch"
  | "lighting-change"
  | "explicit"
  | "abort";

export interface TemporalHistoryRevision {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly camera: number;
  readonly renderScale: number;
  readonly feature: number;
  readonly format: number;
  readonly light: number;
  readonly view: string;
}

export interface TemporalHistoryState {
  readonly name: string;
  readonly active: boolean;
  readonly valid: boolean;
  readonly readIndex: 0 | 1;
  readonly writeIndex: 0 | 1;
  readonly revision: number;
  readonly invalidationCount: number;
  readonly lastInvalidationReason: TemporalHistoryInvalidationReason;
}

type MutableHistoryState = {
  active: boolean;
  valid: boolean;
  committedIndex: 0 | 1;
  produced: boolean;
  revision: number;
  invalidationCount: number;
  lastInvalidationReason: TemporalHistoryInvalidationReason;
};

/**
 * Shared submission-aware invalidation registry for temporal consumers.
 *
 * The registry owns no GPU resource. A pass may expose history only after its
 * producing command was submitted; an aborted frame invalidates every active
 * consumer instead of advancing a frame-index-derived ping-pong slot.
 */
export class TemporalHistoryRegistry {
  private readonly histories = new Map<string, MutableHistoryState>();
  private previousRevision: TemporalHistoryRevision | null = null;
  private activeFrame: number | null = null;
  private activeNames = new Set<string>();

  constructor(names: readonly string[]) {
    for (const name of names) this.register(name);
  }

  register(name: string): void {
    if (name.length === 0) throw new Error("Temporal history name must not be empty");
    if (this.histories.has(name)) return;
    this.histories.set(name, {
      active: false,
      valid: false,
      committedIndex: 0,
      produced: false,
      revision: 0,
      invalidationCount: 0,
      lastInvalidationReason: "initial"
    });
  }

  beginFrame(
    frameIndex: number,
    revision: TemporalHistoryRevision,
    activeNames: readonly string[]
  ): void {
    assertFrameIndex(frameIndex);
    if (this.activeFrame !== null) {
      throw new Error(`Temporal history frame ${this.activeFrame} is still active`);
    }
    validateRevision(revision);
    const nextActive = new Set(activeNames);
    for (const name of nextActive) {
      if (!this.histories.has(name)) {
        throw new Error(`Unknown temporal history '${name}'`);
      }
    }

    const activeChanged = !sameSet(this.activeNames, nextActive);
    const reason = activeChanged
      ? "feature-toggle"
      : invalidationReason(this.previousRevision, revision);
    if (reason !== null) this.invalidate(reason);

    this.activeFrame = frameIndex;
    this.activeNames = nextActive;
    this.previousRevision = { ...revision };
    for (const [name, state] of this.histories) {
      state.active = nextActive.has(name);
      state.produced = false;
    }
  }

  markProduced(name: string): void {
    if (this.activeFrame === null) {
      throw new Error("Temporal history has no active frame");
    }
    const state = this.require(name);
    if (!state.active) {
      throw new Error(`Temporal history '${name}' is not active in this frame`);
    }
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
        committed = true;
      }
    }
    this.activeFrame = null;
    return committed;
  }

  abortFrame(frameIndex: number): void {
    this.assertActiveFrame(frameIndex);
    this.invalidate("abort");
    this.activeFrame = null;
  }

  invalidate(reason: TemporalHistoryInvalidationReason = "explicit"): void {
    for (const state of this.histories.values()) {
      state.valid = false;
      state.produced = false;
      state.revision++;
      state.invalidationCount++;
      state.lastInvalidationReason = reason;
    }
  }

  state(name: string): TemporalHistoryState {
    const state = this.require(name);
    return Object.freeze({
      name,
      active: state.active,
      valid: state.valid,
      readIndex: state.committedIndex,
      writeIndex: otherIndex(state.committedIndex),
      revision: state.revision,
      invalidationCount: state.invalidationCount,
      lastInvalidationReason: state.lastInvalidationReason
    });
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
  if (previous.view !== next.view) return "view-switch";
  if (previous.camera !== next.camera) return "camera-cut";
  if (
    previous.outputWidth !== next.outputWidth ||
    previous.outputHeight !== next.outputHeight
  ) return "output-resize";
  if (
    previous.internalWidth !== next.internalWidth ||
    previous.internalHeight !== next.internalHeight
  ) return "internal-resize";
  if (previous.renderScale !== next.renderScale) return "render-scale";
  if (previous.feature !== next.feature) return "feature-toggle";
  if (previous.format !== next.format) return "format-change";
  if (previous.light !== next.light) return "lighting-change";
  return null;
}

function otherIndex(index: 0 | 1): 0 | 1 {
  return index === 0 ? 1 : 0;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function assertFrameIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("frameIndex must be a non-negative integer");
  }
}

function validateRevision(revision: TemporalHistoryRevision): void {
  for (const [name, value] of Object.entries(revision)) {
    if (name === "view") continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Temporal history revision '${name}' must be a non-negative integer`);
    }
  }
  if (revision.view.length === 0) {
    throw new Error("Temporal history view identity must not be empty");
  }
}
