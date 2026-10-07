/** Exact Closure Cache Publication. These regions live in the existing Surface
 * control allocation, so Product workers retain the 16-storage binding profile.
 * Requests/nomination/maps are frame scratch; store cells survive queue-ordered
 * frames until the Surface resource recipe retires behind its submission fence. */
export const APPEARANCE_CACHE_HEADER = 304;
export const APPEARANCE_CACHE_BINS = 32;
export const APPEARANCE_CACHE_KEY_WORDS = 96;
/** Bounded per-request guide continuation: tangent/sign, normal TS/validity,
 * coat TS/validity. Residual fields are already in their final destinations. */
export const APPEARANCE_CACHE_CONTINUATION_OFFSET = 8 + APPEARANCE_CACHE_KEY_WORDS + 4;
export const APPEARANCE_CACHE_REQUEST_WORDS = APPEARANCE_CACHE_CONTINUATION_OFFSET + 12;
export const APPEARANCE_CACHE_CELL_WORDS = 4 + APPEARANCE_CACHE_KEY_WORDS + 4;
export const APPEARANCE_CACHE_PROBES = 4;
export const APPEARANCE_CACHE_STORED_REF = 0x80000000;

export interface AppearanceClosureCacheCapacity {
  readonly keyWords: number;
  readonly requestWords: number;
  readonly cellWords: number;
  readonly perBin: number;
  readonly slots: number;
  readonly mapBase: number;
  readonly requestBase: number;
  readonly nominationBase: number;
  readonly storeBase: number;
  readonly binBase: number;
  readonly queueBase: number;
  readonly argsBase: number;
  readonly end: number;
  readonly bytes: number;
  readonly persistentBytes: number;
}

/** Optional allocation. Failure admits no request and leaves mandatory Surface
 * destinations untouched. Complete keys beyond this profile always run direct. */
export function planAppearanceClosureCache(
  base: number,
  pixels: number,
  maximumBytes: number,
  enabled: boolean,
  requestedPerBin = 128,
  keyWords = APPEARANCE_CACHE_KEY_WORDS,
  screenWorkingSet = false,
): AppearanceClosureCacheCapacity {
  if (
    ![base, pixels, maximumBytes, requestedPerBin, keyWords].every(Number.isSafeInteger) ||
    base < 0 ||
    pixels < 0 ||
    maximumBytes < 0 ||
    requestedPerBin < 0 ||
    requestedPerBin > 65536 || keyWords < 1 || keyWords > APPEARANCE_CACHE_KEY_WORDS
  ) {
    throw new RangeError("Invalid exact Appearance cache capacity");
  }
  const disabled = Object.freeze({
    keyWords,
    requestWords: 24 + keyWords,
    cellWords: 8 + keyWords,
    perBin: 0,
    slots: 0,
    mapBase: base,
    requestBase: base,
    nominationBase: base,
    storeBase: base,
    binBase: base,
    queueBase: base,
    argsBase: base,
    end: base,
    bytes: 0,
    persistentBytes: 0,
  });
  if (!enabled || requestedPerBin === 0) {
    return disabled;
  }
  const perBin = Math.min(requestedPerBin, Math.max(1, Math.ceil(pixels / 4)));
  const requests = perBin * APPEARANCE_CACHE_BINS;
  const requestWords = 24 + keyWords;
  const cellWords = 8 + keyWords;
  const minimumSlots = 2 ** Math.ceil(Math.log2(requests * 2));
  const fixedWords = base + pixels + requests * (requestWords + 1) + APPEARANCE_CACHE_BINS * 6;
  const affordableSlots = Math.floor((maximumBytes / 4 - fixedWords) / (cellWords + 1));
  const maximumSlots = affordableSlots > 0 ? 2 ** Math.floor(Math.log2(affordableSlots)) : 0;
  const desiredSlots = screenWorkingSet ? 2 ** Math.ceil(Math.log2(Math.max(1, pixels))) : minimumSlots;
  const slots = Math.min(maximumSlots, Math.max(minimumSlots, desiredSlots));
  if (slots < minimumSlots) {
    return disabled;
  }
  const mapBase = base;
  const requestBase = mapBase + pixels;
  const nominationBase = requestBase + requests * requestWords;
  const binBase = nominationBase + slots;
  // Each bin owns a request counter and a unique-miss counter.
  const queueBase = binBase + APPEARANCE_CACHE_BINS * 2;
  const argsBase = queueBase + requests;
  const storeBase = argsBase + APPEARANCE_CACHE_BINS * 4;
  const end = storeBase + slots * cellWords;
  if (!Number.isSafeInteger(end) || end >= 0x80000000 || end * 4 > maximumBytes) {
    return disabled;
  }
  return Object.freeze({
    keyWords,
    requestWords,
    cellWords,
    perBin,
    slots,
    mapBase,
    requestBase,
    nominationBase,
    storeBase,
    binBase,
    queueBase,
    argsBase,
    end,
    bytes: (end - base) * 4,
    persistentBytes: slots * APPEARANCE_CACHE_CELL_WORDS * 4,
  });
}
