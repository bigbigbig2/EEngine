import type { CompiledFrameGraph } from "./FrameGraph.js";

/** FrameGraph 资源生命周期统计，供 Debug View 和阶段 Gate 使用。 */
export interface FrameResourceSummary {
  readonly imported: number;
  readonly transient: number;
  readonly transientTextures: number;
  readonly transientBuffers: number;
  readonly culledResources: number;
}

/**
 * 从已编译 Graph 的真实资源 dump 生成生命周期摘要。
 * 不读取 GPU 对象，也不会创建资源，因此可在 graph compile 后无额外 GPU 成本调用。
 */
export function summarizeFrameGraphResources(
  graph: CompiledFrameGraph
): FrameResourceSummary {
  const dump = graph.dump();
  let transientTextures = 0;
  let transientBuffers = 0;
  let culledResources = 0;
  for (const resource of dump.resources) {
    if (resource.transient) {
      const description = resource.description ?? "";
      if (description.includes("transient_texture")) transientTextures++;
      if (description.includes("transient_buffer")) transientBuffers++;
    }
    if (resource.firstUsePass === undefined) culledResources++;
  }
  return Object.freeze({
    imported: dump.resources.filter((resource) => resource.imported).length,
    transient: dump.resources.filter((resource) => resource.transient).length,
    transientTextures,
    transientBuffers,
    culledResources
  });
}
