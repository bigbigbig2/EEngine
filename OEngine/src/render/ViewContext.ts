/**
 * ViewContext：负责渲染管线编排、视图状态或渲染目标管理。
 */

import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GPUSceneEnvironmentContext } from "../gpu/GPUSceneEnvironmentContext.js";
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
import { GPUCameraState } from "./GPUCameraState.js";
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

  readonly environment: GPUSceneEnvironmentContext;
  readonly camera: GPUCameraState;
  readonly gpu_previous_camera_state: GPUCameraState;
  readonly hierarchical_z_buffer: HierarchicalZBuffer;
  readonly uniform_buffer: GPUBuffer;

  private readonly graphics: GraphicsContext;
  private readonly device: GPUDevice;
  private readonly uniformData = new ArrayBuffer(GPU_VIEW_TYPE.size);
  private readonly projectionMatrix = new Float32Array(16);
  private readonly viewportMatrix = new Float32Array(16);
  private readonly upscaleRatio = new Float32Array([1, 1]);
  private readonly jitter = new Float32Array(2);

  constructor(
    graphics: GraphicsContext,
    environment: GPUSceneEnvironmentContext,
    camera: GPUCameraState
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("GPUViewContext: GraphicsContext has no device");
    }
    this.graphics = graphics;
    this.device = device;
    this.environment = environment;
    this.camera = camera;
    this.hierarchical_z_buffer = new HierarchicalZBuffer(graphics);
    // The first frame seeds this buffer after the current camera upload. A
    // constructor-time copy would read the not-yet-uploaded current buffer.
    this.gpu_previous_camera_state = new GPUCameraState(device, camera.camera.clone());
    this.uniform_buffer = device.createBuffer({
      label: "GPUViewContext/uj/Yu",
      size: GPU_VIEW_TYPE.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  get gpu_scene_environment(): GPUSceneEnvironmentContext {
    return this.environment;
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
    this.camera.setViewportOffset(x / Math.max(1, this.width), y / Math.max(1, this.height));
  }

  setJitterDelta(x: number, y: number): void {
    this.jitter[0] = x;
    this.jitter[1] = y;
    this.camera.setViewportOffset(x / Math.max(1, this.width), y / Math.max(1, this.height));
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
      this.environment === other.environment &&
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
    if (this.frame_index === 0) {
      // First frame (also a retry after abort): motion starts from the current
      // camera. Both copies are encoded in the owning frame, before Surface.
      command.gpu_encoder.copyBufferToBuffer(this.camera.buffer, 0,
        this.gpu_previous_camera_state.buffer, 0, this.gpu_previous_camera_state.buffer.size);
      this.gpu_previous_camera_state.copyCpu(this.camera);
    }
    this.update_uniforms(command);
    this.graphics.profiler.addCounter("runtime.viewPrepareCount", 1);
  }

  finish_frame(command: ShadeGPUCommandContext, hzbFrameIndex = this.frame_index): void {
    // The GPU copy belongs to this frame encoder. Its CPU mirror and the view
    // counter become visible only if that encoder is actually submitted.
    command.gpu_encoder.copyBufferToBuffer(this.camera.buffer, 0,
      this.gpu_previous_camera_state.buffer, 0, this.gpu_previous_camera_state.buffer.size);
    // History becomes visible only after the owning command context has been submitted.
    command.onFinished.addOne(() => {
      this.gpu_previous_camera_state.copyCpu(this.camera);
      this.hierarchical_z_buffer.commitHistory(hzbFrameIndex);
      this.frame_index++;
    });
    command.onAborted.addOne(() => {
      this.hierarchical_z_buffer.invalidate("explicit");
    });
  }

  destroy(): void {
    this.uniform_buffer.destroy();
    this.gpu_previous_camera_state.destroy();
    this.hierarchical_z_buffer.destroy();
  }
}

export type ViewHandle = GPUViewContext;
