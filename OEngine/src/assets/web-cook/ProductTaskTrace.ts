import type { ProductWorkBudgetV1 } from "./CanonicalWindowPlanner.js";

export type WebCookProductTaskPhase = "canonicalize" | "wasm-plan" | "spill" | "publish";
export type WebCookProductTaskEventKind =
  | "task-started"
  | "phase-started"
  | "phase-completed"
  | "completed"
  | "failed"
  | "cancelled";

export interface WebCookProductTaskIdentityV1 {
  readonly taskId: string;
  readonly productOrdinal: number;
  readonly primitive: string;
  readonly sceneAssetIndices: readonly number[];
  readonly spatial: boolean;
  readonly shardOrdinal?: number;
  readonly shardCount?: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly domains: number;
  readonly canonicalBytes: number;
  readonly limits: ProductWorkBudgetV1;
}

export interface WebCookProductTaskMetricsV1 {
  readonly canonicalizeMs: number;
  readonly wasmPlanMs: number;
  readonly spillMs: number;
  readonly publishMs: number;
  readonly pageCount: number;
  readonly spillBytes: number;
  readonly spillCurrentBytes: number;
  readonly spillPeakBytes: number;
  readonly spillLimitBytes: number;
}

export interface WebCookProductTaskTraceEventV1 {
  readonly schemaVersion: 1;
  readonly kind: WebCookProductTaskEventKind;
  readonly task: WebCookProductTaskIdentityV1;
  readonly phase?: WebCookProductTaskPhase;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly elapsedMs?: number;
  readonly metrics: WebCookProductTaskMetricsV1;
  readonly error?: string;
}

export type WebCookProductTaskTraceListener = (event: WebCookProductTaskTraceEventV1) => void;
