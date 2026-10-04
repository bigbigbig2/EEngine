/** One bounded batch arena. Active, request, unique and producer counts have
 * distinct slots; indirect arguments are derived only from those GPU counts.
 * Requests are narrow handles into shared addresses, never copied wide keys. */
export const SURFACE_DEMAND_CONTROL_WORDS = 128;
export const SURFACE_DEMAND_RECORD_WORDS = 4;
export const SURFACE_DEMAND_PROGRAM_WORDS = 8;
export const SURFACE_DEMAND_PROBE_LIMIT = 64;
export const SURFACE_DEMAND_COUNT = Object.freeze({
    geometry: 0, fields: 1, signals: 2, uniqueFields: 3, uniqueSignals: 4,
    materialGroups: 5, lightingGroups: 6, overflow: 7,
    geometryIndirect: 8, fieldPublishIndirect: 12, signalPublishIndirect: 16,
    fieldRequestIndirect: 20, signalRequestIndirect: 24,
    materialGroupIndirect: 28, lightingGroupIndirect: 32,
    uniqueFieldIndirect: 36, uniqueSignalIndirect: 40,
    fieldFallbacks: 44, signalFallbacks: 45
});
export interface SurfaceDemandLayout {
    readonly targets: number;
    readonly programs: number;
    readonly fieldCapacity: number;
    readonly signalCapacity: number;
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
    if (!Number.isSafeInteger(targets) || targets < 1 || targets % 64 !== 0 ||
        !Number.isSafeInteger(programs) || programs < 1) {
        throw new RangeError("Surface demand requires a complete tile/program capacity");
    }
    const fieldCapacity = targets * 15;
    const signalCapacity = targets * 6;
    const fieldHashCapacity = powerOfTwo(fieldCapacity * 2);
    const signalHashCapacity = powerOfTwo(signalCapacity * 2);
    const sections = [
        ["control", SURFACE_DEMAND_CONTROL_WORDS],
        ["programs", programs * SURFACE_DEMAND_PROGRAM_WORDS],
        ["field_hash", fieldHashCapacity], ["signal_hash", signalHashCapacity],
        ["field_requests", fieldCapacity * SURFACE_DEMAND_RECORD_WORDS],
        ["signal_requests", signalCapacity * SURFACE_DEMAND_RECORD_WORDS],
        ["field_aliases", fieldCapacity], ["signal_aliases", signalCapacity],
        ["field_results", fieldCapacity], ["signal_results", signalCapacity],
        ["unique_fields", fieldCapacity], ["unique_signals", signalCapacity],
        ["geometry_masks", targets], ["material_masks", targets], ["lighting_masks", targets],
        ["material_entries", targets],
        ["field_destinations", fieldCapacity], ["signal_destinations", signalCapacity],
        ["geometry_queue", targets], ["material_queue", targets], ["lighting_queue", targets],
        ["ordered_material_queue", targets]
    ] as const;
    const offsets: Record<string, number> = {};
    let words = 0;
    for (const [name, count] of sections) {
        offsets[name] = words * 4;
        words += count;
    }
    const bytes = Math.ceil(words * 4 / 256) * 256;
    return Object.freeze({ targets, programs, fieldCapacity, signalCapacity, fieldHashCapacity,
        signalHashCapacity, offsets: Object.freeze(offsets), bytes });
}
export function surfaceDemandArenaWgsl(targets: number, programs: number): string {
    const layout = surfaceDemandLayout(targets, programs);
    return /* wgsl */ `
struct SurfaceDemandArena {
  control: array<atomic<u32>, ${SURFACE_DEMAND_CONTROL_WORDS}>,
  programs: array<atomic<u32>, ${programs * SURFACE_DEMAND_PROGRAM_WORDS}>,
  field_hash: array<atomic<u32>, ${layout.fieldHashCapacity}>,
  signal_hash: array<atomic<u32>, ${layout.signalHashCapacity}>,
  field_requests: array<vec4u, ${layout.fieldCapacity}>,
  signal_requests: array<vec4u, ${layout.signalCapacity}>,
  field_aliases: array<u32, ${layout.fieldCapacity}>,
  signal_aliases: array<u32, ${layout.signalCapacity}>,
  field_results: array<u32, ${layout.fieldCapacity}>,
  signal_results: array<u32, ${layout.signalCapacity}>,
  unique_fields: array<u32, ${layout.fieldCapacity}>,
  unique_signals: array<u32, ${layout.signalCapacity}>,
  geometry_masks: array<atomic<u32>, ${targets}>,
  material_masks: array<atomic<u32>, ${targets}>,
  lighting_masks: array<atomic<u32>, ${targets}>,
  material_entries: array<u32, ${targets}>,
  field_destinations: array<atomic<u32>, ${layout.fieldCapacity}>,
  signal_destinations: array<atomic<u32>, ${layout.signalCapacity}>,
  geometry_queue: array<u32, ${targets}>,
  material_queue: array<u32, ${targets}>,
  lighting_queue: array<u32, ${targets}>,
  ordered_material_queue: array<u32, ${targets}>,
}
`;
}
