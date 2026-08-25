/**
 * SceneSdf：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { BinaryReader } from "../loaders/BinaryReader.js";
import { halfToFloat } from "../loaders/float16.js";
import { RAY_QUERY_WGSL } from "../shaders/ray_query.js";
import { ShadeDataType } from "../texture/ShadeDataType.js";
import type { GPUSceneContext } from "./GPUSceneContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  recordGpuReadback,
  submitGpuCommands,
  writeGpuTexture
} from "./GpuQueueEvidence.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";

export type SceneSdfBounds = {
  min: Float32Array;
  max: Float32Array;
};

const SCENE_SDF_MAGIC = "Shade-SDF";
const SCENE_SDF_VERSION = 1;

const QUERY_RESOURCES_WGSL = /* wgsl */ `
@group(1) @binding(0) var<storage, read> scene_database: array<u32>;
@group(1) @binding(1) var<storage, read> tlas_data: array<u32>;
@group(1) @binding(2) var<storage, read> blas_addresses: array<u32>;
@group(1) @binding(3) var<storage, read> blas_nodes: array<u32>;
@group(1) @binding(4) var<storage, read> geometries: array<u32>;
@group(1) @binding(5) var<storage, read> meshlet_headers: array<u32>;
@group(1) @binding(6) var<storage, read> meshlet_data: array<u32>;
`;

function createSceneSdfShader(format: "r16float" | "r32float"): string {
  return /* wgsl */ `
struct SceneSdfBounds {
  min: vec3f,
  _pad0: f32,
  max: vec3f,
  _pad1: f32,
};

struct SceneSdfSettings {
  world_bounds: SceneSdfBounds,
};

@group(0) @binding(0) var<uniform> settings: SceneSdfSettings;
@group(0) @binding(1) var intensity: texture_storage_3d<${format}, write>;
${QUERY_RESOURCES_WGSL}
${RAY_QUERY_WGSL}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let dimensions = textureDimensions(intensity);
  if (any(global_id >= dimensions)) { return; }
  let uvw = (vec3f(global_id) + 0.5) / vec3f(dimensions);
  let span = settings.world_bounds.max - settings.world_bounds.min;
  let position = span * uvw + settings.world_bounds.min;
  let max_distance = length(span);
  let nearest = scene_point_query_nearest(position, max_distance);
  let distance_to_surface = distance(nearest.position, position);
  let sign = scene_point_query_volume_sign(position, max_distance);
  let signed_distance = distance_to_surface * sign;
  textureStore(intensity, global_id, vec4f(signed_distance));
}
`;
}

export class SceneSdf {
  readonly bounds: SceneSdfBounds = {
    min: new Float32Array([-20, -20, -20]),
    max: new Float32Array([20, 20, 20])
  };

  private readonly format: "r16float" | "r32float";
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;
  private textureValue: GPUTexture;
  private sizeValue: [number, number, number] = [256, 256, 256];

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    this.device = device;
    this.format = device.features.has(
      "texture-formats-tier1" as GPUFeatureName
    )
      ? "r16float"
      : "r32float";
    this.pipeline = {
      label: `SceneSdf/${this.format}`,
      layout: {
        label: `SceneSdf/${this.format}-layout`,
        bindGroupLayouts: [sceneSdfOutputLayout(this.format), sceneSdfQueryLayout()]
      },
      compute: {
        module: {
          label: `SceneSdf/${this.format}-module`,
          code: createSceneSdfShader(this.format)
        },
        entryPoint: "main"
      }
    };
    this.textureValue = this.createTexture();
  }

  get texture(): GPUTexture {
    return this.textureValue;
  }

  get size(): readonly [number, number, number] {
    return this.sizeValue;
  }

  get gpu_memory_usage(): number {
    const bytesPerVoxel = this.format === "r16float" ? 2 : 4;
    return (
      this.sizeValue[0] *
      this.sizeValue[1] *
      this.sizeValue[2] *
      bytesPerVoxel
    );
  }

  setVoxelSize(voxelSize: number): void {
    const width = this.bounds.max[0]! - this.bounds.min[0]!;
    const height = this.bounds.max[1]! - this.bounds.min[1]!;
    const depth = this.bounds.max[2]! - this.bounds.min[2]!;
    this.resize(
      this.clampDimension(Math.round(width / voxelSize)),
      this.clampDimension(Math.round(height / voxelSize)),
      this.clampDimension(Math.round(depth / voxelSize))
    );
  }

  resize(width: number, height: number, depth: number): void {
    if (
      width === this.sizeValue[0] &&
      height === this.sizeValue[1] &&
      depth === this.sizeValue[2]
    ) {
      return;
    }
    this.sizeValue = [width, height, depth];
    this.textureValue.destroy();
    this.textureValue = this.createTexture();
  }

  update(command: ShadeGPUCommandContext, scene: GPUSceneContext): void {
    const sceneDatabase = scene.scene_database_buffer;
    const geometryMetadata = scene.meshlets.meshMetaBuffer;
    if (!sceneDatabase || !geometryMetadata) return;
    const settings = this.createSettingsBuffer(command);
    const pass = command.constructComputePass({
      label: "SceneSdf/update",
      pipeline: this.pipeline,
      bindings: [
        [
          { buffer: settings },
          createNativeTextureView(this.textureValue, { dimension: "3d" })
        ],
        [
          { buffer: sceneDatabase },
          { buffer: scene.tlas.buffer },
          { buffer: scene.meshlets.blas.buffer_metadata },
          { buffer: scene.meshlets.blas.buffer_data },
          { buffer: geometryMetadata },
          { buffer: scene.meshlets.headerBuffer },
          { buffer: scene.meshlets.dataBuffer }
        ]
      ]
    });
    pass.dispatchWorkgroups(
      Math.ceil(this.sizeValue[0] / 4),
      Math.ceil(this.sizeValue[1] / 4),
      Math.ceil(this.sizeValue[2] / 4)
    );
    pass.end();
  }

  build(command: ShadeGPUCommandContext, scene: GPUSceneContext): void {
    const bounds = scene.scene.instances.bounding_box;
    this.bounds.min.set([bounds.x0, bounds.y0, bounds.z0]);
    this.bounds.max.set([bounds.x1, bounds.y1, bounds.z1]);
    this.update(command, scene);
  }

  async serialize(writer: BinaryReader): Promise<void> {
    const values = await this.readTextureValues();
    const dataType =
      this.format === "r16float"
        ? ShadeDataType.Float16
        : ShadeDataType.Float32;
    writer.writeUTF8String(SCENE_SDF_MAGIC);
    writer.writeUint32(SCENE_SDF_VERSION);
    writer.writeUTF8String(dataType);
    writer.writeFloat32Array(
      [
        this.bounds.min[0]!,
        this.bounds.min[1]!,
        this.bounds.min[2]!,
        this.bounds.max[0]!,
        this.bounds.max[1]!,
        this.bounds.max[2]!
      ],
      0,
      6
    );
    writer.writeUint32Array(this.sizeValue, 0, 3);
    if (dataType === ShadeDataType.Float16) {
      for (let index = 0; index < values.length; index++) {
        writer.writeFloat16(values[index]!);
      }
    } else if (dataType === ShadeDataType.Float32) {
      writer.writeFloat32Array(values, 0, values.length);
    } else {
      throw new Error(`Unsupported format ${dataType}`);
    }
  }

  async download(): Promise<void> {
    const writer = new BinaryReader();
    await this.serialize(writer);
    writer.trim();
    downloadBinary(writer.data, "scene.sdf", "application/octet-stream");
  }

  deserialize(reader: BinaryReader): void {
    const magic = reader.readUTF8String();
    if (magic !== SCENE_SDF_MAGIC) {
      throw new Error(`Invalid magic tag ${magic}`);
    }
    const version = reader.readUint32();
    if (version !== SCENE_SDF_VERSION) {
      throw new Error(`Unsupported format version ${version}`);
    }
    const expectedType =
      this.format === "r16float"
        ? ShadeDataType.Float16
        : ShadeDataType.Float32;
    const dataType = reader.readUTF8String();
    if (dataType !== expectedType) {
      throw new Error(
        `Incompatible texel format ${dataType}, expected ${expectedType}`
      );
    }

    const bounds = new Float32Array(6);
    reader.readFloat32Array(bounds, 0, bounds.length);
    this.bounds.min.set(bounds.subarray(0, 3));
    this.bounds.max.set(bounds.subarray(3, 6));

    const size = new Uint32Array(3);
    reader.readUint32Array(size, 0, size.length);
    this.resize(size[0]!, size[1]!, size[2]!);
    const valueCount = size[0]! * size[1]! * size[2]!;
    let bytesPerVoxel: number;
    let values: Uint16Array | Float32Array;
    if (dataType === ShadeDataType.Float16) {
      bytesPerVoxel = 2;
      values = new Uint16Array(valueCount);
      reader.readUint16Array(values, 0, values.length);
    } else if (dataType === ShadeDataType.Float32) {
      bytesPerVoxel = 4;
      values = new Float32Array(valueCount);
      reader.readFloat32Array(values, 0, values.length);
    } else {
      throw new Error(`Unsupported format ${dataType}`);
    }
    writeGpuTexture(
      this.device.queue,
      "SceneSdf/upload",
      { texture: this.textureValue },
      values.buffer,
      {
        offset: 0,
        bytesPerRow: size[0]! * bytesPerVoxel,
        rowsPerImage: size[1]!
      },
      size
    );
  }

  destroy(): void {
    this.textureValue.destroy();
  }

  private createTexture(): GPUTexture {
    return createNativeTexture(this.device, {
      label: "SceneSdf/texture",
      size: this.sizeValue,
      dimension: "3d",
      format: this.format,
      mipLevelCount: 1,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    });
  }

  private createSettingsBuffer(command: ShadeGPUCommandContext): GPUBuffer {
    const data = new Float32Array(8);
    data[0] = this.bounds.min[0]!;
    data[1] = this.bounds.min[1]!;
    data[2] = this.bounds.min[2]!;
    data[4] = this.bounds.max[0]!;
    data[5] = this.bounds.max[1]!;
    data[6] = this.bounds.max[2]!;
    const buffer = this.device.createBuffer({
      label: "SceneSdf/settings",
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    command.onFinished.addOne(() => buffer.destroy());
    return buffer;
  }

  private async readTextureValues(): Promise<Float32Array> {
    const [width, height, depth] = this.sizeValue;
    const bytesPerVoxel = this.format === "r16float" ? 2 : 4;
    const bytesPerRow = width * bytesPerVoxel;
    const readback = this.device.createBuffer({
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      size: bytesPerRow * height * depth
    });
    const encoder = this.device.createCommandEncoder({ label: "" });
    encoder.copyTextureToBuffer(
      { texture: this.textureValue, mipLevel: 0, origin: [0, 0, 0] },
      { buffer: readback, offset: 0, bytesPerRow, rowsPerImage: height },
      [width, height, depth]
    );
    recordGpuReadback(this.device, "SceneSdf/read", readback.size);
    submitGpuCommands(this.device, "SceneSdf/read", [encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange();
    let values: Float32Array;
    if (this.format === "r16float") {
      const source = new Uint16Array(mapped);
      values = new Float32Array(source.length);
      for (let index = 0; index < source.length; index++) {
        values[index] = halfToFloat(source[index]!);
      }
    } else {
      values = new Float32Array(mapped).slice();
    }
    readback.destroy();
    return values;
  }

  private clampDimension(value: number): number {
    return Math.min(512, Math.max(2, value));
  }
}

function downloadBinary(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string
): void {
  const blob = new Blob([data], { type: mimeType });
  const anchor = document.createElement("a");
  anchor.href = window.URL.createObjectURL(blob);
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function sceneSdfOutputLayout(
  format: "r16float" | "r32float"
): GPUBindGroupLayoutDescriptor {
  return {
    label: `SceneSdf/${format}-group0`,
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format, viewDimension: "3d" }
      }
    ]
  };
}

function sceneSdfQueryLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "SceneSdf/query-group1",
    entries: Array.from({ length: 7 }, (_, binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  };
}
