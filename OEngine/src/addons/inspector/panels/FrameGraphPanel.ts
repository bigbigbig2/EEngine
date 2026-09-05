import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";

export interface FrameGraphPassLike {
  readonly id: number;
  readonly name: string;
  readonly culled: boolean;
  readonly reads: readonly number[];
  readonly writes: readonly number[];
  readonly scheduleIndex?: number;
  readonly encoderWork?: {
    readonly renderPasses: number;
    readonly computePasses: number;
    readonly dispatches: number;
    readonly draws: number;
  };
}

export interface FrameGraphResourceLike {
  readonly logicalSlot: number;
  readonly name: string;
  readonly imported: boolean;
  readonly transient: boolean;
  readonly firstUsePass?: number;
  readonly lastUsePass?: number;
  readonly description?: string;
}

export interface FrameGraphEvidenceLike {
  readonly cacheKey?: string;
  readonly dump?: {
    readonly executablePassOrder: readonly number[];
    readonly passes: readonly FrameGraphPassLike[];
    readonly resources: readonly FrameGraphResourceLike[];
  };
  readonly resources?: {
    readonly imported: number;
    readonly transient: number;
    readonly transientTextures: number;
    readonly transientBuffers: number;
    readonly culledResources: number;
  };
}

export interface FrameGraphPassRow {
  readonly id: number;
  readonly name: string;
  readonly state: "active" | "pruned";
  readonly phase: "render" | "compute" | "mixed" | "unknown";
  readonly scheduleIndex: number | null;
  readonly reads: number;
  readonly writes: number;
  readonly gpuDurationMs: number | null;
}

function phase(pass: FrameGraphPassLike): FrameGraphPassRow["phase"] {
  const render = pass.encoderWork?.renderPasses ?? 0;
  const compute = pass.encoderWork?.computePasses ?? 0;
  if (render > 0 && compute > 0) return "mixed";
  if (render > 0) return "render";
  if (compute > 0) return "compute";
  return "unknown";
}

export function buildFrameGraphRows(
  evidence: FrameGraphEvidenceLike | null,
  frame: ProfileFrame | undefined
): readonly FrameGraphPassRow[] {
  const passes = evidence?.dump?.passes ?? [];
  return passes.map((pass) => {
    const span = frame?.spans.find((candidate) =>
      candidate.name === pass.name && candidate.clockDomain === "gpu-device" && candidate.availability === "available"
    );
    return Object.freeze({
      id: pass.id,
      name: pass.name,
      state: pass.culled ? "pruned" : "active",
      phase: phase(pass),
      scheduleIndex: pass.scheduleIndex ?? null,
      reads: pass.reads.length,
      writes: pass.writes.length,
      gpuDurationMs: span?.duration ?? null
    });
  });
}

export class FrameGraphPanel {
  readonly element: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly table: HTMLElement;

  constructor(document: Document) {
    this.element = document.createElement("section");
    this.element.className = "domain-panel framegraph-panel";
    const heading = document.createElement("h3");
    heading.textContent = "FrameGraph";
    this.summary = document.createElement("div");
    this.table = document.createElement("pre");
    this.element.append(heading, this.summary, this.table);
  }

  update(evidence: FrameGraphEvidenceLike | null, frame: ProfileFrame | undefined): void {
    const rows = buildFrameGraphRows(evidence, frame);
    const dump = evidence?.dump;
    const resources = evidence?.resources;
    this.summary.textContent = dump === undefined
      ? "FrameGraph unavailable"
      : `active ${rows.filter((row) => row.state === "active").length} · pruned ${rows.filter((row) => row.state === "pruned").length} · resources ${resources?.imported ?? dump.resources.length}`;
    this.table.textContent = rows.length === 0
      ? "No pass evidence"
      : rows.map((row) => `${row.scheduleIndex ?? "—"} ${row.state} ${row.phase} ${row.name} · R${row.reads}/W${row.writes} · GPU ${row.gpuDurationMs === null ? "unsupported" : `${row.gpuDurationMs.toFixed(2)} ms`}`).join("\n");
  }
}
