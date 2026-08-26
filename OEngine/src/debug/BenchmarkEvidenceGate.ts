import { BENCHMARK_RESULT_SCHEMA_VERSION } from "./EnvironmentManifest.js";
import {
  BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  BENCHMARK_FEATURE_SET_EVIDENCE,
  BENCHMARK_GPU_COUNTER_EVIDENCE,
  type BenchmarkFeatureSetName,
  type CounterEvidenceDeclaration,
  type FeatureSetEvidenceDeclaration
} from "./BenchmarkCapabilityEvidence.js";
import {
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";
import {
  GPU_FRAME_PHASES,
  type GpuFramePhase
} from "./GpuFramePhase.js";

export type BenchmarkEvidenceSeverity = "error" | "warning";

export type BenchmarkEvidenceIssue = {
  code: string;
  severity: BenchmarkEvidenceSeverity;
  path: string;
  message: string;
};

export type BenchmarkEvidenceReport = {
  /** Result JSON is structurally complete and contains honest evidence declarations. */
  gateEligible: boolean;
  /** Every enabled feature and its required counters are currently supported. */
  capabilityComplete: boolean;
  blockedCapabilities: BenchmarkCapabilityBlocker[];
  baselineRole: string | null;
  errors: BenchmarkEvidenceIssue[];
  warnings: BenchmarkEvidenceIssue[];
};

export type BenchmarkCapabilityBlocker = {
  kind: "feature-set" | "gpu-counter";
  id: string;
  blockerTaskId: string;
  reason: string;
};

const GATE_BASELINE_ROLES = new Set([
  "minimum-a",
  "minimum-b",
  "engine-generality-c"
]);
const GPU_FRAME_PHASE_SET = new Set<string>(GPU_FRAME_PHASES);
const GPU_COUNTER_FIELD_SET = new Set<string>(
  GPU_COUNTER_FIELDS.map((field) => field.name)
);

type FrameEvidenceStats = {
  timestampSamples: number;
  gpuValues: Map<string, number[]>;
  gpuPhaseValues: Map<GpuFramePhase, number[]>;
  gpuCounterValues: Map<GpuCounterFieldName, number[]>;
};

type CapabilityValidation = {
  requiredSupportedCounters: Set<GpuCounterFieldName>;
  unsupportedCounters: Set<GpuCounterFieldName>;
  blockers: BenchmarkCapabilityBlocker[];
};

/**
 * 判断一个结果文件是否具备进入性能 gate 的最低机器证据。
 *
 * 这里不判断 FPS 是否达标，只判断结果是否可比较、可追溯且已经完成异步证据。
 * 截图和浏览器控制台 artifact 仍由外层 run bundle 校验，不能从 JSON 中猜测。
 */
export function validateBenchmarkEvidence(value: unknown): BenchmarkEvidenceReport {
  const issues: BenchmarkEvidenceIssue[] = [];
  const root = asRecord(value);
  if (root === null) {
    add(issues, "result-not-object", "error", "$", "benchmark result 必须是对象");
    return finish(issues, null, []);
  }

  numberEquals(
    issues,
    root.schemaVersion,
    BENCHMARK_RESULT_SCHEMA_VERSION,
    "schema-version",
    "$.schemaVersion"
  );
  const environment = requiredRecord(issues, root.environment, "$.environment");
  const run = environment === null
    ? null
    : requiredRecord(issues, environment.run, "$.environment.run");
  const role = run === null || typeof run.baselineRole !== "string"
    ? null
    : run.baselineRole;
  if (role === null || !GATE_BASELINE_ROLES.has(role)) {
    add(
      issues,
      "non-gate-baseline-role",
      "error",
      "$.environment.run.baselineRole",
      `baselineRole 必须是 minimum-a、minimum-b 或 engine-generality-c，实际为 ${String(role)}`
    );
  }

  if (environment !== null) {
    numberEquals(
      issues,
      environment.schemaVersion,
      BENCHMARK_RESULT_SCHEMA_VERSION,
      "environment-schema-version",
      "$.environment.schemaVersion"
    );
    validateEngine(issues, environment.engine);
    if (
      typeof environment.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(environment.capturedAt))
    ) {
      add(
        issues,
        "captured-at-invalid",
        "error",
        "$.environment.capturedAt",
        "capturedAt 必须是有效时间"
      );
    }
    validatePlatform(issues, environment.platform);
    validateFrameEnvironment(issues, environment.frame);
    validateWebGpuEnvironment(issues, environment.webgpu);
    const adapter = asRecord(environment.adapter);
    if (adapter === null) {
      add(
        issues,
        "adapter-identity-missing",
        "error",
        "$.environment.adapter",
        "性能 gate 需要可追溯 GPU adapter identity；driver 仍允许为 null"
      );
    } else if (
      ![adapter.vendor, adapter.architecture, adapter.device, adapter.description]
        .some((item) => typeof item === "string" && item.length > 0)
    ) {
      add(
        issues,
        "adapter-identity-empty",
        "error",
        "$.environment.adapter",
        "adapter identity 至少需要一个非空硬件标识"
      );
    }
  }

  if (run !== null) {
    positiveInteger(issues, run.warmupFrames, "$.environment.run.warmupFrames", true);
    positiveInteger(issues, run.sampleFrames, "$.environment.run.sampleFrames");
    positiveInteger(issues, run.gpuSampleInterval, "$.environment.run.gpuSampleInterval");
    positiveInteger(
      issues,
      run.gpuCounterSampleInterval,
      "$.environment.run.gpuCounterSampleInterval"
    );
    positiveInteger(issues, run.readbackRingSlots, "$.environment.run.readbackRingSlots");
    if (typeof run.readbackRingSlots === "number" && run.readbackRingSlots < 3) {
      add(
        issues,
        "readback-ring-too-small",
        "error",
        "$.environment.run.readbackRingSlots",
        "GPU readback ring 至少需要 3 个槽"
      );
    }
    const features = Array.isArray(run.featureSet) ? run.featureSet : [];
    if (
      features.length === 0 ||
      features.some((feature) => typeof feature !== "string" || feature.length === 0)
    ) {
      add(
        issues,
        "feature-set-empty",
        "error",
        "$.environment.run.featureSet",
        "gate 结果必须声明真实 feature set"
      );
    }
  }

  validateCase(issues, root.case);
  validateDiagnostics(issues, root.diagnostics);
  const capability = validateCapabilityEvidence(
    issues,
    root.capabilityEvidence,
    run
  );
  const frameStats = validateFrames(
    issues,
    root.frames,
    environment,
    run,
    capability
  );
  validateSummary(issues, root.summary, frameStats);
  return finish(issues, role, capability.blockers);
}

function validateCapabilityEvidence(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  run: Record<string, unknown> | null
): CapabilityValidation {
  const result: CapabilityValidation = {
    requiredSupportedCounters: new Set(),
    unsupportedCounters: new Set(),
    blockers: []
  };
  for (const field of GPU_COUNTER_FIELDS) {
    if (BENCHMARK_GPU_COUNTER_EVIDENCE[field.name].status === "unsupported") {
      result.unsupportedCounters.add(field.name);
    }
  }

  const evidence = requiredRecord(issues, value, "$.capabilityEvidence");
  if (evidence === null) return result;
  numberEquals(
    issues,
    evidence.schemaVersion,
    BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    "capability-schema-version",
    "$.capabilityEvidence.schemaVersion"
  );

  const declaredFeatureSets = requiredRecord(
    issues,
    evidence.featureSets,
    "$.capabilityEvidence.featureSets"
  );
  const runFeatureNames = run !== null && Array.isArray(run.featureSet)
    ? run.featureSet.filter((name): name is string => typeof name === "string")
    : [];
  const expectedFeatureNames = [...new Set(runFeatureNames)].sort((a, b) =>
    a.localeCompare(b)
  );
  if (declaredFeatureSets !== null) {
    const undeclared = new Set(Object.keys(declaredFeatureSets));
    for (const name of expectedFeatureNames) {
      undeclared.delete(name);
      const expected = BENCHMARK_FEATURE_SET_EVIDENCE[
        name as BenchmarkFeatureSetName
      ];
      const path = `$.capabilityEvidence.featureSets.${name}`;
      if (expected === undefined) {
        add(
          issues,
          "capability-feature-set-unknown",
          "error",
          path,
          `feature set '${name}' 没有冻结的证据契约`
        );
        continue;
      }
      const actual = asRecord(declaredFeatureSets[name]);
      if (actual === null) {
        add(
          issues,
          "capability-feature-set-declaration-missing",
          "error",
          path,
          `缺少 feature set '${name}' 的证据声明`
        );
      } else {
        validateDeclarationShape(issues, actual, path);
        if (!declarationEquals(actual, expected)) {
          add(
            issues,
            "capability-feature-set-declaration-mismatch",
            "error",
            path,
            `feature set '${name}' 的声明与冻结矩阵不一致`
          );
        }
      }

      if (expected.status === "unsupported") {
        result.blockers.push({
          kind: "feature-set",
          id: name,
          blockerTaskId: expected.blockerTaskId,
          reason: expected.reason
        });
        continue;
      }
      for (const field of expected.requiredGpuCounters) {
        const counter = BENCHMARK_GPU_COUNTER_EVIDENCE[field];
        if (counter.status === "supported") {
          result.requiredSupportedCounters.add(field);
        } else {
          addBlocker(result.blockers, {
            kind: "gpu-counter",
            id: field,
            blockerTaskId: counter.blockerTaskId,
            reason: counter.reason
          });
        }
      }
    }
    for (const name of undeclared) {
      add(
        issues,
        "capability-feature-set-declaration-extra",
        "error",
        `$.capabilityEvidence.featureSets.${name}`,
        `声明了 run.featureSet 中不存在的 feature set '${name}'`
      );
    }
  }

  const declaredCounters = requiredRecord(
    issues,
    evidence.gpuCounters,
    "$.capabilityEvidence.gpuCounters"
  );
  if (declaredCounters !== null) {
    const unknown = new Set(Object.keys(declaredCounters));
    for (const field of GPU_COUNTER_FIELDS) {
      const name = field.name;
      unknown.delete(name);
      const path = `$.capabilityEvidence.gpuCounters.${name}`;
      const actual = asRecord(declaredCounters[name]);
      if (actual === null) {
        add(
          issues,
          "capability-counter-declaration-missing",
          "error",
          path,
          `缺少 GPU counter '${name}' 的 supported/unsupported 声明`
        );
        continue;
      }
      validateDeclarationShape(issues, actual, path);
      if (!declarationEquals(actual, BENCHMARK_GPU_COUNTER_EVIDENCE[name])) {
        add(
          issues,
          "capability-counter-declaration-mismatch",
          "error",
          path,
          `GPU counter '${name}' 的声明与冻结 producer 事实不一致`
        );
      }
    }
    for (const name of unknown) {
      add(
        issues,
        "capability-counter-declaration-unknown",
        "error",
        `$.capabilityEvidence.gpuCounters.${name}`,
        `GPU counter ABI 不包含声明 '${name}'`
      );
    }
  }
  return result;
}

function validateDeclarationShape(
  issues: BenchmarkEvidenceIssue[],
  declaration: Record<string, unknown>,
  path: string
): void {
  if (declaration.status === "supported") {
    if (
      "producer" in declaration &&
      (typeof declaration.producer !== "string" || declaration.producer.trim().length === 0)
    ) {
      add(issues, "capability-producer-invalid", "error", `${path}.producer`, "supported counter 必须记录非空真实 producer");
    }
    if (
      "requiredInSampledFrames" in declaration &&
      declaration.requiredInSampledFrames !== true
    ) {
      add(issues, "capability-sampled-requirement-invalid", "error", `${path}.requiredInSampledFrames`, "supported counter 的 sampled-frame 要求必须为 true");
    }
    return;
  }
  if (declaration.status === "unsupported") {
    if (
      typeof declaration.blockerTaskId !== "string" ||
      !/^[A-Z]+-[0-9]+(?:-[A-Z0-9]+)*$/.test(declaration.blockerTaskId)
    ) {
      add(issues, "capability-blocker-task-invalid", "error", `${path}.blockerTaskId`, "unsupported 声明必须使用稳定任务 ID，例如 WORLD-07");
    }
    if (typeof declaration.reason !== "string" || declaration.reason.trim().length === 0) {
      add(issues, "capability-blocker-reason-missing", "error", `${path}.reason`, "unsupported 声明必须记录非空原因");
    }
    return;
  }
  add(issues, "capability-status-invalid", "error", `${path}.status`, "status 必须是 supported 或 unsupported");
}

function declarationEquals(
  actual: Record<string, unknown>,
  expected: CounterEvidenceDeclaration | FeatureSetEvidenceDeclaration
): boolean {
  return stableStringify(actual) === stableStringify(expected);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const record = asRecord(value);
  if (record === null) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortObjectKeys(record[key])])
  );
}

function addBlocker(
  blockers: BenchmarkCapabilityBlocker[],
  blocker: BenchmarkCapabilityBlocker
): void {
  if (!blockers.some((candidate) =>
    candidate.kind === blocker.kind && candidate.id === blocker.id
  )) blockers.push(blocker);
}

function validatePlatform(
  issues: BenchmarkEvidenceIssue[],
  value: unknown
): void {
  const platform = requiredRecord(issues, value, "$.environment.platform");
  if (platform === null) return;
  for (const field of ["os", "browser", "userAgent"]) {
    if (typeof platform[field] !== "string" || platform[field].length === 0) {
      add(
        issues,
        "platform-identity-missing",
        "error",
        `$.environment.platform.${field}`,
        `缺少 platform ${field}`
      );
    }
  }
}

function validateEngine(issues: BenchmarkEvidenceIssue[], value: unknown): void {
  const engine = requiredRecord(issues, value, "$.environment.engine");
  if (engine === null) return;
  if (
    typeof engine.commit !== "string" ||
    !/^[0-9a-f]{7,64}$/i.test(engine.commit)
  ) {
    add(
      issues,
      "engine-commit-missing",
      "error",
      "$.environment.engine.commit",
      "必须记录可追溯 commit"
    );
  }
  if (engine.dirty !== false) {
    add(
      issues,
      "engine-dirty",
      "error",
      "$.environment.engine.dirty",
      "dirty 工作区结果只能作为探索数据"
    );
  }
  if (!Array.isArray(engine.dirtyReasons)) {
    add(
      issues,
      "dirty-reasons-missing",
      "error",
      "$.environment.engine.dirtyReasons",
      "Schema v3 必须保存 dirtyReasons 数组"
    );
  } else if (engine.dirtyReasons.length > 0) {
    add(
      issues,
      "dirty-reasons-present",
      "error",
      "$.environment.engine.dirtyReasons",
      "gate 结果不能包含未提交改动"
    );
  }
}

function validateFrameEnvironment(
  issues: BenchmarkEvidenceIssue[],
  value: unknown
): void {
  const frame = requiredRecord(issues, value, "$.environment.frame");
  if (frame === null) return;
  for (const field of ["canvasWidth", "canvasHeight", "internalWidth", "internalHeight"]) {
    positiveInteger(issues, frame[field], `$.environment.frame.${field}`);
  }
  positiveFinite(issues, frame.dpr, "$.environment.frame.dpr");
}

function validateWebGpuEnvironment(
  issues: BenchmarkEvidenceIssue[],
  value: unknown
): void {
  const webgpu = requiredRecord(issues, value, "$.environment.webgpu");
  if (webgpu === null) return;
  const features = Array.isArray(webgpu.features) ? webgpu.features : null;
  if (features === null || features.some((feature) => typeof feature !== "string" || feature.length === 0)) {
    add(issues, "webgpu-features-missing", "error", "$.environment.webgpu.features", "缺少 WebGPU features");
  }
  const limits = asRecord(webgpu.limits);
  if (limits === null || Object.keys(limits).length === 0) {
    add(issues, "webgpu-limits-missing", "error", "$.environment.webgpu.limits", "缺少 WebGPU limits");
  }
  if (typeof webgpu.timestampQueryAvailable !== "boolean") {
    add(
      issues,
      "timestamp-capability-missing",
      "error",
      "$.environment.webgpu.timestampQueryAvailable",
      "必须明确 timestamp-query 是否可用"
    );
  } else if (
    features !== null &&
    webgpu.timestampQueryAvailable !== features.includes("timestamp-query")
  ) {
    add(
      issues,
      "timestamp-capability-inconsistent",
      "error",
      "$.environment.webgpu.timestampQueryAvailable",
      "timestampQueryAvailable 必须与 features 中的 timestamp-query 一致"
    );
  }
  if (
    webgpu.powerPreference !== "low-power" &&
    webgpu.powerPreference !== "high-performance"
  ) {
    add(
      issues,
      "power-preference-missing",
      "error",
      "$.environment.webgpu.powerPreference",
      "性能 gate 必须固定 low-power 或 high-performance"
    );
  }
}

function validateCase(issues: BenchmarkEvidenceIssue[], value: unknown): void {
  const manifest = requiredRecord(issues, value, "$.case");
  if (manifest === null) return;
  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    add(issues, "case-id-missing", "error", "$.case.id", "缺少 benchmark case id");
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    add(issues, "case-name-missing", "error", "$.case.name", "缺少 benchmark case name");
  }
  if (!Number.isInteger(manifest.seed)) {
    add(issues, "case-seed-invalid", "error", "$.case.seed", "benchmark seed 必须是整数");
  }
  const hashes = Array.isArray(manifest.sceneAssetHashes)
    ? manifest.sceneAssetHashes
    : [];
  if (
    hashes.length === 0 ||
    hashes.some((hash) => typeof hash !== "string" || !isTraceableSha256(hash))
  ) {
    add(
      issues,
      "asset-hash-placeholder",
      "error",
      "$.case.sceneAssetHashes",
      "gate case 必须保存真实资产 hash，不能使用 none/procedural 占位"
    );
  }
  if (
    typeof manifest.cameraPathHash !== "string" ||
    !isTraceableSha256(manifest.cameraPathHash)
  ) {
    add(
      issues,
      "camera-hash-placeholder",
      "error",
      "$.case.cameraPathHash",
      "gate case 必须保存固定相机轨迹 hash"
    );
  }
}

function validateDiagnostics(
  issues: BenchmarkEvidenceIssue[],
  value: unknown
): void {
  const diagnostics = requiredRecord(issues, value, "$.diagnostics");
  if (diagnostics === null) return;
  const countFields = [
    "validationErrorCount",
    "uncapturedErrorCount",
    "deviceLostCount",
    "failedGpuTimestampBatches",
    "droppedGpuCounterSamples",
    "failedGpuCounterSamples"
  ] as const;
  for (const field of countFields) {
    const count = diagnostics[field];
    if (!Number.isInteger(count) || (count as number) < 0) {
      add(
        issues,
        `diagnostics-${field}-invalid`,
        "error",
        `$.diagnostics.${field}`,
        `${field} 必须是非负整数`
      );
    } else if (count !== 0) {
      add(
        issues,
        `diagnostics-${field}`,
        "error",
        `$.diagnostics.${field}`,
        `${field} 必须为 0`
      );
    }
  }
  const arrays = [
    ["uncapturedErrors", "uncapturedErrorCount"],
    ["deviceLostReasons", "deviceLostCount"]
  ] as const;
  for (const [field, countField] of arrays) {
    const entries = diagnostics[field];
    if (!Array.isArray(entries)) {
      add(
        issues,
        `diagnostics-${field}`,
        "error",
        `$.diagnostics.${field}`,
        `${field} 必须是数组`
      );
      continue;
    }
    if (entries.length > 0) {
      add(issues, `diagnostics-${field}`, "error", `$.diagnostics.${field}`, `${field} 必须是空数组`);
    }
    if (Number.isInteger(diagnostics[countField]) && entries.length !== diagnostics[countField]) {
      add(
        issues,
        `diagnostics-${field}-count-mismatch`,
        "error",
        `$.diagnostics.${field}`,
        `${field}.length 必须等于 ${countField}`
      );
    }
  }
}

function validateFrames(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  environment: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
  capability: CapabilityValidation
): FrameEvidenceStats {
  const stats: FrameEvidenceStats = {
    timestampSamples: 0,
    gpuValues: new Map(),
    gpuPhaseValues: new Map(),
    gpuCounterValues: new Map()
  };
  if (!Array.isArray(value)) {
    add(issues, "frames-missing", "error", "$.frames", "缺少 measured frames");
    return stats;
  }
  if (run !== null && Number.isInteger(run.sampleFrames) && value.length !== run.sampleFrames) {
    add(
      issues,
      "sample-frame-count-mismatch",
      "error",
      "$.frames",
      `frames=${value.length}，manifest sampleFrames=${String(run.sampleFrames)}`
    );
  }
  let counterSamples = 0;
  let unclassifiedSegments = 0;
  const frameIndices = new Set<number>();
  for (let index = 0; index < value.length; index++) {
    const frame = asRecord(value[index]);
    if (frame === null) continue;
    if (
      typeof frame.frameIndex !== "number" ||
      !Number.isInteger(frame.frameIndex) ||
      frame.frameIndex < 0
    ) {
      add(issues, "frame-index-invalid", "error", `$.frames[${index}].frameIndex`, "frameIndex 必须是非负整数");
    } else if (frameIndices.has(frame.frameIndex)) {
      add(issues, "frame-index-duplicate", "error", `$.frames[${index}].frameIndex`, "measured frameIndex 不能重复");
    } else {
      frameIndices.add(frame.frameIndex);
    }
    const gpu = asRecord(frame.gpu);
    if (gpu !== null) {
      if (gpu.pending === true) {
        add(issues, "gpu-timestamp-pending", "error", `$.frames[${index}].gpu.pending`, "timestamp readback 尚未完成");
      }
      const segments = Array.isArray(gpu.segments) ? gpu.segments : [];
      if (
        gpu.sampled === true &&
        gpu.pending !== true &&
        segments.length > 0
      ) {
        stats.timestampSamples++;
      }
      const framePhaseTotals = new Map<GpuFramePhase, number>();
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = asRecord(segments[segmentIndex]);
        const segmentPath = `$.frames[${index}].gpu.segments[${segmentIndex}]`;
        if (segment === null) {
          add(issues, "gpu-segment-invalid", "error", segmentPath, "timestamp segment 必须是对象");
          continue;
        }
        const labelValid = typeof segment.label === "string" && segment.label.length > 0;
        if (!labelValid) {
          add(issues, "gpu-label-invalid", "error", `${segmentPath}.label`, "timestamp label 不能为空");
        }
        if (segment.type !== "compute" && segment.type !== "render") {
          add(issues, "gpu-pass-type-invalid", "error", `${segmentPath}.type`, "timestamp type 必须是 compute 或 render");
        }
        const durationValid =
          typeof segment.durationMs === "number" &&
          Number.isFinite(segment.durationMs) &&
          segment.durationMs >= 0;
        if (!durationValid) {
          add(issues, "gpu-duration-invalid", "error", `${segmentPath}.durationMs`, "timestamp durationMs 必须是有限非负数");
        }
        const phasePath = `${segmentPath}.phase`;
        if (typeof segment.phase !== "string") {
          add(issues, "gpu-phase-missing", "error", phasePath, "Schema v3 segment 缺少逻辑 phase");
          continue;
        }
        if (!GPU_FRAME_PHASE_SET.has(segment.phase)) {
          add(issues, "gpu-phase-invalid", "error", phasePath, `未知逻辑 phase：${segment.phase}`);
          continue;
        }
        const phase = segment.phase as GpuFramePhase;
        if (phase === "unclassified") {
          unclassifiedSegments++;
        }
        if (
          gpu.sampled === true &&
          gpu.pending !== true &&
          labelValid &&
          durationValid
        ) {
          append(stats.gpuValues, segment.label as string, segment.durationMs as number);
          framePhaseTotals.set(
            phase,
            (framePhaseTotals.get(phase) ?? 0) + (segment.durationMs as number)
          );
        }
      }
      for (const [phase, durationMs] of framePhaseTotals) {
        append(stats.gpuPhaseValues, phase, durationMs);
      }
    }
    const counters = asRecord(frame.gpuCounters);
    if (counters !== null) {
      if (counters.schemaVersion !== GPU_COUNTER_SCHEMA_VERSION) {
        add(
          issues,
          "gpu-counter-schema-version",
          "error",
          `$.frames[${index}].gpuCounters.schemaVersion`,
          `GPU counter schema 需要 ${GPU_COUNTER_SCHEMA_VERSION}，实际为 ${String(counters.schemaVersion)}`
        );
      }
      if (counters.pending === true) {
        add(issues, "gpu-counter-pending", "error", `$.frames[${index}].gpuCounters.pending`, "counter readback 尚未完成");
      }
      if (counters.dropped === true) {
        add(issues, "gpu-counter-dropped", "error", `$.frames[${index}].gpuCounters.dropped`, "counter sample 被丢弃");
      }
      const counterValues = asRecord(counters.values);
      if (counterValues !== null) {
        for (const [field, rawCounter] of Object.entries(counterValues)) {
          if (!GPU_COUNTER_FIELD_SET.has(field)) {
            add(issues, "gpu-counter-field-unknown", "error", `$.frames[${index}].gpuCounters.values.${field}`, `GPU counter ABI 不包含 ${field}`);
          }
          if (
            !Number.isInteger(rawCounter) ||
            (rawCounter as number) < 0 ||
            (rawCounter as number) > 0xffff_ffff
          ) {
            add(issues, "gpu-counter-value-invalid", "error", `$.frames[${index}].gpuCounters.values.${field}`, "GPU counter 值必须是 u32");
          }
          if (capability.unsupportedCounters.has(field as GpuCounterFieldName)) {
            add(
              issues,
              "gpu-counter-unsupported-field-present",
              "error",
              `$.frames[${index}].gpuCounters.values.${field}`,
              `unsupported counter '${field}' 不得出现在 values 中；即使值为 0 也不能冒充 producer`
            );
          }
        }
      }
      if (
        counters.sampled === true &&
        counters.pending !== true &&
        counters.dropped !== true &&
        counterValues !== null
      ) {
        counterSamples++;
        for (const field of capability.requiredSupportedCounters) {
          if (!(field in counterValues)) {
            add(
              issues,
              "gpu-counter-required-field-missing",
              "error",
              `$.frames[${index}].gpuCounters.values.${field}`,
              `启用的 feature set 要求真实采样 counter '${field}'；字段缺失不是 0`
            );
          }
        }
        for (const [field, rawCounter] of Object.entries(counterValues)) {
          if (
            GPU_COUNTER_FIELD_SET.has(field) &&
            !capability.unsupportedCounters.has(field as GpuCounterFieldName) &&
            Number.isInteger(rawCounter) &&
            (rawCounter as number) >= 0 &&
            (rawCounter as number) <= 0xffff_ffff
          ) {
            append(
              stats.gpuCounterValues,
              field as GpuCounterFieldName,
              rawCounter as number
            );
          }
        }
      }
    }
  }
  const webgpu = environment === null ? null : asRecord(environment.webgpu);
  if (webgpu?.timestampQueryAvailable === true && stats.timestampSamples === 0) {
    add(issues, "gpu-timestamp-samples-missing", "error", "$.frames", "设备支持 timestamp-query，但结果没有 GPU timestamp 样本");
  }
  if (counterSamples === 0) {
    add(issues, "gpu-counter-samples-missing", "error", "$.frames", "结果没有已完成的 GPU counter 样本");
  }
  if (unclassifiedSegments > 0) {
    add(
      issues,
      "gpu-phase-unclassified",
      "error",
      "$.frames[*].gpu.segments[*].phase",
      `${unclassifiedSegments} 个 timestamp segment 尚未归类，不能形成完整瓶颈证据`
    );
  }
  return stats;
}

function validateSummary(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  stats: FrameEvidenceStats
): void {
  const summary = requiredRecord(issues, value, "$.summary");
  if (summary === null) return;
  validateGpuSummaryMap(
    issues,
    summary.gpuMs,
    stats.gpuValues,
    "$.summary.gpuMs",
    "gpu-summary"
  );
  validateGpuSummaryMap(
    issues,
    summary.gpuPhaseMs,
    stats.gpuPhaseValues,
    "$.summary.gpuPhaseMs",
    "gpu-phase-summary"
  );
  validateGpuSummaryMap(
    issues,
    summary.gpuCounters,
    stats.gpuCounterValues,
    "$.summary.gpuCounters",
    "gpu-counter-summary"
  );
}

function validateGpuSummaryMap<K extends string>(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  expected: ReadonlyMap<K, number[]>,
  path: string,
  codePrefix: string
): void {
  const summary = asRecord(value);
  if (summary === null) {
    add(issues, `${codePrefix}-missing`, "error", path, `缺少 ${path} 汇总`);
    return;
  }
  const actualLabels = new Set(Object.keys(summary));
  for (const [label, values] of expected) {
    actualLabels.delete(label);
    const actualSeries = asRecord(summary[label]);
    if (actualSeries === null) {
      add(issues, `${codePrefix}-label-missing`, "error", `${path}.${label}`, `缺少 ${label} 汇总`);
      continue;
    }
    const expectedSeries = summarize(values);
    for (const field of ["count", "mean", "min", "max", "p50", "p95", "p99"] as const) {
      const actual = actualSeries[field];
      if (typeof actual !== "number" || !Number.isFinite(actual) || !nearlyEqual(actual, expectedSeries[field])) {
        add(
          issues,
          `${codePrefix}-value-mismatch`,
          "error",
          `${path}.${label}.${field}`,
          `${label}.${field} 应为 ${expectedSeries[field]}，实际为 ${String(actual)}`
        );
      }
    }
  }
  for (const label of actualLabels) {
    add(issues, `${codePrefix}-unexpected-label`, "error", `${path}.${label}`, `${label} 没有对应的已完成帧样本`);
  }
}

function append<K extends string>(map: Map<K, number[]>, label: K, value: number): void {
  const values = map.get(label);
  if (values === undefined) map.set(label, [value]);
  else values.push(value);
}

function summarize(values: readonly number[]): Record<"count" | "mean" | "min" | "max" | "p50" | "p95" | "p99", number> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    mean: round(sum / sorted.length),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return round(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

function requiredRecord(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  path: string
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record === null) add(issues, "required-object-missing", "error", path, `${path} 必须是对象`);
  return record;
}

function positiveInteger(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  path: string,
  allowZero = false
): void {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    add(issues, "positive-integer-required", "error", path, `${path} 必须是${allowZero ? "非负" : "正"}整数`);
  }
}

function positiveFinite(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  path: string
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    add(issues, "positive-number-required", "error", path, `${path} 必须是有限正数`);
  }
}

function numberEquals(
  issues: BenchmarkEvidenceIssue[],
  value: unknown,
  expected: number,
  code: string,
  path: string
): void {
  if (value !== expected) add(issues, code, "error", path, `需要 schema ${expected}，实际为 ${String(value)}`);
}

function isTraceableSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(value.trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function add(
  issues: BenchmarkEvidenceIssue[],
  code: string,
  severity: BenchmarkEvidenceSeverity,
  path: string,
  message: string
): void {
  issues.push({ code, severity, path, message });
}

function finish(
  issues: BenchmarkEvidenceIssue[],
  baselineRole: string | null,
  blockedCapabilities: BenchmarkCapabilityBlocker[]
): BenchmarkEvidenceReport {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    gateEligible: errors.length === 0,
    capabilityComplete: errors.length === 0 && blockedCapabilities.length === 0,
    blockedCapabilities,
    baselineRole,
    errors,
    warnings
  };
}
