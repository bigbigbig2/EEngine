export const MAX_DIRECTIONAL_LIGHTS = 32;

export function assertDirectionalLightCapacity(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Directional light count must be a non-negative integer");
  }
  if (count > MAX_DIRECTIONAL_LIGHTS) {
    throw new RangeError(
      `Directional light count ${count} exceeds the explicit capacity ${MAX_DIRECTIONAL_LIGHTS}`
    );
  }
}
