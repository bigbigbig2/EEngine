import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";

export const scgiProfile = {
  width: 7,
  height: 5,
  resolution: 2,
  cascades: 2,
  patches: 8,
  requests: 16,
  bounceRequests: 4,
  updates: 4,
  rayBatch: 8,
};

/** Real command context and real pooled staging; profiler only disables timing.
 * This is a transaction fixture, not a substitute renderer or GI producer. */
export function scgiGraphics(device) {
  return {
    device,
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    profiler: { enabled: false, attachGpuTimingContext() {}, recordUpload() {} }
  };
}

export function scgiCommand(graphics) {
  return ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
}

export function scgiWriteKnown(transaction, value) {
  const { command, publication } = transaction;
  const world = publication.candidateWorld;
  const regions = [
    {
      destination: world.buffer,
      destinationOffset: world.plan.ranges.map.offset,
      bytes: new Uint8Array(new Uint32Array([value, 17]).buffer)
    },
    {
      destination: world.buffer,
      destinationOffset: world.plan.ranges.patches.offset + 160,
      bytes: new Uint8Array(new Float32Array([value + 0.25, -2, 3, 4]).buffer)
    },
    {
      destination: world.buffer,
      destinationOffset: world.plan.ranges.patches.offset + 208,
      bytes: new Uint8Array(new Float32Array([value + 0.5, -6, 7, 8]).buffer)
    },
    {
      destination: world.buffer,
      destinationOffset: 64,
      bytes: new Uint8Array(new Uint32Array([value + 3, value + 4, value + 5, value + 6]).buffer)
    },
    {
      destination: world.buffer,
      destinationOffset: world.plan.ranges.bounceRequests.offset,
      bytes: new Uint8Array(new Uint32Array([value + 7]).buffer)
    },
    {
      destination: publication.candidateWorldField.segments[0].buffer,
      destinationOffset: 0,
      bytes: new Uint8Array(new Uint32Array([value + 8]).buffer)
    }
  ];
  command.uploadRegions(regions);
  transaction.markFieldComplete();
}
