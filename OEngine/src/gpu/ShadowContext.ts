/**
 * ShadowContext：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */


import { AABB2 } from "../core/math/AABB2.js";
import { Vec3 } from "../core/math/Vec3.js";
import { Quat } from "../core/math/Quat.js";
import { mat4FromTRS, mat4Invert } from "../core/math/Mat4.js";
import type { Camera } from "../camera/Camera.js";
import { OrthographicCamera } from "../camera/OrthographicCamera.js";
import { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import type { DirectionalLight } from "../light/DirectionalLight.js";
import type { Light } from "../light/Light.js";
import type { PointLight } from "../light/PointLight.js";
import type { SpotLight } from "../light/SpotLight.js";
import type { SceneLights } from "../scene/Scene.js";
import {
  SceneAABB,
  aabbSetFromTransformedPositions
} from "../scene/Scene.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { ShadowRasterPass } from "../render/passes/ShadowRasterPass.js";
import { PackedCsmShadowPass } from "../render/passes/PackedCsmShadowPass.js";
import { GPUCameraState } from "../render/GPUCameraState.js";
import { GPUViewContext } from "../render/ViewContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { GPUSceneContext } from "./GPUSceneContext.js";
import type { PackedSceneRuntime } from "./GpuPackedSceneRegistry.js";
import type { GpuAssetBindings } from "./GpuAssetStore.js";
import type { GpuSceneBindings } from "./GpuScene.js";
import type { MeshletDrawList } from "./MeshletDrawList.js";
import type { GPUDatabase, GPUTypedTable } from "./GPUDatabase.js";
import { GPUTextureContext } from "./GPUTextureContext.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import {
  ShadowAtlasAllocator,
  ShadowAtlasResolutionController,
  type AdaptiveShadowMap
} from "./ShadowAtlas.js";
import { SHADOW_CASCADE_COUNT } from "./ShadowContract.js";

export const SHADOW_ATLAS_MAX_SIZE = 4096;
export const DIRECTIONAL_SHADOW_INITIAL_SIZES = [1740, 1440] as const;

export type ShadowView = {
  label: string;
  camera: Camera;
  gpu_context?: GPUViewContext;
  packed_camera_state?: GPUCameraState;
};

export abstract class ShadowMapBase<TLight extends Light = Light> implements AdaptiveShadowMap {
  id = 0;
  layout: AABB2[] = [];
  pending_layout: AABB2[] | null = null;
  views: ShadowView[] = [];
  projected_area_px = 0;
  last_updated_frame_index = -1;
  last_resize_frame_index = -1;
  is_invalid = true;
  should_draw = false;
  metadata_changed = true;

  constructor(readonly light: TLight) {}

  destroy(): void {
    for (const view of this.views) {
      view.gpu_context?.destroy();
      view.gpu_context = undefined;
      view.packed_camera_state?.destroy();
      view.packed_camera_state = undefined;
    }
  }
}

export class DirectionalShadowMap extends ShadowMapBase<DirectionalLight> {
  distance_min = 0;
  distance_max = 1;
  readonly splits = new Float32Array(3);

  update(
    camera: Camera,
    cascadeLambda = 0.5,
    maximumDistance = Number.POSITIVE_INFINITY,
    texelGuardBand = 2.5
  ): void {
    const near = camera.near;
    const far = Math.min(
      camera.far,
      Math.max(near + 0.001, maximumDistance)
    );
    this.splits.set(computePracticalCascadeSplits(
      near,
      far,
      SHADOW_CASCADE_COUNT,
      Math.max(0, Math.min(1, cascadeLambda))
    ));

    const frustum = new Float32Array(camera.frustum);
    replaceInfiniteFarPlane(frustum, camera.view_matrix, far);
    const lightRotation = new Quat().copy(this.light.transform_global.rotation);
    const forward = new Vec3().copy(Vec3.forward).applyQuaternion(lightRotation).negate();
    const up = new Vec3().copy(Vec3.up).applyQuaternion(lightRotation);
    const shadowRotation = new Quat().lookRotation(forward, up);

    for (let cascade = 0; cascade < this.views.length; cascade++) {
      const distanceMin = cascade === 0 ? this.distance_min : this.splits[cascade - 1]!;
      const distanceMax = this.splits[cascade]!;
      const slicedPlanes = new Float32Array(24);
      sliceFrustumPlanes(slicedPlanes, frustum, distanceMin, distanceMax);
      const corners = new Float32Array(24);
      frustumCorners(corners, slicedPlanes);
      const center = averagePoints(corners, 8);
      const lightWorld = new Float32Array(16);
      mat4FromTRS(lightWorld, center, shadowRotation, new Vec3(1, 1, -1));
      const lightView = new Float32Array(16);
      if (!mat4Invert(lightView, lightWorld)) throw new Error("DirectionalShadowMap: singular light transform");
      const bounds = transformedPointBounds(corners, lightView);
      bounds.z0 = Math.min(bounds.z0, -2 * far);
      const layout = this.layout[cascade]!;
      const guardBand = Math.max(0, Math.min(8, texelGuardBand));
      const growX = (bounds.width / layout.width) * guardBand;
      const growY = (bounds.height / layout.height) * guardBand;
      bounds.x0 -= growX;
      bounds.x1 += growX;
      bounds.y0 -= growY;
      bounds.y1 += growY;
      snapShadowBoundsToTexelGrid(bounds, layout.width, layout.height);

      const shadowCamera = this.views[cascade]!.camera as OrthographicCamera;
      shadowCamera.left = bounds.x0;
      shadowCamera.right = bounds.x1;
      shadowCamera.bottom = bounds.y0;
      shadowCamera.top = bounds.y1;
      shadowCamera.near = bounds.z0;
      shadowCamera.far = bounds.z1;
      shadowCamera.transform.rotation.copy(lightRotation);
      shadowCamera.transform.position.copy(center);
      shadowCamera.update();
    }
    this.metadata_changed = true;
  }

  make_record(): Array<{ atlas: Float32Array; projection: Float32Array }> {
    const records = new Array<{ atlas: Float32Array; projection: Float32Array }>(SHADOW_CASCADE_COUNT);
    for (let cascade = 0; cascade < SHADOW_CASCADE_COUNT; cascade++) {
      const layout = this.layout[cascade]!;
      records[cascade] = {
        atlas: new Float32Array([layout.x0, layout.y0, layout.width, layout.height]),
        projection: new Float32Array(this.views[cascade]!.camera.view_projection_matrix)
      };
    }
    return records;
  }
}

export class PointShadowMap extends ShadowMapBase<PointLight> {
  cube_near = 0.01;

  update(): void {
    const position = this.light.transform_global.position;
    const near = Math.max(this.light.near_clip_distance, 0.01);
    this.cube_near = near;
    const directions = [
      [1, 0, 0, 0, 1, 0],
      [-1, 0, 0, 0, 1, 0],
      [0, 1, 0, 0, 0, 1],
      [0, -1, 0, 0, 0, -1],
      [0, 0, 1, 0, 1, 0],
      [0, 0, -1, 0, 1, 0]
    ] as const;
    for (let face = 0; face < 6; face++) {
      const camera = this.views[face]!.camera as PerspectiveCamera;
      const axes = directions[face]!;
      camera.transform.position.copy(position);
      camera.transform.rotation._lookRotation(axes[0], axes[1], axes[2], axes[3], axes[4], axes[5]);
      camera.fov = 0.5 * Math.PI;
      camera.aspect = 1;
      camera.near = near;
      camera.far = this.light.distance;
      camera.update();
    }
  }

  make_record(): Float32Array {
    const layout = this.layout[0]!;
    return new Float32Array([layout.x0 + 4, layout.y0 + 4, layout.width - 8, layout.height - 8]);
  }
}

export class SpotShadowMap extends ShadowMapBase<SpotLight> {
  update(): void {
    const camera = this.views[0]!.camera as PerspectiveCamera;
    camera.transform.rotation.copy(this.light.transform_global.rotation);
    camera.transform.position.copy(this.light.transform_global.position);
    camera.fov = 2 * this.light.angle;
    camera.aspect = 1;
    camera.near = Math.max(this.light.near_clip_distance, 0.01);
    camera.far = this.light.distance;
    camera.update();
    this.metadata_changed = true;
  }

  make_record(): { atlas: Float32Array; projection: Float32Array } {
    const layout = this.layout[0]!;
    return {
      atlas: new Float32Array([layout.x0, layout.y0, layout.width, layout.height]),
      projection: new Float32Array(this.views[0]!.camera.view_projection_matrix)
    };
  }
}

export class ShadowContext {
  directional_cascade_lambda = 0.5;
  directional_maximum_distance = Number.POSITIVE_INFINITY;
  directional_texel_guard_band = 2.5;
  readonly atlas: ShadowAtlasAllocator;
  readonly maps: ShadowMapBase[] = [];
  readonly resolution_controller: ShadowAtlasResolutionController;
  enabled = false;
  lastHzbBuildCount = 0;
  lastHzbComputePassCount = 0;
  lastHzbDispatchCount = 0;
  lastHzbOutputPixels = 0;

  private debugRenderCount = 0;
  private frameIndex = -1;
  private deferredBudget = 0;
  private previousPointCount = 0;
  private previousSpotCount = 0;
  private previousDirectionalCount = 0;
  private _texture: GPUTextureContext | null = null;
  private rasterPass: ShadowRasterPass | null = null;
  private packedRasterPass: PackedCsmShadowPass | null = null;
  private readonly graphics: GraphicsContext;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext, private readonly source: SceneLights) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("ShadowContext: GraphicsContext has no device");
    }
    this.graphics = graphics;
    this.device = device;
    const size = Math.min(device.limits.maxTextureDimension2D, SHADOW_ATLAS_MAX_SIZE);
    this.atlas = new ShadowAtlasAllocator(SHADOW_ATLAS_MAX_SIZE, SHADOW_ATLAS_MAX_SIZE);
    this.atlas.resize(size, size);
    this.resolution_controller = new ShadowAtlasResolutionController(this.atlas);
  }

  get texture(): GPUTextureContext {
    return this.ensureTexture();
  }

  get atlas_allocated_bytes(): number {
    const texture = this._texture;
    return texture === null ? 0 : texture.width * texture.height * 4;
  }

  get atlas_width(): number { return this.atlas.size.x; }
  get atlas_height(): number { return this.atlas.size.y; }

  get packed_cascade_draw_count(): number {
    return this.packedRasterPass?.lastCascadeDraws ?? 0;
  }

  get packed_atlas_pixels_updated(): number {
    return this.packedRasterPass?.lastAtlasPixelsUpdated ?? 0;
  }

  setEnabled(enabled: boolean, command: ShadeGPUCommandContext): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    const texture = this._texture;
    const raster = this.rasterPass;
    const packed = this.packedRasterPass;
    const viewOwners: Array<GPUViewContext | GPUCameraState> = [];
    for (const map of this.maps) {
      for (const view of map.views) {
        if (view.gpu_context !== undefined) viewOwners.push(view.gpu_context);
        if (view.packed_camera_state !== undefined) viewOwners.push(view.packed_camera_state);
        view.gpu_context = undefined;
        view.packed_camera_state = undefined;
      }
    }
    this._texture = null;
    this.rasterPass = null;
    this.packedRasterPass = null;
    if (texture !== null || raster !== null || packed !== null || viewOwners.length > 0) {
      command.destroyAfterGpuDone({
        destroy: () => {
          packed?.destroy();
          raster?.destroy();
          texture?.destroy();
          for (const owner of viewOwners) owner.destroy();
        }
      });
    }
  }

  get debug_render_count(): number {
    return this.debugRenderCount;
  }

  get debug_atlas_occupancy(): number {
    return this.resolution_controller.last_occupancy;
  }

  get debug_drop_size_scale(): number {
    return this.resolution_controller.drop_size_scale;
  }

  get_map(light: Light): ShadowMapBase | undefined {
    return this.maps.find((map) => map.light === light);
  }

  process_lights(): boolean {
    if (!this.enabled) {
      const changed = this.maps.length > 0;
      for (let index = this.maps.length - 1; index >= 0; index--) this.removeMap(this.maps[index]!);
      this.maps.length = 0;
      return changed;
    }

    const lights = this.source.elements;
    let changed = false;
    const active = new Set(lights);
    for (let index = this.maps.length - 1; index >= 0; index--) {
      const map = this.maps[index]!;
      if (!active.has(map.light) || !map.light.casts_shadow) {
        this.removeMap(map);
        this.maps.splice(index, 1);
        changed = true;
      }
    }

    for (const light of lights) {
      if (!light.casts_shadow || this.get_map(light) !== undefined) continue;
      try {
        this.createMap(light);
        changed = true;
      } catch (error) {
        console.error(error);
      }
    }

    let pointIndex = 0;
    let spotIndex = 0;
    let directionalIndex = 0;
    for (const map of this.maps) {
      let shadowId: number;
      if ((map.light as PointLight).isPointLight) shadowId = pointIndex++;
      else if ((map.light as SpotLight).isSpotLight) shadowId = spotIndex++;
      else if ((map.light as DirectionalLight).isDirectionalLight) shadowId = directionalIndex++;
      else continue;
      if (map.light._gpu_shadowmap_id !== shadowId) {
        map.light._gpu_shadowmap_id = shadowId;
        map.metadata_changed = true;
        changed = true;
      }
    }
    return changed;
  }

  select_for_draw(camera: Camera, frameIndex: number, resolution: ArrayLike<number>): void {
    camera.update();
    this.frameIndex = frameIndex;
    for (const map of this.maps) map.should_draw = false;
    for (const map of this.maps) map.projected_area_px = projectedShadowArea(map.light, camera, resolution);
    this.resolution_controller.adjust(this.maps, frameIndex);
    const ordered = this.maps.map((map) => ({ map, score: shadowUpdateScore(map, frameIndex) }));
    ordered.sort((a, b) => b.score - a.score);
    const budget = 32 + this.deferredBudget;
    let selectedViews = 0;
    let deferred = false;
    for (const entry of ordered) {
      const map = entry.map;
      const viewCount = map.views.length;
      if ((map.light as DirectionalLight).isDirectionalLight) {
        map.should_draw = true;
        (map as DirectionalShadowMap).update(
          camera,
          this.directional_cascade_lambda,
          this.directional_maximum_distance,
          this.directional_texel_guard_band
        );
        selectedViews += viewCount;
        continue;
      }
      if (map.projected_area_px <= 0) continue;
      if (map.is_invalid || selectedViews + viewCount <= budget) {
        map.should_draw = true;
        if ((map.light as PointLight).isPointLight) (map as PointShadowMap).update();
        else (map as SpotShadowMap).update();
        selectedViews += viewCount;
      } else {
        deferred = true;
      }
    }
    this.deferredBudget = deferred ? Math.max(0, budget - selectedViews) : 0;
  }

  draw(
    command: ShadeGPUCommandContext,
    scene: GPUSceneContext,
    database: GPUDatabase,
    drawList: MeshletDrawList,
    packed: Readonly<{
      runtime: PackedSceneRuntime;
      assets: GpuAssetBindings;
      scene: GpuSceneBindings;
      counterBuffer: GPUBuffer | null;
      sseThreshold: number;
    }> | null = null
  ): number {
    this.debugRenderCount = 0;
    this.lastHzbBuildCount = 0;
    this.lastHzbComputePassCount = 0;
    this.lastHzbDispatchCount = 0;
    this.lastHzbOutputPixels = 0;
    this.packedRasterPass?.beginFrame();
    const meshlets = scene.meshlets;
    const sceneDatabaseBuffer = scene.scene_database_buffer;
    const meshTable = scene.meshSlice;
    const canRaster =
      sceneDatabaseBuffer !== null &&
      meshTable !== null &&
      meshlets.headerBuffer !== null &&
      meshlets.dataBuffer !== null &&
      meshlets.meshMetaBuffer !== null;

    if (canRaster || packed !== null) {
      const atlasView = this.ensureTexture().obtainView();
      for (const map of this.maps) {
        if (!map.should_draw) continue;

        let oldLayout: AABB2[] | null = null;
        if (map.pending_layout !== null) {
          oldLayout = map.layout;
          map.layout = map.pending_layout;
          map.pending_layout = null;
          map.metadata_changed = true;
        }

        let drew = true;
        if (packed !== null && (map.light as DirectionalLight).isDirectionalLight) {
          const pass = this.obtainPackedRasterPass();
          for (let viewIndex = 0; viewIndex < map.views.length; viewIndex++) {
            const layout = map.layout[viewIndex]!;
            const shadowView = map.views[viewIndex]!;
            const camera = shadowView.camera as OrthographicCamera;
            shadowView.packed_camera_state ??= new GPUCameraState(this.device, camera);
            shadowView.packed_camera_state.update(command);
            pass.execute(command, {
              runtime: packed.runtime,
              assets: packed.assets,
              scene: packed.scene,
              materials: packed.runtime.materialResources,
              camera,
              cameraBuffer: shadowView.packed_camera_state.buffer,
              cascadeIndex: viewIndex,
              viewport: [layout.x0, layout.y0, layout.width, layout.height],
              depthView: atlasView,
              sseThreshold: packed.sseThreshold,
              counterBuffer: packed.counterBuffer
            });
          }
        } else if (packed !== null) {
          // FX-04 owns directional CSM only. Packed point/spot shadows remain
          // explicitly unsupported instead of falling back to a CPU draw list.
          drew = false;
        } else if ((map.light as PointLight).isPointLight) {
          drew = this.drawPointMap(
            command,
            scene,
            map as PointShadowMap,
            atlasView,
            sceneDatabaseBuffer!,
            meshTable!,
            drawList
          );
        } else {
          for (let viewIndex = 0; viewIndex < map.views.length; viewIndex++) {
            const layout = map.layout[viewIndex]!;
            const shadowView = map.views[viewIndex]!;
            const viewContext = this.prepareViewContext(
              command,
              shadowView,
              scene,
              layout.width,
              layout.height
            );
            this.obtainLegacyRasterPass().executeFull(command, {
              camera: shadowView.camera,
              viewport: [layout.x0, layout.y0, layout.width, layout.height],
              depthView: atlasView,
              depthTexture: this.texture,
              viewContext,
              scene: scene.scene,
              sceneDatabase: scene.scene_database,
              sceneDatabaseBuffer: sceneDatabaseBuffer!,
              meshTable: meshTable!,
              materialMetadata: scene.material_metadata,
              materialRegistry: scene.materials,
              meshlets,
              drawList,
              meshCount: scene.mesh_count
            });
          }
        }

        if (!drew) {
          if (oldLayout !== null) {
            map.pending_layout = map.layout;
            map.layout = oldLayout;
          }
          map.should_draw = false;
          continue;
        }

        if (oldLayout !== null) {
          for (const layout of oldLayout) this.atlas.remove(layout);
        }
        map.should_draw = false;
        map.is_invalid = false;
        map.last_updated_frame_index = this.frameIndex;
        this.debugRenderCount++;
      }
    }

    this.commitShadowRecords(database);
    database.update(command);
    for (const map of this.maps) {
      if (map.last_updated_frame_index !== this.frameIndex) continue;
      for (const view of map.views) {
        const context = view.gpu_context;
        if (!context) continue;
        const hzb = context.hierarchical_z_buffer;
        this.lastHzbBuildCount += hzb.lastBuildCount;
        this.lastHzbComputePassCount += hzb.lastComputePassCount;
        this.lastHzbDispatchCount += hzb.lastDispatchCount;
        this.lastHzbOutputPixels += hzb.lastOutputPixels;
        context.finish_frame(command, this.frameIndex);
      }
    }
    return this.debugRenderCount;
  }

  private drawPointMap(
    command: ShadeGPUCommandContext,
    scene: GPUSceneContext,
    map: PointShadowMap,
    atlasView: GPUTextureView,
    sceneDatabaseBuffer: GPUBuffer,
    meshTable: NonNullable<GPUSceneContext["meshSlice"]>,
    drawList: MeshletDrawList
  ): boolean {
    const layout = map.layout[0]!;
    const faceResolution = Math.ceil(layout.width);
    const cubeTexture = createNativeTexture(command.device, {
      label: "ShadowContext/#zi/3x2-point-depth",
      size: [3 * faceResolution, 2 * faceResolution, 1],
      dimension: "2d",
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    const cubeView = createNativeTextureView(cubeTexture);
    const baseJob = {
      camera: map.views[0]!.camera,
      viewport: [0, 0, faceResolution, faceResolution] as const,
      depthView: cubeView,
      scene: scene.scene,
      sceneDatabase: scene.scene_database,
      sceneDatabaseBuffer,
      meshTable,
      materialMetadata: scene.material_metadata,
      materialRegistry: scene.materials,
      meshlets: scene.meshlets,
      drawList,
      meshCount: scene.mesh_count
    };
    const position = map.light.transform_global.position;
    const rasterPass = this.obtainLegacyRasterPass();
    const prepared = rasterPass.preparePointSphereMeshes(command, baseJob, [
      position.x,
      position.y,
      position.z,
      map.light.distance
    ]);
    if (!prepared) {
      cubeTexture.destroy();
      return false;
    }

    for (let face = 0; face < 6; face++) {
      const column = face % 3;
      const row = Math.floor(face / 3);
      const shadowView = map.views[face]!;
      const viewContext = this.prepareViewContext(
        command,
        shadowView,
        scene,
        faceResolution,
        faceResolution
      );
      rasterPass.executePrepared(command, {
        ...baseJob,
        camera: shadowView.camera,
        viewContext,
        viewport: [
          column * faceResolution,
          row * faceResolution,
          faceResolution,
          faceResolution
        ]
      });
    }

    rasterPass.resolvePointShadow(
      command,
      cubeView,
      atlasView,
      [layout.x0, layout.y0, layout.width, layout.height],
      map.light.distance,
      map.cube_near
    );
    command.onFinished.addOne(() => cubeTexture.destroy());
    return true;
  }

  private prepareViewContext(
    command: ShadeGPUCommandContext,
    shadowView: ShadowView,
    scene: GPUSceneContext,
    width: number,
    height: number
  ): GPUViewContext {
    let context = shadowView.gpu_context;
    if (!context) {
      context = new GPUViewContext(
        this.graphics,
        scene,
        new GPUCameraState(this.device, shadowView.camera),
        command
      );
      context.label = shadowView.label;
      shadowView.gpu_context = context;
    }
    context.update(command);
    context.setViewportSize(width, height);
    context.hierarchical_z_buffer.resetFrameStatistics();
    context.hierarchical_z_buffer.beginFrame(this.frameIndex);
    return context;
  }

  private commitShadowRecords(database: GPUDatabase): void {
    const points = database.get("shadow_point") as GPUTypedTable<ArrayLike<number>>;
    const spots = database.get("shadow_spot") as GPUTypedTable<{
      atlas: ArrayLike<number>;
      projection: ArrayLike<number>;
    }>;
    const directionals = database.get("shadow_directional") as GPUTypedTable<
      Array<{ atlas: ArrayLike<number>; projection: ArrayLike<number> }>
    >;
    let pointCount = 0;
    let spotCount = 0;
    let directionalCount = 0;

    for (const map of this.maps) {
      if (map.is_invalid) continue;
      if ((map.light as PointLight).isPointLight) {
        const index = pointCount++;
        if (map.metadata_changed) points.set(index, (map as PointShadowMap).make_record());
      } else if ((map.light as SpotLight).isSpotLight) {
        const index = spotCount++;
        if (map.metadata_changed) spots.set(index, (map as SpotShadowMap).make_record());
      } else if ((map.light as DirectionalLight).isDirectionalLight) {
        const index = directionalCount++;
        if (map.metadata_changed) {
          directionals.set(index, (map as DirectionalShadowMap).make_record());
        }
      }
      map.metadata_changed = false;
    }

    for (let index = pointCount; index < this.previousPointCount; index++) points.remove(index);
    for (let index = spotCount; index < this.previousSpotCount; index++) spots.remove(index);
    for (
      let index = directionalCount;
      index < this.previousDirectionalCount;
      index++
    ) {
      directionals.remove(index);
    }
    this.previousPointCount = pointCount;
    this.previousSpotCount = spotCount;
    this.previousDirectionalCount = directionalCount;
  }

  private createMap(light: Light): void {
    if ((light as DirectionalLight).isDirectionalLight) {
      const map = new DirectionalShadowMap(light as DirectionalLight);
      const allocated: AABB2[] = [];
      try {
        for (let cascade = 0; cascade < SHADOW_CASCADE_COUNT; cascade++) {
          const size = DIRECTIONAL_SHADOW_INITIAL_SIZES[Math.min(cascade, DIRECTIONAL_SHADOW_INITIAL_SIZES.length - 1)]!;
          const layout = this.bind(size);
          allocated.push(layout);
          map.layout[cascade] = layout;
          map.views[cascade] = { label: `Shadow Cascade ${cascade}`, camera: new OrthographicCamera() };
        }
      } catch (error) {
        for (const layout of allocated) this.atlas.remove(layout);
        throw error;
      }
      this.maps.push(map);
      return;
    }

    if ((light as SpotLight).isSpotLight) {
      const map = new SpotShadowMap(light as SpotLight);
      const layout = this.bind(128);
      map.layout[0] = layout;
      map.views[0] = { label: "Spot Shadow", camera: new PerspectiveCamera() };
      this.maps.push(map);
      return;
    }

    if ((light as PointLight).isPointLight) {
      const map = new PointShadowMap(light as PointLight);
      map.layout[0] = this.bind(128);
      for (let face = 0; face < 6; face++) {
        map.views[face] = { label: `Point Shadow face ${face}`, camera: new PerspectiveCamera() };
      }
      this.maps.push(map);
    }
  }

  private bind(size: number): AABB2 {
    const layout = new AABB2(0, 0, size, size);
    if (!this.atlas.add(layout)) throw new Error("Failed to add shadowmap to atlas");
    return layout;
  }

  private removeMap(map: ShadowMapBase): void {
    for (const layout of map.layout) this.atlas.remove(layout);
    if (map.pending_layout !== null) {
      for (const layout of map.pending_layout) this.atlas.remove(layout);
      map.pending_layout = null;
    }
    map.light._gpu_shadowmap_id = -1;
    map.destroy();
  }

  destroy(): void {
    this.packedRasterPass?.destroy();
    this.rasterPass?.destroy();
    this._texture?.destroy();
    for (const map of this.maps) map.destroy();
    this.maps.length = 0;
  }

  releasePackedScene(
    runtime: PackedSceneRuntime,
    command: ShadeGPUCommandContext
  ): void {
    this.packedRasterPass?.release(runtime, command);
  }

  private ensureTexture(): GPUTextureContext {
    if (!this.enabled) throw new Error("Shadow atlas requested while shadows are disabled");
    if (this._texture !== null) return this._texture;
    const size = Math.min(this.device.limits.maxTextureDimension2D, SHADOW_ATLAS_MAX_SIZE);
    this._texture = new GPUTextureContext(this.device, {
      label: "FX-04 ShadowAtlas/depth32float",
      size: [size, size, 1],
      dimension: "2d",
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    }, {
      accounting: this.graphics.resource_accounting,
      category: "atlas",
      owner: "ShadowService"
    });
    return this._texture;
  }

  private obtainLegacyRasterPass(): ShadowRasterPass {
    this.rasterPass ??= new ShadowRasterPass(this.graphics);
    return this.rasterPass;
  }

  private obtainPackedRasterPass(): PackedCsmShadowPass {
    this.packedRasterPass ??= new PackedCsmShadowPass(this.graphics);
    return this.packedRasterPass;
  }
}

/** Practical split (uniform/log blend) used by three.js CSM and PSSM references. */
export function computePracticalCascadeSplits(
  near: number,
  far: number,
  cascadeCount = 3,
  lambda = 0.5
): Float32Array {
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    throw new RangeError("CSM split range must satisfy 0 < near < far");
  }
  if (!Number.isInteger(cascadeCount) || cascadeCount <= 0) {
    throw new RangeError("CSM cascade count must be a positive integer");
  }
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new RangeError("CSM practical split lambda must be in [0, 1]");
  }
  const splits = new Float32Array(cascadeCount);
  for (let cascade = 1; cascade <= cascadeCount; cascade++) {
    const ratio = cascade / cascadeCount;
    const uniform = near + (far - near) * ratio;
    const logarithmic = near * Math.pow(far / near, ratio);
    const distance = lerp(uniform, logarithmic, lambda);
    splits[cascade - 1] = cascade === cascadeCount
      ? 1
      : (distance - near) / (far - near);
  }
  return splits;
}

export function snapShadowBoundsToTexelGrid(
  bounds: SceneAABB,
  width: number,
  height: number
): void {
  if (!(width > 0) || !(height > 0) || !(bounds.width > 0) || !(bounds.height > 0)) {
    throw new RangeError("CSM texel snapping requires positive bounds and resolution");
  }
  const texelX = bounds.width / width;
  const texelY = bounds.height / height;
  const centerX = 0.5 * (bounds.x0 + bounds.x1);
  const centerY = 0.5 * (bounds.y0 + bounds.y1);
  const snappedX = Math.floor(centerX / texelX) * texelX;
  const snappedY = Math.floor(centerY / texelY) * texelY;
  const deltaX = snappedX - centerX;
  const deltaY = snappedY - centerY;
  bounds.x0 += deltaX;
  bounds.x1 += deltaX;
  bounds.y0 += deltaY;
  bounds.y1 += deltaY;
}

export function shadowUpdateScore(map: ShadowMapBase, frameIndex: number): number {
  return (map.light as DirectionalLight).isDirectionalLight
    ? Number.POSITIVE_INFINITY
    : map.projected_area_px * (1 + Math.max(0, frameIndex - map.last_updated_frame_index));
}

export function projectedShadowArea(light: Light, camera: Camera, resolution: ArrayLike<number>): number {
  const fullArea = resolution[0]! * resolution[1]!;
  if ((light as DirectionalLight).isDirectionalLight) return fullArea;
  let radius = 0;
  if ((light as PointLight).isPointLight) radius = (light as PointLight).distance;
  else if ((light as SpotLight).isSpotLight) radius = (light as SpotLight).distance / Math.max(Math.cos((light as SpotLight).angle), 1e-4);
  else return 0;
  if (!Number.isFinite(radius) || radius <= 0) return fullArea;

  const position = light.transform_global.position;
  const view = camera.view_matrix;
  const x = view[0]! * position.x + view[4]! * position.y + view[8]! * position.z + view[12]!;
  const y = view[1]! * position.x + view[5]! * position.y + view[9]! * position.z + view[13]!;
  const z = view[2]! * position.x + view[6]! * position.y + view[10]! * position.z + view[14]!;
  if (z - radius > 0) return 0;
  if (z >= -radius) return fullArea;

  const projection = camera.projection_matrix;
  const radiusSquared = radius * radius;
  const xTerm = x * x + z * z - radiusSquared;
  const yTerm = y * y + z * z - radiusSquared;
  if (xTerm <= 0 || yTerm <= 0) return fullArea;
  const xRoot = Math.sqrt(xTerm);
  const xRadius = x * radius;
  const zRadius = z * radius;
  let x0 = ((x * xRoot - zRadius) * projection[0]!) / (z * xRoot + xRadius);
  let x1 = ((x * xRoot + zRadius) * projection[0]!) / (z * xRoot - xRadius);
  const yRoot = Math.sqrt(yTerm);
  const yRadius = y * radius;
  let y0 = ((y * yRoot - zRadius) * projection[5]!) / (z * yRoot + yRadius);
  let y1 = ((y * yRoot + zRadius) * projection[5]!) / (z * yRoot - yRadius);
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  x0 = Math.max(x0, -1);
  x1 = Math.min(x1, 1);
  y0 = Math.max(y0, -1);
  y1 = Math.min(y1, 1);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return 0;
  return 0.5 * width * resolution[0]! * (0.5 * height * resolution[1]!);
}

function replaceInfiniteFarPlane(frustum: Float32Array, viewMatrix: Float32Array, far: number): void {
  const inverse = new Float32Array(16);
  if (!mat4Invert(inverse, viewMatrix)) return;
  const sx = -inverse[8]!;
  const sy = -inverse[9]!;
  const sz = -inverse[10]!;
  const nx = -sx;
  const ny = -sy;
  const nz = -sz;
  frustum[20] = nx;
  frustum[21] = ny;
  frustum[22] = nz;
  frustum[23] = -(nx * (inverse[12]! + sx * far) + ny * (inverse[13]! + sy * far) + nz * (inverse[14]! + sz * far));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function writeLerpedPlane(
  out: Float32Array,
  offset: number,
  planes: ArrayLike<number>,
  aOffset: number,
  bOffset: number,
  t: number,
  reverse: boolean
): void {
  const aScale = reverse ? -1 : 1;
  const bScale = -aScale;
  const x = lerp(aScale * planes[aOffset]!, bScale * planes[bOffset]!, t);
  const y = lerp(aScale * planes[aOffset + 1]!, bScale * planes[bOffset + 1]!, t);
  const z = lerp(aScale * planes[aOffset + 2]!, bScale * planes[bOffset + 2]!, t);
  const w = lerp(aScale * planes[aOffset + 3]!, bScale * planes[bOffset + 3]!, t);
  const inverseLength = 1 / Math.sqrt(x * x + y * y + z * z);
  out[offset] = x * inverseLength;
  out[offset + 1] = y * inverseLength;
  out[offset + 2] = z * inverseLength;
  out[offset + 3] = w * inverseLength;
}

function slicePlanePair(out: Float32Array, offset: number, planes: ArrayLike<number>, aOffset: number, bOffset: number, min: number, max: number): void {
  writeLerpedPlane(out, offset, planes, aOffset, bOffset, min, false);
  writeLerpedPlane(out, offset + 4, planes, aOffset, bOffset, max, true);
}

function sliceFrustumPlanes(out: Float32Array, planes: ArrayLike<number>, zMin: number, zMax: number): void {
  slicePlanePair(out, 0, planes, 0, 4, 0, 1);
  slicePlanePair(out, 8, planes, 8, 12, 0, 1);
  slicePlanePair(out, 16, planes, 16, 20, zMin, zMax);
}

function intersectPlanes(out: Float32Array, offset: number, a: ArrayLike<number>, ao: number, bo: number, co: number): boolean {
  const n0 = a[ao]!;
  const n1 = a[ao + 1]!;
  const n2 = a[ao + 2]!;
  const nd = a[ao + 3]!;
  const b0 = a[bo]!;
  const b1 = a[bo + 1]!;
  const b2 = a[bo + 2]!;
  const bd = a[bo + 3]!;
  const c0 = a[co]!;
  const c1 = a[co + 1]!;
  const c2 = a[co + 2]!;
  const cd = a[co + 3]!;
  const h = b1 * c2 - b2 * c1;
  const g = b2 * c0 - b0 * c2;
  const p = b0 * c1 - b1 * c0;
  const v = c1 * n2 - c2 * n1;
  const A = c2 * n0 - c0 * n2;
  const B = c0 * n1 - c1 * n0;
  const w = n1 * b2 - n2 * b1;
  const x = n2 * b0 - n0 * b2;
  const y = n0 * b1 - n1 * b0;
  const determinant = n0 * h + n1 * g + n2 * p;
  if (determinant === 0) return false;
  const inverse = 1 / determinant;
  const negativeD = -nd;
  out[offset] = (h * negativeD - v * bd - w * cd) * inverse;
  out[offset + 1] = (g * negativeD - A * bd - x * cd) * inverse;
  out[offset + 2] = (p * negativeD - B * bd - y * cd) * inverse;
  return true;
}

function frustumCorners(out: Float32Array, planes: ArrayLike<number>): void {
  intersectPlanes(out, 0, planes, 0, 8, 16);
  intersectPlanes(out, 3, planes, 0, 8, 20);
  intersectPlanes(out, 6, planes, 0, 12, 16);
  intersectPlanes(out, 9, planes, 0, 12, 20);
  intersectPlanes(out, 12, planes, 4, 8, 16);
  intersectPlanes(out, 15, planes, 4, 8, 20);
  intersectPlanes(out, 18, planes, 4, 12, 16);
  intersectPlanes(out, 21, planes, 4, 12, 20);
}

function averagePoints(points: ArrayLike<number>, count: number): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    x += points[offset]!;
    y += points[offset + 1]!;
    z += points[offset + 2]!;
  }
  return new Vec3(x / count, y / count, z / count);
}

function transformedPointBounds(points: ArrayLike<number>, matrix: Float32Array): SceneAABB {
  const bounds = new SceneAABB();
  aabbSetFromTransformedPositions(bounds, points, points.length, matrix);
  return bounds;
}
