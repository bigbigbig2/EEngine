/**
 * ViewContext：负责渲染管线编排、视图状态或渲染目标管理。
 */

import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GPUSceneContext } from "../gpu/GPUSceneContext.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  WGSL_mat4x4f,
  WGSL_u32,
  WGSL_vec2f
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";
import {
  mat4FromTranslationScale,
  mat4Multiply
} from "../core/math/Mat4.js";
import type { GPUCameraState } from "./GPUCameraState.js";
import { HierarchicalZBuffer } from "./HierarchicalZBuffer.js";

export const GPU_VIEW_TYPE = StructType.from(
  {
    projection_matrix: WGSL_mat4x4f,
    width: WGSL_u32,
    height: WGSL_u32,
    frame_index: WGSL_u32,
    upscale_ratio: WGSL_vec2f,
    jitter: WGSL_vec2f
  },
  "PipelineCacheKey"
).pack();

let nextGpuViewContextId = 0;

export class GPUViewContext {
  readonly isGPUViewContext = true;
  readonly id = nextGpuViewContextId++;
  label = "";
  width = 1;
  height = 1;
  frame_index = 0;
  private readonly resolutionValue = new Uint32Array([1, 1]);

  readonly scene: GPUSceneContext;
  readonly camera: GPUCameraState;
  readonly gpu_previous_camera_state: GPUCameraState;
  readonly hierarchical_z_buffer: HierarchicalZBuffer;
  readonly uniform_buffer: GPUBuffer;

  private readonly graphics: GraphicsContext;
  private readonly device: GPUDevice;
  private readonly uniformData = new ArrayBuffer(GPU_VIEW_TYPE.size);
  private readonly projectionMatrix = new Float32Array(16);
  private readonly viewportMatrix = new Float32Array(16);
  private readonly previousViewProjection = new Float32Array(16);
  private readonly upscaleRatio = new Float32Array([1, 1]);
  private readonly jitter = new Float32Array(2);

  constructor(
    graphics: GraphicsContext,
    scene: GPUSceneContext,
    camera: GPUCameraState,
    command: ShadeGPUCommandContext
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("GPUViewContext: GraphicsContext has no device");
    }
    this.graphics = graphics;
    this.device = device;
    this.scene = scene;
    this.camera = camera;
    this.hierarchical_z_buffer = new HierarchicalZBuffer(graphics);
    this.gpu_previous_camera_state = camera.clone(command);
    this.uniform_buffer = device.createBuffer({
      label: "GPUViewContext/uj/Yu",
      size: GPU_VIEW_TYPE.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  get gpu_scene(): GPUSceneContext {
    return this.scene;
  }

  get gpu_camera_state(): GPUCameraState {
    return this.camera;
  }

  setUpscaleRatio(x: number, y: number): void {
    this.upscaleRatio[0] = x;
    this.upscaleRatio[1] = y;
  }

  setJitter(x: number, y: number): void {
    this.jitter[0] = x;
    this.jitter[1] = y;
  }

  setJitterDelta(x: number, y: number): void {
    this.jitter[0] = x;
    this.jitter[1] = y;
  }

  get resolution(): Uint32Array {
    return this.resolutionValue;
  }

  setViewportSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resolutionValue[0] = width;
    this.resolutionValue[1] = height;
    this.hierarchical_z_buffer.setViewportSize(this.width, this.height);
  }

  equals(other: GPUViewContext): boolean {
    return this === other || (
      this.device === other.device &&
      this.scene === other.scene &&
      this.camera === other.camera
    );
  }

  hash(): number {
    return 0;
  }

  update_uniforms(command: ShadeGPUCommandContext): void {
    mat4FromTranslationScale(
      this.viewportMatrix,
      { x: 0.5 * this.width, y: 0.5 * this.height, z: 0 },
      { x: 0.5 * this.width, y: -0.5 * this.height, z: 1 }
    );
    mat4Multiply(
      this.projectionMatrix,
      this.viewportMatrix,
      this.camera.view_projection_matrix
    );
    writeWgslToBuffer(
      {
        projection_matrix: this.projectionMatrix,
        width: this.width,
        height: this.height,
        frame_index: this.frame_index,
        upscale_ratio: this.upscaleRatio,
        jitter: this.jitter
      },
      GPU_VIEW_TYPE,
      this.uniformData
    );
    command.writeBuffer(
      this.uniform_buffer,
      0,
      this.uniformData,
      0,
      this.uniformData.byteLength
    );
  }

  update(command: ShadeGPUCommandContext): void {
    this.camera.update(command);
    this.update_uniforms(command);
    this.graphics.profiler.addCounter("runtime.viewPrepareCount", 1);
  }

  finish_frame(command: ShadeGPUCommandContext): void {
    this.previousViewProjection.set(this.camera.camera.view_projection_matrix);
    this.gpu_previous_camera_state.copy(this.camera, command.gpu_encoder);
    this.frame_index++;
  }

  destroy(): void {
    this.uniform_buffer.destroy();
    this.gpu_previous_camera_state.destroy();
    this.hierarchical_z_buffer.destroy();
  }
}

export type ViewHandle = GPUViewContext;
