import type { Scene } from "../../scene/Scene.js";

export type FrameGeometrySource<TPacked, TLegacy> =
  | Readonly<{ readonly kind: "packed"; readonly runtime: TPacked }>
  | Readonly<{ readonly kind: "legacy"; readonly context: TLegacy }>;

export interface ResolvedFrameSceneOwners<TEnvironment, TPacked, TLegacy> {
  readonly environment: TEnvironment;
  readonly geometry: FrameGeometrySource<TPacked, TLegacy>;
}

/**
 * Resolves the mutually-exclusive geometry owner before any legacy obtain.
 * The shared environment is present for both render-world inputs.
 */
export function resolveFrameSceneOwners<
  TEnvironment,
  TPacked,
  TLegacy
>(
  scene: Scene,
  packedScenes: Readonly<{ runtime(scene: Scene): TPacked | null }> | undefined,
  environments: Readonly<{ obtain(scene: Scene): TEnvironment }>
): ResolvedFrameSceneOwners<TEnvironment, TPacked, TLegacy> {
  const packed = packedScenes?.runtime(scene) ?? null;
  if (packed === null) {
    throw new Error(
      `Scene ${scene.id ?? "<unknown>"} has no GPU Render World registration; ` +
      "call uploadScene() with cooked geometry packages before render()"
    );
  }
  const environment = environments.obtain(scene);
  return Object.freeze({
    environment,
    geometry: Object.freeze({ kind: "packed" as const, runtime: packed })
  });
}
