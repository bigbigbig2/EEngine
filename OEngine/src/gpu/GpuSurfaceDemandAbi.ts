/** Mask-first batch arena. Mandatory output uses formula slots; only optional
 * StableCache admission gets a narrow request and bounded dictionary entry.
 * Cache queue exhaustion leaves every mandatory fine value covered. */
export const SURFACE_DEMAND_CONTROL_WORDS = 128;
export const SURFACE_DEMAND_RECORD_WORDS = 4;
export const SURFACE_DEMAND_PROGRAM_WORDS = 8;
export const SURFACE_DEMAND_PROBE_LIMIT = 64;
export const SURFACE_DEMAND_COUNT = Object.freeze({
  geometry: 0,
  fields: 1,
  signals: 2,
  uniqueFields: 3,
  uniqueSignals: 4,
  materialGroups: 5,
  lightingGroups: 6,
  overflow: 7,
  geometryIndirect: 8,
  fieldPublishIndirect: 12,
  signalPublishIndirect: 16,
  fieldRequestIndirect: 20,
  signalRequestIndirect: 24,
  materialGroupIndirect: 28,
  lightingGroupIndirect: 32,
  uniqueFieldIndirect: 36,
  uniqueSignalIndirect: 40,
  fieldFallbacks: 44,
  signalFallbacks: 45,
  fieldAdmissionRejected: 47,
  signalAdmissionRejected: 48,
  fieldValues: 49,
  signalValues: 50,
  fieldCommitted: 51,
  signalCommitted: 52,
  fieldProbes: 53,
  signalProbes: 54,
});
export interface SurfaceDemandLayout {
  readonly targets: number;
  readonly programs: number;
  readonly fieldCapacity: number;
  readonly signalCapacity: number;
  readonly fieldAdmissionCapacity: number;
  readonly signalAdmissionCapacity: number;
  readonly fieldHashCapacity: number;
  readonly signalHashCapacity: number;
  readonly offsets: Readonly<Record<string, number>>;
  readonly bytes: number;
}
function powerOfTwo(value: number): number {
  let result = 1;
  while (result < value) {
    result *= 2;
  }
  if (result > 0x40000000) {
    throw new RangeError("Surface request dictionary exceeds the complete u32 profile");
  }
  return result;
}
export function surfaceDemandLayout(targets: number, programs: number): SurfaceDemandLayout {
  if (
    !Number.isSafeInteger(targets) ||
    targets < 1 ||
    targets % 64 !== 0 ||
    !Number.isSafeInteger(programs) ||
    programs < 1
  ) {
    throw new RangeError("Surface demand requires a complete tile/program capacity");
  }
  const fieldCapacity = targets * 15;
  const signalCapacity = targets * 6;
  // Optional cache admission is independent of mandatory fine output capacity.
  // A saturated queue leaves the formula-addressed transient value intact.
  const fieldAdmissionCapacity = targets * 2;
  const signalAdmissionCapacity = targets;
  const fieldHashCapacity = powerOfTwo(fieldAdmissionCapacity * 2);
  const signalHashCapacity = powerOfTwo(signalAdmissionCapacity * 2);
  const sections = [
    ["control", SURFACE_DEMAND_CONTROL_WORDS],
    ["programs", programs * SURFACE_DEMAND_PROGRAM_WORDS],
    ["field_hash", fieldHashCapacity],
    ["signal_hash", signalHashCapacity],
    ["field_requests", fieldAdmissionCapacity * SURFACE_DEMAND_RECORD_WORDS],
    ["signal_requests", signalAdmissionCapacity * SURFACE_DEMAND_RECORD_WORDS],
    ["field_aliases", fieldAdmissionCapacity],
    ["signal_aliases", signalAdmissionCapacity],
    ["field_results", fieldAdmissionCapacity],
    ["signal_results", signalAdmissionCapacity],
    ["unique_fields", fieldAdmissionCapacity],
    ["unique_signals", signalAdmissionCapacity],
    ["geometry_masks", targets],
    ["material_masks", targets],
    ["lighting_masks", targets],
    ["material_entries", targets],
    ["geometry_queue", targets],
    ["material_queue", targets],
    ["lighting_queue", targets],
    ["ordered_material_queue", targets],
  ] as const;
  const offsets: Record<string, number> = {};
  let words = 0;
  for (const [name, count] of sections) {
    offsets[name] = words * 4;
    words += count;
  }
  const bytes = Math.ceil((words * 4) / 256) * 256;
  return Object.freeze({
    targets,
    programs,
    fieldCapacity,
    signalCapacity,
    fieldAdmissionCapacity,
    signalAdmissionCapacity,
    fieldHashCapacity,
    signalHashCapacity,
    offsets: Object.freeze(offsets),
    bytes,
  });
}
/** Request/alias/result/queue payload is overwritten inside actual counts.
 * Empty hash slots and atomic target masks start from the current batch. */
export function surfaceDemandResetRanges(
  layout: SurfaceDemandLayout,
): readonly (readonly [number, number])[] {
  return Object.freeze([
    Object.freeze([0, layout.offsets.field_requests!] as const),
    Object.freeze([layout.offsets.geometry_masks!, layout.targets * 3 * 4] as const),
  ]);
}
export function surfaceDemandArenaWgsl(targets: number, programs: number): string {
  const layout = surfaceDemandLayout(targets, programs);
  return /* wgsl */ `
struct SurfaceDemandArena {
  control: array<atomic<u32>, ${SURFACE_DEMAND_CONTROL_WORDS}>,
  programs: array<atomic<u32>, ${programs * SURFACE_DEMAND_PROGRAM_WORDS}>,
  field_hash: array<atomic<u32>, ${layout.fieldHashCapacity}>,
  signal_hash: array<atomic<u32>, ${layout.signalHashCapacity}>,
  field_requests: array<vec4u, ${layout.fieldAdmissionCapacity}>,
  signal_requests: array<vec4u, ${layout.signalAdmissionCapacity}>,
  field_aliases: array<u32, ${layout.fieldAdmissionCapacity}>,
  signal_aliases: array<u32, ${layout.signalAdmissionCapacity}>,
  field_results: array<u32, ${layout.fieldAdmissionCapacity}>,
  signal_results: array<u32, ${layout.signalAdmissionCapacity}>,
  unique_fields: array<u32, ${layout.fieldAdmissionCapacity}>,
  unique_signals: array<u32, ${layout.signalAdmissionCapacity}>,
  geometry_masks: array<atomic<u32>, ${targets}>,
  material_masks: array<atomic<u32>, ${targets}>,
  lighting_masks: array<atomic<u32>, ${targets}>,
  material_entries: array<u32, ${targets}>,
  geometry_queue: array<u32, ${targets}>,
  material_queue: array<u32, ${targets}>,
  lighting_queue: array<u32, ${targets}>,
  ordered_material_queue: array<u32, ${targets}>,
}
`;
}
