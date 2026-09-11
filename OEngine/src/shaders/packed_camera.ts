/** Shared packed camera ABI used by raster and compute shaders. */

import { ArrayType, WGSL_mat4x4f, WGSL_vec4f } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";

export const PACKED_CAMERA_TYPE = StructType.from(
  {
    transform: WGSL_mat4x4f,
    transform_inverse: WGSL_mat4x4f,
    view_matrix: WGSL_mat4x4f,
    view_matrix_inverse: WGSL_mat4x4f,
    projection_matrix: WGSL_mat4x4f,
    projection_matrix_inverse: WGSL_mat4x4f,
    view_projection_matrix: WGSL_mat4x4f,
    view_projection_matrix_inverse: WGSL_mat4x4f,
    frustum: ArrayType.from(WGSL_vec4f, 6),
    device_depth_to_view_space: WGSL_vec4f
  },
  "CommandEncoder"
).pack();
