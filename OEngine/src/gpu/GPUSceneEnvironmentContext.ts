import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { Scene } from "../scene/Scene.js";
import { Brick4LightMap } from "./Brick4LightMap.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { GPULightProbeVolume } from "./GPULightProbeVolume.js";
import { GPULightCollection } from "./LightDatabase.js";
import { GPUVolumetrics } from "./GPUVolumetrics.js";

export interface SceneEnvironmentFrameEvidence {
  readonly prepareCount: number;
  readonly changedLights: number;
  readonly fullResync: boolean;
}

export interface GPUSceneEnvironmentEvidence {
  readonly prepareCount: number;
  readonly lastSceneChangeRevision: number;
}

let nextEnvironmentId = 1;

/**
 * Scene-scoped GPU data shared by Packed and legacy geometry consumers.
 *
 * This owner deliberately contains no geometry, material, skinning, TLAS, or
 * SceneDatabase state. Packed frames may create and update it without paying
 * for the temporary legacy render world.
 */
export class GPUSceneEnvironmentContext {
  readonly isGPUSceneEnvironmentContext = true;
  readonly id = nextEnvironmentId++;
  readonly lights: GPULightCollection;
  readonly light_probe_volume: GPULightProbeVolume;
  readonly volumetric_light_map: Brick4LightMap;
  readonly volumetrics: GPUVolumetrics;

  private lastSceneChangeRevision = -1;
  private lastPreparedFrame = -1;
  private prepareCount = 0;

  constructor(
    graphics: GraphicsContext,
    readonly scene: Scene
  ) {
    const device = graphics.device;
    this.lights = new GPULightCollection(graphics, scene.lights);
    this.light_probe_volume = new GPULightProbeVolume(
      graphics,
      scene.light_probe_volume
    );
    this.volumetric_light_map = new Brick4LightMap(device);
    this.volumetrics = new GPUVolumetrics(device, scene.volumetrics);
  }

  encodeFrame(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    timeDeltaSeconds: number
  ): SceneEnvironmentFrameEvidence {
    if (this.lastPreparedFrame === frameIndex) {
      return { prepareCount: 0, changedLights: 0, fullResync: false };
    }
    const previousRevision = this.lastSceneChangeRevision;
    this.lastPreparedFrame = frameIndex;
    command.onAborted.addOne(() => {
      if (this.lastPreparedFrame === frameIndex) this.lastPreparedFrame = -1;
      this.lastSceneChangeRevision = previousRevision;
    });

    const changes = this.scene.changesSince(this.lastSceneChangeRevision);
    this.light_probe_volume.update();
    this.lights.update(
      command,
      changes.fullResyncRequired || changes.changedLights.length > 0
    );
    this.volumetrics.update(command, timeDeltaSeconds);
    this.lastSceneChangeRevision = changes.revision;
    this.prepareCount++;
    return {
      prepareCount: 1,
      changedLights: changes.changedLights.length,
      fullResync: changes.fullResyncRequired
    };
  }

  /** Explicit tool path; render frames use encodeFrame for idempotence. */
  update(command: ShadeGPUCommandContext): void {
    const changes = this.scene.changesSince(this.lastSceneChangeRevision);
    this.light_probe_volume.update();
    this.lights.update(
      command,
      changes.fullResyncRequired || changes.changedLights.length > 0
    );
    this.volumetrics.update(command, 0);
    this.lastSceneChangeRevision = changes.revision;
    this.prepareCount++;
  }

  evidence(): GPUSceneEnvironmentEvidence {
    return Object.freeze({
      prepareCount: this.prepareCount,
      lastSceneChangeRevision: this.lastSceneChangeRevision
    });
  }

  get gpu_memory_usage(): number {
    return this.lights.gpu_memory_usage +
      this.light_probe_volume.gpu_memory_usage +
      this.volumetric_light_map.gpu_memory_usage;
  }

  destroy(): void {
    this.lights.destroy();
    this.light_probe_volume.destroy();
    this.volumetric_light_map.destroy();
    this.volumetrics.destroy();
  }
}
