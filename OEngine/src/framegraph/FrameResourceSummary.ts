import type { CompiledFrameGraph } from "./FrameGraph.js";

/** FrameGraph 资源生命周期统计，供 Debug View 和阶段 Gate 使用。 */
export interface FrameResourceSummary {
  /** All declarations, including resources whose entire producer chain was culled. */
  readonly imported: number;
  readonly transient: number;
  readonly transientTextures: number;
  readonly transientBuffers: number;
  /** Resources referenced by at least one executable pass. */
  readonly liveImported: number;
  readonly liveTransient: number;
  readonly liveTransientTextures: number;
  readonly liveTransientBuffers: number;
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
  let liveImported = 0;
  let liveTransient = 0;
  let liveTransientTextures = 0;
  let liveTransientBuffers = 0;
  let culledResources = 0;
  for (const resource of dump.resources) {
    const live = resource.firstUsePass !== undefined;
    const description = resource.description ?? "";
    if (resource.transient) {
      if (description.includes("transient_texture")) transientTextures++;
      if (description.includes("transient_buffer")) transientBuffers++;
    }
    if (!live) {
      culledResources++;
      continue;
    }
    if (resource.imported) liveImported++;
    if (resource.transient) {
      liveTransient++;
      if (description.includes("transient_texture")) liveTransientTextures++;
      if (description.includes("transient_buffer")) liveTransientBuffers++;
    }
  }
  return Object.freeze({
    imported: dump.resources.filter((resource) => resource.imported).length,
    transient: dump.resources.filter((resource) => resource.transient).length,
    transientTextures,
    transientBuffers,
    liveImported,
    liveTransient,
    liveTransientTextures,
    liveTransientBuffers,
    culledResources
  });
}
