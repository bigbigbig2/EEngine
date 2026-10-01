import { APPEARANCE_DEPENDENCY as D, selectAppearanceProductProgram } from "./AppearanceGraphCompiler.js";
import type { CompiledAppearanceGraph, AppearanceInstruction, CompiledAppearanceProductRead } from "./AppearanceGraphCompiler.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import { appearanceFieldIdentity } from "./AppearanceFieldIdentity.js";

export interface AppearanceProductBinding {
  /** Exact immutable source snapshot used to cook these fields. New publication needs new bindings. */
  readonly source: CompiledAppearanceGraph;
  readonly asset: AppearanceAssetPackage;
  /** Plain fields can replace reusable internal roots, including roots below dynamic target expressions. */
  readonly roots?: Readonly<Record<string, readonly number[]>>;
  /** Selected moment fields allow one stale lobe to fall back without dropping the other. */
  readonly normalPairs?: readonly string[];
}

/**
 * Local TextureBaker-style reconnection. Substitutes actual data leaves, then
 * prunes dead source samples/parameters/operations. No GPU lifetime here.
 * Normal pairs override named lobe outputs independently: two originally CSE'd
 * roughness values must NOT force base/coat filtered results to be identical.
 * Source program references remain immutable dependency provenance for versions.
 */
export function bindAppearanceProducts(source: CompiledAppearanceGraph,
  bindings: readonly AppearanceProductBinding[]): CompiledAppearanceGraph {
  if (bindings.length === 0) return source;
  if (source.productReads?.length) throw new RangeError("Appearance products bind once to the original source snapshot");
  const instructions: AppearanceInstruction[] = [...source.instructions];
  const outputs = { ...source.outputs };
  const reads: CompiledAppearanceProductRead[] = [];
  const replaced = new Set<number>(), overriddenOutputs = new Set<string>();
  const coordinateAnchors = new Map<string, number>();
  const forbidden = D.Geometry | D.Dynamic | D.View | D.Nonlocal;
  const validateRoots = (roots: readonly number[]) => {
    if (roots.length < 1 || roots.length > 4 || roots.some(ref => !Number.isInteger(ref) || ref < 0 || ref >= source.instructions.length ||
        (source.instructions[ref]!.dependency & forbidden) !== 0)) {
      throw new RangeError("Appearance product cannot replace dynamic/geometry/view/nonlocal or invalid source roots");
    }
  };
  const addRead = (binding: AppearanceProductBinding, name: string, roots: readonly number[]) => {
    validateRoots(roots);
    const field = binding.asset.fields.find(item => item.name === name);
    if (field === undefined) throw new RangeError(`Appearance product field '${name}' is missing`);
    if (appearanceFieldIdentity(source, roots).key !== field.sourceIdentity.key) throw new RangeError("Appearance product source identity is stale or mismatched");
    let uv: readonly [number, number] | null = null;
    if (field.constant === undefined) {
      const domains = [...new Set(roots.flatMap(ref => source.instructions[ref]!.coordinateDomains))];
      if (domains.length !== 1 || domains[0] !== binding.asset.coordinateDomain) throw new RangeError("Appearance product coordinate domain mismatch");
      const inputRefs = source.instructions.flatMap((instruction, index) => instruction.kind === "input" &&
        instruction.dependency === D.Surface && instruction.coordinateDomains.includes(domains[0]!) ? [index] : []);
      const inputNames = new Set(inputRefs.map(ref => source.instructions[ref]!.input));
      const seed = source.instructions[inputRefs[0]!];
      if (inputNames.size !== 1 || seed === undefined || source.inputs.find(input => input.name === seed.input)?.width !== 2) {
        throw new RangeError("Appearance product requires its authored two-channel coordinate domain");
      }
      // Keep authoritative coordinates even if a procedural output is itself uv.x / uv.y.
      uv = Object.freeze([0, 1].map(channel => {
        const key = `${seed.input}:${channel}`;
        let anchor = coordinateAnchors.get(key);
        if (anchor === undefined) {
          anchor = instructions.length; instructions.push(Object.freeze({ ...seed, channel })); coordinateAnchors.set(key, anchor);
        }
        return anchor;
      })) as readonly [number, number];
    } else if (roots.some(ref => (source.instructions[ref]!.dependency & ~D.Material) !== 0)) {
      throw new RangeError("Appearance constant product cannot replace a spatial source field");
    }
    const product = reads.length;
    reads.push(Object.freeze({ asset: binding.asset, field, uv, source, sourceRoots: Object.freeze([...roots]) }));
    return { product, field, uv };
  };
  for (const binding of bindings) {
    if (binding.source !== source) throw new RangeError("Appearance product binding belongs to a different source snapshot");
    if (binding.asset.kind === "coupled-vmf-moments") {
      if (binding.roots !== undefined) throw new RangeError("Appearance normal pairs reconnect their named lobe outputs");
      if (binding.normalPairs?.some(name => !binding.asset.normalFilters.some(pair => pair.momentField === name))) throw new RangeError("Appearance normal pair selection is missing");
      for (const pair of binding.asset.normalFilters) {
        if (binding.normalPairs !== undefined && !binding.normalPairs.includes(pair.momentField)) continue;
        const normal = source.outputs[pair.normalOutput], roughness = source.outputs[pair.roughnessOutput];
        const validityName = `${pair.normalOutput}Validity`;
        if (normal?.length !== 3 || roughness?.length !== 1 || overriddenOutputs.has(pair.normalOutput) ||
            overriddenOutputs.has(pair.roughnessOutput) || Object.hasOwn(outputs, validityName)) throw new RangeError("Appearance normal pair output mismatch");
        const read = addRead(binding, pair.momentField, [...normal, ...roughness]);
        const channels = Array.from({ length: 5 }, (_, channel) => {
          const id = instructions.length;
          instructions.push(Object.freeze({ kind: "normal-product", product: read.product, channel,
            args: read.uv ?? [], dependency: read.uv === null ? D.Material : D.Texture | D.Surface,
            coordinateDomains: read.uv === null ? [] : [binding.asset.coordinateDomain!], filter: "nonlinear" }));
          return id;
        });
        outputs[pair.normalOutput] = Object.freeze(channels.slice(0, 3));
        outputs[pair.roughnessOutput] = Object.freeze(channels.slice(3, 4));
        outputs[validityName] = Object.freeze(channels.slice(4));
        overriddenOutputs.add(pair.normalOutput); overriddenOutputs.add(pair.roughnessOutput);
      }
      continue;
    }
    if (binding.roots === undefined) throw new RangeError("Appearance plain products need explicit source roots");
    for (const [name, roots] of Object.entries(binding.roots)) {
      const read = addRead(binding, name, roots);
      if (roots.length !== read.field.width || roots.some(ref => replaced.has(ref))) throw new RangeError("Appearance product root width or overlap mismatch");
      roots.forEach((ref, channel) => {
        replaced.add(ref);
        instructions[ref] = Object.freeze({ kind: "product", product: read.product, channel,
          args: read.uv ?? [], dependency: read.uv === null ? D.Material : D.Texture | D.Surface,
          coordinateDomains: read.uv === null ? [] : [binding.asset.coordinateDomain!], filter: "affine" });
      });
    }
  }
  return selectAppearanceProductProgram({ ...source, instructions, productReads: reads }, outputs);
}
