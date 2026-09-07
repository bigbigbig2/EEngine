/** Material execution policy used during the Visibility-to-Surface migration. */
export type MaterialResolveBackend =
  | "legacy-pixel-queue"
  | "class-depth"
  | "class-discard";

export function isMaterialResolveBackend(value: unknown): value is MaterialResolveBackend {
  return value === "legacy-pixel-queue" ||
    value === "class-depth" ||
    value === "class-discard";
}
