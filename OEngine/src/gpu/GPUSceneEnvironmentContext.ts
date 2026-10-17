import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { Scene } from "../scene/Scene.js";
import { Brick4LightMap } from "./Brick4LightMap.js";
import type { GraphicsContext } from "./GraphicsContext.js";
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
 * Scene-scoped GPU data shared by Packed and ordinary Render World inputs.
 *
 * This owner deliberately contains no geometry, material, skinning, or TLAS
 * state and remains independent from the geometry Render World.
 * Optional environment tables (brick4 lightmap, volumetrics)
 * are lazily allocated only when populated or explicitly requested.
 */
export class GPUSceneEnvironmentContext {
  readonly isGPUSceneEnvironmentContext = true;
  readonly id = nextEnvironmentId++;
  readonly lights: GPULightCollection;

  private readonly graphics: GraphicsContext;
  private _volumetricLightMap: Brick4LightMap | null = null;
  private _volumetrics: GPUVolumetrics | null = null;
  private lastSceneChangeRevision = -1;
  private lastPreparedFrame = -1;
  private prepareCount = 0;

  constructor(
    graphics: GraphicsContext,
    readonly scene: Scene,
  ) {
    this.graphics = graphics;
    this.lights = new GPULightCollection(graphics, scene.lights);
  }

  get volumetric_light_map(): Brick4LightMap {
    if (this._volumetricLightMap === null) {
      this._volumetricLightMap = new Brick4LightMap(this.graphics.device);
    }
    return this._volumetricLightMap;
  }

  get volumetrics(): GPUVolumetrics {
    if (this._volumetrics === null) {
      this._volumetrics = new GPUVolumetrics(this.graphics.device, this.scene.volumetrics);
    }
    return this._volumetrics;
  }

  encodeFrame(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    timeDeltaSeconds: number,
  ): SceneEnvironmentFrameEvidence {
    if (this.lastPreparedFrame === frameIndex) {
      return { prepareCount: 0, changedLights: 0, fullResync: false };
    }
    const previousRevision = this.lastSceneChangeRevision;
    this.lastPreparedFrame = frameIndex;
    command.onAborted.addOne(() => {
      if (this.lastPreparedFrame === frameIndex) {
        this.lastPreparedFrame = -1;
      }
      this.lastSceneChangeRevision = previousRevision;
    });

    const changes = this.scene.changesSince(this.lastSceneChangeRevision);
    this.lights.update(command, changes.fullResyncRequired || changes.changedLights.length > 0);
    if (this._volumetrics !== null || this.scene.volumetrics.volumes.length > 0) {
      this.volumetrics.update(command, timeDeltaSeconds);
    }
    this.lastSceneChangeRevision = changes.revision;
    this.prepareCount++;
    return {
      prepareCount: 1,
      changedLights: changes.changedLights.length,
      fullResync: changes.fullResyncRequired,
    };
  }

  /** Explicit tool path; render frames use encodeFrame for idempotence. */
  update(command: ShadeGPUCommandContext): void {
    const changes = this.scene.changesSince(this.lastSceneChangeRevision);
    this.lights.update(command, changes.fullResyncRequired || changes.changedLights.length > 0);
    if (this._volumetrics !== null || this.scene.volumetrics.volumes.length > 0) {
      this.volumetrics.update(command, 0);
    }
    this.lastSceneChangeRevision = changes.revision;
    this.prepareCount++;
  }

  evidence(): GPUSceneEnvironmentEvidence {
    return Object.freeze({
      prepareCount: this.prepareCount,
      lastSceneChangeRevision: this.lastSceneChangeRevision,
    });
  }

  get gpu_memory_usage(): number {
    return this.lights.gpu_memory_usage + (this._volumetricLightMap?.gpu_memory_usage ?? 0);
  }

  destroy(): void {
    this.lights.destroy();
    this._volumetricLightMap?.destroy();
    this._volumetricLightMap = null;
    this._volumetrics?.destroy();
    this._volumetrics = null;
  }
}
