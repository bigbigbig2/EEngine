import {
  RenderFeatureGraph,
  type CompiledRenderFeatureGraph,
  type RenderFeatureDefinition,
  type RenderFeatureValue
} from "./RenderFeatureGraph.js";

export type {
  RenderFeatureDefinition,
  RenderFeatureProducts,
  RenderFeatureValue
} from "./RenderFeatureGraph.js";

export interface RenderFeatureSelection {
  readonly enabled: readonly string[];
  readonly persistentOwners: readonly string[];
  readonly histories: readonly string[];
}

/**
 * Registers the one set of render Feature definitions used for both topology
 * evidence and executable graph composition.
 */
export class RenderFeatureRegistry<TContext> {
  private readonly definitions: readonly RenderFeatureDefinition<TContext>[];
  private readonly graph: RenderFeatureGraph<TContext>;

  constructor(definitions: readonly RenderFeatureDefinition<TContext>[]) {
    this.graph = new RenderFeatureGraph(definitions);
    this.definitions = Object.freeze(
      this.graph.ids.map((id) => this.graph.definition(id))
    );
  }

  get ids(): readonly string[] {
    return this.graph.ids;
  }

  /**
   * Returns owner/history selection evidence without executing contributions.
   * Migrated graph construction must use compile().
   */
  resolve(context: TContext): RenderFeatureSelection {
    const enabled = this.definitions.filter((definition) => definition.enabled(context));
    const enabledIds = new Set(enabled.map((definition) => definition.id));
    for (const definition of enabled) {
      for (const dependency of definition.dependencies ?? []) {
        if (!enabledIds.has(dependency)) {
          throw new Error(
            `Render Feature '${definition.id}' is enabled but dependency '${dependency}' is disabled`
          );
        }
      }
    }

    const persistentOwners: string[] = [];
    const histories: string[] = [];
    for (const definition of enabled) {
      const owner = resolveFeatureValue(definition.persistentOwner, context);
      if (owner !== undefined) persistentOwners.push(owner);
      const history = resolveFeatureValue(definition.history, context);
      if (history !== undefined) histories.push(history);
    }
    return Object.freeze({
      enabled: Object.freeze(enabled.map((definition) => definition.id)),
      persistentOwners: Object.freeze(uniqueStrings(persistentOwners)),
      histories: Object.freeze(uniqueStrings(histories))
    });
  }

  compile(
    context: TContext,
    externalProducts: readonly string[] = []
  ): CompiledRenderFeatureGraph<TContext> {
    return this.graph.compile(context, externalProducts);
  }

  definition(id: string): RenderFeatureDefinition<TContext> {
    return this.graph.definition(id);
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
