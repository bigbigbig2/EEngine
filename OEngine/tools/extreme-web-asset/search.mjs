import { createHash } from "node:crypto";

export const searchQualities = Object.freeze([95, 90, 85, 80, 75, 70, 60, 50, 40, 30]);
const hashPattern = /^[a-f0-9]{64}$/;
const anchors = Object.freeze({ high: 80, extreme: 50 });

export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Object key order is not part of a recipe; array order and numeric types are. */
export function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Search identities require finite JSON values without undefined or opaque objects");
}

export function searchIdentity(identity) {
  // The adapter owns full material/metric interpretation, not a quality threshold
  // guessed here. Its source, runtime, browser and device profile are mandatory.
  for (const key of ["canonical", "recipe", "encoder", "argv", "target", "evaluator", "metrics", "device"]) {
    if (!hashPattern.test(identity[key])) throw new Error(`Missing immutable search identity: ${key}`);
  }
  return contentHash(stableJson({ version: 1, ...identity }));
}

export function candidatesFor(quality, virtual = false) {
  if (!(quality in anchors)) throw new Error("Unknown image quality tier");
  const anchor = anchors[quality];
  const result = [{ quality: anchor, speed: 4, cell: virtual ? 512 : null, donor: true }];
  for (const cell of virtual ? [128, 256, 512] : [null]) {
    for (const q of searchQualities) {
      for (const speed of [4, 2]) {
        if (q === anchor && speed === 4 && cell === result[0].cell) continue;
        result.push({ quality: q, speed, cell, donor: false });
      }
    }
  }
  return Object.freeze(result.map(Object.freeze));
}

/** Metrics are a named vector. Higher is better for perceptual scores; all
 * errors/costs are lower-is-better. Equality retains the donor's own budget. */
export function validateEvaluation(value, semantic) {
  if (
    !value ||
    value.representation !== "gpu-final" ||
    !hashPattern.test(value.identity) ||
    !hashPattern.test(value.inputHash) ||
    typeof value.hardSemantics !== "boolean"
  ) {
    throw new Error("Search requires a provenance-checked final GPU evaluation");
  }
  const required = semantic.startsWith("color-")
    ? ["perceptual", "alphaMax", "boundaryMax", "materialError"]
    : semantic === "normal-xy"
      ? ["angleP50", "angleP95", "angleP99", "angleMax", "materialError", "boundaryMax"]
      : semantic === "moment-xyz"
        ? ["xyzMax", "lengthMax", "materialError", "boundaryMax"]
        : ["channelR", "channelG", "channelB", "materialError", "boundaryMax"];
  if (!value.metrics || required.some((key) => !Number.isFinite(value.metrics[key]))) {
    throw new Error(`Incomplete ${semantic} final GPU quality vector`);
  }
  if (Object.values(value.metrics).some((metric) => !Number.isFinite(metric)))
    throw new Error("Non-finite quality metric");
  for (const [key, metric] of Object.entries(value.metrics)) {
    if (key !== "perceptual" && metric < 0) throw new Error("Negative error metric");
  }
  if (
    value.metrics.perceptual !== undefined &&
    (value.metrics.perceptual < -1 || value.metrics.perceptual > 1)
  ) {
    throw new Error("Perceptual SSIM metric outside its declared domain");
  }
  return value;
}

export function donorRelativeAccept(candidate, donor, semantic) {
  validateEvaluation(candidate, semantic);
  validateEvaluation(donor, semantic);
  if (candidate.identity !== donor.identity) throw new Error("Evaluation environment changed during search");
  if (!candidate.hardSemantics) return false;
  if (Object.keys(candidate.metrics).sort().join("/") !== Object.keys(donor.metrics).sort().join("/")) {
    throw new Error("Candidate and donor use different quality vector contracts");
  }
  return Object.entries(donor.metrics).every(([key, expected]) =>
    key === "perceptual" ? candidate.metrics[key] >= expected : candidate.metrics[key] <= expected
  );
}

/** Exhaustive finite enumeration: neither AV1 size nor final BC quality is
 * assumed monotonic in Q/speed/cell. No passing result means no publication. */
export async function selectImageCandidate({ quality, semantic, virtual = false, evaluate, signal }) {
  const candidates = candidatesFor(quality, virtual);
  const rows = [];
  let donor;
  let selected;
  for (let index = 0; index < candidates.length; index++) {
    signal?.throwIfAborted();
    const candidate = candidates[index];
    const result = await evaluate(candidate, index);
    signal?.throwIfAborted();
    validateEvaluation(result.evaluation, semantic);
    if (
      !Number.isSafeInteger(result.deliveryBytes) ||
      result.deliveryBytes < 1 ||
      !Number.isFinite(result.encodeMs) ||
      result.encodeMs < 0
    )
      throw new Error("Invalid candidate byte/cost receipt");
    if (index === 0) {
      donor = result;
      if (!result.evaluation.hardSemantics)
        throw new Error("Donor fails hard semantics; product is not publishable");
    }
    const accepted = donorRelativeAccept(result.evaluation, donor.evaluation, semantic);
    const row = { candidate, ...result, accepted };
    rows.push(row);
    if (accepted && (!selected || row.deliveryBytes < selected.deliveryBytes)) selected = row;
  }
  if (!selected) throw new Error("No qualified image candidate");
  return Object.freeze({
    quality,
    semantic,
    selected,
    donor: rows[0],
    rows: Object.freeze(rows),
    scope: "bounded offline selection; not a full-scene quality or performance qualification"
  });
}
