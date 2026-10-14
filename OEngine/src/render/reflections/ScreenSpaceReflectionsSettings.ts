/** Full-resolution opaque reflections. Settings are device independent; changes
 * are applied to a submitted frame atomically. Invalid patches throw and leave
 * the caller's immutable snapshot intact. Cost scales with eligible ray/tile work. */
export interface ScreenSpaceReflectionsSettings {
  readonly enabled: boolean;
  readonly strength: number;
  readonly quality: "balanced" | "high";
  readonly maxRoughness: number;
  readonly thicknessMeters: number;
  readonly metersPerWorldUnit: number;
  readonly temporalStability: number;
}

export const SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS: Readonly<ScreenSpaceReflectionsSettings> =
  Object.freeze({
    enabled: false,
    strength: 1,
    quality: "balanced",
    maxRoughness: Math.sqrt(0.2),
    thicknessMeters: 0.015,
    metersPerWorldUnit: 1,
    temporalStability: 0.7
  });

const MIN_NORMAL_F32 = 2 ** -126;

export function resolveScreenSpaceReflectionsSettings(
  current: ScreenSpaceReflectionsSettings,
  patch: Partial<ScreenSpaceReflectionsSettings>
): Readonly<ScreenSpaceReflectionsSettings> {
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS, key)) {
      throw new RangeError(`Unknown screen-space reflection setting '${key}'`);
    }
  }
  const next = { ...current, ...patch };
  if (typeof next.enabled !== "boolean" || (next.quality !== "balanced" && next.quality !== "high")) {
    throw new RangeError("Reflections require boolean enabled and balanced/high quality");
  }
  for (const name of ["strength", "temporalStability"] as const) {
    if (!Number.isFinite(next[name]) || next[name] < 0 || next[name] > 1) {
      throw new RangeError(`Reflections ${name} must be finite in [0, 1]`);
    }
  }
  for (const name of ["maxRoughness", "thicknessMeters", "metersPerWorldUnit"] as const) {
    if (
      !Number.isFinite(next[name]) ||
      Math.fround(next[name]) < MIN_NORMAL_F32 ||
      !Number.isFinite(Math.fround(next[name]))
    ) {
      throw new RangeError(`Reflections ${name} must be positive finite f32`);
    }
  }
  if (next.maxRoughness > 1) {
    throw new RangeError("Reflections maxRoughness must be in (0, 1]");
  }
  const thickness = Math.fround(next.thicknessMeters / next.metersPerWorldUnit);
  const alpha = Math.fround(next.maxRoughness * next.maxRoughness);
  if (!Number.isFinite(thickness) || thickness < MIN_NORMAL_F32 || alpha < MIN_NORMAL_F32) {
    throw new RangeError("Reflections derived thickness/roughness exceed f32 capacity");
  }
  return Object.keys(next).every(
    (key) =>
      next[key as keyof ScreenSpaceReflectionsSettings] ===
      current[key as keyof ScreenSpaceReflectionsSettings]
  )
    ? current
    : Object.freeze(next);
}

/** Strength is a final color correction, independent of the accumulated signal. */
export function screenSpaceReflectionsHistoryKey(settings: ScreenSpaceReflectionsSettings): string {
  return JSON.stringify([
    settings.quality,
    Math.fround(settings.maxRoughness ** 2),
    Math.fround(settings.thicknessMeters / settings.metersPerWorldUnit),
    Math.fround(settings.metersPerWorldUnit),
    Math.fround(settings.temporalStability)
  ]);
}
