import {
  FrameGraph,
  FrameGraphBindingLayout,
  type CompiledFrameGraph,
  type CompiledFrameGraphDump
} from "../framegraph/FrameGraph.js";
import {
  CompiledFrameGraphCache,
  type CompiledFrameGraphCacheObserver
} from "../framegraph/CompiledFrameGraphCache.js";
import {
  summarizeFrameGraphResources,
  type FrameResourceSummary
} from "../framegraph/FrameResourceSummary.js";
import {
  RenderFeatureGraph,
  type RenderFeatureContributionEvidence,
  type RenderFeatureDefinition
} from "./RenderFeatureGraph.js";

export interface MainViewContributionContext<TBindings, TState> {
  readonly graph: FrameGraph;
  readonly state: TState;
  bind<TValue extends object>(
    name: string,
    resolve: (bindings: TBindings) => TValue
  ): TValue;
}

export interface MainViewCompositionRequest<TBindings, TState> {
  readonly cacheKey: string;
  readonly bindings: TBindings;
  readonly state: TState;
  readonly externalProducts: (
    context: MainViewContributionContext<TBindings, TState>
  ) => ReadonlyMap<string, unknown>;
}

export interface MainViewComposition {
  readonly cacheKey: string;
  readonly cacheHit: boolean;
  readonly graph: CompiledFrameGraph;
  readonly featureOrder: readonly string[];
  readonly contributions: readonly RenderFeatureContributionEvidence[];
  readonly dump: CompiledFrameGraphDump;
  readonly resources: FrameResourceSummary;
}

export interface MainViewComposerOptions {
  readonly graphName?: string;
  readonly cacheCapacity?: number;
  readonly cacheObserver?: Partial<CompiledFrameGraphCacheObserver>;
}

export interface MainViewGraphEncoder {
  encodeCompiledGraph(graph: CompiledFrameGraph, bindings: unknown): void;
}

type CachedCompositionMetadata = Readonly<{
  featureOrder: readonly string[];
  contributions: readonly RenderFeatureContributionEvidence[];
}>;

/**
 * Owns main-view graph compilation and reuse. It records Feature contributions
 * into one FrameGraph but deliberately does not create, finish, or submit a
 * command encoder.
 */
export class MainViewComposer<TBindings, TState> {
  private readonly featureGraph: RenderFeatureGraph<
    MainViewContributionContext<TBindings, TState>
  >;
  private readonly cache: CompiledFrameGraphCache;
  private readonly metadata = new WeakMap<CompiledFrameGraph, CachedCompositionMetadata>();
  private readonly graphName: string;
  private readonly observer: Partial<CompiledFrameGraphCacheObserver>;

  constructor(
    definitions: readonly RenderFeatureDefinition<
      MainViewContributionContext<TBindings, TState>
    >[],
    options: MainViewComposerOptions = {}
  ) {
    this.featureGraph = new RenderFeatureGraph(definitions);
    this.cache = new CompiledFrameGraphCache(options.cacheCapacity ?? 16);
    this.graphName = options.graphName ?? "main-view";
    this.observer = options.cacheObserver ?? {};
  }

  compose(
    request: MainViewCompositionRequest<TBindings, TState>
  ): MainViewComposition {
    if (request.cacheKey.length === 0) {
      throw new Error("MainViewComposer cache key must not be empty");
    }
    let cacheHit = false;
    const graph = this.cache.getOrCreate(
      request.cacheKey,
      () => this.build(request),
      {
        hit: () => {
          cacheHit = true;
          this.observer.hit?.();
        },
        miss: () => this.observer.miss?.(),
        evict: () => this.observer.evict?.()
      }
    );
    const metadata = this.metadata.get(graph);
    if (metadata === undefined) {
      throw new Error("MainViewComposer cache entry has no Feature composition metadata");
    }
    return Object.freeze({
      cacheKey: request.cacheKey,
      cacheHit,
      graph,
      featureOrder: metadata.featureOrder,
      contributions: metadata.contributions,
      dump: graph.dump(),
      resources: summarizeFrameGraphResources(graph)
    });
  }

  encode(
    command: MainViewGraphEncoder,
    composition: MainViewComposition,
    bindings: TBindings
  ): void {
    command.encodeCompiledGraph(composition.graph, bindings);
  }

  destroy(): void {
    this.cache.destroy();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private build(
    request: MainViewCompositionRequest<TBindings, TState>
  ): CompiledFrameGraph {
    const bindingLayout = new FrameGraphBindingLayout<TBindings>();
    const graph = new FrameGraph(this.graphName);
    const context: MainViewContributionContext<TBindings, TState> = Object.freeze({
      graph,
      state: request.state,
      bind: <TValue extends object>(
        name: string,
        resolve: (bindings: TBindings) => TValue
      ): TValue => bindingLayout.slot(name, request.bindings, resolve)
    });
    const externalProducts = request.externalProducts(context);
    const compiledFeatures = this.featureGraph.compile(
      context,
      [...externalProducts.keys()]
    );
    const execution = compiledFeatures.contribute(context, externalProducts);
    const compiledGraph = graph.compile();
    this.metadata.set(compiledGraph, Object.freeze({
      featureOrder: compiledFeatures.order,
      contributions: execution.contributions
    }));
    return compiledGraph;
  }
}
