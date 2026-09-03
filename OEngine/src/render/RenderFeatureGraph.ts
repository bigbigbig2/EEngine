export type RenderFeatureValue<TContext> =
  | string
  | undefined
  | ((context: TContext) => string | undefined);

export interface RenderFeatureProducts {
  read<T = unknown>(name: string): T;
  has(name: string): boolean;
  publish<T = unknown>(name: string, value: T): void;
}

export interface RenderFeatureDefinition<TContext> {
  readonly id: string;
  readonly enabled: (context: TContext) => boolean;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly debugViews?: readonly string[];
  readonly persistentOwner?: RenderFeatureValue<TContext>;
  readonly history?: RenderFeatureValue<TContext>;
  readonly dependencies?: readonly string[];
  readonly contribute?: (
    context: TContext,
    products: RenderFeatureProducts
  ) => void;
}

export interface RenderFeatureContributionEvidence {
  readonly featureId: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export interface RenderFeatureExecution {
  readonly products: ReadonlyMap<string, unknown>;
  readonly contributions: readonly RenderFeatureContributionEvidence[];
}

/**
 * An immutable, topology-specific list of enabled Feature contributors.
 *
 * It does not own a command encoder or a FrameGraph. A render context may carry
 * those objects, but contributors can only exchange declared logical products.
 */
export class CompiledRenderFeatureGraph<TContext> {
  readonly order: readonly string[];
  readonly persistentOwners: readonly string[];
  readonly histories: readonly string[];
  readonly debugViews: readonly string[];

  constructor(
    private readonly definitions: readonly FrozenRenderFeatureDefinition<TContext>[],
    private readonly externalProducts: ReadonlySet<string>,
    context: TContext
  ) {
    this.order = Object.freeze(definitions.map((definition) => definition.id));
    this.persistentOwners = Object.freeze(uniqueResolvedValues(
      definitions,
      context,
      (definition) => definition.persistentOwner
    ));
    this.histories = Object.freeze(uniqueResolvedValues(
      definitions,
      context,
      (definition) => definition.history
    ));
    this.debugViews = Object.freeze(uniqueStrings(
      definitions.flatMap((definition) => definition.debugViews)
    ));
  }

  contribute(
    context: TContext,
    initialProducts: ReadonlyMap<string, unknown> = new Map()
  ): RenderFeatureExecution {
    const products = new Map<string, unknown>();
    for (const [name, value] of initialProducts) {
      if (!this.externalProducts.has(name)) {
        throw new Error(`Render FeatureGraph received undeclared external product '${name}'`);
      }
      products.set(name, value);
    }

    const contributions: RenderFeatureContributionEvidence[] = [];
    for (const definition of this.definitions) {
      if (!definition.enabled(context)) {
        throw new Error(
          `Render FeatureGraph topology changed before contribution: '${definition.id}' is now disabled`
        );
      }
      for (const input of definition.inputs) {
        if (!products.has(input)) {
          throw new Error(
            `Render Feature '${definition.id}' cannot read unavailable product '${input}'`
          );
        }
      }

      const declaredInputs = new Set(definition.inputs);
      const declaredOutputs = new Set(definition.outputs);
      const api: RenderFeatureProducts = Object.freeze({
        read: <T = unknown>(name: string): T => {
          if (!declaredInputs.has(name)) {
            throw new Error(
              `Render Feature '${definition.id}' cannot read undeclared input '${name}'`
            );
          }
          if (!products.has(name)) {
            throw new Error(
              `Render Feature '${definition.id}' cannot read unavailable product '${name}'`
            );
          }
          return products.get(name) as T;
        },
        has: (name: string): boolean => {
          if (!declaredInputs.has(name)) {
            throw new Error(
              `Render Feature '${definition.id}' cannot inspect undeclared input '${name}'`
            );
          }
          return products.has(name);
        },
        publish: <T = unknown>(name: string, value: T): void => {
          if (!declaredOutputs.has(name)) {
            throw new Error(
              `Render Feature '${definition.id}' cannot publish undeclared output '${name}'`
            );
          }
          if (products.has(name)) {
            throw new Error(
              `Render Feature '${definition.id}' cannot overwrite product '${name}'`
            );
          }
          products.set(name, value);
        }
      });

      definition.contribute?.(context, api);
      for (const output of definition.outputs) {
        if (!products.has(output)) {
          throw new Error(
            `Render Feature '${definition.id}' did not publish declared output '${output}'`
          );
        }
      }
      contributions.push(Object.freeze({
        featureId: definition.id,
        inputs: definition.inputs,
        outputs: definition.outputs
      }));
    }

    return Object.freeze({
      products: readonlyMap(products),
      contributions: Object.freeze(contributions)
    });
  }
}

/**
 * Compiles enabled render Features into a stable contribution order using
 * explicit dependencies and logical producer/consumer edges.
 */
export class RenderFeatureGraph<TContext> {
  private readonly definitions: readonly FrozenRenderFeatureDefinition<TContext>[];
  private readonly byId: ReadonlyMap<string, FrozenRenderFeatureDefinition<TContext>>;

  constructor(definitions: readonly RenderFeatureDefinition<TContext>[]) {
    const byId = new Map<string, FrozenRenderFeatureDefinition<TContext>>();
    for (const definition of definitions) {
      const frozen = freezeDefinition(definition);
      if (byId.has(frozen.id)) {
        throw new Error(`Render Feature '${frozen.id}' is duplicated`);
      }
      byId.set(frozen.id, frozen);
    }
    for (const definition of byId.values()) {
      for (const dependency of definition.dependencies) {
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
    return Object.freeze(this.definitions.map((definition) => definition.id));
  }

  definition(id: string): RenderFeatureDefinition<TContext> {
    const definition = this.byId.get(id);
    if (definition === undefined) throw new Error(`Unknown Render Feature '${id}'`);
    return definition;
  }

  compile(
    context: TContext,
    externalProducts: readonly string[] = []
  ): CompiledRenderFeatureGraph<TContext> {
    const external = new Set(validateNames(externalProducts, "external product", "FeatureGraph"));
    const enabled = this.definitions.filter((definition) => definition.enabled(context));
    const enabledIds = new Set(enabled.map((definition) => definition.id));
    const producers = new Map<string, FrozenRenderFeatureDefinition<TContext>>();

    for (const definition of enabled) {
      for (const dependency of definition.dependencies) {
        if (!enabledIds.has(dependency)) {
          throw new Error(
            `Render Feature '${definition.id}' is enabled but dependency '${dependency}' is disabled`
          );
        }
      }
      for (const output of definition.outputs) {
        const previous = producers.get(output);
        if (previous !== undefined) {
          throw new Error(
            `Render product '${output}' is produced by both '${previous.id}' and '${definition.id}'`
          );
        }
        if (external.has(output)) {
          throw new Error(
            `Render product '${output}' is both external and produced by '${definition.id}'`
          );
        }
        producers.set(output, definition);
      }
    }

    const dependencies = new Map<string, Set<string>>();
    for (const definition of enabled) {
      const featureDependencies = new Set(definition.dependencies);
      for (const input of definition.inputs) {
        const producer = producers.get(input);
        if (producer !== undefined) {
          featureDependencies.add(producer.id);
        } else if (!external.has(input)) {
          throw new Error(
            `Render Feature '${definition.id}' requires missing product '${input}'`
          );
        }
      }
      dependencies.set(definition.id, featureDependencies);
    }

    const orderedIds = stableFeatureOrder(enabled, dependencies);
    const ordered = orderedIds.map((id) => this.byId.get(id)!);
    return new CompiledRenderFeatureGraph(ordered, external, context);
  }
}

type FrozenRenderFeatureDefinition<TContext> = Readonly<{
  id: string;
  enabled: (context: TContext) => boolean;
  inputs: readonly string[];
  outputs: readonly string[];
  debugViews: readonly string[];
  persistentOwner?: RenderFeatureValue<TContext>;
  history?: RenderFeatureValue<TContext>;
  dependencies: readonly string[];
  contribute?: (context: TContext, products: RenderFeatureProducts) => void;
}>;

function freezeDefinition<TContext>(
  definition: RenderFeatureDefinition<TContext>
): FrozenRenderFeatureDefinition<TContext> {
  if (definition.id.length === 0) throw new Error("Render Feature id must not be empty");
  return Object.freeze({
    ...definition,
    inputs: Object.freeze(validateNames(definition.inputs ?? [], "input", definition.id)),
    outputs: Object.freeze(validateNames(definition.outputs ?? [], "output", definition.id)),
    debugViews: Object.freeze(validateNames(definition.debugViews ?? [], "debug view", definition.id)),
    dependencies: Object.freeze(validateNames(
      definition.dependencies ?? [],
      "dependency",
      definition.id
    ))
  });
}

function validateNames(
  names: readonly string[],
  kind: string,
  owner: string
): string[] {
  const result = [...names];
  if (result.some((name) => name.length === 0)) {
    throw new Error(`Render Feature '${owner}' has an empty ${kind} name`);
  }
  if (new Set(result).size !== result.length) {
    throw new Error(`Render Feature '${owner}' has duplicated ${kind} names`);
  }
  return result;
}

function stableFeatureOrder<TContext>(
  enabled: readonly FrozenRenderFeatureDefinition<TContext>[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const insertion = enabled.map((definition) => definition.id);
  const indegree = new Map(insertion.map((id) => [id, dependencies.get(id)?.size ?? 0]));
  const consumers = new Map<string, string[]>();
  for (const [id, featureDependencies] of dependencies) {
    for (const dependency of featureDependencies) {
      const list = consumers.get(dependency) ?? [];
      list.push(id);
      consumers.set(dependency, list);
    }
  }
  const ready = insertion.filter((id) => indegree.get(id) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const consumer of consumers.get(id) ?? []) {
      const next = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, next);
      if (next === 0) ready.push(consumer);
    }
  }
  if (result.length !== insertion.length) {
    const cycle = insertion.filter((id) => !result.includes(id));
    throw new Error(`Render FeatureGraph contains a dependency cycle: ${cycle.join(" -> ")}`);
  }
  return result;
}

function resolveValue<TContext>(
  value: RenderFeatureValue<TContext> | undefined,
  context: TContext
): string | undefined {
  const resolved = typeof value === "function" ? value(context) : value;
  if (resolved === undefined) return undefined;
  if (resolved.length === 0) throw new Error("Render Feature owner/history must not be empty");
  return resolved;
}

function uniqueResolvedValues<TContext>(
  definitions: readonly FrozenRenderFeatureDefinition<TContext>[],
  context: TContext,
  select: (
    definition: FrozenRenderFeatureDefinition<TContext>
  ) => RenderFeatureValue<TContext> | undefined
): string[] {
  return uniqueStrings(definitions
    .map((definition) => resolveValue(select(definition), context))
    .filter((value): value is string => value !== undefined));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const snapshot = new Map(source);
  return Object.freeze({
    get size(): number { return snapshot.size; },
    has: (key: K): boolean => snapshot.has(key),
    get: (key: K): V | undefined => snapshot.get(key),
    forEach: (
      callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown
    ): void => snapshot.forEach((value, key) => callbackfn.call(thisArg, value, key, snapshot)),
    entries: (): MapIterator<[K, V]> => snapshot.entries(),
    keys: (): MapIterator<K> => snapshot.keys(),
    values: (): MapIterator<V> => snapshot.values(),
    [Symbol.iterator]: (): MapIterator<[K, V]> => snapshot[Symbol.iterator]()
  });
}
