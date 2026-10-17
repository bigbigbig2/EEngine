import { planScgiArena, scgiInteger, type ScgiBufferLimits } from "./ScgiCapacity.js";

/** Scalar-word ABI, shared by estimator generator and host. Pool slots are
 * never compacted: status, including physical no-hit, belongs to the measure. */
export const SCGI_ESTIMATOR = Object.freeze({
  poolStride: 192,
  // Native hit/result/identity 192B, phase metadata 32B, radiance 16B.
  pathStride: 240,
  shadowStride: 16,
  cohortStride: 96,
  lightStride: 16,
  settingsBytes: 128,
  hitStride: 96 as const,
  workgroupSize: 64
});

export interface ScgiEstimatorProfile {
  readonly lightSamples: number;
  readonly hemisphereSamples: number;
  readonly connectionSamples: number;
  readonly maximumLights: number;
  readonly batchRays: number;
}

export function planScgiEstimator(
  limits: ScgiBufferLimits,
  profile: ScgiEstimatorProfile,
  updates: number,
  lightPages = 1
) {
  for (const [name, value] of Object.entries(profile)) {
    scgiInteger(value, `estimator ${name}`);
  }
  scgiInteger(updates, "estimator updates");
  scgiInteger(profile.hemisphereSamples + profile.connectionSamples, "cohort samples");
  scgiInteger(updates * profile.hemisphereSamples, "hemisphere work");
  scgiInteger(updates * profile.connectionSamples, "connection work");
  scgiInteger(lightPages, "light pages");
  return planScgiArena(limits, [
    ["control", 32, 4],
    ["lights", profile.maximumLights, SCGI_ESTIMATOR.lightStride],
    ["lightPages", lightPages, 8],
    ["pool", profile.lightSamples, SCGI_ESTIMATOR.poolStride],
    ["paths", profile.batchRays, SCGI_ESTIMATOR.pathStride],
    ["shadow", profile.batchRays, SCGI_ESTIMATOR.shadowStride],
    ["shadowMap", profile.batchRays, 4],
    ["cohorts", updates, SCGI_ESTIMATOR.cohortStride]
  ]);
}
