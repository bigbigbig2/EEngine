import type { AppearanceExecutionProfiles } from "../material/AppearanceExecutionProfile.js";

export const SURFACE_EXECUTION_HEADER_WORDS = 8;
export const SURFACE_FIELD_EXECUTION_WORDS = 20;
export const SURFACE_SIGNAL_EXECUTION_WORDS = 12;
export const SURFACE_EXECUTION_WORDS = SURFACE_EXECUTION_HEADER_WORDS + 15 * SURFACE_FIELD_EXECUTION_WORDS + 6 * SURFACE_SIGNAL_EXECUTION_WORDS;

/** Material-row indexed immutable profiles. Group membership is a 15-bit mask;
 * group tokens resolve full equality retained by the publication registry. */
export function packSurfaceExecutionProfiles(profiles: readonly AppearanceExecutionProfiles[]): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(Math.max(1, profiles.length) * SURFACE_EXECUTION_WORDS);
  const f32Bits = (value: number): number => new Uint32Array(new Float32Array([value]).buffer)[0]!;
  for (let entry = 0; entry < profiles.length; entry++) {
    const profile = profiles[entry]!;
    const base = entry * SURFACE_EXECUTION_WORDS;
    words.set([profile.token, profile.enabledMask, profile.inputMask, profile.groups.length, 1, 0, 0, 0], base);
    profile.fields.forEach((field, index) => {
      const group = profile.groups[field.group]!;
      words.set([field.token, field.inputMask, field.domain.seamMask, field.cacheClass,
        field.valueNodes, field.valueSamples, field.domain.token, field.proof.token,
        field.proof.nodes, field.proof.coordinateNodes, field.proof.queries, field.proof.visitLimit,
        group.token, group.fields, f32Bits(field.proof.tolerance),
        Number(field.present) | (Number(field.publication) << 1) | (Number(field.proof.supported) << 2) |
        (Number(field.domain.instance) << 3) | (Number(field.domain.side) << 4) | (Number(field.domain.lod) << 5) |
        (Number(field.domain.primitiveLocal) << 6) | (field.proof.qualityClass << 8),
        field.proof.visitBound, f32Bits(field.proof.normalConeCos), field.domain.uvMask, field.valueCostClass],
      base + SURFACE_EXECUTION_HEADER_WORDS + index * SURFACE_FIELD_EXECUTION_WORDS);
    });
    profile.signals.forEach((signal, index) => {
      words.set([signal.token, signal.fields, signal.providers, signal.seamMask, signal.inputMask,
        signal.maxRate, signal.proofClass, signal.domainToken,
        signal.semantic === "coloredResidual" ? 0 : signal.semantic === "irradiance" ? 1 : 2,
        f32Bits(0.9986295348), 0, 0], base + SURFACE_EXECUTION_HEADER_WORDS + 15 * SURFACE_FIELD_EXECUTION_WORDS + index * SURFACE_SIGNAL_EXECUTION_WORDS);
    });
  }
  return words;
}
