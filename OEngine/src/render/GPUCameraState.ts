/**
 * GPUCameraState：负责渲染管线编排、视图状态或渲染目标管理。
 */

import type { Camera } from "../camera/Camera.js";
import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";
import {
  submitGpuCommands,
  writeGpuBuffer
} from "../gpu/GpuQueueEvidence.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";

let nextGpuCameraStateId = 0;

export class GPUCameraState {
  readonly id = nextGpuCameraStateId++;
  readonly buffer: GPUBuffer;
  private readonly packed = new ArrayBuffer(LPV_CAMERA_TYPE.size);
  private readonly viewportOffset = new Float32Array(2);
  private readonly viewProjection = new Float32Array(16);

  constructor(
    private readonly device: GPUDevice,
    private cameraValue: Camera,
  ) {
    this.buffer = device.createBuffer({
      label: "GPUCameraState/Ud",
      size: LPV_CAMERA_TYPE.size,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.UNIFORM |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
  }

  get gpu_buffer(): GPUBuffer {
    return this.buffer;
  }

  get camera(): Camera {
    return this.cameraValue;
  }

  set camera(value: Camera) {
    this.cameraValue = value;
  }

  get view_projection_matrix(): Float32Array {
    return this.viewProjection;
  }

  setViewportOffset(x: number, y: number): void {
    this.viewportOffset[0] = x;
    this.viewportOffset[1] = y;
  }

  update(): void {
    const camera = this.cameraValue;
    camera.update();
    const projection = Float64Array.from(camera.projection_matrix);
    projection[8] = projection[8]! + this.viewportOffset[0]!;
    projection[9] = projection[9]! - this.viewportOffset[1]!;
    const viewProjection = multiplyMat4(projection, camera.view_matrix);
    this.viewProjection.set(viewProjection);
    const transformInverse = invertMat4(camera.transform.matrix);
    const viewInverse = invertMat4(camera.view_matrix);
    const projectionInverse = invertMat4(projection);
    const viewProjectionInverse = invertMat4(viewProjection);
    const frustum = new Array<Float32Array>(6);
    for (let index = 0; index < 6; index++) {
      frustum[index] = camera.frustum.subarray(index * 4, index * 4 + 4);
    }
    const near = Math.min(camera.near, camera.far);
    const far = Math.max(camera.near, camera.far);
    const depthToView = new Float32Array(4);
    if (camera.isInfiniteFar) {
      depthToView[0] = 0;
      depthToView[1] = near;
    } else {
      depthToView[0] = near / (far - near);
      depthToView[1] = (far * near) / (far - near);
    }
    const fov = (camera as PerspectiveCamera).fov;
    const cotangent = Math.cos(0.5 * fov) / Math.sin(0.5 * fov);
    depthToView[2] = 1 / (cotangent / camera.aspect);
    depthToView[3] = 1 / cotangent;
    writeWgslToBuffer(
      {
        transform: camera.transform.matrix,
        transform_inverse: transformInverse,
        view_matrix: camera.view_matrix,
        view_matrix_inverse: viewInverse,
        projection_matrix: projection,
        projection_matrix_inverse: projectionInverse,
        view_projection_matrix: viewProjection,
        view_projection_matrix_inverse: viewProjectionInverse,
        frustum,
        device_depth_to_view_space: depthToView,
      },
      LPV_CAMERA_TYPE,
      this.packed,
    );
    writeGpuBuffer(
      this.device.queue,
      "GPUCameraState/update",
      this.buffer,
      0,
      this.packed
    );
  }

  clone(): GPUCameraState {
    const clone = new GPUCameraState(this.device, this.cameraValue.clone());
    clone.viewportOffset.set(this.viewportOffset);
    clone.viewProjection.set(this.viewProjection);
    clone.copy(this);
    return clone;
  }

  copy(source: GPUCameraState, encoder?: GPUCommandEncoder): void {
    this.cameraValue.copy(source.camera);
    this.viewportOffset.set(source.viewportOffset);
    this.viewProjection.set(source.viewProjection);
    if (encoder) {
      encoder.copyBufferToBuffer(
        source.buffer,
        0,
        this.buffer,
        0,
        this.buffer.size,
      );
      return;
    }
    const copyEncoder = this.device.createCommandEncoder();
    copyEncoder.copyBufferToBuffer(
      source.buffer,
      0,
      this.buffer,
      0,
      this.buffer.size,
    );
    submitGpuCommands(this.device, "GPUCameraState/copy", [copyEncoder.finish()]);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

export class GPUCameraStateManager {
  private readonly states = new Map<Camera, GPUCameraState>();

  constructor(private readonly device: GPUDevice) {}

  obtain(camera: Camera): GPUCameraState {
    let state = this.states.get(camera);
    if (!state) {
      state = new GPUCameraState(this.device, camera);
      this.states.set(camera, state);
    }
    return state;
  }

  destroy(): void {
    for (const state of this.states.values()) state.destroy();
    this.states.clear();
  }
}

function multiplyMat4(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): Float32Array {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    const b0 = b[offset] ?? 0;
    const b1 = b[offset + 1] ?? 0;
    const b2 = b[offset + 2] ?? 0;
    const b3 = b[offset + 3] ?? 0;
    output[offset] =
      b0 * (a[0] ?? 0) +
      b1 * (a[4] ?? 0) +
      b2 * (a[8] ?? 0) +
      b3 * (a[12] ?? 0);
    output[offset + 1] =
      b0 * (a[1] ?? 0) +
      b1 * (a[5] ?? 0) +
      b2 * (a[9] ?? 0) +
      b3 * (a[13] ?? 0);
    output[offset + 2] =
      b0 * (a[2] ?? 0) +
      b1 * (a[6] ?? 0) +
      b2 * (a[10] ?? 0) +
      b3 * (a[14] ?? 0);
    output[offset + 3] =
      b0 * (a[3] ?? 0) +
      b1 * (a[7] ?? 0) +
      b2 * (a[11] ?? 0) +
      b3 * (a[15] ?? 0);
  }
  return output;
}

function invertMat4(a: ArrayLike<number>): Float32Array {
  const a00 = a[0] ?? 0,
    a01 = a[1] ?? 0,
    a02 = a[2] ?? 0,
    a03 = a[3] ?? 0;
  const a10 = a[4] ?? 0,
    a11 = a[5] ?? 0,
    a12 = a[6] ?? 0,
    a13 = a[7] ?? 0;
  const a20 = a[8] ?? 0,
    a21 = a[9] ?? 0,
    a22 = a[10] ?? 0,
    a23 = a[11] ?? 0;
  const a30 = a[12] ?? 0,
    a31 = a[13] ?? 0,
    a32 = a[14] ?? 0,
    a33 = a[15] ?? 0;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let determinant =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (determinant === 0) {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
  }
  determinant = 1 / determinant;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * determinant,
    (a02 * b10 - a01 * b11 - a03 * b09) * determinant,
    (a31 * b05 - a32 * b04 + a33 * b03) * determinant,
    (a22 * b04 - a21 * b05 - a23 * b03) * determinant,
    (a12 * b08 - a10 * b11 - a13 * b07) * determinant,
    (a00 * b11 - a02 * b08 + a03 * b07) * determinant,
    (a32 * b02 - a30 * b05 - a33 * b01) * determinant,
    (a20 * b05 - a22 * b02 + a23 * b01) * determinant,
    (a10 * b10 - a11 * b08 + a13 * b06) * determinant,
    (a01 * b08 - a00 * b10 - a03 * b06) * determinant,
    (a30 * b04 - a31 * b02 + a33 * b00) * determinant,
    (a21 * b02 - a20 * b04 - a23 * b00) * determinant,
    (a11 * b07 - a10 * b09 - a12 * b06) * determinant,
    (a00 * b09 - a01 * b07 + a02 * b06) * determinant,
    (a31 * b01 - a30 * b03 - a32 * b00) * determinant,
    (a20 * b03 - a21 * b01 + a22 * b00) * determinant,
  ]);
}
