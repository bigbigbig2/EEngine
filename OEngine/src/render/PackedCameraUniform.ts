/**
 * PackedCameraUniform：负责渲染管线编排、视图状态或渲染目标管理。
 */

import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";
import { mat4Invert } from "../core/math/Mat4.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";

export class PackedCameraUniform {
  readonly buffer: GPUBuffer;
  private readonly data = new ArrayBuffer(LPV_CAMERA_TYPE.size);
  private readonly transformInverse = new Float32Array(16);
  private readonly viewInverse = new Float32Array(16);
  private readonly projectionInverse = new Float32Array(16);
  private readonly viewProjectionInverse = new Float32Array(16);

  constructor(
    private readonly device: GPUDevice,
    label: string
  ) {
    this.buffer = device.createBuffer({
      label,
      size: LPV_CAMERA_TYPE.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  update(camera: PerspectiveCamera): void {
    camera.update();
    if (
      !mat4Invert(this.transformInverse, camera.transform.matrix) ||
      !mat4Invert(this.viewInverse, camera.view_matrix) ||
      !mat4Invert(this.projectionInverse, camera.projection_matrix) ||
      !mat4Invert(this.viewProjectionInverse, camera.view_projection_matrix)
    ) {
      throw new Error("PackedCameraUniform: camera matrix is singular");
    }
    const frustum = new Array<Float32Array>(6);
    for (let i = 0; i < 6; i++) {
      frustum[i] = camera.frustum.subarray(i * 4, i * 4 + 4);
    }
    const cotangent = 1 / Math.tan(camera.fov * 0.5);
    const depthToView = new Float32Array([
      0,
      Math.min(camera.near, camera.far),
      camera.aspect / cotangent,
      1 / cotangent
    ]);
    writeWgslToBuffer(
      {
        transform: camera.transform.matrix,
        transform_inverse: this.transformInverse,
        view_matrix: camera.view_matrix,
        view_matrix_inverse: this.viewInverse,
        projection_matrix: camera.projection_matrix,
        projection_matrix_inverse: this.projectionInverse,
        view_projection_matrix: camera.view_projection_matrix,
        view_projection_matrix_inverse: this.viewProjectionInverse,
        frustum,
        device_depth_to_view_space: depthToView
      },
      LPV_CAMERA_TYPE,
      this.data
    );
    writeGpuBuffer(
      this.device.queue,
      "PackedCameraUniform/update",
      this.buffer,
      0,
      this.data
    );
  }

  destroy(): void {
    this.buffer.destroy();
  }
}
