/** Material execution policy used during the Visibility-to-Surface migration. */
export type MaterialResolveBackend = "tile-compute";

export function isMaterialResolveBackend(value: unknown): value is MaterialResolveBackend {
  return value === "tile-compute";
}
