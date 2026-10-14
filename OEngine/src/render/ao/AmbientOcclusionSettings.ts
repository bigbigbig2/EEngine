import {
  XE_GTAO_DEFAULT_RADIUS_MULTIPLIER,
  XE_GTAO_DEFAULT_FALLOFF_RANGE,
  xeGtaoRadiusIsRepresentable
} from "./XeGtaoPreparationAbi.js";

/** Device-independent scalar AO controls. Changes apply on the next ordinary
 * frame, retain the selected full-resolution XeGTAO algorithm and reset only
 * affected color accumulation. Invalid patches throw without changing state. */
export interface AmbientOcclusionSettings {
  readonly enabled: boolean;
  readonly radiusMeters: number;
  readonly metersPerWorldUnit: number;
  /** Linear blend from neutral visibility (0) to full screen AO (1). */
  readonly strength: number;
  /** Donor visibility curve, independent of linear strength. */
  readonly finalValuePower: number;
  readonly quality: "medium" | "high";
  readonly denoisePasses: 0 | 1 | 2 | 3;
}

export const AMBIENT_OCCLUSION_DEFAULT_SETTINGS: Readonly<AmbientOcclusionSettings> = Object.freeze({
  enabled: true,
  radiusMeters: 1,
  metersPerWorldUnit: 1,
  strength: 1,
  finalValuePower: 2.2,
  quality: "high",
  denoisePasses: 1
});

export function resolveAmbientOcclusionSettings(
  current: AmbientOcclusionSettings,
  patch: Partial<AmbientOcclusionSettings>
): Readonly<AmbientOcclusionSettings> {
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(AMBIENT_OCCLUSION_DEFAULT_SETTINGS, key)) {
      throw new RangeError(`Unknown ambient occlusion setting '${key}'`);
    }
  }
  const next = { ...current, ...patch };
  if (typeof next.enabled !== "boolean") {
    throw new RangeError("Ambient occlusion enabled must be boolean");
  }
  for (const name of ["radiusMeters", "metersPerWorldUnit"] as const) {
    if (!Number.isFinite(next[name]) || next[name] <= 0) {
      throw new RangeError(`Ambient occlusion ${name} must be positive and finite`);
    }
  }
  if (
    !xeGtaoRadiusIsRepresentable(
      next.radiusMeters / next.metersPerWorldUnit,
      XE_GTAO_DEFAULT_RADIUS_MULTIPLIER,
      XE_GTAO_DEFAULT_FALLOFF_RANGE
    )
  ) {
    throw new RangeError("Ambient occlusion world radius is outside f32 capacity");
  }
  if (!Number.isFinite(next.strength) || next.strength < 0 || next.strength > 1) {
    throw new RangeError("Ambient occlusion strength must be finite in [0, 1]");
  }
  if (!Number.isFinite(next.finalValuePower) || next.finalValuePower < 0.5 || next.finalValuePower > 5) {
    throw new RangeError("Ambient occlusion finalValuePower must be finite in [0.5, 5]");
  }
  if (next.quality !== "medium" && next.quality !== "high") {
    throw new RangeError("Ambient occlusion quality must be medium or high");
  }
  if (!Number.isInteger(next.denoisePasses) || next.denoisePasses < 0 || next.denoisePasses > 3) {
    throw new RangeError("Ambient occlusion denoisePasses must be an integer in [0, 3]");
  }
  if (
    Object.keys(next).every(
      (key) => next[key as keyof AmbientOcclusionSettings] === current[key as keyof AmbientOcclusionSettings]
    )
  ) {
    return current;
  }
  return Object.freeze(next);
}

/** Content identity, computed only when settings change. Inactive parameters
 * cannot invalidate color or create graph variants. Physical GPU values define
 * equality, including equivalent conversions between metres and world units. */
export function ambientOcclusionContentKey(settings: AmbientOcclusionSettings): string | null {
  if (!settings.enabled || settings.strength === 0) {
    return null;
  }
  return JSON.stringify([
    Math.fround(settings.radiusMeters / settings.metersPerWorldUnit),
    Math.fround(settings.strength),
    Math.fround(settings.finalValuePower),
    settings.quality,
    settings.denoisePasses
  ]);
}
