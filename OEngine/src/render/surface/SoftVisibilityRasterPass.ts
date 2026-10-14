import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import type { NativeSurfaceGeometry } from "./SurfaceV4.js";
import type { NativeRasterWorkPartitions } from "./NativeRasterWorkPartitions.js";
import {
  nativeSoftVisibilityWgsl,
  NATIVE_VISIBILITY_VIEW_BYTES,
  SOFT_VISIBILITY_MAX_FOOTPRINT_PIXELS,
} from "../../shaders/native_visibility.js";

export interface SoftVisibilityRasterInput {
  readonly graphics?: GraphicsContext;
  readonly geometry: NativeSurfaceGeometry;
  readonly publication: GpuNativeMaterialPublication;
  readonly partitions: NativeRasterWorkPartitions;
  readonly view: GPUBuffer;
  readonly width: number;
  readonly height: number;
  readonly maxFootprintPixels?: number;
}

/**
 * Compute software rasterizer for sub-pixel and micro-polygon OPAQUE triangles.
 * Uses positive Reverse-Z IEEE-754 float bitcast<u32> atomicMax depth testing
 * followed by deterministic winner key publication, eliminating hardware 2x2 quad
 * overdraw on dense virtual-geometry meshlets.
 */
export class SoftVisibilityRasterPass {
  readonly width: number;
  readonly height: number;
  readonly maxFootprintPixels: number;
  readonly softDepth: GPUBuffer;
  readonly softKeys: GPUBuffer;
  private readonly settingsBackCull: GPUBuffer;
  private readonly settingsNoCull: GPUBuffer;
  private readonly routeBuffer: GPUBuffer;
  private readonly buffers: GPUBuffer[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private readonly group0Layout: GPUBindGroupLayout;
  private readonly group1Layout: GPUBindGroupLayout;
  private readonly group2Layout: GPUBindGroupLayout;
  private readonly depthPipeline: GPUComputePipeline;
  private readonly keyPipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPUComputePipeline;
  private readonly partitionGroups: readonly GPUBindGroup[];
  private readonly routeGroup: GPUBindGroup;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly input: SoftVisibilityRasterInput,
  ) {
    if (
      !Number.isSafeInteger(input.width) ||
      input.width < 1 ||
      !Number.isSafeInteger(input.height) ||
      input.height < 1
    ) {
      throw new RangeError("Soft visibility rasterizer requires positive integer dimensions");
    }
    this.width = input.width;
    this.height = input.height;
    this.maxFootprintPixels = input.maxFootprintPixels ?? SOFT_VISIBILITY_MAX_FOOTPRINT_PIXELS;
    const pixelCount = this.width * this.height;
    const gridBytes = pixelCount * 4;
    if (
      gridBytes > device.limits.maxStorageBufferBindingSize ||
      gridBytes > Number(device.limits.maxBufferSize)
    ) {
      throw new RangeError("Soft visibility rasterizer grid exceeds device storage buffer limits");
    }
    const makeBuffer = (
      label: string,
      size: number,
      usage: GPUBufferUsageFlags,
      values?: Uint32Array,
    ): GPUBuffer => {
      const buffer = device.createBuffer({ label, size, usage });
      this.buffers.push(buffer);
      const handle = input.graphics?.resource_accounting.created(
        {
          kind: "buffer",
          category: "transient",
          owner: "SoftVisibilityRasterPass",
          bytes: size,
          label,
        },
        buffer,
      );
      if (handle) {
        this.accountingHandles.push(handle);
      }
      if (values) {
        device.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>);
      }
      return buffer;
    };

    try {
      this.softDepth = makeBuffer(
        "SoftVisibility/depth",
        gridBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      this.softKeys = makeBuffer(
        "SoftVisibility/keys",
        gridBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      this.settingsBackCull = makeBuffer(
        "SoftVisibility/settings-back",
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        new Uint32Array([this.width, this.height, this.maxFootprintPixels, 1]),
      );
      this.settingsNoCull = makeBuffer(
        "SoftVisibility/settings-none",
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        new Uint32Array([this.width, this.height, this.maxFootprintPixels, 0]),
      );
      this.routeBuffer = makeBuffer(
        "SoftVisibility/route",
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        new Uint32Array([0, 0, 0, 0]),
      );

      const productGeometry = input.geometry.productHeap !== undefined;
      const read = (binding: number): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      });
      const uniform = (binding: number, minBindingSize: number): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform", minBindingSize },
      });
      this.group0Layout = device.createBindGroupLayout({
        entries: [
          read(0),
          read(1),
          read(2),
          uniform(3, NATIVE_VISIBILITY_VIEW_BYTES),
          read(4),
          read(5),
          read(6),
          uniform(7, 16),
          ...(productGeometry ? [read(8), read(9), read(10), read(11), read(12)] : []),
        ],
      });
      this.group1Layout = device.createBindGroupLayout({
        entries: [
          uniform(0, 16),
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          {
            binding: 3,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { format: "r32uint", access: "write-only" },
          },
        ],
      });
      this.group2Layout = device.createBindGroupLayout({
        entries: [read(1), uniform(3, 16)],
      });

      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [this.group0Layout, this.group1Layout, this.group2Layout],
      });
      const module = device.createShaderModule({
        label: "SoftVisibility/shader",
        code: nativeSoftVisibilityWgsl(productGeometry),
      });
      this.depthPipeline = device.createComputePipeline({
        label: "SoftVisibility/rasterize_depth",
        layout: pipelineLayout,
        compute: { module, entryPoint: "rasterize_depth" },
      });
      this.keyPipeline = device.createComputePipeline({
        label: "SoftVisibility/rasterize_key",
        layout: pipelineLayout,
        compute: { module, entryPoint: "rasterize_key" },
      });
      this.resolvePipeline = device.createComputePipeline({
        label: "SoftVisibility/resolve",
        layout: pipelineLayout,
        compute: { module, entryPoint: "resolve_soft_visibility" },
      });

      const baseEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: input.geometry.meshletWork } },
        { binding: 1, resource: { buffer: input.geometry.arena } },
        { binding: 2, resource: { buffer: input.geometry.instances } },
        { binding: 3, resource: { buffer: input.view } },
        { binding: 4, resource: { buffer: input.geometry.vertexPayload } },
        { binding: 5, resource: { buffer: input.partitions.indices } },
        { binding: 6, resource: { buffer: input.partitions.states } },
      ];
      if (productGeometry) {
        baseEntries.push({ binding: 8, resource: { buffer: input.geometry.productHeap! } });
        input.geometry.productBanks!.forEach((bank, index) => {
          baseEntries.push({ binding: 9 + index, resource: { buffer: bank } });
        });
      }
      this.partitionGroups = Array.from({ length: 8 }, (_, partition) =>
        device.createBindGroup({
          layout: this.group0Layout,
          entries: [
            ...baseEntries,
            {
              binding: 7,
              resource: {
                buffer: input.partitions.partitionSettings,
                offset: partition * input.partitions.partitionStride,
                size: 16,
              },
            },
          ],
        }),
      );
      this.routeGroup = device.createBindGroup({
        layout: this.group2Layout,
        entries: [
          { binding: 1, resource: { buffer: input.publication.rasterDirectory } },
          { binding: 3, resource: { buffer: this.routeBuffer } },
        ],
      });
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  get allocatedBytes(): number {
    if (this.destroyed) {
      return 0;
    }
    return this.buffers.reduce((sum, buffer) => sum + buffer.size, 0);
  }

  encode(
    encoder: GPUCommandEncoder,
    visibilityView: GPUTextureView,
    workgroupCounts: readonly number[],
  ): void {
    if (this.destroyed) {
      throw new Error("Soft visibility rasterizer is destroyed");
    }
    encoder.clearBuffer(this.softDepth);
    encoder.clearBuffer(this.softKeys);
    const groupBack = this.device.createBindGroup({
      layout: this.group1Layout,
      entries: [
        { binding: 0, resource: { buffer: this.settingsBackCull } },
        { binding: 1, resource: { buffer: this.softDepth } },
        { binding: 2, resource: { buffer: this.softKeys } },
        { binding: 3, resource: visibilityView },
      ],
    });
    const groupNone = this.device.createBindGroup({
      layout: this.group1Layout,
      entries: [
        { binding: 0, resource: { buffer: this.settingsNoCull } },
        { binding: 1, resource: { buffer: this.softDepth } },
        { binding: 2, resource: { buffer: this.softKeys } },
        { binding: 3, resource: visibilityView },
      ],
    });
    const pass = encoder.beginComputePass({ label: "SoftVisibility/micro-polygon-raster" });
    pass.setBindGroup(2, this.routeGroup);
    for (const pipeline of [this.depthPipeline, this.keyPipeline]) {
      pass.setPipeline(pipeline);
      for (let partition = 0; partition < 8; partition++) {
        const count = workgroupCounts[partition] ?? 0;
        if (count < 1) {
          continue;
        }
        pass.setBindGroup(0, this.partitionGroups[partition]!);
        pass.setBindGroup(1, (partition & 1) === 0 ? groupBack : groupNone);
        const groupsX = Math.min(count, 65535);
        const groupsY = Math.ceil(count / groupsX);
        pass.dispatchWorkgroups(groupsX, groupsY);
      }
    }
    pass.setPipeline(this.resolvePipeline);
    pass.setBindGroup(0, this.partitionGroups[0]!);
    pass.setBindGroup(1, groupBack);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.accountingHandles.forEach((handle) => {
      this.input.graphics?.resource_accounting.destroyed(handle);
    });
    this.accountingHandles.length = 0;
  }
}
