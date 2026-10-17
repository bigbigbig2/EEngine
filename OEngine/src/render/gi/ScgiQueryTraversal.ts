import { geometryQueryPipelines } from "../../gpu/GeometryQueryPipelines.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type {
  GeometryQueryGeometryLease,
  GeometryQueryGeometrySegment
} from "../../gpu/VirtualGeometryResidency.js";
import type { GeometryQueryInstances } from "../../gpu/GeometryQueryInstances.js";
import { scgiQueryGeometryWgsl } from "../../shaders/scgi_query_geometry.js";
import type { ScgiBvhPlan } from "./ScgiBvhLayout.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import type { NativeSceneQueryMaterial } from "../../gpu/GpuNativeMaterialScene.js";
import { validateScgiDescriptors } from "./ScgiCapacity.js";
import type { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import type { ScgiQueryTailWork } from "./ScgiQueryTailWork.js";
import type { ScgiQueryRayCount } from "./ScgiQueryRayCount.js";
import { GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES } from "../../gpu/GeometryQueryDirectory.js";

/** Complete native coverage-class traversal used during query construction and
 * validation. The query scene owner must merge all relevant classes/shards and
 * establish domain coverage before a cohort can publish a hit or physical miss. */
export class ScgiQueryTraversal {
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly lease: GeometryQueryGeometryLease,
    private readonly settings: GPUBuffer,
    private readonly traceSettings: GPUBuffer,
    private readonly group: GPUBindGroup,
    private readonly pipeline: GPUComputePipeline,
    readonly rayCount: number,
    private readonly coverageGroup?: GPUBindGroup,
    private readonly materialGroup?: GPUBindGroup,
    private readonly coverageBuffers: readonly GPUBuffer[] = [],
    private readonly outputGroup?: GPUBindGroup,
    private readonly hitWork?: { readonly work: ScgiQueryHitWork | ScgiQueryTailWork; readonly bin: number },
    private readonly tail?: { readonly continuation: GPUBuffer; readonly dispatches: number },
    private readonly feedbackGroups?: ReadonlyMap<GPUBuffer, GPUBindGroup>,
    private readonly tailWork?: ScgiQueryTailWork,
    private readonly rayWork?: ScgiQueryRayCount,
    readonly descriptors?: ReturnType<typeof validateScgiDescriptors>
  ) {}

  get byteLength(): number {
    return (
      this.settings.size +
      this.traceSettings.size +
      this.coverageBuffers.reduce((bytes, buffer) => bytes + buffer.size, 0)
    );
  }

  get dispatchUpperBound(): number {
    const quanta = this.tail?.dispatches ?? 1;
    return this.tailWork === undefined ? quanta : quanta * 3 + 1;
  }

  get tailQuanta(): number {
    return this.tail?.dispatches ?? 0;
  }

  static async create(
    device: GPUDevice,
    blasPlan: ScgiBvhPlan,
    tlasPlan: ScgiBvhPlan,
    input: {
      lease: GeometryQueryGeometryLease;
      segment: GeometryQueryGeometrySegment;
      asset: number;
      blas: GPUBuffer;
      tlas: GPUBuffer;
      instances: GeometryQueryInstances;
      batch: GPUBuffer;
      rayCount: number;
      resultByteOffset: number;
      anyHit?: boolean;
      merge?: boolean;
      primitiveOffset?: number;
      primitiveCount?: number;
      coverageStatus?: GPUBuffer;
      pendingWork?: ScgiQueryHitWork;
      tailWork?: ScgiQueryTailWork;
      rayWork?: ScgiQueryRayCount;
      wavefront?: {
        phase: "candidate" | "coverage" | "tail";
        continuation: GPUBuffer;
        work?: ScgiQueryHitWork;
        nodeQuantum?: number;
      };
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
        constants?: GPUBuffer;
        work?: ScgiQueryHitWork;
        binIndex?: number;
        output: GPUBuffer;
        feedback?: GPUBuffer;
        feedbackBuffers?: readonly GPUBuffer[];
        view: ArrayLike<number>;
        camera: ArrayLike<number>;
        coneWidth: number;
        coneSpread: number;
      };
    }
  ): Promise<ScgiQueryTraversal> {
    const { lease } = input;
    const asset = input.segment.queryAssets[input.asset];
    const primitiveOffset = input.primitiveOffset ?? 0;
    const primitiveCount = input.primitiveCount ?? asset?.primitiveCount ?? 0;
    const resultWords = input.resultByteOffset / 4;
    if (
      !lease.valid ||
      !lease.segments.includes(input.segment) ||
      asset === undefined ||
      !Number.isSafeInteger(primitiveOffset) ||
      primitiveOffset < 0 ||
      !Number.isSafeInteger(primitiveCount) ||
      primitiveCount < 0 ||
      primitiveOffset + primitiveCount > asset.primitiveCount ||
      primitiveCount > blasPlan.primitiveCapacity ||
      !Number.isSafeInteger(input.rayCount) ||
      input.rayCount < 0 ||
      !Number.isSafeInteger(resultWords) ||
      resultWords < input.rayCount * 12 ||
      input.resultByteOffset + input.rayCount * 32 > input.batch.size ||
      input.blas.size < blasPlan.hierarchy.bytes ||
      input.tlas.size < tlasPlan.hierarchy.bytes ||
      Math.ceil(input.rayCount / 64) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError(
        "Opaque query requires complete nonoverlapping ray/result ranges and live AS inputs"
      );
    }
    const coverage = input.coverage;
    const diffuse = input.diffuse;
    const wavefront = input.wavefront;
    const nodeQuantum = wavefront?.nodeQuantum ?? 4096;
    if (!Number.isSafeInteger(nodeQuantum) || nodeQuantum < 1 || nodeQuantum > 65536) {
      throw new RangeError("Query node quantum must be a positive finite dispatch bound");
    }
    const work = diffuse?.work ?? wavefront?.work ?? input.tailWork ?? input.pendingWork;
    if (
      wavefront !== undefined &&
      (wavefront.continuation.size < input.rayCount * 64 ||
        (wavefront.phase === "coverage" && (coverage === undefined || work === undefined)) ||
        (wavefront.phase === "candidate" && coverage !== undefined))
    ) {
      throw new RangeError("Query wavefront requires complete continuation and native coverage work");
    }
    if (coverage !== undefined && diffuse !== undefined) {
      throw new Error("Query dispatch must select coverage traversal or accepted-hit shading");
    }
    if (
      diffuse !== undefined &&
      (diffuse.output.size < input.rayCount * 64 ||
        (diffuse.material.binding.program.virtualTextures &&
          diffuse.feedback === undefined &&
          !diffuse.feedbackBuffers?.length))
    ) {
      throw new RangeError("Diffuse query requires a complete output domain and live VT feedback");
    }
    if (
      diffuse?.work !== undefined &&
      (diffuse.work.rayCount !== input.rayCount || (diffuse.binIndex ?? 0) >= diffuse.work.binCount)
    ) {
      throw new RangeError("Native hit work must match the complete ray batch and material bin");
    }
    const coverageClass =
      diffuse === undefined
        ? coverage?.publication.rasterClasses[coverage.classIndex]
        : {
            program: diffuse.material.binding.program,
            layoutEntries: diffuse.material.binding.layoutEntries,
            materialEntries: diffuse.material.binding.entries,
            frameInputs: new Float32Array(Math.max(1, diffuse.material.binding.program.inputCount) * 4)
          };
    if (coverage !== undefined && coverageClass === undefined) {
      throw new RangeError("Unknown native coverage class");
    }
    const storage = (binding: number, writable = false): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: writable ? "storage" : "read-only-storage" }
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    });
    const queryEntries = [
      uniform(0),
      storage(2),
      storage(3),
      storage(4),
      storage(5, true),
      uniform(6),
      ...(input.coverageStatus ? [storage(7)] : []),
      storage(8),
      storage(9),
      storage(10),
      storage(11),
      storage(12)
    ];
    const coverageEntries =
      coverageClass === undefined
        ? []
        : [
            storage(0),
            storage(1),
            uniform(2),
            ...(coverageClass.program === null ? [] : [storage(3), uniform(4), uniform(5)])
          ];
    const outputEntries = [
      ...(diffuse === undefined
        ? []
        : [
            storage(0, true),
            ...(diffuse.material.binding.program.virtualTextures ? [storage(1, true)] : [])
          ]),
      ...(work === undefined ? [] : [storage(2)]),
      ...(wavefront === undefined ? [] : [storage(3, true)])
    ];
    const materialEntries =
      coverageClass?.layoutEntries.map((entry) => ({ ...entry, visibility: GPUShaderStage.COMPUTE })) ?? [];
    const descriptors = validateScgiDescriptors(device.limits, [
      queryEntries,
      coverageEntries,
      outputEntries,
      materialEntries
    ]);
    const cache = geometryQueryPipelines(device);
    const queryLayout = cache.layouts.obtainBindGroupLayout({ entries: queryEntries });
    const coverageLayout = cache.layouts.obtainBindGroupLayout({ entries: coverageEntries });
    const outputLayout = cache.layouts.obtainBindGroupLayout({ entries: outputEntries });
    const materialLayout = cache.layouts.obtainBindGroupLayout({ entries: materialEntries });
    const pipeline = await cache.prepare({
      label: "SCGI/query traversal",
      layout: {
        bindGroupLayouts: [queryEntries, coverageEntries, outputEntries, materialEntries].map((entries) => ({
          entries
        }))
      },
      compute: {
        module: {
          code: scgiQueryGeometryWgsl(
            blasPlan,
            tlasPlan,
            coverageClass?.program,
            diffuse !== undefined,
            diffuse?.material.unlit,
            input.coverageStatus !== undefined,
            work?.listWordOffset,
            wavefront?.phase,
            input.pendingWork !== undefined || input.tailWork !== undefined,
            nodeQuantum
          )
        },
        entryPoint:
          wavefront?.phase === "coverage"
            ? "accept_candidate"
            : diffuse === undefined
              ? "trace_opaque"
              : "shade_hit"
      }
    });
    const settings = device.createBuffer({
      label: "SCGI/opaque geometry parameters",
      size: 48,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    let traceSettings: GPUBuffer | undefined;
    const coverageBuffers: GPUBuffer[] = [];
    try {
      new Uint32Array(settings.getMappedRange()).set([
        GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES / 4,
        input.segment.queryTrianglePrefixWordOffset,
        input.asset,
        lease.productGeneration,
        asset.primitiveBegin + primitiveOffset,
        primitiveCount,
        asset.cutBegin,
        asset.cutCount,
        lease.productTableSlot,
        lease.assetReferenceBegin + input.asset,
        input.instances.first,
        input.instances.count
      ]);
      settings.unmap();
      traceSettings = device.createBuffer({
        label: "SCGI/opaque trace parameters",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      new Uint32Array(traceSettings.getMappedRange()).set([
        input.rayCount,
        0,
        resultWords,
        Number(input.anyHit ?? false) | (Number(input.merge ?? false) << 1)
      ]);
      traceSettings.unmap();
      const group = device.createBindGroup({
        layout: queryLayout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 2, resource: { buffer: input.blas, size: blasPlan.hierarchy.bytes } },
          { binding: 3, resource: { buffer: input.tlas, size: tlasPlan.hierarchy.bytes } },
          { binding: 4, resource: { buffer: input.instances.records } },
          { binding: 5, resource: { buffer: input.batch } },
          { binding: 6, resource: { buffer: traceSettings } },
          ...(input.coverageStatus ? [{ binding: 7, resource: { buffer: input.coverageStatus } }] : []),
          { binding: 8, resource: { buffer: input.segment.metadata } },
          ...lease.banks.map((buffer, index) => ({ binding: 9 + index, resource: { buffer } }))
        ]
      });
      let coverageGroup: GPUBindGroup | undefined;
      let materialGroup: GPUBindGroup | undefined;
      let outputGroup: GPUBindGroup | undefined;
      let feedbackGroups: Map<GPUBuffer, GPUBindGroup> | undefined;
      if ((coverage !== undefined || diffuse !== undefined) && coverageClass !== undefined) {
        const uniformBuffer = (label: string, bytes: Uint8Array) => {
          const buffer = device.createBuffer({
            label,
            size: bytes.byteLength,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true
          });
          coverageBuffers.push(buffer);
          new Uint8Array(buffer.getMappedRange()).set(bytes);
          buffer.unmap();
          return buffer;
        };
        const route = uniformBuffer(
          "SCGI/native coverage class",
          new Uint8Array(new Uint32Array([coverage?.classIndex ?? diffuse?.binIndex ?? 0, 0, 0, 0]).buffer)
        );
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: input.instances.sourceSnapshot } },
          { binding: 1, resource: { buffer: diffuse?.directory ?? coverage!.publication.rasterDirectory } },
          { binding: 2, resource: { buffer: route } }
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
          const frameInputs = uniformBuffer(
            "SCGI/native coverage frame inputs",
            new Uint8Array(
              coverageClass.frameInputs.buffer,
              coverageClass.frameInputs.byteOffset,
              coverageClass.frameInputs.byteLength
            )
          );
          let constants = diffuse?.constants ?? coverage?.publication.rasterConstants;
          if (diffuse !== undefined && constants === undefined) {
            const data = diffuse.material.constants;
            constants = device.createBuffer({
              label: "SCGI/native diffuse constants",
              size: Math.max(4, data.byteLength),
              usage: GPUBufferUsage.STORAGE,
              mappedAtCreation: true
            });
            coverageBuffers.push(constants);
            new Float32Array(constants.getMappedRange()).set(data);
            constants.unmap();
          }
          entries.push(
            { binding: 3, resource: { buffer: constants! } },
            { binding: 4, resource: { buffer: viewBuffer } },
            { binding: 5, resource: { buffer: frameInputs } }
          );
        }
        coverageGroup = device.createBindGroup({ layout: coverageLayout, entries });
        materialGroup = device.createBindGroup({
          layout: materialLayout,
          entries: coverageClass.materialEntries
        });
      }
      if (outputEntries.length > 0) {
        const outputEntries: GPUBindGroupEntry[] = [
          ...(diffuse === undefined
            ? []
            : [
                { binding: 0, resource: { buffer: diffuse.output } },
                ...(diffuse.material.binding.program.virtualTextures
                  ? [{ binding: 1, resource: { buffer: diffuse.feedback ?? diffuse.feedbackBuffers![0]! } }]
                  : [])
              ]),
          ...(work === undefined ? [] : [{ binding: 2, resource: { buffer: work.buffer } }]),
          ...(wavefront === undefined ? [] : [{ binding: 3, resource: { buffer: wavefront.continuation } }])
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
                  entry.binding === 1 ? { binding: 1, resource: { buffer } } : entry
                )
              })
            );
          }
        }
      }
      return new ScgiQueryTraversal(
        device,
        lease,
        settings,
        traceSettings,
        group,
        pipeline,
        input.rayCount,
        coverageGroup,
        materialGroup,
        coverageBuffers,
        outputGroup,
        work === undefined
          ? undefined
          : {
              work,
              bin:
                input.pendingWork === undefined && input.tailWork === undefined
                  ? (diffuse?.binIndex ?? coverage?.classIndex ?? 0)
                  : 0
            },
        wavefront?.phase === "tail"
          ? {
              continuation: wavefront.continuation,
              // Each TLAS/BLAS node has at most three parent-continuation visits.
              // Each instance adds one BLAS-to-TLAS return; the last step exits.
              // Count repeated BLAS visits per instance, not unique BLAS nodes.
              // Geometry count and the complete source window are known without
              // GPU readback. Spare arena capacity is not reachable topology.
              dispatches: Math.ceil(
                (3 * Math.max(0, input.instances.count * 2 - 1) +
                  input.instances.count * (3 * Math.max(0, primitiveCount * 2 - 1) + 1) +
                  1) /
                  nodeQuantum
              )
            }
          : undefined,
        feedbackGroups,
        input.tailWork,
        input.rayWork,
        descriptors
      );
    } catch (error) {
      settings.destroy();
      traceSettings?.destroy();
      for (const buffer of coverageBuffers) {
        buffer.destroy();
      }
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext, feedback?: GPUBuffer): void {
    if (this.destroyed || !this.lease.valid || command.device !== this.device || command.closed) {
      throw new Error("Opaque query requires its live scene publication");
    }
    if (this.tail !== undefined) {
      command.clearBuffer(this.tail.continuation);
    }
    if (this.rayWork !== undefined) {
      command.copyBufferToBuffer(this.rayWork.buffer, 0, this.traceSettings, 0, 4);
    }
    for (let dispatch = 0; dispatch < (this.tail?.dispatches ?? 1); dispatch++) {
      this.tailWork?.compact(command);
      const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/query traversal" });
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
          throw new Error("Query VT feedback has no prepared physical binding");
        }
        pass.setBindGroup(2, group);
      }
      if (this.hitWork === undefined) {
        if (this.rayWork !== undefined) {
          pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 16);
        } else {
          pass.dispatchWorkgroups(Math.ceil(this.rayCount / 64));
        }
      } else {
        pass.dispatchWorkgroupsIndirect(this.hitWork.work.indirect, this.hitWork.bin * 32 + 16);
      }
      pass.end();
    }
    this.tailWork?.finish(command);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.settings.destroy();
    this.traceSettings.destroy();
    for (const buffer of this.coverageBuffers) {
      buffer.destroy();
    }
  }
}
