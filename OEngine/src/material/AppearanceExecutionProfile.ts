import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import { appearanceFieldIdentity } from "./AppearanceFieldIdentity.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { APPEARANCE_FIELD_NAMES } from "../gpu/GpuAppearanceFieldAbi.js";

export const FIELD_CACHE_CLASS = Object.freeze({ publication: 0, stable: 1, share: 2, transient: 3 });
export const FIELD_VALUE_COST_CLASS = Object.freeze({ publication: 0, input: 1, sampled: 2, program: 3 });
export const SURFACE_PROOF_STATE = Object.freeze({ unknown: 0, exactPublication: 1, exactPoint: 2,
  constantDomain: 3, boundedDomain: 4, pendingValidation: 5 });
export interface DomainRecipe {
  readonly token: number;
  readonly seamMask: number;
  readonly inputMask: number;
  readonly uvMask: number;
  readonly instance: boolean;
  readonly side: boolean;
  readonly lod: boolean;
  readonly primitiveLocal: boolean;
}
export interface ProofProfile {
  readonly token: number;
  readonly supported: boolean;
  readonly nodes: number;
  readonly coordinateNodes: number;
  readonly queries: number;
  /** Complete accepted visitor ceiling, including mip and level selection
   * metadata plus bound payload reads, per equivalent RGBA query. */
  readonly visitBound: number;
  /** Total visitor admission ceiling; exhaustion must yield Unknown in Phase 3. */
  readonly visitLimit: number;
  readonly tolerance: number;
  readonly normalConeCos: number;
  readonly qualityClass: number;
}
export interface FieldExecutionProfile {
  readonly token: number;
  readonly identity: string;
  readonly present: boolean;
  readonly publication: boolean;
  readonly inputMask: number;
  readonly dependencyMask: number;
  readonly samples: readonly number[];
  readonly products: readonly number[];
  readonly valueNodes: number;
  readonly valueSamples: number;
  readonly valueCostClass: number;
  readonly cacheClass: number;
  readonly domain: DomainRecipe;
  readonly proof: ProofProfile;
  readonly group: number;
}
export interface DependencyGroup {
  readonly token: number;
  readonly fields: number;
  readonly inputMask: number;
  readonly seamMask: number;
  readonly samples: readonly number[];
  readonly products: readonly number[];
}
export interface SignalExecutionProfile {
  readonly token: number;
  readonly fields: number;
  /** light, shadow, sun, environment, view: independent provider versions. */
  readonly providers: number;
  readonly seamMask: number;
  readonly inputMask: number;
  readonly semantic: "coloredResidual" | "irradiance" | "radiance" | "diffuseTransport";
  readonly residualToken: number;
  readonly maxRate: number;
  readonly proofClass: number;
  readonly domainToken: number;
}
export interface AppearanceExecutionProfiles {
  readonly token: number;
  readonly fields: readonly FieldExecutionProfile[];
  readonly groups: readonly DependencyGroup[];
  readonly signals: readonly SignalExecutionProfile[];
  readonly enabledMask: number;
  readonly inputMask: number;
}

const fieldMask = (...fields: number[]): number => fields.reduce((mask, field) => mask | (1 << field), 0);
export const SURFACE_DIRECT_RESIDUAL_FIELDS = fieldMask(0, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14);
export const SURFACE_DIRECT_TRANSPORT_FIELDS = fieldMask(6, 10, 12, 13, 14);
// Runtime publication chooses transport only after the current numeric envelope
// is proved. Unsafe profiles retain the original combined BRDF finite guard.
export const SURFACE_SIGNAL_FIELD_MASKS = Object.freeze([
  SURFACE_DIRECT_TRANSPORT_FIELDS, fieldMask(6, 13),
  fieldMask(0, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14),
  fieldMask(0, 2, 3, 6, 7, 8, 9, 13),
  fieldMask(0, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14), fieldMask(10, 11, 12, 14)
]);

/** Original scalar DAG closure, including coordinate DAGs of nested samples. */
export function appearanceExecutionClosure(program: CompiledAppearanceGraph, roots: readonly number[]): readonly number[] {
  const live = new Set<number>();
  const pending = [...roots];
  while (pending.length !== 0) {
    const ref = pending.pop()!;
    if (live.has(ref)) { continue; }
    const node = program.instructions[ref];
    if (node === undefined) { throw new RangeError("Invalid Appearance execution DAG reference"); }
    live.add(ref);
    pending.push(...node.args);
    if (node.sample !== undefined) { pending.push(...program.samples[node.sample]!.uv); }
    if (node.product !== undefined) { pending.push(...program.productReads![node.product]!.uv ?? []); }
  }
  return Object.freeze([...live].sort((a, b) => a - b));
}

/** Cook/publication only. Intern compares complete strings; numeric tokens are
 * handles to that equality, never hashes or evidence of dynamic value validity. */
export function appearanceExecutionProfiles(program: CompiledAppearanceGraph,
  intern: (witness: string) => number): AppearanceExecutionProfiles {
  const groups: DependencyGroup[] = [];
  const groupKeys = new Map<string, number>();
  const fields = APPEARANCE_FIELD_NAMES.map((name, field): FieldExecutionProfile => {
    const roots = program.outputs[name];
    const live = roots === undefined ? [] : appearanceExecutionClosure(program, roots);
    let inputMask = 0;
    let seamMask = 0;
    let uvMask = 0;
    let dependencyMask = 0;
    let supported = true;
    let view = false;
    const samples = new Set<number>();
    const products = new Set<number>();
    const inputs: unknown[] = [];
    const coordinateRoots: number[] = [];
    for (const ref of live) {
      const node = program.instructions[ref]!;
      dependencyMask |= node.dependency;
      if (node.kind === "input") {
        const input = program.inputs.find(input => input.name === node.input)!;
        const kind = appearanceGeometryInputKind(input, program);
        inputMask |= 1 << kind;
        seamMask |= kind === 1 ? 1 : kind === 2 ? 2 : kind === 3 ? 64 : kind === 4 ? 16 :
          [5, 11, 14].includes(kind) ? 4 : [6, 12].includes(kind) ? 8 : kind === 0 ? 0 : 32;
        if (kind >= 1 && kind <= 3) { uvMask |= 1 << (kind - 1); }
        view ||= [8, 9, 13, 14].includes(kind);
        supported &&= input.domain !== "dynamic" && input.domain !== "nonlocal";
        inputs.push([input.name, input.domain, input.width, node.channel, node.coordinateDomains, node.range]);
      }
      if (node.sample !== undefined) {
        samples.add(node.sample);
        coordinateRoots.push(...program.samples[node.sample]!.uv);
      }
      if (node.product !== undefined && program.productReads![node.product]!.field.constant === undefined) {
        products.add(node.product);
        coordinateRoots.push(...program.productReads![node.product]!.uv!);
      }
    }
    const publication = roots === undefined || (dependencyMask & ~64) === 0;
    const sampleIds = Object.freeze([...samples].sort((a, b) => a - b));
    const productIds = Object.freeze([...products].sort((a, b) => a - b));
    const domainFacts = [seamMask, inputMask, uvMask, !publication, !publication, !publication, (uvMask & 4) !== 0];
    const domain: DomainRecipe = Object.freeze({ token: intern(JSON.stringify(["domain-recipe-v1", domainFacts])),
      seamMask, inputMask, uvMask, instance: !publication, side: !publication, lod: !publication, primitiveLocal: (uvMask & 4) !== 0 });
    const coordinateLive = appearanceExecutionClosure(program, coordinateRoots);
    const coordinateNodes = coordinateLive.length;
    const coordinateQueries = new Set<string>();
    for (const ref of coordinateLive) {
      const node = program.instructions[ref]!;
      if (node.sample !== undefined) { coordinateQueries.add(`sample:${node.sample}`); }
      if (node.product !== undefined && program.productReads![node.product]!.field.constant === undefined) {
        coordinateQueries.add(`product:${node.product}`);
      }
      // Match the original interval compiler's derivative support, including
      // texture-driven/nonlinear coordinates; never infer this from WGSL text.
      if (node.kind === "operation" && !["add", "subtract", "multiply", "divide"].includes(node.op!)) { supported = false; }
      if (node.kind === "texture" || ((node.kind === "product" || node.kind === "normal-product") &&
        program.productReads![node.product!]!.field.constant === undefined)) { supported = false; }
    }
    const queries = samples.size + products.size;
    // Bound SSA values, both coordinate-derivative axes, and one RGBA query
    // declaration per independent texture/product. Query-internal hierarchy
    // selection and payload visits share their own 32-visit ceiling.
    const proofNodes = live.length + coordinateNodes * 2 + queries;
    const visitBound = queries * 32;
    const identity = roots === undefined ? `default:${name}` : appearanceFieldIdentity(program, roots).key;
    const qualityClass = field === 6 || field === 12 ? 1 : field === 5 ? 2 : 0;
    const proofFacts = [supported, proofNodes, coordinateNodes, queries, visitBound, 32, 0.02, 0.99965732498];
    const proof: ProofProfile = Object.freeze({ token: intern(JSON.stringify([
      "proof-profile-v1", name, identity, domain.token, qualityClass, proofFacts])),
      supported, nodes: proofNodes, coordinateNodes, queries, visitBound, visitLimit: 32,
      tolerance: 0.02, normalConeCos: 0.99965732498, qualityClass });
    const queryIdentities = sampleIds.map(sample => appearanceFieldIdentity(program, [
      program.instructions.findIndex(node => node.sample === sample)]).key);
    const productIdentities = productIds.map(product => appearanceFieldIdentity(program, [
      program.instructions.findIndex(node => node.product === product)]).key);
    const dependencyKey = JSON.stringify(["dependency-group-v1", inputs, queryIdentities, productIdentities, domainFacts, proofFacts]);
    let group = groupKeys.get(dependencyKey);
    if (group === undefined) {
      group = groups.length;
      groupKeys.set(dependencyKey, group);
      groups.push({ token: intern(dependencyKey), fields: 0, inputMask, seamMask, samples: sampleIds, products: productIds });
    }
    groups[group] = { ...groups[group]!, fields: groups[group]!.fields | (1 << field) };
    const cacheClass = publication ? FIELD_CACHE_CLASS.publication : view || (dependencyMask & (8 | 32)) !== 0 ||
      (queries === 0 && live.length + coordinateNodes * 3 <= 8) ? FIELD_CACHE_CLASS.transient :
      (inputMask & ~((1 << 1) | (1 << 2) | (1 << 3))) === 0 && [1, 2, 4].includes(uvMask) ? FIELD_CACHE_CLASS.stable : FIELD_CACHE_CLASS.share;
    // The existing value compiler executes coordinate ancestors at C/X/Y, then
    // the live value closure. Nested coordinate RGBA queries are separate from
    // the final output query; four channels of one sample are still one query.
    const valueSamples = queries + coordinateQueries.size * 3;
    const valueNodes = live.length + coordinateNodes * 3;
    const valueCostClass = publication ? FIELD_VALUE_COST_CLASS.publication : queries === 0 && valueNodes <= 8 ?
      FIELD_VALUE_COST_CLASS.input : queries <= 1 && coordinateQueries.size === 0 && valueNodes <= 32 ?
        FIELD_VALUE_COST_CLASS.sampled : FIELD_VALUE_COST_CLASS.program;
    const token = intern(JSON.stringify(["field-execution-v1", name, identity, inputMask, dependencyMask,
      valueNodes, valueSamples, valueCostClass, cacheClass, domain.token, proof.token, groups[group]!.token]));
    return Object.freeze({ token, identity, present: roots !== undefined, publication, inputMask, dependencyMask,
      samples: sampleIds, products: productIds, valueNodes,
      valueSamples, valueCostClass, cacheClass, domain, proof, group });
  });
  const signals = SURFACE_SIGNAL_FIELD_MASKS.map((mask, kind): SignalExecutionProfile => {
    let seamMask = 12;
    let inputMask = (1 << 5) | (1 << 6) | (1 << 7);
    for (let field = 0; field < 15; field++) {
      if ((mask & (1 << field)) !== 0) { seamMask |= fields[field]!.domain.seamMask; inputMask |= fields[field]!.inputMask; }
    }
    const providers = (kind & 1) === 0 ? 1 | 2 | 4 | 16 : 8 | (kind === 1 ? 0 : 16);
    const semantic = kind === 0 ? "diffuseTransport" : kind === 1 ? "irradiance" : "radiance";
    const maxRate = kind <= 1 ? 8 : 4;
    const proofClass = (kind & 1) === 0 ? 2 : 1;
    const domainToken = intern(JSON.stringify(["signal-domain-v1", seamMask, inputMask, true, true, true]));
    const token = intern(JSON.stringify(["signal-execution-v1", mask, providers, semantic, maxRate, proofClass,
      domainToken, fields.filter((_profile, field) => (mask & (1 << field)) !== 0).map(profile => profile.token)]));
    const residualToken = kind === 0 ? intern(JSON.stringify(["direct-colored-residual-v2",
      SURFACE_DIRECT_RESIDUAL_FIELDS, providers, fields.map(profile => profile.token)])) : token;
    return Object.freeze({ token, residualToken, fields: mask, providers, seamMask, inputMask, semantic, maxRate, proofClass, domainToken });
  });
  let enabledMask = 0;
  let inputMask = 0;
  for (let field = 0; field < 15; field++) {
    if (fields[field]!.present) { enabledMask |= 1 << field; inputMask |= fields[field]!.inputMask; }
  }
  if ((enabledMask & fieldMask(2, 3, 6, 7)) !== 0) {
    enabledMask |= 63 << 15;
    inputMask |= (1 << 5) | (1 << 6) | (1 << 7);
  }
  const token = intern(JSON.stringify(["surface-execution-v1", fields.map(profile => profile.token), signals.map(profile => profile.token)]));
  return Object.freeze({ token, fields: Object.freeze(fields), groups: Object.freeze(groups.map(group => Object.freeze(group))),
    signals: Object.freeze(signals), enabledMask, inputMask });
}
