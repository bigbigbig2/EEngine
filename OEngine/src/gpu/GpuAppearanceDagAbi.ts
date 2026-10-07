import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";
import type { AppearanceWgslProgram } from "../shaders/appearance_program.js";
import { compileAppearanceExecutionPlan, APPEARANCE_DAG_OPS } from "../material/ExactAppearanceDag.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { APPEARANCE_FIELD_NAMES } from "./GpuAppearanceFieldAbi.js";
import { APPEARANCE_CACHE_KEY_WORDS } from "./GpuAppearanceClosureCacheAbi.js";
import {
  AppearanceClosureInterner,
  APPEARANCE_CLOSURE_READ_WORDS,
  compileAppearanceClosurePlans,
  type AppearanceClosurePlan
} from "../material/AppearanceClosurePlan.js";
import {
  compileFixedSurfaceFormulas,
  FIXED_SURFACE_FLAG,
  FIXED_SURFACE_PLAN_WORDS
} from "../material/FixedSurfaceFormulas.js";

export const APPEARANCE_DAG_ENTRY_WORDS = 16;
export const APPEARANCE_DAG_PRODUCT_WORDS = 12;
export const APPEARANCE_DAG_MIP_WORDS = 4;
export const APPEARANCE_DAG_PRODUCT_BANKS = 2;
/** Existing update/export plan words 0..7 retain their readers. Words 8..9
 * locate the optional exact closure directory in this same immutable buffer. */
export const APPEARANCE_DAG_CLOSURES_OFFSET = 8;
export const APPEARANCE_DAG_CLOSURES_COUNT = 9;
export const APPEARANCE_DAG_CACHE_CLOSURE = 10;
export const APPEARANCE_CLOSURE_PLAN_WORDS = 9;

export interface AppearanceDagSource {
  readonly program: CompiledAppearanceGraph;
  readonly lowered: AppearanceWgslProgram;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly inputBase: number;
  readonly textureBindingSetId: number;
  readonly domainHandle?: number;
  readonly routeIdentityBase?: number;
}
export interface AppearanceDagPublicationData {
  readonly workPlans: readonly import("../material/ExactAppearanceDag.js").AppearanceWorkPlan[];
  readonly closurePlans: readonly (readonly AppearanceClosurePlan[])[];
  readonly closureCount: number;
  readonly cacheCandidateCount: number;
  readonly uniformResourceSetMask: number;
  readonly code: Uint32Array;
  readonly products: readonly Uint32Array[];
  readonly productBankWords: number;
  readonly liveWords: number;
  readonly domainCount: number;
  readonly domainBase: number;
  readonly uniformWords: number;
  readonly templateCount: number;
  readonly uniformFlagBase: number;
  readonly hasFrameUniform: boolean;
  readonly coherenceSetMask: number;
  readonly uniformDependencies: readonly (readonly number[])[];
}

/** Local publication ABI integration. Immutable cooked half payload is retained
 * bit-for-bit; formats, every mip and exact domain mapping remain data. Asset
 * count/identity never adds a binding or a PSO. Two negotiated storage banks
 * cover the existing 256 MiB static-residency profile at 128 MiB per binding. */
export function packAppearanceDagPublication(
  sources: readonly AppearanceDagSource[],
  maximumBindingBytes: number,
  productBankBytes = maximumBindingBytes,
  uniformBase = 0
): AppearanceDagPublicationData {
  if (!Number.isSafeInteger(maximumBindingBytes) || maximumBindingBytes < 4) {
    throw new RangeError("Invalid Appearance DAG storage limit");
  }
  if (
    !Number.isSafeInteger(productBankBytes) ||
    productBankBytes < 4 ||
    productBankBytes % 4 !== 0 ||
    productBankBytes > maximumBindingBytes
  ) {
    throw new RangeError("Invalid immutable Product bank limit");
  }
  const bankWords = productBankBytes / 4;
  const words = Array<number>(Math.max(1, sources.length) * APPEARANCE_DAG_ENTRY_WORDS).fill(0);
  const payloads: Uint8Array[] = [];
  const productFields = new Map<string, { offset: number; field: AppearanceAssetField }>();
  let productBytes = 0;
  let liveWords = 1;
  let uniformWords = 0;
  const templates = new Map<
    string,
    { index: number; instructions: number; update: number; frameUpdate: number; publication: number }
  >();
  let hasFrameUniform = false;
  const frameRecords: number[] = [];
  const uniformDependencies: number[][] = [];
  const workPlans: import("../material/ExactAppearanceDag.js").AppearanceWorkPlan[] = [];
  const closurePlans: (readonly AppearanceClosurePlan[])[] = [];
  const closureInterner = new AppearanceClosureInterner();
  let cacheCandidateCount = 0;
  let uniformResourceSetMask = 0;
  const generalTemplates = Array.from({ length: 4 }, () => new Set<number>());
  const domains: number[][] = [];
  const domainIds = new Map<string, number>();
  const bits = (value: number): number => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  };
  for (let entry = 0; entry < sources.length; entry++) {
    const source = sources[entry]!;
    // Alpha has a real Coverage producer/consumer; Surface has no alpha reader.
    // Keep the scalar source snapshot for Coverage and the full-output oracle,
    // but do not schedule its exclusive geometry/query ancestors at S5.
    const surfaceProgram = {
      ...source.program,
      outputs: Object.fromEntries(Object.entries(source.program.outputs).filter(([name]) => name !== "alpha"))
    };
    const execution = compileAppearanceExecutionPlan(surfaceProgram, source.lowered);
    workPlans.push(execution.workPlan);
    const closures = compileAppearanceClosurePlans(
      surfaceProgram,
      source.lowered,
      execution,
      closureInterner,
      source.routeIdentityBase
    );
    closurePlans.push(closures);
    if (
      execution.workPlan.uniformTextureQueries.length > 0 ||
      execution.workPlan.uniformProductQueries.length > 0
    ) {
      uniformResourceSetMask |= 1 << source.textureBindingSetId;
    }
    const dag = execution.varying;
    const constantMask = execution.constantFields;
    const formulas = compileFixedSurfaceFormulas(surfaceProgram, source.lowered, execution.uniformRefs);
    const templateKey = JSON.stringify([
      Array.from(dag.instructions),
      Array.from(execution.publication.instructions),
      Array.from(execution.update.instructions),
      Array.from(execution.frameUpdate.instructions),
      formulas === null ? null : Array.from(formulas),
      source.program.inputs.map((input) => [input.width, appearanceGeometryInputKind(input, source.program)]),
      source.program.samples.map((sample) => [
        sample.binding.decode,
        sample.readMask,
        sample.binding.sampler
      ]),
      source.program.productReads?.map((read) => [read.field.width, read.field.constant === undefined])
    ]);
    let template = templates.get(templateKey);
    if (template === undefined) {
      for (let word = 0; word < FIXED_SURFACE_PLAN_WORDS; word++) {
        words.push(formulas?.[word] ?? 0);
      }
      const instructions = words.length;
      words.push(...dag.instructions);
      const update = words.length;
      words.push(...execution.update.instructions);
      const frameUpdate = words.length;
      words.push(...execution.frameUpdate.instructions);
      const publication = words.length;
      words.push(...execution.publication.instructions);
      template = { index: templates.size, instructions, update, frameUpdate, publication };
      templates.set(templateKey, template);
    }
    if (formulas === null && (dag.fieldMask & ~constantMask) !== 0) {
      generalTemplates[source.textureBindingSetId]!.add(template.index);
    }
    const instructions = template.instructions;
    const outputs = words.length;
    // Snapshot execution/export plan; immutable tapes belong to the template.
    words.push(
      template.update,
      execution.update.instructions.length / 8,
      execution.uniformWords,
      template.index,
      uniformBase + uniformWords,
      0,
      execution.constantOutputs.length / 4,
      0,
      0,
      closures.length,
      0
    );
    words[outputs + 5] = words.length;
    words.push(...execution.constantOutputs);
    words[outputs + 7] = words.length;
    frameRecords.push(words.length);
    words.push(
      template.frameUpdate,
      execution.frameUpdate.instructions.length / 8,
      0,
      template.publication,
      execution.publication.instructions.length / 8
    );
    const dependencies = new Set<number>();
    for (let at = 0; at < execution.update.instructions.length; at += 8) {
      const code = execution.update.instructions;
      const width = Math.max(1, code[at + 7]! >>> 28);
      if (code[at] === APPEARANCE_DAG_OPS.constant) {
        for (let component = 0; component < width; component++) {
          dependencies.add(source.constantBase + code[at + 6]! + component);
        }
      } else if (code[at] === APPEARANCE_DAG_OPS.input) {
        const channel = code[at + 7]! & 255;
        for (let component = 0; component < width; component++) {
          dependencies.add(-1 - ((source.inputBase + code[at + 6]!) * 4 + channel + component));
        }
      }
    }
    uniformDependencies.push([...dependencies]);
    hasFrameUniform ||= execution.frameUpdate.instructions.length > 0;
    uniformWords += execution.uniformWords;
    for (const word of dag.outputs) {
      words.push(word);
    }
    words[outputs + APPEARANCE_DAG_CLOSURES_OFFSET] = words.length;
    const closureDirectory = words.length;
    for (let word = 0; word < closures.length * APPEARANCE_CLOSURE_PLAN_WORDS; word++) {
      words.push(0);
    }
    for (let index = 0; index < closures.length; index++) {
      const closure = closures[index]!;
      const descriptor = [
        closure.handle,
        1 << closure.field,
        closure.keyWords,
        closure.valueWords,
        closure.geometryMask,
        closure.neighborMask,
        words.length,
        closure.reads.length / APPEARANCE_CLOSURE_READ_WORDS,
        0
      ];
      for (let word = 0; word < APPEARANCE_CLOSURE_PLAN_WORDS; word++) {
        words[closureDirectory + index * APPEARANCE_CLOSURE_PLAN_WORDS + word] = descriptor[word]!;
      }
      words.push(...closure.reads);
      // O(1) reads of Geometry-owned exact key inputs in the existing worker.
      // Index zero means an unused component, never a truncated dependency.
      const geometryReads = new Uint32Array(15 * 12);
      for (let read = 0; read < closure.reads.length; read += APPEARANCE_CLOSURE_READ_WORDS) {
        const semantic = closure.reads[read + 2]!;
        if (closure.reads[read] === 2 && semantic !== 0) {
          geometryReads[semantic * 12 + closure.reads[read + 3]! * 3 + closure.reads[read + 4]!] =
            2 + read / APPEARANCE_CLOSURE_READ_WORDS;
        }
      }
      words[closureDirectory + index * APPEARANCE_CLOSURE_PLAN_WORDS + 8] = words.length;
      words.push(...geometryReads);
    }
    const reads = source.program.productReads ?? [];
    const activeProducts = new Set<number>();
    const reached = new Set<number>();
    const pending = Object.values(surfaceProgram.outputs).flatMap((roots) => [...roots]);
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (reached.has(ref)) {
        continue;
      }
      reached.add(ref);
      const node = surfaceProgram.instructions[ref]!;
      pending.push(...node.args);
      if (node.sample !== undefined) {
        pending.push(...surfaceProgram.samples[node.sample]!.uv);
      }
      if (node.product !== undefined) {
        activeProducts.add(node.product);
        pending.push(...(reads[node.product]!.uv ?? []));
      }
    }
    const products = words.length;
    for (let word = 0; word < reads.length * APPEARANCE_DAG_PRODUCT_WORDS; word++) {
      words.push(0);
    }
    for (let index = 0; index < reads.length; index++) {
      const read = reads[index]!;
      if (!activeProducts.has(index) || read.field.constant !== undefined) {
        continue;
      }
      const key = `${read.asset.runtime.manifest.assetId}:${read.field.name}:${read.field.contentKey}`;
      let resident = productFields.get(key);
      if (resident === undefined) {
        resident = { offset: productBytes, field: read.field };
        productFields.set(key, resident);
        for (const mip of read.field.mips) {
          const padded = new Uint8Array(Math.ceil(mip.payload.byteLength / 4) * 4);
          padded.set(mip.payload);
          payloads.push(padded);
          productBytes += padded.byteLength;
        }
      }
      const mipBase = words.length;
      let byteOffset = resident.offset;
      for (const mip of read.field.mips) {
        words.push(byteOffset / 4, mip.width, mip.height, 0);
        byteOffset += Math.ceil(mip.payload.byteLength / 4) * 4;
      }
      const channels = read.field.width === 3 ? 4 : read.field.width;
      const base = products + index * APPEARANCE_DAG_PRODUCT_WORDS;
      const data = [
        mipBase,
        read.field.mips.length,
        channels,
        0,
        bits(read.asset.domainMin[0]),
        bits(read.asset.domainMin[1]),
        bits(1 / (read.asset.domainMax[0] - read.asset.domainMin[0])),
        bits(1 / (read.asset.domainMax[1] - read.asset.domainMin[1])),
        read.field.width,
        0,
        0,
        0
      ];
      for (let word = 0; word < data.length; word++) {
        words[base + word] = data[word]!;
      }
    }
    const lit = Number((dag.fieldMask & ((1 << 2) | (1 << 3) | (1 << 6) | (1 << 7))) !== 0);
    // Admit one exact closure even when sibling fields remain varying. The
    // cache record has one value payload; residual fields stay on the same
    // direct recipe and are evaluated while request Geometry is live. This
    // keeps one writer/value authority while extending admission beyond the
    // single-missing-field fixture.
    const missingFields = dag.fieldMask & ~constantMask;
    let candidate = -1;
    let bestSavings = 0;
    for (let index = 0; index < closures.length; index++) {
      const closure = closures[index]!;
      // Five read-record loads, the value read, xor and multiply per key word.
      // These compiler weights include payload but do not prove GPU net gain.
      const keyReadCost = closure.keyWords * 8 + closure.valueWords;
      // Apply the existing expensive-work boundary to work that actually
      // disappears. Shared texture/ALU ancestors remain on the direct recipe.
      if ((missingFields & (1 << closure.field)) === 0 || closure.valueWords > 4 ||
          closure.keyWords > APPEARANCE_CACHE_KEY_WORDS ||
          closure.exclusiveOperationCost <= Math.max(12, keyReadCost)) {
        continue;
      }
      const savings = closure.exclusiveOperationCost / closure.keyWords;
      if (savings > bestSavings) {
        candidate = index;
        bestSavings = savings;
      }
    }
    if (candidate !== -1) {
      words[outputs + APPEARANCE_DAG_CACHE_CLOSURE] =
        closureDirectory + candidate * APPEARANCE_CLOSURE_PLAN_WORDS;
      cacheCandidateCount++;
    }
    // A published execution domain is an equality-backed structural recipe,
    // not a value/cache identity. Each entry retains its own numeric input and
    // resource addresses. Many coverage refs/samples may consume one recipe.
    const domain = [
      source.domainHandle ?? 0,
      dag.fieldMask,
      constantMask,
      dag.geometryMask,
      dag.neighborMask,
      lit === 0 ? 0 : 63,
      source.textureBindingSetId,
      8
    ];
    const domainKey = JSON.stringify(domain);
    let domainId = domainIds.get(domainKey);
    if (domainId === undefined) {
      domainId = domains.length;
      domainIds.set(domainKey, domainId);
      domains.push(domain);
    }
    const header = [
      instructions,
      dag.instructions.length / 8,
      outputs,
      dag.outputs.length / 4,
      dag.liveWords,
      source.constantBase,
      source.routeBase,
      source.inputBase,
      source.textureBindingSetId,
      products,
      dag.geometryMask,
      dag.neighborMask,
      dag.fieldMask,
      (constantMask | (formulas === null ? 0 : FIXED_SURFACE_FLAG)) >>> 0,
      domainId,
      lit
    ];
    for (let word = 0; word < APPEARANCE_DAG_ENTRY_WORDS; word++) {
      words[entry * APPEARANCE_DAG_ENTRY_WORDS + word] = header[word]!;
    }
    liveWords = Math.max(
      liveWords,
      dag.liveWords,
      execution.publication.liveWords,
      execution.update.liveWords,
      execution.frameUpdate.liveWords
    );
  }
  const uniformFlagBase = uniformBase + uniformWords;
  for (let entry = 0; entry < frameRecords.length; entry++) {
    words[frameRecords[entry]! + 2] = uniformFlagBase + entry;
  }
  const domainBase = words.length;
  for (const domain of domains) {
    words.push(...domain);
  }
  for (let entry = 0; entry < sources.length; entry++) {
    words[entry * APPEARANCE_DAG_ENTRY_WORDS + 14] =
      domainBase + words[entry * APPEARANCE_DAG_ENTRY_WORDS + 14]! * 8;
  }
  if (
    words.length * 4 > maximumBindingBytes ||
    productBytes > productBankBytes * APPEARANCE_DAG_PRODUCT_BANKS
  ) {
    throw new RangeError("Complete Appearance DAG publication exceeds negotiated code/product storage");
  }
  const products = Array.from({ length: APPEARANCE_DAG_PRODUCT_BANKS }, (_, bank) => {
    const size = Math.max(4, Math.min(productBankBytes, productBytes - bank * productBankBytes));
    return new Uint32Array(Math.ceil(size / 4));
  });
  let byteOffset = 0;
  for (const payload of payloads) {
    let consumed = 0;
    while (consumed < payload.byteLength) {
      const bank = Math.floor(byteOffset / (bankWords * 4));
      const offset = byteOffset % (bankWords * 4);
      const bytes = Math.min(payload.byteLength - consumed, bankWords * 4 - offset);
      new Uint8Array(products[bank]!.buffer).set(payload.subarray(consumed, consumed + bytes), offset);
      consumed += bytes;
      byteOffset += bytes;
    }
  }
  return Object.freeze({
    workPlans: Object.freeze(workPlans),
    closurePlans: Object.freeze(closurePlans),
    closureCount: closureInterner.size,
    cacheCandidateCount,
    uniformResourceSetMask,
    code: Uint32Array.from(words),
    products: Object.freeze(products),
    productBankWords: bankWords,
    liveWords,
    domainCount: domains.length,
    domainBase,
    uniformWords: uniformWords + sources.length,
    uniformDependencies: Object.freeze(uniformDependencies.map((values) => Object.freeze(values))),
    uniformFlagBase,
    hasFrameUniform,
    coherenceSetMask: generalTemplates.reduce(
      (mask, values, set) => mask | (Number(values.size > 1) << set),
      0
    ),
    templateCount: templates.size
  });
}
