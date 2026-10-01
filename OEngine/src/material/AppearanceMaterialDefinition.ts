import type { AppearanceGraph } from "./AppearanceGraph.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import { appearanceFieldIdentity } from "./AppearanceFieldIdentity.js";
import { bindAppearanceProducts, type AppearanceProductBinding } from "./AppearanceProductBinding.js";

let nextDefinition = 0;

/**
 * Immutable, device-independent authored program/products. Replacing this object
 * requires an explicit material/scene republication (currently resyncScene). Construction does not
 * compile, allocate or submit GPU work. Stale fields restore their source program;
 * unchanged fields keep their cooked data. Raw portable sources need content versions.
 */
export class AppearanceMaterialDefinition {
  private readonly id = nextDefinition++;
  readonly products: readonly AppearanceAssetPackage[];
  constructor(readonly graph: AppearanceGraph | null = null, products: readonly AppearanceAssetPackage[] = []) {
    this.products = Object.freeze([...products]);
    Object.freeze(this);
  }
  hash(): number { return this.id; }
}

export interface AppearanceProductResolution {
  readonly program: CompiledAppearanceGraph;
  readonly reused: readonly string[];
  readonly stale: readonly string[];
}

/** Exact CPU publication matching, including internal roots and independent lobe invalidation. */
export function resolveAppearanceMaterialProducts(source: CompiledAppearanceGraph,
  products: readonly AppearanceAssetPackage[]): AppearanceProductResolution {
  const bindings: AppearanceProductBinding[] = [], reused: string[] = [], stale: string[] = [];
  const selectors = new Map<string, number>();
  if (products.some(product => product.kind === "reevaluated-mip-fields")) {
    source.instructions.forEach((_instruction, ref) => selectors.set(appearanceFieldIdentity(source, [ref]).key, ref));
  }
  for (const asset of products) {
    const label = (name: string) => `${asset.runtime.manifest.assetId}/${name}`;
    if (asset.kind === "coupled-vmf-moments") {
      const normalPairs: string[] = [];
      for (const pair of asset.normalFilters) {
        const normal = source.outputs[pair.normalOutput], roughness = source.outputs[pair.roughnessOutput];
        const field = asset.fields.find(field => field.name === pair.momentField)!;
        if (normal?.length === 3 && roughness?.length === 1 &&
            appearanceFieldIdentity(source, [...normal, ...roughness]).key === field.sourceIdentity.key) {
          normalPairs.push(pair.momentField); reused.push(label(pair.momentField));
        } else stale.push(label(pair.momentField));
      }
      if (normalPairs.length > 0) bindings.push({ source, asset, normalPairs });
    } else {
      const roots: Record<string, readonly number[]> = Object.create(null);
      for (const field of asset.fields) {
        const refs = field.sourceIdentity.components.map(key => selectors.get(key));
        if (refs.every((ref): ref is number => ref !== undefined) && appearanceFieldIdentity(source, refs).key === field.sourceIdentity.key) {
          roots[field.name] = refs; reused.push(label(field.name));
        } else stale.push(label(field.name));
      }
      if (Object.keys(roots).length > 0) bindings.push({ source, asset, roots });
    }
  }
  return Object.freeze({ program: bindAppearanceProducts(source, bindings), reused: Object.freeze(reused), stale: Object.freeze(stale) });
}
