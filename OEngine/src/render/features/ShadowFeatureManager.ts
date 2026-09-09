import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GPUSceneEnvironmentContext } from "../../gpu/GPUSceneEnvironmentContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { Scene } from "../../scene/Scene.js";
import {
  ShadowFeature,
  type ShadowFeatureEvidence
} from "./ShadowFeature.js";

export interface ShadowFeatureManagerEvidence {
  readonly featureCount: number;
  readonly atlasCount: number;
  readonly atlasAllocatedBytes: number;
  readonly packedRasterPassCount: number;
  readonly legacyRasterPassCount: number;
  readonly packedWorkSetCount: number;
  readonly packedWorkBytes: number;
  readonly shadowViewOwnerCount: number;
  readonly directionalCameraRevision: number;
  readonly directionalCascadeSplits: readonly number[];
  readonly directionalCascadeLayouts: readonly (readonly [number, number, number, number])[];
}

/** Render-layer registry for Scene-scoped Shadow Feature owners. */
export class ShadowFeatureManager {
  private readonly features = new Map<Scene, ShadowFeature>();

  constructor(private readonly graphics: GraphicsContext) {}

  reconcile(
    scene: Scene,
    environment: GPUSceneEnvironmentContext,
    enabled: boolean,
    command: ShadeGPUCommandContext
  ): ShadowFeature | null {
    const current = this.features.get(scene);
    if (enabled) {
      if (current !== undefined) return current;
      const feature = new ShadowFeature(this.graphics, environment.lights);
      this.features.set(scene, feature);
      command.onAborted.addOne(() => {
        if (this.features.get(scene) !== feature) return;
        this.features.delete(scene);
        feature.destroy();
      });
      return feature;
    }
    if (current === undefined) return null;
    current.deactivate();
    command.onAborted.addOne(() => current.cancelDeactivate());
    command.onFinished.addOne(() => {
      if (this.features.get(scene) !== current) return;
      this.features.delete(scene);
      void command.gpuDone.then(
        () => current.destroy(),
        () => current.destroy()
      );
    });
    return null;
  }

  get(scene: Scene): ShadowFeature | undefined {
    return this.features.get(scene);
  }

  releasePackedScene(
    scene: Scene,
    runtime: PackedSceneRuntime,
    command: ShadeGPUCommandContext
  ): void {
    this.features.get(scene)?.releasePackedScene(runtime, command);
  }

  release(scene: Scene, command: ShadeGPUCommandContext): boolean {
    const feature = this.features.get(scene);
    if (feature === undefined) return false;
    feature.deactivate();
    command.onAborted.addOne(() => feature.cancelDeactivate());
    command.onFinished.addOne(() => {
      if (this.features.get(scene) !== feature) return;
      this.features.delete(scene);
      void command.gpuDone.then(
        () => feature.destroy(),
        () => feature.destroy()
      );
    });
    return true;
  }

  evidence(): ShadowFeatureManagerEvidence {
    const total = {
      featureCount: this.features.size,
      atlasCount: 0,
      atlasAllocatedBytes: 0,
      packedRasterPassCount: 0,
      legacyRasterPassCount: 0,
      packedWorkSetCount: 0,
      packedWorkBytes: 0,
      shadowViewOwnerCount: 0,
      directionalCameraRevision: 0,
      directionalCascadeSplits: Object.freeze([]) as readonly number[],
      directionalCascadeLayouts: Object.freeze([]) as readonly (readonly [number, number, number, number])[]
    };
    for (const feature of this.features.values()) {
      const evidence: ShadowFeatureEvidence = feature.evidence();
      if (evidence.atlasAllocatedBytes > 0) total.atlasCount++;
      total.atlasAllocatedBytes += evidence.atlasAllocatedBytes;
      if (evidence.packedRasterPassCreated) total.packedRasterPassCount++;
      if (evidence.legacyRasterPassCreated) total.legacyRasterPassCount++;
      total.packedWorkSetCount += evidence.packedWorkSetCount;
      total.packedWorkBytes += evidence.packedWorkBytes;
      total.shadowViewOwnerCount += evidence.shadowViewOwnerCount;
      total.directionalCameraRevision += evidence.directionalCameraRevision;
      if (total.directionalCascadeSplits.length === 0) {
        total.directionalCascadeSplits = evidence.directionalCascadeSplits;
        total.directionalCascadeLayouts = evidence.directionalCascadeLayouts;
      }
    }
    return Object.freeze(total);
  }

  destroy(): void {
    for (const feature of this.features.values()) feature.destroy();
    this.features.clear();
  }
}
