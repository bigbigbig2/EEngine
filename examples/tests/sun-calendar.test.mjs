import assert from "node:assert/strict";
import test from "node:test";
import { Body, Equator, Horizon, Observer } from "astronomy-engine";
import {
  calendarSunDirection,
  formatSunDay,
  formatSunTime
} from "../demos/14-integrated/bistro-texture-compression/sun-calendar.ts";

const parameters = { dayOfYear: 172, timeOfDay: 10, latitude: 35, longitude: 0 };

test("calendar direction matches an independent topocentric horizon reference", () => {
  // The production path is geocentric, matching Takram. The independent horizon
  // path includes solar parallax (at most about 9 arcseconds at Earth's surface).
  for (const dayOfYear of [1, 80, 172, 266, 355]) {
    for (const timeOfDay of [0, 6, 12, 18]) {
      for (const latitude of [-35, 0, 35, 80]) {
        const result = calendarSunDirection({
          ...parameters,
          dayOfYear,
          timeOfDay,
          latitude,
          longitude: 139.7
        });
        const observer = new Observer(latitude, 139.7, 0);
        const equator = Equator(Body.Sun, result.date, observer, true, false);
        const horizon = Horizon(result.date, observer, equator.ra, equator.dec);
        const altitude = (horizon.altitude * Math.PI) / 180;
        const azimuth = (horizon.azimuth * Math.PI) / 180;
        const reference = [
          Math.cos(altitude) * Math.cos(azimuth),
          Math.sin(altitude),
          Math.cos(altitude) * Math.sin(azimuth)
        ];
        const distance = Math.hypot(...reference.map((value, index) => value - result.direction[index]));
        assert.ok(distance < 5e-5, JSON.stringify({ dayOfYear, timeOfDay, latitude, distance }));
        assert.ok(Math.abs(Math.hypot(...result.direction) - 1) < 1e-12);
      }
    }
  }
});

test("daily and seasonal motion preserves North-Up-East axes and night", () => {
  const sun = (dayOfYear, timeOfDay) => calendarSunDirection({ ...parameters, dayOfYear, timeOfDay });
  assert.ok(sun(172, 6).direction[2] > 0, "morning sun is east");
  assert.ok(sun(172, 18).direction[2] < 0, "evening sun is west");
  assert.ok(sun(172, 0).altitudeDegrees < 0, "midnight stays below the horizon");
  assert.ok(sun(172, 12).altitudeDegrees > 75);
  assert.ok(sun(355, 12).altitudeDegrees > 30 && sun(355, 12).altitudeDegrees < 35);
});

test("24:00 rolls to the next day and longitude sets a deterministic UTC offset", () => {
  const midnight = calendarSunDirection({ ...parameters, timeOfDay: 24 });
  const nextDay = calendarSunDirection({ ...parameters, dayOfYear: 173, timeOfDay: 0 });
  assert.equal(midnight.date.getTime(), nextDay.date.getTime());
  assert.deepEqual(midnight.direction, nextDay.direction);
  assert.equal(
    calendarSunDirection({ ...parameters, dayOfYear: 365, timeOfDay: 24 }).date.toISOString(),
    "2027-01-01T00:00:00.000Z"
  );
  assert.equal(
    calendarSunDirection({ ...parameters, longitude: 120 }).date.getTime(),
    calendarSunDirection(parameters).date.getTime() - 8 * 3600000
  );
  assert.equal(formatSunTime(24), "24:00");
  assert.equal(formatSunTime(10.1), "10:06");
  assert.match(formatSunDay(365), /31 Dec/);
});

test("invalid calendar inputs reject before publishing a non-finite sun direction", () => {
  for (const [key, values] of Object.entries({
    dayOfYear: [0, 366, 1.5, NaN],
    timeOfDay: [-1, 25, NaN],
    latitude: [-91, 91, Infinity],
    longitude: [-181, 181, NaN]
  })) {
    for (const value of values)
      assert.throws(() => calendarSunDirection({ ...parameters, [key]: value }), RangeError);
  }
});
