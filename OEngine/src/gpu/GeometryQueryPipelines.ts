import { ComputePipelineCache, PipelineLayoutCache, ShaderModuleCache } from "./GPUDescriptorCaches.js";

const devices = new WeakMap<GPUDevice, ComputePipelineCache>();

/** Reuse the engine descriptor caches for finite query layouts/Programs.
 * Immutable scene candidates own data/bind groups, never another PSO family. */
export function geometryQueryPipelines(device: GPUDevice): ComputePipelineCache {
  let cache = devices.get(device);
  if (cache === undefined) {
    cache = new ComputePipelineCache(device, new PipelineLayoutCache(device), new ShaderModuleCache(device));
    devices.set(device, cache);
  }
  return cache;
}
