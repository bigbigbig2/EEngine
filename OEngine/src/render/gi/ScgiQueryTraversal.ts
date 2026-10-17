import { geometryQueryPipelines } from "../../gpu/GeometryQueryPipelines.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import type { NativeSceneQueryMaterial } from "../../gpu/GpuNativeMaterialScene.js";
import { scgiQuerySceneWgsl } from "../../shaders/scgi_query_scene.js";
import { validateScgiDescriptors } from "./ScgiCapacity.js";
import type { ScgiQueryArena, ScgiQueryArenaRoute } from "./ScgiQueryArena.js";
import type { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import type { ScgiQueryRayCount } from "./ScgiQueryRayCount.js";

import type { ScgiQueryRouteWork } from "./ScgiQueryRouteWork.js";

export class ScgiQueryTraversal {
  private destroyed = false;
  private frameView: GPUBuffer | undefined;
  private constructor(
    private readonly device: GPUDevice,
    private readonly settings: GPUBuffer,
    private readonly group: GPUBindGroup,
    private readonly pipeline: GPUComputePipeline,
    readonly rayCount: number,
    private readonly coverageGroup: GPUBindGroup | undefined,
    private readonly materialGroup: GPUBindGroup | undefined,
    private readonly buffers: readonly GPUBuffer[],
    private readonly outputGroup: GPUBindGroup | undefined,
    private readonly work: ScgiQueryHitWork | undefined,
    private readonly bin: number,
    private readonly rayWork: ScgiQueryRayCount | undefined,
    private readonly feedbackGroups: ReadonlyMap<GPUBuffer, GPUBindGroup> | undefined,
    readonly descriptors: ReturnType<typeof validateScgiDescriptors>,
    private readonly routing?: { work: ScgiQueryRouteWork; route: ScgiQueryArenaRoute },
  ) {}
  get byteLength(): number {
    return this.settings.size + this.buffers.reduce((n, b) => n + b.size, 0);
  }
  static async create(
    device: GPUDevice,
    input: {
      arena: ScgiQueryArena;
      route: ScgiQueryArenaRoute;
      source: GPUBuffer;
      instances: GPUBuffer;
      batch: GPUBuffer;
      coverageStatus: GPUBuffer;
      rayCount: number;
      resultByteOffset: number;
      diagnostics?: boolean;
      anyHit?: boolean;
      merge?: boolean;
      geometryOnly?: boolean;
      rayWork?: ScgiQueryRayCount;
      work?: ScgiQueryHitWork;
      routing?: { work: ScgiQueryRouteWork; route: ScgiQueryArenaRoute };
      coverage?: {
        publication: GpuNativeMaterialPublication;
        classIndex: number;
        view: ArrayLike<number>;
        camera: ArrayLike<number>;
        coneWidth: number;
        coneSpread: number;
      };
      diffuse?: {
        material: NativeSceneQueryMaterial;
        directory: GPUBuffer;
        constants: GPUBuffer;
        binIndex: number;
        output: GPUBuffer;
        outputStride?: 64 | 96;
        feedback?: GPUBuffer;
        feedbackBuffers?: readonly GPUBuffer[];
        view: ArrayLike<number>;
        camera: ArrayLike<number>;
        coneWidth: number;
        coneSpread: number;
      };
      geometryOutput?: GPUBuffer;
      outputStride?: 64 | 96;
    },
  ): Promise<ScgiQueryTraversal> {
    const coverage = input.coverage;
    const diffuse = input.diffuse;
    const attributes = diffuse !== undefined || (coverage !== undefined && coverage.classIndex !== 0);
    const coverageClass =
      diffuse === undefined
        ? coverage === undefined
          ? { program: null, layoutEntries: [], materialEntries: [], frameInputs: new Float32Array(4) }
          : coverage.publication.rasterClasses[coverage.classIndex]!
        : {
            program: diffuse.material.binding.program,
            layoutEntries: diffuse.material.binding.layoutEntries,
            materialEntries: diffuse.material.binding.entries,
            frameInputs: new Float32Array(Math.max(1, diffuse.material.binding.program.inputCount) * 4),
          };
    const storage = (binding: number, writable = false): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: writable ? "storage" : "read-only-storage" },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" },
    });
    const queryEntries = [
      uniform(0),
      storage(2),
      storage(3),
      storage(4),
      storage(5, true),
      storage(7),
      ...(attributes ? [storage(8), storage(9), storage(10), storage(11), storage(12)] : []),
    ];
    const coverageEntries = [
      storage(0),
      ...(coverageClass.program === null ? [] : [storage(1), uniform(2)]),
      ...(coverageClass.program === null ? [] : [storage(3), uniform(4), uniform(5)]),
    ];
    const outputEntries = [
      ...(diffuse === undefined && !input.geometryOnly ? [] : [storage(0, true)]),
      ...(diffuse?.material.binding.program.virtualTextures ? [storage(1, true)] : []),
      ...(input.work === undefined && input.routing === undefined ? [] : [storage(2, true)]),
    ];
    const materialEntries = coverageClass.layoutEntries.map((entry) => ({
      ...entry,
      visibility: GPUShaderStage.COMPUTE,
    }));
    const descriptors = validateScgiDescriptors(device.limits, [
      queryEntries,
      coverageEntries,
      outputEntries,
      materialEntries,
    ]);
    const cache = geometryQueryPipelines(device);
    const layouts = [queryEntries, coverageEntries, outputEntries, materialEntries].map((entries) =>
      cache.layouts.obtainBindGroupLayout({ entries }),
    );
    const [queryLayout, coverageLayout, outputLayout, materialLayout] = layouts as [
      GPUBindGroupLayout,
      GPUBindGroupLayout,
      GPUBindGroupLayout,
      GPUBindGroupLayout,
    ];
    const mode = input.geometryOnly ? "geometry" : diffuse === undefined ? "trace" : "material";
    const pipeline = await cache.prepare({
      label: `SCGI/scene query ${mode}`,
      layout: {
        bindGroupLayouts: [queryEntries, coverageEntries, outputEntries, materialEntries].map((entries) => ({
          entries,
        })),
      },
      compute: {
        module: {
          code: scgiQuerySceneWgsl(
            input.arena.plan,
            coverageClass.program,
            mode,
            diffuse?.material.unlit ?? false,
            diffuse?.outputStride ?? input.outputStride ?? 64,
            input.work?.listWordOffset,
            input.routing !== undefined,
            input.diagnostics ?? false,
          ),
        },
        entryPoint: "main",
      },
    });
    const settings = device.createBuffer({
      label: "SCGI/scene query settings",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    const coverageBuffers: GPUBuffer[] = [];
    let frameView: GPUBuffer | undefined;
    try {
      new Uint32Array(settings.getMappedRange()).set([
        input.rayCount,
        input.resultByteOffset / 4,
        Number(input.anyHit ?? false),
        Number(input.merge ?? false),
        input.route.sourceGroup,
        diffuse?.binIndex ?? 0,
        0,
        0,
      ]);
      settings.unmap();
      const group = device.createBindGroup({
        layout: queryLayout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 2, resource: { buffer: input.arena.buffer } },
          { binding: 3, resource: { buffer: input.route.tlas } },
          { binding: 4, resource: { buffer: input.instances } },
          { binding: 5, resource: { buffer: input.batch } },
          { binding: 7, resource: { buffer: input.coverageStatus } },
          ...(attributes
            ? [
                { binding: 8, resource: { buffer: input.route.segment.metadata } },
                ...input.route.lease.banks.map((buffer, i) => ({ binding: 9 + i, resource: { buffer } })),
              ]
            : []),
        ],
      });
      let coverageGroup: GPUBindGroup | undefined;
      let materialGroup: GPUBindGroup | undefined;
      let outputGroup: GPUBindGroup | undefined;
      let feedbackGroups: Map<GPUBuffer, GPUBindGroup> | undefined;
      {
        const uniformBuffer = (label: string, bytes: Uint8Array) => {
          const buffer = device.createBuffer({
            label,
            size: bytes.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
          });
          coverageBuffers.push(buffer);
          new Uint8Array(buffer.getMappedRange()).set(bytes);
          buffer.unmap();
          return buffer;
        };
        const route =
          coverageClass.program === null
            ? undefined
            : uniformBuffer(
                "SCGI/native coverage class",
                new Uint8Array(
                  new Uint32Array([coverage?.classIndex ?? diffuse?.binIndex ?? 0, 0, 0, 0]).buffer,
                ),
              );
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: input.source } },
          ...(coverageClass.program === null
            ? []
            : [
                {
                  binding: 1,
                  resource: { buffer: diffuse?.directory ?? coverage!.publication.rasterDirectory },
                },
                { binding: 2, resource: { buffer: route! } },
              ]),
        ];
        if (coverageClass.program !== null) {
          const viewFacts = diffuse ?? coverage!;
          if (
            viewFacts.view.length !== 16 ||
            viewFacts.camera.length !== 3 ||
            !Number.isFinite(viewFacts.coneWidth) ||
            !Number.isFinite(viewFacts.coneSpread) ||
            viewFacts.coneWidth < 0 ||
            viewFacts.coneSpread < 0
          ) {
            throw new RangeError("Native query coverage requires complete view and cone facts");
          }
          const view = new Float32Array(24);
          view.set(Array.from(viewFacts.view));
          view.set(Array.from(viewFacts.camera), 16);
          view.set([viewFacts.coneWidth, viewFacts.coneSpread], 20);
          if (!view.every(Number.isFinite)) {
            throw new RangeError("Nonfinite query coverage view");
          }
          const viewBuffer = uniformBuffer("SCGI/native coverage view", new Uint8Array(view.buffer));
          frameView = viewBuffer;
          const frameInputs = uniformBuffer(
            "SCGI/native coverage frame inputs",
            new Uint8Array(
              coverageClass.frameInputs.buffer,
              coverageClass.frameInputs.byteOffset,
              coverageClass.frameInputs.byteLength,
            ),
          );
          let constants = diffuse?.constants ?? coverage?.publication.rasterConstants;
          if (diffuse !== undefined && constants === undefined) {
            const data = diffuse.material.constants;
            constants = device.createBuffer({
              label: "SCGI/native diffuse constants",
              size: Math.max(4, data.byteLength),
              usage: GPUBufferUsage.STORAGE,
              mappedAtCreation: true,
            });
            coverageBuffers.push(constants);
            new Float32Array(constants.getMappedRange()).set(data);
            constants.unmap();
          }
          entries.push(
            { binding: 3, resource: { buffer: constants! } },
            { binding: 4, resource: { buffer: viewBuffer } },
            { binding: 5, resource: { buffer: frameInputs } },
          );
        }
        coverageGroup = device.createBindGroup({ layout: coverageLayout, entries });
        materialGroup = device.createBindGroup({
          layout: materialLayout,
          entries: coverageClass.materialEntries,
        });
      }
      if (outputEntries.length > 0) {
        const outputEntries: GPUBindGroupEntry[] = [
          ...(input.geometryOnly ? [{ binding: 0, resource: { buffer: input.geometryOutput! } }] : []),
          ...(diffuse === undefined
            ? []
            : [
                { binding: 0, resource: { buffer: diffuse.output } },
                ...(diffuse.material.binding.program.virtualTextures
                  ? [{ binding: 1, resource: { buffer: diffuse.feedback ?? diffuse.feedbackBuffers![0]! } }]
                  : []),
              ]),
          ...(input.work === undefined && input.routing === undefined
            ? []
            : [{ binding: 2, resource: { buffer: input.work?.buffer ?? input.routing!.work.buffer } }]),
        ];
        outputGroup = device.createBindGroup({ layout: outputLayout, entries: outputEntries });
        if (diffuse?.material.binding.program.virtualTextures && diffuse.feedbackBuffers !== undefined) {
          feedbackGroups = new Map();
          for (const buffer of diffuse.feedbackBuffers) {
            feedbackGroups.set(
              buffer,
              device.createBindGroup({
                layout: outputLayout,
                entries: outputEntries.map((entry) =>
                  entry.binding === 1 ? { binding: 1, resource: { buffer } } : entry,
                ),
              }),
            );
          }
        }
      }
      const result = new ScgiQueryTraversal(
        device,
        settings,
        group,
        pipeline,
        input.rayCount,
        coverageGroup,
        materialGroup,
        coverageBuffers,
        outputGroup,
        input.work,
        diffuse?.binIndex ?? 0,
        input.rayWork,
        feedbackGroups,
        descriptors,
        input.routing,
      );
      result.frameView = frameView;
      return result;
    } catch (error) {
      settings.destroy();
      for (const buffer of coverageBuffers) {
        buffer.destroy();
      }
      throw error;
    }
  }
  updateView(
    command: ShadeGPUCommandContext,
    view: ArrayLike<number>,
    camera: ArrayLike<number>,
    coneWidth: number,
    coneSpread: number,
  ): void {
    if (this.frameView === undefined) {
      return;
    }
    if (view.length !== 16 || camera.length !== 3 || coneWidth < 0 || coneSpread < 0) {
      throw new RangeError("Query frame view requires complete camera and cone facts");
    }
    const values = new Float32Array(24);
    for (let i = 0; i < 16; i++) {
      values[i] = view[i]!;
    }
    for (let i = 0; i < 3; i++) {
      values[16 + i] = camera[i]!;
    }
    values.set([coneWidth, coneSpread], 20);
    if (!values.every(Number.isFinite)) {
      throw new RangeError("Query frame view must be finite f32");
    }
    command.writeBuffer(this.frameView, 0, values.buffer, 0, values.byteLength);
  }
  encode(command: ShadeGPUCommandContext, feedback?: GPUBuffer): void {
    if (this.destroyed || command.device !== this.device || command.closed) {
      throw new Error("Query traversal is not live");
    }
    if (this.rayWork !== undefined) {
      command.copyBufferToBuffer(this.rayWork.buffer, 0, this.settings, 0, 4);
    }
    this.routing?.work.encode(command, this.routing.route);
    const pass = command.beginComputePass({ label: "SCGI/complete scene query" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    if (this.coverageGroup !== undefined) {
      pass.setBindGroup(1, this.coverageGroup);
    }
    if (this.materialGroup !== undefined) {
      pass.setBindGroup(3, this.materialGroup);
    }
    if (this.outputGroup !== undefined) {
      const group =
        feedback === undefined || this.feedbackGroups === undefined
          ? this.outputGroup
          : this.feedbackGroups.get(feedback);
      if (group === undefined) {
        throw new Error("Query VT feedback has no prepared binding");
      }
      pass.setBindGroup(2, group);
    }
    if (this.routing !== undefined) {
      pass.dispatchWorkgroupsIndirect(this.routing.work.indirect, 16);
    } else if (this.work !== undefined) {
      pass.dispatchWorkgroupsIndirect(this.work.indirect, this.bin * 32 + 16);
    } else if (this.rayWork !== undefined) {
      pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 16);
    } else {
      pass.dispatchWorkgroups(Math.ceil(this.rayCount / 64));
    }
    pass.end();
    this.routing?.work.capture(command, this.routing.route);
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.settings.destroy();
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
  }
}
