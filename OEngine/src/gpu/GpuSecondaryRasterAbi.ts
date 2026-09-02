import {
  GPU_DRAW_INDIRECT_ARGS_SIZE,
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} from "./GpuWorkGenerationAbi.js";
import { GPU_INSTANCE_FLAGS } from "./GpuInstanceAbi.js";

/**
 * SecondaryRasterWork reuses the bounded hierarchy family and exact triangle ABI.
 * Each shadow/secondary view owns independent queue headers and indirect args;
 * records contain stable table indices only and are consumed without readback.
 */
export const GPU_SECONDARY_RASTER_ABI_VERSION = 2;

export const GPU_SECONDARY_RASTER_FLAGS = Object.freeze({
  CastsShadow: GPU_INSTANCE_FLAGS.CastsShadow,
  AlphaTested: GPU_INSTANCE_FLAGS.AlphaTested,
  DoubleSided: GPU_INSTANCE_FLAGS.DoubleSided,
  Transparent: GPU_INSTANCE_FLAGS.Transparent
} as const);

export const GPU_SECONDARY_RASTER_SCHEMA = Object.freeze({
  abiVersion: GPU_SECONDARY_RASTER_ABI_VERSION,
  queueHeader: GPU_WORK_QUEUE_HEADER_SCHEMA,
  rasterWork: GPU_RASTER_WORK_SCHEMA,
  drawIndirectBytes: GPU_DRAW_INDIRECT_ARGS_SIZE,
  overflowBehavior: "all-or-nothing reservation; consumer reads written only",
  ownership: "one independent family per secondary view"
} as const);

export function secondaryRasterQueueByteLength(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 0xffffffff) {
    throw new RangeError("SecondaryRasterWork capacity must be a positive u32");
  }
  const byteLength = GPU_WORK_QUEUE_HEADER_SCHEMA.stride +
    capacity * GPU_RASTER_WORK_SCHEMA.stride;
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("SecondaryRasterWork byte length is invalid");
  }
  return byteLength;
}
