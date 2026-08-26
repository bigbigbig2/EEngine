/**
 * GPUVolumetrics：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import {
  WGSL_f32,
  WGSL_mat4x4f,
  WGSL_u32,
  WGSL_vec3f
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";
import { mat4Invert } from "../core/math/Mat4.js";
import type {
  ParticipatingMediaVolume,
  SceneVolumetrics
} from "../scene/Scene.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { GPUIndexedRecordTable } from "./GPUIndexedRecordTable.js";
import { GPUTypedBuffer } from "./GPUTypedBuffer.js";

export const GPU_VOLUMETRIC_PARTICLE_TYPE = StructType.from(
  {
    scattering: WGSL_vec3f,
    extinction: WGSL_vec3f,
    diameter_micron: WGSL_f32,
    g: WGSL_f32
  },
  "GPUVolumetricParticleSpec"
);

export const GPU_VOLUMETRIC_INSTANCE_TYPE = StructType.from(
  {
    particle_spec: GPU_VOLUMETRIC_PARTICLE_TYPE,
    transform: WGSL_mat4x4f,
    transform_inverse: WGSL_mat4x4f,
    fade_distance: WGSL_f32,
    density: WGSL_f32
  },
  "GPUVolumetricInstance"
);

export const GPU_VOLUMETRIC_METADATA_TYPE = StructType.from(
  { instance_count: WGSL_u32 },
  "GPUVolumetricMetadata"
);

export const GPU_VOLUMETRIC_RECORD_BYTES =
  GPU_VOLUMETRIC_INSTANCE_TYPE.aligned_size;
export const GPU_VOLUMETRIC_METADATA_BYTES =
  GPU_VOLUMETRIC_METADATA_TYPE.size;
export const GPU_VOLUMETRICS_UPDATE_LABEL = "volumetrics update";

export type GPUVolumetricRecord = {
  particle_spec: {
    scattering: ArrayLike<number>;
    extinction: ArrayLike<number>;
    diameter_micron: number;
    g: number;
  };
  transform: ArrayLike<number>;
  transform_inverse: ArrayLike<number>;
  fade_distance: number;
  density: number;
};

export function packGPUVolumetricRecord(
  value: GPUVolumetricRecord,
  target: ArrayBuffer,
  byteOffset = 0
): void {
  writeWgslToBuffer(
    value,
    GPU_VOLUMETRIC_INSTANCE_TYPE,
    target,
    byteOffset
  );
}

export class GPUVolumetrics {
  readonly source: SceneVolumetrics;

  private version = -1;
  private readonly device: GPUDevice;
  private readonly gpuTable: GPUIndexedRecordTable<GPUVolumetricRecord>;
  private readonly metadataBuffer: GPUTypedBuffer<{ instance_count: number }>;

  get table(): GPUIndexedRecordTable<GPUVolumetricRecord> {
    return this.gpuTable;
  }

  get metadata_buffer(): GPUTypedBuffer<{ instance_count: number }> {
    return this.metadataBuffer;
  }

  constructor(device: GPUDevice, source: SceneVolumetrics) {
    this.device = device;
    this.source = source;
    this.gpuTable = new GPUIndexedRecordTable<GPUVolumetricRecord>({
      device,
      type: GPU_VOLUMETRIC_INSTANCE_TYPE,
      recordSizeBytes: GPU_VOLUMETRIC_RECORD_BYTES,
      pack: packGPUVolumetricRecord
    });
    this.metadataBuffer = GPUTypedBuffer.create({
      label: "",
      device,
      type: GPU_VOLUMETRIC_METADATA_TYPE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  update(command: ShadeGPUCommandContext, _timeDeltaSeconds = 0): boolean {
    if (this.version === this.source.version) return false;

    const transformInverse = new Float32Array(16);
    this.source.volumes.forEach((volume, index) => {
      this.queueVolume(index, volume, transformInverse);
    });
    this.gpuTable.update(command);
    this.metadataBuffer.upload(
      { instance_count: this.source.volumes.length },
      this.device.queue
    );
    this.version = this.source.version;
    return true;
  }

  destroy(): void {
    this.gpuTable.destroy();
  }

  private queueVolume(
    index: number,
    volume: ParticipatingMediaVolume,
    transformInverse: Float32Array
  ): void {
    mat4Invert(transformInverse, volume.transform.matrix);
    this.gpuTable.set(index, {
      particle_spec: {
        scattering: volume.particle_spec.scattering,
        extinction: volume.particle_spec.extinction,
        diameter_micron: 2 * volume.particle_spec.radius * 1e6,
        g: volume.particle_spec.g
      },
      transform: volume.transform.matrix,
      transform_inverse: transformInverse,
      fade_distance: volume.fade_distance,
      density: volume.density
    });
  }
}
