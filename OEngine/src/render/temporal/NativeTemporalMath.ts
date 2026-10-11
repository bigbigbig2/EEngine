type Clip = readonly [number, number, number, number];

/** Mirrors the native Temporal publication change detector; equal-content
 * slots remain distinct conservatively, never as exact material identity. */
export function nativeSurfaceTemporalMaterialSignature(input: {
  readonly materialHandle: number;
  readonly instanceFlags: number;
  readonly materialSlot: number;
  readonly signature: number;
  readonly valueRevision: number;
}): number {
  let signature = 2166136261;
  for (const word of [
    input.materialHandle,
    input.instanceFlags,
    input.materialSlot,
    input.signature,
    input.valueRevision,
  ]) {
    if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
      throw new RangeError("Native Temporal material words must be u32");
    }
    signature = Math.imul(signature ^ word, 16777619) >>> 0;
  }
  return signature;
}

/** Current-minus-previous UV; both clips include their own frame's jitter. */
export function nativeSurfaceMotion(current: Clip, previous: Clip, historyValid: boolean) {
  const invalid = { motion: [0, 0] as readonly [number, number], valid: false };
  if (
    !historyValid ||
    !current.every(Number.isFinite) ||
    !previous.every(Number.isFinite) ||
    current[3] <= 1e-6 ||
    previous[3] <= 1e-6 ||
    current[2] < 0 ||
    current[2] > current[3] ||
    previous[2] < 0 ||
    previous[2] > previous[3]
  ) {
    return invalid;
  }
  const currentUv = [(current[0] / current[3]) * 0.5 + 0.5, (current[1] / current[3]) * -0.5 + 0.5];
  const priorUv = [(previous[0] / previous[3]) * 0.5 + 0.5, (previous[1] / previous[3]) * -0.5 + 0.5];
  if (!currentUv.every((v) => v >= 0 && v < 1) || !priorUv.every((v) => v >= 0 && v < 1)) {
    return invalid;
  }
  return { motion: [currentUv[0]! - priorUv[0]!, currentUv[1]! - priorUv[1]!] as const, valid: true };
}

/** Same four lanes as TemporalFacts; signatures are change detectors, not exact IDs. */
export function nativeSurfaceTemporalMask(
  current: readonly [number, number, number, number],
  previous: readonly [number, number, number, number],
  historyValid: boolean,
  motionValid: boolean,
  opaqueReactive: number,
  responseBits: number,
): readonly [number, number, number, number] {
  if (
    !Number.isFinite(opaqueReactive) ||
    !Number.isInteger(responseBits) ||
    responseBits < 0 ||
    responseBits > 255
  ) {
    throw new RangeError("Invalid native Temporal response");
  }
  let mismatch = false;
  let bits = responseBits;
  motionValid = motionValid && historyValid;
  if (historyValid && motionValid) {
    mismatch =
      current[0] === previous[0] &&
      (current[1] !== previous[1] || (current[3] === previous[3] && current[2] !== previous[2]));
    for (let lane = 0; lane < 4; lane++) {
      if (current[lane] !== previous[lane]) {
        bits |= 1 << lane;
      }
    }
  }
  if (!motionValid) {
    bits |= 16;
  }
  return [Math.min(1, Math.max(0, opaqueReactive)), Number(motionValid), Number(mismatch), bits / 255];
}
