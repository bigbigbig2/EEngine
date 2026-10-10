const MiB = 1024 ** 2;

/** Application target, not adapter-name detection or a claim about OS residency.
 * Leave 2 GiB outside the API envelope for the browser, driver and other apps.
 * Within it reserve 1408 MiB for textures/effects/transients/publication overlap.
 * Metadata is deliberately unchanged in this capacity-only unit. */
export const DUNGEON_4GB_RESOURCE_BUDGET = Object.freeze({
  profile: "target-4gb",
  targetDeviceBytes: 4096 * MiB,
  apiEnvelopeBytes: 2048 * MiB,
  nonGeometryReserveBytes: 1408 * MiB,
  geometryCapacityBytes: 512 * MiB,
  metadataBytes: 128 * MiB,
});

/** Explicit overrides are experiments/custom budgets, not a 4GB guarantee.
 * Reject malformed requests instead of silently running a different capacity. */
export function dungeonResourceBudget(geometryMiB: string | null) {
  if (geometryMiB === null) return DUNGEON_4GB_RESOURCE_BUDGET;
  const requested = Number(geometryMiB);
  if (!Number.isSafeInteger(requested) || requested < 128 || requested > 2048) {
    throw new RangeError("geometryMiB must be an integer in [128, 2048]");
  }
  return Object.freeze({
    ...DUNGEON_4GB_RESOURCE_BUDGET,
    profile: "explicit-geometry-budget",
    geometryCapacityBytes: requested * MiB,
  });
}
