import { VSM_RESIDENCY_CONSTANT_BYTES } from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../../shaders/vsm_allocate_pages.js";
import { VSM_DEMAND_SCAN_WGSL } from "../../shaders/vsm_demand_scan.js";
import { VSM_ADMISSION_WGSL } from "../../shaders/vsm_admission.js";
import type { VsmAllocationFrame } from "./VsmResidency.js";
import type { VsmResources, VsmBufferKey } from "./VsmResources.js";
import type { VsmDirectionalFrameConstants } from "./VsmProjection.js";

export interface VsmAllocatePagesInputs {
  /** The receiver-produced complete request bitset, before compaction. */
  readonly demand: ResourceId;
  readonly priority: ResourceId;
  readonly resources: VsmResources;
  readonly generation: number;
  readonly frameSerial: number;
  readonly contentVersion: ResourceId;
  readonly frame: VsmDirectionalFrameConstants;
}

type Stage =
  | "histogram"
  | "cutoff"
  | "admit"
  | "count_words"
  | "prefix_requests"
  | "prefix_misses"
  | "scatter"
  | "touch"
  | "collect_slots"
  | "allocate"
  | "publish_dirty";
const STAGES: readonly Stage[] = [
  "histogram",
  "cutoff",
  "admit",
  "count_words",
  "prefix_requests",
  "prefix_misses",
  "scatter",
  "touch",
  "collect_slots",
  "allocate",
  "publish_dirty",
];

/** Shared scan/residency constants ABI: three vec4u followed by sixteen clip vec4f. */
export function packVsmResidencyConstants(input: VsmAllocatePagesInputs): ArrayBuffer {
  const profile = input.resources.capabilities;
  const data = new ArrayBuffer(VSM_RESIDENCY_CONSTANT_BYTES);
  new Uint32Array(data).set([
    input.generation,
    profile.demandCapacity,
    profile.residentSlots,
    profile.clipLevels,
    profile.virtualPagesPerAxis,
    profile.atlasPagesPerAxis,
    profile.virtualEntryCount,
    input.frameSerial,
    input.frame.projectionEpoch,
    input.frame.namespace,
    profile.coarseReservedSlots,
    input.frame.settings?.dirtyPageBudget ?? 64,
  ]);
  const floats = new Float32Array(data);
  for (let level = 0; level < profile.clipLevels; level++) {
    floats.set(input.frame.clipOriginExtent[level]!, 12 + level * 4);
  }
  return data;
}

/** Complete-domain GPU residency. Constant pipelines/bindings, actual request
 * dispatches, and ordered publications in the renderer's single frame submit. */
export class VsmAllocatePagesPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([...this.pipelines.values()].map((pipeline) => pipeline.prepare()));
  }

  private readonly constants: GPUBuffer;
  private readonly pipelines = new Map<Stage, PreparedComputePipeline>();
  private readonly bindings = new WeakMap<VsmResources, Map<string, GPUBindGroup>>();

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/complete residency constants",
      size: VSM_RESIDENCY_CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const scan = device.createShaderModule({
      label: "VSM/unique request prefix",
      code: VSM_DEMAND_SCAN_WGSL,
    });
    const residency = device.createShaderModule({
      label: "VSM/ordered residency",
      code: VSM_ALLOCATE_PAGES_WGSL,
    });
    const admission = device.createShaderModule({
      label: "VSM/screen-benefit admission",
      code: VSM_ADMISSION_WGSL,
    });
    for (const entryPoint of STAGES) {
      const admissionStage = entryPoint === "histogram" || entryPoint === "cutoff" || entryPoint === "admit";
      const scanStage =
        entryPoint === "count_words" ||
        entryPoint === "prefix_requests" ||
        entryPoint === "prefix_misses" ||
        entryPoint === "scatter";
      this.pipelines.set(
        entryPoint,
        new PreparedComputePipeline(device, {
          label: `VSM/${entryPoint}`,
          // Entry-specific layouts retain the portable eight-storage-buffer limit.
          layout: "auto",
          compute: { module: admissionStage ? admission : scanStage ? scan : residency, entryPoint },
        }),
      );
    }
  }

  private group(stage: Stage, resources: VsmResources, misses: boolean): GPUBindGroup {
    let groups = this.bindings.get(resources);
    if (groups === undefined) {
      groups = new Map();
      this.bindings.set(resources, groups);
    }
    const name = `${stage}/${misses ? "misses" : "requests"}`;
    const prior = groups.get(name);
    if (prior !== undefined) {
      return prior;
    }
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: this.constants } }];
    const bind = (binding: number, key: VsmBufferKey) => {
      const buffer = resources.getBuffer(key);
      if (buffer === null) {
        throw new Error(`VSM ${stage} requires ${key}`);
      }
      entries.push({ binding, resource: { buffer } });
    };
    const bits: VsmBufferKey = misses ? "missingPages" : "admittedPages";
    if (stage === "histogram") {
      bind(1, "requestedPages");
      bind(2, "receiverPriority");
      bind(4, "admissionStatistics");
    } else if (stage === "cutoff") {
      bind(4, "admissionStatistics");
    } else if (stage === "admit") {
      bind(1, "requestedPages");
      bind(2, "receiverPriority");
      bind(3, "admittedPages");
      bind(4, "admissionStatistics");
    } else if (stage === "count_words" || stage === "scatter") {
      bind(1, bits);
      bind(2, "demandScan");
      if (stage === "scatter") {
        bind(3, "demand");
      }
    } else if (stage === "prefix_requests" || stage === "prefix_misses") {
      bind(2, "demandScan");
      if (stage === "prefix_requests") {
        bind(3, "demand");
      }
      bind(4, "demandIndirect");
    } else if (stage === "touch") {
      bind(2, "missingPages");
      bind(3, "demand");
      bind(4, "pageTable");
      bind(5, "metaTable");
      bind(8, "overflowCounters");
      bind(9, "contentVersion");
    } else if (stage === "collect_slots") {
      bind(1, "admittedPages");
      bind(5, "metaTable");
      bind(7, "slotCandidates");
    } else if (stage === "allocate") {
      bind(3, "demand");
      bind(4, "pageTable");
      bind(5, "metaTable");
      bind(7, "slotCandidates");
      bind(8, "overflowCounters");
      bind(9, "contentVersion");
      bind(10, "demandScan");
    } else {
      bind(1, "admittedPages");
      bind(4, "pageTable");
      bind(5, "metaTable");
      bind(6, "allocation");
      bind(8, "overflowCounters");
    }
    const group = this.device.createBindGroup({
      label: `VSM/${name}`,
      layout: this.pipelines.get(stage)!.requirePrepared().getBindGroupLayout(0),
      entries,
    });
    groups.set(name, group);
    return group;
  }

  addToGraph(graph: FrameGraph, input: VsmAllocatePagesInputs): VsmAllocationFrame {
    const resources = input.resources;
    if (resources.profile === "shadow-disabled") {
      throw new Error("VSM allocation requires an enabled profile");
    }
    for (const value of [input.generation, input.frameSerial]) {
      if (!Number.isSafeInteger(value) || value < 1 || value >= 0xffffffff) {
        throw new RangeError("VSM residency epoch/frame serial must be uint32");
      }
    }
    const keys: readonly VsmBufferKey[] = [
      "pageTable",
      "metaTable",
      "demand",
      "missingPages",
      "demandScan",
      "demandIndirect",
      "slotCandidates",
      "admittedPages",
      "admissionStatistics",
      "allocation",
      "overflowCounters",
    ];
    const handles = new Map<VsmBufferKey, ResourceId>();
    for (const key of keys) {
      const buffer = resources.getBuffer(key);
      if (buffer === null) {
        throw new Error(`VSM complete residency requires ${key}`);
      }
      handles.set(key, graph.import_resource(`VSM/residency ${key}`, { kind: "imported" }, buffer));
    }
    const produce = graph.add(
      "VSM/complete demand and ordered residency",
      input,
      (data, _resolved, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const owner = data.resources;
        command.writeBuffer(this.constants, 0, packVsmResidencyConstants(data), 0, VSM_RESIDENCY_CONSTANT_BYTES);
        command.clearBuffer(owner.missingPages!);
        command.clearBuffer(owner.getBuffer("admissionStatistics")!);
        command.clearBuffer(owner.overflowCounters!, 0, 16);
        const wordGroups = Math.ceil(Math.ceil(owner.capabilities.virtualEntryCount / 32) / 64);
        const pass = command.beginComputePass({ label: "VSM/complete demand and ordered residency" });
        const encode = (stage: Stage, misses: boolean, indirect = false) => {
          pass.setPipeline(this.pipelines.get(stage)!.requirePrepared());
          pass.setBindGroup(0, this.group(stage, owner, misses));
          if (indirect) {
            pass.dispatchWorkgroupsIndirect(owner.demandIndirect!, 0);
          } else {
            pass.dispatchWorkgroups(
              stage === "count_words" || stage === "scatter" || stage === "histogram" ? wordGroups : 1,
            );
          }
        };
        encode("histogram", false);
        encode("cutoff", false);
        encode("admit", false);
        encode("count_words", false);
        encode("prefix_requests", false);
        encode("scatter", false);
        encode("touch", false, true);
        encode("collect_slots", false);
        // Reuse request records after touch. The admitted bitset protects all
        // accepted hits; separate statistics preserve complete raw fine counts.
        encode("count_words", true);
        encode("prefix_misses", true);
        encode("scatter", true);
        encode("allocate", true, true);
        encode("publish_dirty", false);
        pass.end();
      },
    );
    produce.read(input.demand);
    produce.read(input.priority);
    const published = new Map<VsmBufferKey, ResourceId>();
    for (const [key, handle] of handles) {
      published.set(key, produce.write(handle));
    }
    const contentVersion = produce.write(input.contentVersion);
    produce.make_side_effect();
    return {
      allocation: published.get("allocation")!,
      demand: published.get("demand")!,
      admitted: published.get("admittedPages")!,
      pageTable: published.get("pageTable")!,
      metaTable: published.get("metaTable")!,
      contentVersion,
      generation: input.generation,
      capacity: resources.capabilities.residentSlots,
    };
  }

  destroy(): void {
    this.constants.destroy();
  }
}
