export type FramePlanFrequency = "per-frame" | "when-dirty" | "on-demand";

export interface FramePlanStageDefinition {
  readonly id: "scene-update" | "lpv-update" | "shadow-update" | "main-view-graph";
  readonly dependencies: readonly FramePlanStageDefinition["id"][];
  readonly enabled: boolean;
  readonly frequency: FramePlanFrequency;
  readonly dirtyCondition: string;
  readonly persistentOutputs: readonly string[];
  readonly gpuTimingLabel: string;
}

export interface FramePlanStageDump extends FramePlanStageDefinition {
  readonly order: number;
  readonly executed: boolean;
  readonly cpuDurationMs: number;
}

export interface FramePlanDump {
  readonly frameIndex: number;
  readonly order: readonly FramePlanStageDefinition["id"][];
  readonly stages: readonly FramePlanStageDump[];
  readonly complete: boolean;
}

type MutableStage = {
  definition: FramePlanStageDefinition;
  executed: boolean;
  cpuDurationMs: number;
};

/**
 * Frame-level scheduler above the individual resource graphs.
 *
 * It does not create another command encoder or submit. It validates the
 * cross-graph dependency order while every enabled stage records into the
 * same Renderer main command.
 */
export class FramePlan {
  private readonly stages = new Map<FramePlanStageDefinition["id"], MutableStage>();
  private readonly ordered: readonly FramePlanStageDefinition["id"][];

  constructor(
    readonly frameIndex: number,
    definitions: readonly FramePlanStageDefinition[]
  ) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("FramePlan frameIndex must be a non-negative integer");
    }
    for (const definition of definitions) {
      if (this.stages.has(definition.id)) {
        throw new Error(`FramePlan stage '${definition.id}' is duplicated`);
      }
      this.stages.set(definition.id, {
        definition: freezeDefinition(definition),
        executed: false,
        cpuDurationMs: 0
      });
    }
    for (const stage of this.stages.values()) {
      for (const dependency of stage.definition.dependencies) {
        if (!this.stages.has(dependency)) {
          throw new Error(
            `FramePlan stage '${stage.definition.id}' has missing dependency '${dependency}'`
          );
        }
      }
    }
    this.ordered = Object.freeze(stablePlanOrder(this.stages));
  }

  execute<T>(id: FramePlanStageDefinition["id"], run: () => T): T {
    const stage = this.require(id);
    if (!stage.definition.enabled) {
      throw new Error(`FramePlan stage '${id}' is disabled`);
    }
    if (stage.executed) throw new Error(`FramePlan stage '${id}' already executed`);
    for (const dependencyId of stage.definition.dependencies) {
      const dependency = this.require(dependencyId);
      if (dependency.definition.enabled && !dependency.executed) {
        throw new Error(
          `FramePlan stage '${id}' executed before dependency '${dependencyId}'`
        );
      }
    }
    const start = performanceNow();
    try {
      const result = run();
      stage.executed = true;
      return result;
    } finally {
      stage.cpuDurationMs += performanceNow() - start;
    }
  }

  assertComplete(): void {
    const pending = [...this.stages.values()]
      .filter((stage) => stage.definition.enabled && !stage.executed)
      .map((stage) => stage.definition.id);
    if (pending.length > 0) {
      throw new Error(`FramePlan has unexecuted stages: ${pending.join(", ")}`);
    }
  }

  dump(): FramePlanDump {
    const stages = this.ordered.map((id, order) => {
      const stage = this.require(id);
      return Object.freeze({
        ...stage.definition,
        order,
        executed: stage.executed,
        cpuDurationMs: stage.cpuDurationMs
      });
    });
    const complete = stages.every((stage) => !stage.enabled || stage.executed);
    return Object.freeze({
      frameIndex: this.frameIndex,
      order: this.ordered,
      stages: Object.freeze(stages),
      complete
    });
  }

  private require(id: FramePlanStageDefinition["id"]): MutableStage {
    const stage = this.stages.get(id);
    if (stage === undefined) throw new Error(`Unknown FramePlan stage '${id}'`);
    return stage;
  }
}

export function createRendererFramePlan(
  frameIndex: number,
  options: { readonly lpv: boolean; readonly shadows: boolean }
): FramePlan {
  const mainDependencies: FramePlanStageDefinition["id"][] = ["scene-update"];
  if (options.lpv) mainDependencies.push("lpv-update");
  if (options.shadows) mainDependencies.push("shadow-update");
  return new FramePlan(frameIndex, [
    stage("scene-update", [], true, "per-frame", "scene/patch/view changed", [], "scene-update"),
    stage("lpv-update", ["scene-update"], options.lpv, "when-dirty", "LPV mode and probe update", ["LPV atlases"], "lpv-update"),
    stage("shadow-update", ["scene-update"], options.shadows, "per-frame", "shadow feature and directional light", ["shadow atlas"], "shadow-update"),
    stage("main-view-graph", mainDependencies, true, "per-frame", "visible main view", ["history", "present"], "main-view-graph")
  ]);
}

function stage(
  id: FramePlanStageDefinition["id"],
  dependencies: readonly FramePlanStageDefinition["id"][],
  enabled: boolean,
  frequency: FramePlanFrequency,
  dirtyCondition: string,
  persistentOutputs: readonly string[],
  gpuTimingLabel: string
): FramePlanStageDefinition {
  return { id, dependencies, enabled, frequency, dirtyCondition, persistentOutputs, gpuTimingLabel };
}

function freezeDefinition(definition: FramePlanStageDefinition): FramePlanStageDefinition {
  return Object.freeze({
    ...definition,
    dependencies: Object.freeze([...definition.dependencies]),
    persistentOutputs: Object.freeze([...definition.persistentOutputs])
  });
}

function stablePlanOrder(
  stages: ReadonlyMap<FramePlanStageDefinition["id"], MutableStage>
): FramePlanStageDefinition["id"][] {
  const insertion = [...stages.keys()];
  const indegree = new Map(insertion.map((id) => [id, 0]));
  const consumers = new Map<FramePlanStageDefinition["id"], FramePlanStageDefinition["id"][]>();
  for (const stage of stages.values()) {
    for (const dependency of stage.definition.dependencies) {
      indegree.set(stage.definition.id, (indegree.get(stage.definition.id) ?? 0) + 1);
      const list = consumers.get(dependency) ?? [];
      list.push(stage.definition.id);
      consumers.set(dependency, list);
    }
  }
  const ready = insertion.filter((id) => indegree.get(id) === 0);
  const result: FramePlanStageDefinition["id"][] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const consumer of consumers.get(id) ?? []) {
      const next = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, next);
      if (next === 0) ready.push(consumer);
    }
  }
  if (result.length !== insertion.length) throw new Error("FramePlan contains a dependency cycle");
  return result;
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
