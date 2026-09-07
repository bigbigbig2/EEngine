/** Material execution policy used during the Visibility-to-Surface migration. */
export type MaterialResolveBackend =
  | "class-depth"
  | "class-discard";

export function isMaterialResolveBackend(value: unknown): value is MaterialResolveBackend {
  return value === "class-depth" ||
    value === "class-discard";
}
