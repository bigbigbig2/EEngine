import type { Scene } from "../../scene/Scene.js";

export type FrameGeometrySource<TRuntime> = Readonly<{
  readonly runtime: TRuntime;
}>;

export interface ResolvedFrameSceneOwners<TEnvironment, TRuntime> {
  readonly environment: TEnvironment;
  readonly geometry: FrameGeometrySource<TRuntime>;
}

/**
 * Resolves the authoritative Render World owner before frame encoding.
 * The shared environment is present for both render-world inputs.
 */
export function resolveFrameSceneOwners<
  TEnvironment,
  TRuntime
>(
  scene: Scene,
  renderWorld: Readonly<{ runtime(scene: Scene): TRuntime | null }> | undefined,
  environments: Readonly<{ obtain(scene: Scene): TEnvironment }>
): ResolvedFrameSceneOwners<TEnvironment, TRuntime> {
  const runtime = renderWorld?.runtime(scene) ?? null;
  if (runtime === null) {
    throw new Error(
      `Scene ${scene.id ?? "<unknown>"} has no GPU Render World registration; ` +
      "call uploadScene() with cooked geometry packages before render()"
    );
  }
  const environment = environments.obtain(scene);
  return Object.freeze({
    environment,
    geometry: Object.freeze({ runtime })
  });
}
