/**
 * Render Feature 注册表：统一管理功能启用状态、持久化 owner 和跨帧历史。
 *
 * 该模块只负责拓扑选择，不实现具体渲染算法；算法仍由对应 Feature owner 持有。
 */

export type RenderFeatureValue<TContext> =
  | string
  | undefined
  | ((context: TContext) => string | undefined);

export interface RenderFeatureDefinition<TContext> {
  readonly id: string;
  readonly enabled: (context: TContext) => boolean;
  /** Feature 读取的逻辑输入名，供拓扑审计和后续 Pass 接线使用。 */
  readonly inputs?: readonly string[];
  /** Feature 生产的逻辑输出名，必须在同一主管线中由消费者接线。 */
  readonly outputs?: readonly string[];
  /** Feature 可提供的 Debug View 标识。 */
  readonly debugViews?: readonly string[];
  readonly persistentOwner?: RenderFeatureValue<TContext>;
  readonly history?: RenderFeatureValue<TContext>;
  readonly dependencies?: readonly string[];
}

export interface RenderFeatureSelection {
  readonly enabled: readonly string[];
  readonly persistentOwners: readonly string[];
  readonly histories: readonly string[];
}

/**
 * Feature 注册表是 FrameGraph 拓扑的唯一选择入口。
 * 关闭 Feature 时不会返回它的 owner 或 history，调用方据此跳过资源和 Pass。
 */
export class RenderFeatureRegistry<TContext> {
  private readonly definitions: readonly RenderFeatureDefinition<TContext>[];
  private readonly byId: ReadonlyMap<string, RenderFeatureDefinition<TContext>>;

  constructor(definitions: readonly RenderFeatureDefinition<TContext>[]) {
    const byId = new Map<string, RenderFeatureDefinition<TContext>>();
    for (const definition of definitions) {
      if (definition.id.length === 0) {
        throw new Error("Render Feature id must not be empty");
      }
      if (byId.has(definition.id)) {
        throw new Error(`Render Feature '${definition.id}' is duplicated`);
      }
      byId.set(definition.id, Object.freeze({
        ...definition,
        inputs: freezeNames(definition.inputs, "input", definition.id),
        outputs: freezeNames(definition.outputs, "output", definition.id),
        debugViews: freezeNames(definition.debugViews, "debug view", definition.id),
        dependencies: Object.freeze([...(definition.dependencies ?? [])])
      }));
    }
    for (const definition of byId.values()) {
      for (const dependency of definition.dependencies ?? []) {
        if (dependency === definition.id) {
          throw new Error(`Render Feature '${definition.id}' depends on itself`);
        }
        if (!byId.has(dependency)) {
          throw new Error(
            `Render Feature '${definition.id}' has missing dependency '${dependency}'`
          );
        }
      }
    }
    this.definitions = Object.freeze([...byId.values()]);
    this.byId = byId;
  }

  get ids(): readonly string[] {
    return this.definitions.map((definition) => definition.id);
  }

  resolve(context: TContext): RenderFeatureSelection {
    const enabled = new Set<string>();
    for (const definition of this.definitions) {
      if (definition.enabled(context)) enabled.add(definition.id);
    }

    for (const definition of this.definitions) {
      if (!enabled.has(definition.id)) continue;
      for (const dependency of definition.dependencies ?? []) {
        if (!enabled.has(dependency)) {
          throw new Error(
            `Render Feature '${definition.id}' is enabled but dependency '${dependency}' is disabled`
          );
        }
      }
    }

    const persistentOwners: string[] = [];
    const histories: string[] = [];
    for (const definition of this.definitions) {
      if (!enabled.has(definition.id)) continue;
      const owner = resolveFeatureValue(definition.persistentOwner, context);
      if (owner !== undefined) persistentOwners.push(owner);
      const history = resolveFeatureValue(definition.history, context);
      if (history !== undefined) histories.push(history);
    }
    return Object.freeze({
      enabled: Object.freeze(this.definitions
        .filter((definition) => enabled.has(definition.id))
        .map((definition) => definition.id)),
      persistentOwners: Object.freeze(uniqueStrings(persistentOwners)),
      histories: Object.freeze(uniqueStrings(histories))
    });
  }

  definition(id: string): RenderFeatureDefinition<TContext> {
    const definition = this.byId.get(id);
    if (definition === undefined) {
      throw new Error(`Unknown Render Feature '${id}'`);
    }
    return definition;
  }
}

function resolveFeatureValue<TContext>(
  value: RenderFeatureValue<TContext> | undefined,
  context: TContext
): string | undefined {
  const resolved = typeof value === "function" ? value(context) : value;
  if (resolved === undefined) return undefined;
  if (resolved.length === 0) throw new Error("Render Feature owner/history must not be empty");
  return resolved;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function freezeNames(
  names: readonly string[] | undefined,
  kind: string,
  featureId: string
): readonly string[] {
  if (names === undefined) return Object.freeze([]);
  const result = [...names];
  if (result.some((name) => name.length === 0)) {
    throw new Error(`Render Feature '${featureId}' has an empty ${kind} name`);
  }
  if (new Set(result).size !== result.length) {
    throw new Error(`Render Feature '${featureId}' has duplicated ${kind} names`);
  }
  return Object.freeze(result);
}
