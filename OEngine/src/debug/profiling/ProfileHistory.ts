import {
  cloneProfileFrame,
  type ProfileFrame,
  type ProfileFramePatch
} from "./ProfileFrame.js";

export type ProfilePatchStatus = "updated" | "orphaned";

export interface ProfilePatchResult {
  readonly status: ProfilePatchStatus;
  readonly frame?: ProfileFrame;
}

export type ProfileHistoryListener = (frame: ProfileFrame) => void;

export class ProfileHistory {
  private readonly frames = new Map<number, ProfileFrame>();
  private readonly listeners = new Set<ProfileHistoryListener>();
  private revisionValue = 0;
  private capacityValue: number;

  constructor(capacity: number = 2048) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be positive");
    this.capacityValue = capacity;
  }

  get revision(): number {
    return this.revisionValue;
  }

  add(frame: ProfileFrame): ProfileFrame {
    if (!Number.isInteger(frame.frameIndex) || frame.frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    validateProfileFrame(frame);
    const frozen = cloneProfileFrame(frame);
    this.frames.set(frozen.frameIndex, frozen);
    while (this.frames.size > this.capacityValue) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
    }
    this.revisionValue++;
    this.notify(frozen);
    return frozen;
  }

  patch(frameIndex: number, patch: ProfileFramePatch): ProfilePatchResult {
    const current = this.frames.get(frameIndex);
    if (current === undefined) return { status: "orphaned" };
    const next = cloneProfileFrame({ ...current, ...patch, frameIndex });
    validateProfileFrame(next);
    validateStateTransitions(current, next);
    this.frames.set(frameIndex, next);
    this.revisionValue++;
    this.notify(next);
    return { status: "updated", frame: next };
  }

  get(frameIndex: number): ProfileFrame | undefined {
    return this.frames.get(frameIndex);
  }

  latest(): ProfileFrame | undefined {
    const last = [...this.frames.keys()].sort((a, b) => a - b).at(-1);
    return last === undefined ? undefined : this.frames.get(last);
  }

  values(): readonly ProfileFrame[] {
    return Object.freeze([...this.frames.values()].sort((a, b) => a.frameIndex - b.frameIndex));
  }

  selectRange(startFrameIndex: number, endFrameIndex: number): ProfileFrame[] {
    if (startFrameIndex > endFrameIndex) throw new RangeError("Invalid frame range");
    return this.values().filter((frame) =>
      frame.frameIndex >= startFrameIndex && frame.frameIndex <= endFrameIndex
    );
  }

  subscribe(listener: ProfileHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.frames.clear();
    this.revisionValue++;
  }

  setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be positive");
    this.capacityValue = capacity;
    while (this.frames.size > this.capacityValue) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
    }
  }

  private notify(frame: ProfileFrame): void {
    for (const listener of this.listeners) listener(frame);
  }
}

function validateProfileFrame(frame: ProfileFrame): void {
  for (const sample of Object.values(frame.samples)) {
    if (sample.value !== null && !Number.isFinite(sample.value)) {
      throw new RangeError(`Profile sample '${sample.metricId}' must be finite or null`);
    }
    if (sample.availability !== "available" && sample.value !== null) {
      throw new TypeError(`Unavailable profile sample '${sample.metricId}' must use null`);
    }
  }
  for (const span of frame.spans) {
    if (span.start !== null && !Number.isFinite(span.start)) throw new RangeError("Profile span start must be finite or null");
    if (span.duration !== null && (!Number.isFinite(span.duration) || span.duration < 0)) {
      throw new RangeError("Profile span duration must be finite and non-negative or null");
    }
    if (span.availability !== "available" && span.duration !== null) {
      throw new TypeError(`Unavailable profile span '${span.name}' must use null duration`);
    }
  }
}

function validateStateTransitions(previous: ProfileFrame, next: ProfileFrame): void {
  for (const [id, before] of Object.entries(previous.samples)) {
    const after = next.samples[id];
    if (after === undefined || before.availability !== "pending") continue;
    if (after.availability === "pending") continue;
    if (!["available", "invalid", "dropped"].includes(after.availability)) {
      throw new Error(`Invalid profile sample state transition for '${id}'`);
    }
  }
}
