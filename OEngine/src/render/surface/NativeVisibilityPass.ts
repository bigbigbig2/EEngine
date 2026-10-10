import type { ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { NativeSurfaceGeometry } from "./SurfaceV4.js";
import type {
  GpuNativeMaterialPublication,
  NativeRasterClass,
} from "../../gpu/GpuNativeMaterialPublication.js";
import {
  nativeVisibilityShader,
  NATIVE_VISIBILITY_VIEW_BYTES,
  type NativeVisibilityShader,
} from "../../shaders/native_visibility.js";
import { NativeRasterWorkPartitions } from "./NativeRasterWorkPartitions.js";
import { GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS } from "../../gpu/GpuMeshletRasterWorkAbi.js";

export function nativeVisibilityPipelineDescriptor(
  shader: NativeVisibilityShader,
  shadow: boolean,
  cullMode: GPUCullMode,
): CachedRenderPipelineDescriptor {
  const module = { code: shader.source };
  return {
    layout: { bindGroupLayouts: shader.groups.map((entries) => ({ entries })) },
    vertex: { module, entryPoint: shader.vertexEntryPoint },
    fragment: {
      module,
      entryPoint: shader.fragmentEntryPoint,
      targets: shadow ? [] : [{ format: "r32uint" }],
    },
    primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "greater",
    },
  };
}

export interface NativeVisibilityInput {
  readonly graphics?: GraphicsContext;
  readonly geometry: NativeSurfaceGeometry;
  readonly publication: GpuNativeMaterialPublication;
  readonly capacity: number;
  readonly generation: number;
  readonly generationSource?: GPUBuffer;
  readonly camera?: GPUBuffer;
  readonly view: Uint8Array<ArrayBuffer>;
  readonly shadow?: boolean;
  /** Actual VSM caster queue (16B header/32B records), atlas constants/page table. */
  readonly vsmAtlas?: Readonly<{ constants: GPUBuffer; pageTable: GPUBuffer }>;
}

interface RouteState {
  readonly pipelines: readonly [GPURenderPipeline, GPURenderPipeline];
  readonly groups: readonly GPUBindGroup[];
  readonly partitionGroups: readonly GPUBindGroup[];
  readonly inputs: GPUBuffer | null;
}

/** Production native raster. GPU partitions preserve original work slots;
 * indirect commands scale with raster classes, triangle buckets and side,
 * never OPAQUE materials or Surface execution bins. Capacity misses
 * use the same exact resident/Product source decoder as native shading.
 * Await this.ready and publication.ready before atomic scene activation.
 * No submit, CPU-visible work control, old publication/runtime or history.
 * NativeRasterWorkPartitions owns the scheduling Cost Card. This owner adds
 * 192B view + 16B/class route + MASK input uniforms and two render PSOs/class; zero new
 * full-frame intermediates. Main/shadow share native CXY alpha and raster data.
 */
export class NativeVisibilityPass {
  readonly ready: Promise<void>;
  readonly partitions: NativeRasterWorkPartitions;
  private readonly buffers: GPUBuffer[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private readonly view: GPUBuffer;
  private routes: readonly RouteState[] | null = null;
  private destroyed = false;
  private retiring = false;
  readonly input: NativeVisibilityInput;

  constructor(
    private readonly device: GPUDevice,
    input: NativeVisibilityInput,
  ) {
    // Snapshot CPU descriptors before asynchronous PSO creation. Borrowed GPU
    // resources remain owned by their publication through the last frame fence.
    input = Object.freeze({
      ...input,
      view: input.view.slice(),
      geometry: Object.freeze({
        ...input.geometry,
        source: Object.freeze([...input.geometry.source]) as NativeSurfaceGeometry["source"],
        sourcePayload: Object.freeze([
          ...input.geometry.sourcePayload,
        ]) as NativeSurfaceGeometry["sourcePayload"],
        ...(input.geometry.productBanks
          ? {
              productBanks: Object.freeze([
                ...input.geometry.productBanks,
              ]) as NativeSurfaceGeometry["productBanks"],
            }
          : {}),
      }),
      ...(input.vsmAtlas ? { vsmAtlas: Object.freeze({ ...input.vsmAtlas }) } : {}),
    });
    this.input = input;
    if (input.view.byteLength !== NATIVE_VISIBILITY_VIEW_BYTES) {
      throw new RangeError("Native visibility requires the complete view");
    }
    this.validateView(input.view, input.generation);
    const limits = device.limits;
    if (
      limits.maxBindGroups < 4 ||
      limits.maxUniformBufferBindingSize < NATIVE_VISIBILITY_VIEW_BYTES ||
      (input.geometry.productHeap === undefined) !== (input.geometry.productBanks === undefined) ||
      (input.geometry.productBanks && input.geometry.productBanks.length !== 4)
    ) {
      throw new RangeError("Native visibility requires its complete negotiated resource profile");
    }
    for (const source of [input.geometry.source, input.geometry.sourcePayload]) {
      if (
        source.length !== 4 ||
        !source.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
      ) {
        throw new RangeError("Native visibility source offsets must be complete u32 values");
      }
    }
    for (const buffer of [
      input.geometry.meshletWork,
      input.geometry.arena,
      input.geometry.instances,
      input.geometry.vertexPayload,
      input.publication.rasterConstants,
      input.publication.rasterDirectory,
      ...(input.geometry.productHeap ? [input.geometry.productHeap, ...input.geometry.productBanks!] : []),
      ...(input.vsmAtlas ? [input.vsmAtlas.pageTable] : []),
    ]) {
      if (
        buffer.size < 4 ||
        buffer.size > limits.maxStorageBufferBindingSize ||
        (buffer.usage & GPUBufferUsage.STORAGE) === 0
      ) {
        throw new RangeError("Native visibility borrowed storage violates negotiated capacity/usage");
      }
    }
    if (
      input.vsmAtlas &&
      (input.vsmAtlas.constants.size < 240 ||
        input.vsmAtlas.constants.size > limits.maxUniformBufferBindingSize ||
        (input.vsmAtlas.constants.usage & GPUBufferUsage.UNIFORM) === 0)
    ) {
      throw new RangeError("Native VSM requires its complete atlas constants");
    }
    const shaders: NativeVisibilityShader[] = [];
    for (const route of input.publication.rasterClasses) {
      const shader = nativeVisibilityShader(route.program, route.layoutEntries, {
        partitioned: true,
        productGeometry: input.geometry.productHeap !== undefined,
        shadow: input.shadow || input.vsmAtlas !== undefined,
        vsmAtlas: input.vsmAtlas !== undefined,
      });
      for (const stage of [GPUShaderStage.VERTEX, GPUShaderStage.FRAGMENT]) {
        let storage = 0,
          sampled = 0,
          uniforms = 0,
          samplers = 0;
        for (const group of shader.groups) {
          if (group.length > limits.maxBindingsPerBindGroup) {
            throw new RangeError("Native visibility group exceeds negotiated bindings");
          }
          for (const binding of group) {
            if ((binding.visibility & stage) === 0) {
              continue;
            }
            if (binding.buffer) {
              if (binding.buffer.type === "uniform") {
                uniforms++;
              } else {
                storage++;
              }
            }
            if (binding.texture) {
              sampled++;
            }
            if (binding.sampler) {
              samplers++;
            }
          }
        }
        if (
          storage > limits.maxStorageBuffersPerShaderStage ||
          sampled > limits.maxSampledTexturesPerShaderStage ||
          uniforms > limits.maxUniformBuffersPerShaderStage ||
          samplers > limits.maxSamplersPerShaderStage
        ) {
          throw new RangeError("Native visibility shader exceeds negotiated stage resources");
        }
      }
      const layout = shader.groups[3]!;
      if (
        route.materialEntries.length !== layout.length ||
        layout.some((binding) => !route.materialEntries.some((entry) => entry.binding === binding.binding))
      ) {
        throw new RangeError("Native visibility material binding profile is incomplete");
      }
      shaders.push(shader);
    }
    this.partitions = new NativeRasterWorkPartitions(device, {
      work: input.geometry.meshletWork,
      metadata: input.geometry.arena,
      publication: input.publication,
      capacity: input.capacity,
      meshletWordBase: input.geometry.source[1],
      frameGeometryHeader: input.vsmAtlas === undefined ? input.geometry.sourcePayload[3] : undefined,
      generation: input.generation,
      caster: input.vsmAtlas !== undefined,
      graphics: input.graphics,
    });
    try {
      this.view = this.buffer(NATIVE_VISIBILITY_VIEW_BYTES, input.view);
      const candidates = input.publication.rasterClasses.map((route, bin) =>
        this.createRoute(route, bin, shaders[bin]!),
      );
      if (input.graphics !== undefined) {
        this.routes = candidates as RouteState[];
      }
      this.ready = Promise.all([input.publication.ready, this.partitions.ready, Promise.all(candidates)])
        .then(([, , routes]) => {
          if (this.destroyed) {
            throw new Error("Native visibility stopped during readiness");
          }
          this.routes = routes;
        })
        .catch((error: unknown) => {
          this.destroy();
          throw error;
        });
      void this.ready.catch(() => undefined);
    } catch (error) {
      this.destroy();
      throw error;
    }
    void device.lost.then(() => this.destroy());
  }

  private buffer(size: number, values?: ArrayBufferView<ArrayBuffer>): GPUBuffer {
    const buffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(buffer);
    const handle = this.input.graphics?.resource_accounting.created(
      {
        kind: "buffer",
        category: "transient",
        owner: "NativeVisibilityPass",
        bytes: size,
        label: buffer.label,
      },
      buffer,
    );
    if (handle) {
      this.accountingHandles.push(handle);
    }
    if (values) {
      this.device.queue.writeBuffer(buffer, 0, values);
    }
    return buffer;
  }

  private validateView(view: Uint8Array<ArrayBuffer>, generation: number): void {
    const floats = new Float32Array(view.buffer, view.byteOffset, 36);
    const words = new Uint32Array(view.buffer, view.byteOffset, NATIVE_VISIBILITY_VIEW_BYTES / 4);
    if (
      !floats.every(Number.isFinite) ||
      words[38] !== generation ||
      (this.input.vsmAtlas && words[39] !== generation)
    ) {
      throw new RangeError(
        "Native visibility view must contain finite camera values and matching generations",
      );
    }
  }

  private createRoute(
    route: NativeRasterClass,
    bin: number,
    shader: NativeVisibilityShader,
  ): RouteState | Promise<RouteState> {
    const { device, input } = this;
    const layouts = shader.groups.map((entries) => device.createBindGroupLayout({ entries }));
    const layout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    const module = device.createShaderModule({ code: shader.source });
    if (input.graphics !== undefined) {
      const pipelines = (["back", "none"] as const).map((cullMode) =>
        input.graphics!.render_pipelines.obtain(
          nativeVisibilityPipelineDescriptor(shader, Boolean(input.shadow || input.vsmAtlas), cullMode),
        ),
      ) as [GPURenderPipeline, GPURenderPipeline];
      return this.bindRoute(route, bin, layouts, pipelines);
    }
    return Promise.all(
      (["back", "none"] as const).map((cullMode) =>
        device.createRenderPipelineAsync({
          layout,
          vertex: { module, entryPoint: shader.vertexEntryPoint },
          fragment: {
            module,
            entryPoint: shader.fragmentEntryPoint,
            targets: input.shadow || input.vsmAtlas ? [] : [{ format: "r32uint" }],
          },
          primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
          depthStencil: {
            format: "depth32float",
            depthWriteEnabled: true,
            depthCompare: "greater",
          },
        }),
      ),
    ).then((pipelines) =>
      this.bindRoute(route, bin, layouts, pipelines as [GPURenderPipeline, GPURenderPipeline]),
    );
  }

  private bindRoute(
    route: NativeRasterClass,
    bin: number,
    layouts: readonly GPUBindGroupLayout[],
    pipelines: readonly [GPURenderPipeline, GPURenderPipeline],
  ): RouteState {
    if (this.destroyed) {
      throw new Error("Native visibility cancelled during readiness");
    }
    const { device, input } = this;
    const routeBuffer = this.buffer(16, new Uint32Array([bin, 0, 0, 0]));
    const inputs =
      route.program === null
        ? null
        : this.buffer(Math.max(16, route.program.inputCount * 16), route.frameInputs);
    const geometryEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: input.geometry.meshletWork } },
      { binding: 1, resource: { buffer: input.geometry.arena } },
      { binding: 2, resource: { buffer: input.geometry.instances } },
      { binding: 3, resource: { buffer: this.view } },
      { binding: 4, resource: { buffer: input.geometry.vertexPayload } },
      { binding: 5, resource: { buffer: this.partitions.indices } },
      { binding: 6, resource: { buffer: this.partitions.states } },
    ];
    if (input.geometry.productHeap) {
      if (!input.geometry.productBanks) {
        throw new Error("Native visibility Product geometry requires four source banks");
      }
      geometryEntries.push({ binding: 8, resource: { buffer: input.geometry.productHeap } });
      input.geometry.productBanks.forEach((bank, index) =>
        geometryEntries.push({ binding: 9 + index, resource: { buffer: bank } }),
      );
    }
    if (input.vsmAtlas) {
      geometryEntries.push(
        { binding: 13, resource: { buffer: input.vsmAtlas.constants } },
        { binding: 14, resource: { buffer: input.vsmAtlas.pageTable } },
      );
    }
    const partitionGroups = Array.from({ length: 8 }, (_, partition) =>
      device.createBindGroup({
        layout: layouts[0]!,
        entries: [
          ...geometryEntries,
          {
            binding: 7,
            resource: {
              buffer: this.partitions.partitionSettings,
              offset: (bin * 8 + partition) * this.partitions.partitionStride,
              size: 16,
            },
          },
        ],
      }),
    );
    const groups = [
      partitionGroups[0]!,
      device.createBindGroup({ layout: layouts[1]!, entries: [] }),
      device.createBindGroup({
        layout: layouts[2]!,
        entries: [
          ...(inputs === null
            ? []
            : [{ binding: 0, resource: { buffer: input.publication.rasterConstants } }]),
          { binding: 1, resource: { buffer: input.publication.rasterDirectory } },
          { binding: 3, resource: { buffer: routeBuffer } },
          ...(inputs === null ? [] : [{ binding: 4, resource: { buffer: inputs } }]),
        ],
      }),
      device.createBindGroup({ layout: layouts[3]!, entries: route.materialEntries }),
    ];
    return { pipelines, groups, partitionGroups, inputs };
  }

  get allocatedBytes(): number {
    return this.destroyed
      ? 0
      : this.partitions.allocatedBytes + this.buffers.reduce((total, buffer) => total + buffer.size, 0);
  }

  update(view: Uint8Array<ArrayBuffer>, generation: number): void {
    if (
      this.destroyed ||
      this.retiring ||
      this.routes === null ||
      view.byteLength !== NATIVE_VISIBILITY_VIEW_BYTES
    ) {
      throw new Error("Native visibility update requires a ready complete route profile");
    }
    this.validateView(view, generation);
    this.partitions.updateGeneration(generation);
    this.device.queue.writeBuffer(this.view, 0, view);
  }

  encode(encoder: GPUCommandEncoder, attachments: GPURenderPassDescriptor, recovery = false): void {
    if (this.destroyed || this.retiring || this.routes === null) {
      throw new Error("Native visibility is not ready");
    }
    this.prepareEncoding(encoder, recovery);
    const pass = encoder.beginRenderPass(attachments);
    this.draw(pass);
    pass.end();
  }

  prepareEncoding(encoder: GPUCommandEncoder, recovery = false): void {
    const camera = this.input.camera;
    if (camera !== undefined) {
      // PackedCamera: VP=6*64, view=2*64, world position=inverseView translation.
      encoder.copyBufferToBuffer(camera, 384, this.view, 0, 64);
      encoder.copyBufferToBuffer(camera, 128, this.view, 64, 64);
      encoder.copyBufferToBuffer(camera, 240, this.view, 128, 12);
    }
    if (this.input.generationSource !== undefined) {
      encoder.copyBufferToBuffer(
        this.input.generationSource,
        GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.generation,
        this.view,
        152,
        4,
      );
      if (this.input.vsmAtlas === undefined) {
        this.partitions.copyGeneration(encoder, this.input.generationSource);
      }
    }
    this.partitions.encode(encoder, recovery);
  }

  /** VSM shares the same render pass with page clearing. Partitions encode before it begins. */
  draw(pass: GPURenderPassEncoder): void {
    if (this.routes === null || this.destroyed || this.retiring) {
      throw new Error("Native visibility is not ready");
    }
    for (const [bin, route] of this.routes.entries()) {
      // These groups do not depend on the triangle bucket or draw side.
      // Keep the original draw order so equal-depth winner ownership is unchanged.
      route.groups.forEach((group, index) => {
        if (index !== 0) pass.setBindGroup(index, group);
      });
      for (let partition = 0; partition < 8; partition++) {
        pass.setPipeline(route.pipelines[partition & 1]!);
        pass.setBindGroup(0, route.partitionGroups[partition]!);
        pass.drawIndirect(this.partitions.draws, (bin * 8 + partition) * 16);
      }
    }
  }

  retire(completion: Promise<void>): Promise<void> {
    if (this.destroyed || this.retiring) {
      return completion.then(
        () => undefined,
        () => undefined,
      );
    }
    this.retiring = true;
    this.accountingHandles.forEach((handle) =>
      this.input.graphics?.resource_accounting.setRetired(handle, true),
    );
    void this.partitions.retire(completion);
    return completion.then(
      () => this.destroy(),
      () => this.destroy(),
    );
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.routes = null;
    this.partitions.destroy();
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.accountingHandles.forEach((handle) => this.input.graphics?.resource_accounting.destroyed(handle));
    this.accountingHandles.length = 0;
  }
}
