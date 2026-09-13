import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import {
  GPU_SHADING_BIN_COUNT, GPU_SHADING_BIN_COUNTERS_OFFSET,
  GPU_SHADING_BIN_COUNTER_STRIDE, GPU_SHADING_BIN_INDIRECT_STRIDE,
  GPU_SHADING_BIN_CONTROL_OFFSETS, GPU_SHADING_BIN_COUNTER_OFFSETS
} from "../../gpu/GpuShadingBinAbi.js";

const word = (field: Parameters<typeof counterByteOffset>[0]) => counterByteOffset(field) / 4;
const code = /* wgsl */ `
@group(0) @binding(0) var<storage, read> heap: array<u32>;
@group(0) @binding(1) var<storage, read> args: array<u32>;
@group(0) @binding(2) var<storage, read_write> counters: array<u32>;
@compute @workgroup_size(1) fn main() {
  var attempted = 0u; var written = 0u; var overflow = 0u; var workgroups = 0u; var nonzero = 0u;
  for (var bin = 0u; bin < ${GPU_SHADING_BIN_COUNT}u; bin++) {
    let base = ${GPU_SHADING_BIN_COUNTERS_OFFSET / 4}u + bin * ${GPU_SHADING_BIN_COUNTER_STRIDE / 4}u;
    attempted += heap[base + ${GPU_SHADING_BIN_COUNTER_OFFSETS.attemptedCount / 4}u];
    written += heap[base + ${GPU_SHADING_BIN_COUNTER_OFFSETS.writtenCount / 4}u];
    overflow += heap[base + ${GPU_SHADING_BIN_COUNTER_OFFSETS.overflowCount / 4}u];
    let indirect = bin * ${GPU_SHADING_BIN_INDIRECT_STRIDE / 4}u;
    workgroups += args[indirect] * args[indirect + 1u] * args[indirect + 2u];
    // ADR-0013 uses (0,1,1) as the zero-work sentinel. Count executable X
    // dimensions only so the sentinel cannot be mistaken for dispatch work.
    nonzero += u32(args[indirect] != 0u);
  }
  counters[${word("shadingBinFrameFlags")}u] = heap[${GPU_SHADING_BIN_CONTROL_OFFSETS.frameFlags / 4}u];
  counters[${word("shadingBinErrors")}u] = heap[${GPU_SHADING_BIN_CONTROL_OFFSETS.errorCount / 4}u];
  counters[${word("shadingBinAttempted")}u] = attempted;
  counters[${word("shadingBinWritten")}u] = written;
  counters[${word("shadingBinOverflow")}u] = overflow;
  counters[${word("shadingBinIndirectWorkgroups")}u] = workgroups;
  counters[${word("shadingBinGeneratedMaskLo")}u] = heap[${GPU_SHADING_BIN_CONTROL_OFFSETS.generatedMaskLo / 4}u];
  counters[${word("shadingBinGeneratedMaskHi")}u] = heap[${GPU_SHADING_BIN_CONTROL_OFFSETS.generatedMaskHi / 4}u];
  counters[${word("shadingBinIndirectNonzeroWords")}u] = nonzero;
}`;
const pipeline: CachedComputePipelineDescriptor = { label: "ADR-0013 sampled sparse safety counters",
  layout: { bindGroupLayouts: [{ entries: [
    { binding: 0, visibility: 4, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: 4, buffer: { type: "storage" } }
  ] }] },
  compute: { module: { label: "ADR-0013 sampled sparse safety counters", code }, entryPoint: "main" } };

/** Optional bounded safety sampling, not per-pixel ownership diagnostics. */
export class SparseShadingCounterPass {
  addToGraph(graph: FrameGraph, heap: ResourceId, indirect: ResourceId, counters: ResourceId): ResourceId {
    const node = graph.add("SparseShading/sampled production safety counters", {}, (_, resources, context) => {
      const value = context.encoder;
      if (!value || typeof value !== "object" || !("isGPUCommandContext" in value)) throw new Error("Sparse safety counters need the main command context");
      const command = value as ShadeGPUCommandContext;
      const pass = command.constructComputePass({ label: pipeline.label, pipeline,
        bindings: [[{ buffer: resources.get(heap) as GPUBuffer },
          { buffer: resources.get(indirect) as GPUBuffer }, { buffer: resources.get(counters) as GPUBuffer }]] });
      pass.dispatchWorkgroups(1); pass.end();
    });
    node.read(heap); node.read(indirect); node.read(counters);
    counters = node.write(counters);
    node.make_side_effect();
    node.declareEncoderWork({ computePasses: 1, dispatches: 1 });
    return counters;
  }
}
