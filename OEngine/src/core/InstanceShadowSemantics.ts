/** Authored instance semantics, shared by Scene/import and the GPU ABI.
 * Omitted properties default on; explicit false/zero remains off. */
export const INSTANCE_SHADOW_SEMANTICS = "cast-receive-explicit-v1";
export const INSTANCE_CASTS_SHADOW = 1 << 1;
export const INSTANCE_RECEIVES_SHADOW = 1 << 2;
export const DEFAULT_INSTANCE_SHADOW_FLAGS = INSTANCE_CASTS_SHADOW | INSTANCE_RECEIVES_SHADOW;

/** glTF node extras use optional boolean castShadow / receiveShadow.
 * Other extras belong to their own consumers. No GPU resources are created. */
export function instanceShadowFlagsFromExtras(extras: unknown): number {
  if (extras === undefined || extras === null || typeof extras !== "object" || Array.isArray(extras)) {
    return DEFAULT_INSTANCE_SHADOW_FLAGS;
  }
  const record = extras as Record<string, unknown>;
  let flags = DEFAULT_INSTANCE_SHADOW_FLAGS;
  for (const [name, bit] of [
    ["castShadow", INSTANCE_CASTS_SHADOW],
    ["receiveShadow", INSTANCE_RECEIVES_SHADOW]
  ] as const) {
    const value = record[name];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "boolean") {
      throw new TypeError(`glTF ${name} must be boolean when declared`);
    }
    if (!value) {
      flags &= ~bit;
    }
  }
  return flags;
}
