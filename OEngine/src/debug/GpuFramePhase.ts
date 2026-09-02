/**
 * 跨实现稳定的 GPU 帧阶段。
 *
 * 原始 timestamp label 仍是诊断事实；phase 只把同一帧内的多个底层 Pass
 * 汇总到可跨版本比较的逻辑阶段。无法可靠判断时必须进入 unclassified，
 * 不能为了让报表“完整”而猜测归属。
 */
export const GPU_FRAME_PHASES = [
  "frame",
  "upload",
  "animation",
  "instance-cull",
  "hierarchy-and-cluster-cull",
  "software-raster",
  "hardware-raster",
  "hzb",
  "material-resolve",
  "light-cluster",
  "lighting-and-ibl",
  "shadow",
  "transparency",
  "temporal",
  "post",
  "observability",
  "unclassified"
] as const;

export type GpuFramePhase = (typeof GPU_FRAME_PHASES)[number];

type PhaseRule = {
  phase: Exclude<GpuFramePhase, "unclassified">;
  patterns: readonly RegExp[];
};

// 规则按具体到宽泛排列。新增 label 时先证明 owner，再补规则和测试。
const PHASE_RULES: readonly PhaseRule[] = [
  rule(
    "observability",
    /visibilitycounter/,
    /visibility pixel counters/,
    /r0 visibility counter/,
    /lightcluster\/fx-02 stats/,
    /materialkernel\/publish sampled counters/,
    /gpu.?counter/,
    /counter accumulator/,
    /render debug/
  ),
  rule(
    "upload",
    /upload/,
    /staging copy/,
    /resource copy/,
    /graphicscontext\.update/,
    /gpuscenecontext\/database-(?:build|incremental-update)/,
    /gpuresidentmaterialcontext\/texture-write/,
    /gpulightcollection\/build/,
    /volumetrics update/
  ),
  rule("animation", /animation/, /skinning/),
  rule("shadow", /shadow/),
  rule("transparency", /transparent/, /\boit\b/),
  rule("light-cluster", /lightcluster/, /light cluster/, /cluster assign/),
  rule(
    "material-resolve",
    /material expand/,
    /material resolve/,
    /materialkernel/,
    /material depth/,
    /gbuffer/,
    /g-buffer/
  ),
  rule("hzb", /^hzb$/, /^hzb\//, /hzb\/build/, /hierarchical z/),
  rule(
    "software-raster",
    /software raster/,
    /compute raster/,
    /\bsw raster/
  ),
  rule(
    "hardware-raster",
    /visibility\/id\+depth/,
    /visibility pass\/raster/,
    /packed visibilitykey\/depth .*drawindirect/,
    /hardware raster/,
    /\bhw raster/,
    /^visibility$/
  ),
  rule(
    "instance-cull",
    /instance.?cull/,
    /frustum.?filter/,
    /scene.?mesh.?filter/
  ),
  rule(
    "hierarchy-and-cluster-cull",
    /hierarchy/,
    /cluster.?cull/,
    /meshletdrawlist/,
    /materialmeshletdrawlist/,
    /meshlet expand/,
    /prefix/,
    /scatter/,
    /work generation/
  ),
  rule(
    "temporal",
    /temporal/,
    /\btaa\b/,
    /neural super/,
    /\bnss\b/,
    /velocity/,
    /occlusion confidence/,
    /history/
  ),
  rule(
    "post",
    /motion blur/,
    /sharpen/,
    /bloom/,
    /exposure/,
    /tonemap/,
    /tone map/,
    /postprocess/,
    /post process/
  ),
  rule(
    "lighting-and-ibl",
    /direct lighting/,
    /lighting/,
    /environment background/,
    /\bibl\b/,
    /indirect/,
    /\bssao\b/,
    /\bssr\b/,
    /ambient occlusion/,
    /reflection/,
    /lightprobe/
  ),
  rule("frame", /^frame$/, /renderer\/main/, /main frame/)
];

export function classifyGpuFramePhase(label: string): GpuFramePhase {
  const normalized = label.trim().toLocaleLowerCase("en-US");
  if (normalized.length === 0) return "unclassified";
  for (const entry of PHASE_RULES) {
    if (entry.patterns.some((pattern) => pattern.test(normalized))) {
      return entry.phase;
    }
  }
  return "unclassified";
}

function rule(
  phase: Exclude<GpuFramePhase, "unclassified">,
  ...patterns: RegExp[]
): PhaseRule {
  return { phase, patterns };
}
