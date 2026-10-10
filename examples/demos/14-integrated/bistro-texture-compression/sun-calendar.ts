import { Body, GeoVector, Pivot, RotateVector, Rotation_EQJ_EQD, SiderealTime } from "astronomy-engine";

export const SUN_CALENDAR_YEAR = 2026;

export interface SunCalendarParameters {
  dayOfYear: number;
  timeOfDay: number;
  latitude: number;
  longitude: number;
}

/** Takram's local date convention: longitude / 15 hours, independent of the
 * host timezone and DST. 24:00 is the following day's midnight.
 * Reference: three-geospatial b012ad06d858fc035d88aacfd73f092f93c994e4,
 * localDateControls.ts::getLocalDate and celestialDirections.ts (MIT).
 * Astronomy Engine 2.1.19 owns the ephemeris and equatorial/Earth rotation.
 */
export function calendarSunDirection(parameters: SunCalendarParameters): {
  direction: [number, number, number];
  date: Date;
  altitudeDegrees: number;
} {
  const { dayOfYear, timeOfDay, latitude, longitude } = parameters;
  if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > 365) {
    throw new RangeError("Sun day must be an integer from 1 to 365");
  }
  for (const [value, min, max, name] of [
    [timeOfDay, 0, 24, "time"],
    [latitude, -90, 90, "latitude"],
    [longitude, -180, 180, "longitude"]
  ] as const) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`Sun ${name} must be between ${min} and ${max}`);
    }
  }
  const date = new Date(
    Date.UTC(SUN_CALENDAR_YEAR, 0, 1) + ((dayOfYear - 1) * 24 + timeOfDay - longitude / 15) * 3600000
  );
  const equatorial = GeoVector(Body.Sun, date, false);
  const rotation = Pivot(Rotation_EQJ_EQD(date), 2, -15 * SiderealTime(date));
  const earth = RotateVector(rotation, equatorial);
  const phi = (latitude * Math.PI) / 180;
  const lambda = (longitude * Math.PI) / 180;
  const meridian = Math.cos(lambda) * earth.x + Math.sin(lambda) * earth.y;
  // Match Takram's local North-Up-East frame: +X north, +Y up, +Z east.
  // This is a vector toward the Sun; do not reverse it into light travel.
  const north = -Math.sin(phi) * meridian + Math.cos(phi) * earth.z;
  const up = Math.cos(phi) * meridian + Math.sin(phi) * earth.z;
  const east = -Math.sin(lambda) * earth.x + Math.cos(lambda) * earth.y;
  const length = Math.hypot(north, up, east);
  const direction: [number, number, number] = [north / length, up / length, east / length];
  return {
    direction,
    date,
    altitudeDegrees: (Math.asin(Math.max(-1, Math.min(1, direction[1]))) * 180) / Math.PI
  };
}

export function formatSunTime(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatSunDay(dayOfYear: number): string {
  const date = new Date(Date.UTC(SUN_CALENDAR_YEAR, 0, dayOfYear));
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · ${dayOfYear}/365`;
}
