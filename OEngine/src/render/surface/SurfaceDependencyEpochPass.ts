import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { SURFACE_FIELD_DEPENDENCY_EPOCH_WGSL } from "../../shaders/surface_field_dependency_epoch.js";
import {
  SURFACE_FIELD_DEPENDENCY_HEADER_WORDS,
  SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS,
  SURFACE_FIELD_DEPENDENCY_WAYS,
} from "../../gpu/GpuSurfaceFieldIdentityAbi.js";

/** Per-field exact texture dependency versions. Long-lived snapshots belong to
 * FieldStore, so resize does not recycle a version ID or invalidate every field. */
export class SurfaceDependencyEpochPass {
  private readonly settings: GPUBuffer;
  private readonly disabled: GPUBuffer;
  private readonly pipelines: readonly GPUComputePipeline[];

  constructor(
    private readonly device: GPUDevice,
    private readonly store: GpuSurfaceFieldStore | null,
    private readonly scratch: SurfaceFrameResources,
  ) {
    this.settings = device.createBuffer({
      label: "Surface/field dependency settings",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.disabled = device.createBuffer({
      label: "Surface/disabled field dependency witnesses",
      size: 32,
      usage: GPUBufferUsage.STORAGE,
    });
    const module = device.createShaderModule({
      label: "Surface/exact per-field texture dependencies",
      code: SURFACE_FIELD_DEPENDENCY_EPOCH_WGSL,
    });
    this.pipelines = Object.freeze(
      [
        "lookup_field_dependency_versions",
        "reserve_field_dependency_versions",
        "commit_field_dependency_versions",
        "resolve_field_dependency_versions",
      ].map((entryPoint) =>
        device.createComputePipeline({
          label: `Surface/${entryPoint}`,
          layout: "auto",
          compute: { module, entryPoint },
        }),
      ),
    );
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      metadata: ResourceId;
      versions: ResourceId;
      publication: GpuAppearancePublication;
      bind: SurfaceResourceBinding;
      beforeLookup?: (command: ShadeGPUCommandContext, fields: number) => void;
    },
  ): ResourceId {
    const fields = input.publication.surfaceMetadataOffsets.directoryCount * 15;
    const physical = this.store?.dependencyBuffer ?? this.disabled;
    const sets =
      this.store === null
        ? 1
        : Math.floor(
            (physical.size / 4 - SURFACE_FIELD_DEPENDENCY_HEADER_WORDS) /
              (SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS * SURFACE_FIELD_DEPENDENCY_WAYS),
          );
    let cache = graph.import_resource(
      "Surface/field dependency snapshots",
      { kind: "imported", domain: "internal-full" },
      input.bind("surface-field-dependency-snapshots", () => physical),
    );
    let metadata = input.metadata;
    let owners!: ResourceId;
    let previous: ReturnType<FrameGraph["add"]> | undefined;
    for (const [index, pipeline] of this.pipelines.entries()) {
      const passData = { metadata, cache, owners: -1 };
      const node = graph.add(
        `Surface/field dependency ${["lookup", "reserve", "publish", "resolve"][index]}`,
        passData,
        (data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          if (index === 0) {
            input.beforeLookup?.(command, fields);
            command.writeBuffer(
              this.settings,
              0,
              new Uint32Array([
                fields,
                input.publication.surfaceMetadataOffsets.fieldIdentities,
                input.publication.surfaceMetadataOffsets.fieldTextureDependencies,
                this.store?.nextSubmissionEpoch ?? 1,
                sets,
                this.store === null ? 0 : 1,
                0,
                0,
              ]).buffer,
              0,
              32,
            );
          }
          const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: this.settings } }];
          if (index !== 2) {
            entries.push(
              { binding: 1, resource: { buffer: resources.get(data.metadata) as GPUBuffer } },
              { binding: 2, resource: { buffer: resources.get(input.versions) as GPUBuffer } },
            );
          }
          entries.push({ binding: 3, resource: { buffer: resources.get(data.cache) as GPUBuffer } });
          if (index !== 3) {
            entries.push({ binding: 4, resource: { buffer: resources.get(data.owners) as GPUBuffer } });
          }
          const group = this.scratch.obtainBindGroup(pipeline, 0, entries);
          const pass = command.beginComputePass({
            label: `Surface/field dependency ${["lookup", "reserve", "publish", "resolve"][index]}`,
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(fields / 64));
          pass.end();
        },
      );
      if (index === 0) {
        owners = node.create("Surface/field dependency snapshot owners", {
          kind: "transient_buffer",
          size: Math.max(4, fields * 4),
          usage: GPUBufferUsage.STORAGE,
        });
      }
      node.read(owners);
      passData.owners = owners;
      owners = node.write(owners);
      node.read(cache);
      cache = node.write(cache);
      if (index !== 2) {
        node.read(input.versions);
        node.read(metadata);
        metadata = node.write(metadata);
      }
      if (previous !== undefined) {
        node.dependsOn(previous);
      }
      node.make_side_effect();
      previous = node;
    }
    return metadata;
  }

  destroy(): void {
    this.settings.destroy();
    this.disabled.destroy();
  }
}
