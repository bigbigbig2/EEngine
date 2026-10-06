import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import type { AppearanceWgslProgram } from "../shaders/appearance_program.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";

/** Local exact scalar-IR execution. These opcodes are data, never PSO keys. */
export const APPEARANCE_DAG_OPS = Object.freeze({
  constant: 0,
  input: 1,
  sample: 2,
  product: 3,
  channel: 4,
  normal: 5,
  add: 6,
  subtract: 7,
  multiply: 8,
  divide: 9,
  min: 10,
  max: 11,
  pow: 12,
  sin: 13,
  cos: 14,
  abs: 15,
  sqrt: 16,
  mix: 17,
  clamp: 18,
  constantProduct: 19,
  fieldSink: 20,
  uniformLoad: 21,
  uniformSink: 22,
  normalDecode: 23,
  decodedChannel: 24
});
export const APPEARANCE_DAG_INSTRUCTION_WORDS = 8;
export const APPEARANCE_DAG_OUTPUT_WORDS = 4;
export const APPEARANCE_DAG_WORD_BYTES = 4;

export interface ExactAppearanceDag {
  readonly instructions: Uint32Array;
  /** field, channel, producer word, output mask. Values are consumed by sinks. */
  readonly outputs: Uint32Array;
  readonly liveWords: number;
  readonly geometryMask: number;
  readonly fieldMask: number;
  readonly neighborMask: number;
}

interface LoweredInstruction {
  op: number;
  inputs: number[];
  auxiliary: number;
  channel: number;
  mask: number;
  points: number;
  width: number;
  semanticWidth?: number;
  components?: number[];
  broadcasts?: number;
}

interface TapeStage {
  readonly uniformRefs: ReadonlyMap<number, number>;
  readonly update: boolean;
  readonly uniformLoads?: ReadonlyMap<number, number>;
}

export interface AppearanceExecutionPlan {
  readonly workPlan: AppearanceWorkPlan;
  readonly uniformRefs: ReadonlyMap<number, number>;
  readonly varying: ExactAppearanceDag;
  readonly publication: ExactAppearanceDag;
  readonly update: ExactAppearanceDag;
  readonly frameUpdate: ExactAppearanceDag;
  readonly uniformWords: number;
  readonly constantFields: number;
  /** field/channel/uniform-word/mask: complete publication output mapping. */
  readonly constantOutputs: Uint32Array;
}

/** Complete query dependencies classify work; template bins do not identify values. */
export interface AppearanceWorkPlan {
  readonly fields: readonly AppearanceFieldWork[];
  readonly nodeFrequencies: Uint8Array;
  readonly uniformTextureQueries: Uint32Array;
  readonly sampleTextureQueries: Uint32Array;
  readonly uniformProductQueries: Uint32Array;
  readonly sampleProductQueries: Uint32Array;
}

export interface AppearanceFieldWork {
  readonly field: number;
  readonly roots: readonly number[];
  /** Complete topological closure, including resource coordinates. */
  readonly dependencies: Uint32Array;
  readonly frequency: number;
  readonly textureQueries: Uint32Array;
  readonly productQueries: Uint32Array;
  readonly parameters: readonly string[];
  readonly inputs: readonly string[];
  /** Compiler operation weights, not measured GPU time or cache admission. */
  readonly estimatedOperationCost: number;
  readonly category: "update" | "cheap-sample" | "product-domain" | "expensive-sample";
  readonly value: "uniform" | "product-indexed" | "sample-indexed";
  /** Numeric/frame edits update the matching tape; immutable content/route edits republish. */
  readonly invalidation: readonly ("publication" | "material" | "frame" | "residency")[];
  readonly fallback: "complete-direct";
}

/** SF10 dependency/stack organization, extended locally with exact GPU uniform
 * boundaries. Only values crossing update→sample or update→output persist. */
export function compileAppearanceExecutionPlan(
  program: CompiledAppearanceGraph,
  constants: AppearanceWgslProgram
): AppearanceExecutionPlan {
  // Frequencies are dependency unions: publication, material, frame, sample.
  // Coordinate ancestors participate just like arithmetic operands.
  const frequency = new Uint8Array(program.instructions.length);
  const required = new Uint8Array(program.instructions.length);
  const dependencies = (ref: number): readonly number[] => {
    const node = program.instructions[ref]!;
    const uv =
      node.sample !== undefined
        ? program.samples[node.sample]!.uv
        : node.product !== undefined
          ? program.productReads![node.product!]!.uv
          : null;
    return [...node.args, ...(uv ?? [])];
  };
  const pending = Object.values(program.outputs).flatMap((roots) => [...roots]);
  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (required[ref] !== 0) {
      continue;
    }
    required[ref] = 1;
    pending.push(...dependencies(ref));
  }
  for (let ref = 0; ref < program.instructions.length; ref++) {
    const node = program.instructions[ref]!;
    let rate = node.kind === "parameter" ? 1 : 0;
    if (
      node.kind === "texture" ||
      ((node.kind === "product" || node.kind === "normal-product") &&
        program.productReads![node.product!]!.field.constant === undefined)
    ) {
      // Contents/routes are update dependencies. Complete coordinate ancestors
      // below promote spatial queries to sample-rate, including their CXY.
      rate = 1;
    } else if (node.kind === "input") {
      const input = program.inputs.find((value) => value.name === node.input);
      if (input === undefined) {
        throw new RangeError("Appearance uniform classification has an unpublished input");
      }
      const semantic = appearanceGeometryInputKind(input, program);
      rate = semantic === 0 ? 1 : semantic === 9 ? 2 : 3;
    }
    for (const arg of dependencies(ref)) {
      rate = Math.max(rate, frequency[arg]!);
    }
    frequency[ref] = rate;
  }
  const fields: AppearanceFieldWork[] = [];
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length; field++) {
    const roots = program.outputs[APPEARANCE_FIELD_NAMES[field]!];
    if (roots === undefined) continue;
    const closure = new Set<number>();
    const pending = [...roots];
    const textures = new Set<number>(),
      products = new Set<number>();
    const parameters = new Set<string>(),
      inputs = new Set<string>();
    let cost = 0,
      rate = 0;
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (closure.has(ref)) continue;
      closure.add(ref);
      const node = program.instructions[ref]!;
      rate = Math.max(rate, frequency[ref]!);
      const newQuery =
        node.sample !== undefined
          ? !textures.has(node.sample)
          : node.product !== undefined
            ? !products.has(node.product)
            : false;
      if (node.sample !== undefined) textures.add(node.sample);
      if (node.product !== undefined) products.add(node.product);
      if (node.parameter !== undefined) parameters.add(node.parameter);
      if (node.input !== undefined) inputs.add(node.input);
      cost +=
        node.kind === "texture" || node.kind === "product" || node.kind === "normal-product"
          ? Number(newQuery) * (node.kind === "normal-product" ? 12 : 4)
          : node.kind !== "operation"
            ? 0
            : ["pow", "sin", "cos", "sqrt"].includes(node.op!)
              ? 8
              : 1;
      pending.push(...dependencies(ref));
    }
    const productValue = roots.every((ref) =>
      ["product", "normal-product"].includes(program.instructions[ref]!.kind)
    );
    const invalidation: ("publication" | "material" | "frame" | "residency")[] = ["publication"];
    if ([...closure].some((ref) => frequency[ref] === 1)) invalidation.push("material");
    if ([...closure].some((ref) => frequency[ref] === 2)) invalidation.push("frame");
    if (textures.size > 0) invalidation.push("residency");
    fields.push(
      Object.freeze({
        field,
        roots,
        dependencies: Uint32Array.from([...closure].sort((a, b) => a - b)),
        frequency: rate,
        textureQueries: Uint32Array.from(textures),
        productQueries: Uint32Array.from(products),
        parameters: Object.freeze([...parameters]),
        inputs: Object.freeze([...inputs]),
        estimatedOperationCost: cost,
        category:
          rate < 3
            ? "update"
            : productValue
              ? "product-domain"
              : cost <= 12
                ? "cheap-sample"
                : "expensive-sample",
        value: rate < 3 ? "uniform" : productValue ? "product-indexed" : "sample-indexed",
        invalidation: Object.freeze(invalidation),
        fallback: "complete-direct"
      })
    );
  }
  const boundaries = new Map<number, number>();
  const keep = (ref: number): void => {
    if (!boundaries.has(ref)) {
      boundaries.set(ref, boundaries.size);
    }
  };
  for (let ref = 0; ref < program.instructions.length; ref++) {
    if (required[ref] === 0 || frequency[ref]! < 1) {
      continue;
    }
    for (const arg of dependencies(ref)) {
      if (frequency[arg]! < frequency[ref]!) {
        keep(arg);
      }
    }
  }
  // Unauthored fields retain the publication palette's semantic defaults.
  let constantFields = APPEARANCE_FIELD_NAMES.reduce(
    (mask, name, field) => (program.outputs[name] === undefined ? mask | (1 << field) : mask),
    0
  );
  const outputs: number[] = [];
  for (const { field, roots, value } of fields) {
    if (value === "uniform") {
      constantFields |= 1 << field;
      for (let channel = 0; channel < roots.length; channel++) {
        const ref = roots[channel]!;
        keep(ref);
        outputs.push(field, channel, boundaries.get(ref)!, 1 << field);
      }
    }
  }
  const publication = new Map([...boundaries].filter(([ref]) => frequency[ref] === 0));
  const material = new Map([...boundaries].filter(([ref]) => frequency[ref] === 1));
  const frame = new Map([...boundaries].filter(([ref]) => frequency[ref] === 2));
  const uniformTextures = new Set<number>();
  const sampleTextures = new Set<number>();
  const uniformProducts = new Set<number>();
  const sampleProducts = new Set<number>();
  for (let ref = 0; ref < program.instructions.length; ref++) {
    if (required[ref] === 0) {
      continue;
    }
    const node = program.instructions[ref]!;
    if (node.sample !== undefined) {
      (frequency[ref]! < 3 ? uniformTextures : sampleTextures).add(node.sample);
    }
    if (node.product !== undefined && program.productReads![node.product!]!.field.constant === undefined) {
      (frequency[ref]! < 3 ? uniformProducts : sampleProducts).add(node.product);
    }
  }
  return Object.freeze({
    workPlan: Object.freeze({
      fields: Object.freeze(fields),
      nodeFrequencies: frequency,
      uniformTextureQueries: Uint32Array.from(uniformTextures),
      sampleTextureQueries: Uint32Array.from(sampleTextures),
      uniformProductQueries: Uint32Array.from(uniformProducts),
      sampleProductQueries: Uint32Array.from(sampleProducts)
    }),
    uniformRefs: boundaries,
    varying: compileExactAppearanceDag(program, constants, { uniformRefs: boundaries, update: false }),
    publication: compileExactAppearanceDag(program, constants, { uniformRefs: publication, update: true }),
    update: compileExactAppearanceDag(program, constants, {
      uniformRefs: material,
      uniformLoads: publication,
      update: true
    }),
    frameUpdate: compileExactAppearanceDag(program, constants, {
      uniformRefs: frame,
      uniformLoads: new Map([...publication, ...material]),
      update: true
    }),
    uniformWords: boundaries.size,
    constantFields,
    constantOutputs: Uint32Array.from(outputs)
  });
}

/** Publication-time liveness over the COMPLETE graph. One context owns its whole
 * live range. Scalars occupy one/three f32 words; samples occupy four/twelve.
 * Union field masks include texture/product coordinates, including nested reads.
 * No node, input, output or coordinate count is truncated. */
export function compileExactAppearanceDag(
  program: CompiledAppearanceGraph,
  constants: AppearanceWgslProgram,
  stage?: TapeStage
): ExactAppearanceDag {
  const masks = new Uint32Array(program.instructions.length);
  const neighbors = new Uint8Array(program.instructions.length);
  const pendingRefs: number[] = [];
  const pendingPoints: number[] = [];
  const mark = (root: number, mask: number, neighbor: boolean): void => {
    pendingRefs.push(root);
    pendingPoints.push(Number(neighbor));
    while (pendingRefs.length > 0) {
      const ref = pendingRefs.pop()!;
      const point = pendingPoints.pop()!;
      if (!Number.isInteger(ref) || ref < 0 || ref >= program.instructions.length) {
        throw new RangeError("Exact Appearance DAG has an invalid instruction reference");
      }
      const previous = masks[ref]!;
      const previousNeighbor = neighbors[ref]!;
      masks[ref] = previous | mask;
      neighbors[ref] = previousNeighbor | point;
      if (previous === masks[ref] && previousNeighbor === neighbors[ref]) {
        continue;
      }
      if (
        stage !== undefined &&
        ((!stage.update && stage.uniformRefs.has(ref)) || stage.uniformLoads?.has(ref))
      ) {
        continue;
      }
      const node = program.instructions[ref]!;
      for (const arg of node.args) {
        if (arg >= ref) {
          throw new RangeError("Exact Appearance DAG must be topologically ordered");
        }
        pendingRefs.push(arg);
        pendingPoints.push(point);
      }
      const uv =
        node.sample !== undefined
          ? program.samples[node.sample]?.uv
          : node.product !== undefined
            ? program.productReads?.[node.product]?.uv
            : null;
      for (const arg of uv ?? []) {
        if (arg >= ref) {
          throw new RangeError("Exact Appearance coordinate DAG must be topologically ordered");
        }
        pendingRefs.push(arg);
        pendingPoints.push(1);
      }
    }
  };
  let fieldMask = 0;
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length && !stage?.update; field++) {
    const roots = program.outputs[APPEARANCE_FIELD_NAMES[field]!];
    if (roots === undefined) {
      continue;
    }
    if (roots.length !== APPEARANCE_FIELD_WIDTHS[field]) {
      throw new RangeError("Exact Appearance field width differs from its consumer ABI");
    }
    const bit = 1 << field;
    fieldMask |= bit;
    for (const ref of roots) {
      mark(ref, bit, false);
    }
  }
  if (stage?.update) {
    for (const ref of stage.uniformRefs.keys()) {
      mark(ref, 0x80000000, false);
    }
  }
  const uniformLoads = stage?.update ? stage.uniformLoads : stage?.uniformRefs;
  const lowered: LoweredInstruction[] = [];
  const refs = new Int32Array(program.instructions.length).fill(-1);
  const components = new Uint8Array(program.instructions.length);
  const samples = new Map<string, number>();
  const decodedNormals = new Map<number, number>();
  let geometryMask = 0;
  let neighborMask = 0;
  const emit = (instruction: LoweredInstruction): number => {
    const ref = lowered.length;
    lowered.push(instruction);
    return ref;
  };
  for (let ref = 0; ref < program.instructions.length; ref++) {
    if (masks[ref] === 0) {
      continue;
    }
    const node = program.instructions[ref]!;
    let semanticWidth = 1;
    let broadcasts = 0;
    const uniform = uniformLoads?.has(ref) === true;
    for (let width = 2; width <= 4 && ref + width <= program.instructions.length; width++) {
      const candidate = program.instructions[ref + width - 1]!;
      if (masks[ref + width - 1] === 0 || neighbors[ref + width - 1] !== neighbors[ref]) {
        break;
      }
      const candidateUniform = uniformLoads?.has(ref + width - 1) === true;
      let compatible = false;
      let broadcastMask = 0;
      if (uniform && candidateUniform) {
        compatible = uniformLoads!.get(ref + width - 1) === uniformLoads!.get(ref)! + width - 1;
      } else if (!uniform && !candidateUniform && node.kind === "input" && candidate.kind === "input") {
        compatible = node.input === candidate.input && candidate.channel === node.channel! + width - 1;
      } else if (
        !uniform &&
        !candidateUniform &&
        (node.kind === "constant" || node.kind === "parameter") &&
        (candidate.kind === "constant" || candidate.kind === "parameter")
      ) {
        compatible =
          constants.instructionConstantSlots[ref + width - 1] ===
          constants.instructionConstantSlots[ref]! + width - 1;
      } else if (
        !uniform &&
        !candidateUniform &&
        node.kind === "operation" &&
        candidate.kind === "operation" &&
        candidate.op === node.op &&
        candidate.args.length === node.args.length
      ) {
        compatible = true;
        for (let arg = 0; arg < node.args.length; arg++) {
          const first = node.args[arg]!;
          const producer = refs[first]!;
          let allSame = true;
          let consecutive = true;
          for (let channel = 1; channel < width; channel++) {
            const operand = program.instructions[ref + channel]!.args[arg]!;
            allSame &&= operand === first;
            consecutive &&=
              refs[operand] === producer && components[operand] === components[first]! + channel;
          }
          if (allSame) {
            broadcastMask |= 1 << arg;
          } else if (!consecutive) {
            compatible = false;
          }
        }
      }
      if (!compatible) {
        break;
      }
      semanticWidth = width;
      broadcasts = broadcastMask;
    }
    const instruction: LoweredInstruction = {
      op: 0,
      inputs: [],
      auxiliary: 0,
      channel: 0,
      mask: masks[ref]!,
      points: neighbors[ref]!,
      width: 1,
      semanticWidth,
      broadcasts
    };
    for (let channel = 1; channel < semanticWidth; channel++) {
      instruction.mask |= masks[ref + channel]!;
    }
    if (
      stage !== undefined &&
      ((!stage.update && stage.uniformRefs.has(ref)) || stage.uniformLoads?.has(ref))
    ) {
      instruction.op = APPEARANCE_DAG_OPS.uniformLoad;
      instruction.auxiliary = uniformLoads!.get(ref)!;
    } else if (node.kind === "constant" || node.kind === "parameter") {
      instruction.op = APPEARANCE_DAG_OPS.constant;
      instruction.auxiliary = constants.instructionConstantSlots[ref]!;
    } else if (node.kind === "input") {
      instruction.op = APPEARANCE_DAG_OPS.input;
      const index = program.inputs.findIndex((input) => input.name === node.input);
      const input = program.inputs[index];
      if (input === undefined) {
        throw new RangeError("Exact Appearance input is unpublished");
      }
      instruction.auxiliary = index;
      instruction.channel = node.channel!;
      const kind = appearanceGeometryInputKind(input, program);
      instruction.inputs = [kind]; // Published semantic, not a live-slot reference.
      if (kind !== 0) {
        geometryMask |= 1 << kind;
        if (neighbors[ref] !== 0) {
          neighborMask |= 1 << kind;
        }
      }
    } else if (node.kind === "texture" || node.kind === "product" || node.kind === "normal-product") {
      const product = node.kind !== "texture";
      const index = product ? node.product! : node.sample!;
      const key = `${product ? "product" : "texture"}:${index}`;
      let sample = samples.get(key);
      if (sample === undefined) {
        const uv = product ? program.productReads![index]!.uv : program.samples[index]!.uv;
        const constant = product ? program.productReads![index]!.field.constant : undefined;
        const sampleInstruction: LoweredInstruction = {
          op: product ? APPEARANCE_DAG_OPS.product : APPEARANCE_DAG_OPS.sample,
          inputs: (uv ?? []).map((arg) => refs[arg]!),
          components: (uv ?? []).map((arg) => components[arg]!),
          auxiliary: index,
          channel: 0,
          mask: 0,
          points: 0,
          width: 3
        };
        for (let other = ref; other < program.instructions.length; other++) {
          const candidate = program.instructions[other]!;
          const matches = product ? candidate.product === index : candidate.sample === index;
          if (matches) {
            sampleInstruction.mask |= masks[other]!;
            sampleInstruction.points |= neighbors[other]!;
          }
        }
        if (constant !== undefined) {
          sampleInstruction.op = APPEARANCE_DAG_OPS.constantProduct;
          sampleInstruction.inputs = [];
          sampleInstruction.auxiliary = constants.productConstantSlots[index]![0]!;
          sampleInstruction.channel = program.productReads![index]!.field.width;
        }
        // Reserve only points actually read. Their coordinate ancestors still
        // retain C/X/Y so the original textureSampleGrad footprint is exact.
        sampleInstruction.width = sampleInstruction.points !== 0 ? 12 : 4;
        sample = emit(sampleInstruction);
        samples.set(key, sample);
      }
      if (node.kind === "normal-product") {
        let decoded = decodedNormals.get(index);
        if (decoded === undefined) {
          let mask = 0;
          let points = 0;
          for (let other = ref; other < program.instructions.length; other++) {
            const candidate = program.instructions[other]!;
            if (candidate.kind === "normal-product" && candidate.product === index) {
              mask |= masks[other]!;
              points |= neighbors[other]!;
            }
          }
          decoded = emit({
            op: APPEARANCE_DAG_OPS.normalDecode,
            inputs: [sample],
            auxiliary: 0,
            channel: 0,
            mask,
            points,
            width: points !== 0 ? 15 : 5
          });
          decodedNormals.set(index, decoded);
        }
        instruction.op = APPEARANCE_DAG_OPS.decodedChannel;
        instruction.inputs = [decoded];
      } else {
        instruction.op = APPEARANCE_DAG_OPS.channel;
        instruction.inputs = [sample];
      }
      instruction.channel = node.channel!;
    } else {
      instruction.op = APPEARANCE_DAG_OPS[node.op!];
      instruction.inputs = node.args.map((arg) => refs[arg]!);
      instruction.components = node.args.map((arg) => components[arg]!);
    }
    instruction.width = semanticWidth * (instruction.points !== 0 ? 3 : 1);
    const producer = emit(instruction);
    for (let channel = 0; channel < semanticWidth; channel++) {
      refs[ref + channel] = producer;
      components[ref + channel] = channel;
    }
    ref += semanticWidth - 1;
  }
  // Complete field tuples are exported as soon as all components exist. Their
  // internal users still participate in last-use; a sink does not kill a value.
  const sinkGroups = new Map<number, LoweredInstruction[]>();
  const outputRecords: number[][] = [];
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length && !stage?.update; field++) {
    const roots = program.outputs[APPEARANCE_FIELD_NAMES[field]!] ?? [];
    if (roots.length === 0) {
      continue;
    }
    const producers = roots.map((root) => refs[root]!);
    const position = Math.max(...producers);
    let group = sinkGroups.get(position);
    if (group === undefined) {
      group = [];
      sinkGroups.set(position, group);
    }
    for (let channel = 0; channel < producers.length; channel++) {
      group.push({
        op: APPEARANCE_DAG_OPS.fieldSink,
        inputs: [producers[channel]!],
        components: [components[roots[channel]!]!],
        auxiliary: field,
        channel,
        mask: 1 << field,
        points: 0,
        width: 0
      });
      outputRecords.push([field, channel, producers[channel]!, 1 << field, components[roots[channel]!]!]);
    }
  }
  if (stage?.update) {
    for (const [ref, address] of stage.uniformRefs) {
      const position = refs[ref]!;
      let group = sinkGroups.get(position);
      if (group === undefined) {
        group = [];
        sinkGroups.set(position, group);
      }
      group.push({
        op: APPEARANCE_DAG_OPS.uniformSink,
        inputs: [position],
        components: [components[ref]!],
        auxiliary: address,
        channel: 0,
        mask: 0x80000000,
        points: 0,
        width: 0
      });
    }
  }
  const original = lowered.splice(0);
  const relocated = new Uint32Array(original.length);
  for (let ref = 0; ref < original.length; ref++) {
    const node = original[ref]!;
    if (node.op !== APPEARANCE_DAG_OPS.input) {
      node.inputs = node.inputs.map((input) => relocated[input]!);
    }
    relocated[ref] = lowered.length;
    lowered.push(node);
    for (const sink of sinkGroups.get(ref) ?? []) {
      sink.inputs = sink.inputs.map((input) => relocated[input]!);
      lowered.push(sink);
    }
  }
  const finalUse = new Int32Array(lowered.length).fill(-1);
  for (let ref = 0; ref < lowered.length; ref++) {
    const node = lowered[ref]!;
    if (node.op === APPEARANCE_DAG_OPS.input) {
      continue;
    }
    for (const arg of node.inputs) {
      if (arg < 0 || arg >= ref) {
        throw new RangeError("Exact Appearance liveness references an unavailable producer");
      }
      finalUse[arg] = ref;
    }
  }
  const outputs = outputRecords.flatMap(([field, channel, ref, mask]) => [
    field!,
    channel!,
    relocated[ref!]!,
    mask!
  ]);
  // Each producer expires once. Do not rescan every earlier instruction at
  // every allocation: long legal graphs must not have quadratic release work.
  const releaseHeads = new Int32Array(lowered.length).fill(-1);
  const releaseNext = new Int32Array(lowered.length).fill(-1);
  for (let producer = 0; producer < lowered.length; producer++) {
    if (lowered[producer]!.width === 0) {
      continue;
    }
    const at = finalUse[producer] === -1 ? producer : finalUse[producer]!;
    releaseNext[producer] = releaseHeads[at]!;
    releaseHeads[at] = producer;
  }
  const slots = new Uint32Array(lowered.length);
  const occupied: boolean[] = [];
  const packed = new Uint32Array(lowered.length * APPEARANCE_DAG_INSTRUCTION_WORDS);
  let liveWords = 0;
  for (let ref = 0; ref < lowered.length; ref++) {
    const node = lowered[ref]!;
    let slot = 0;
    while (true) {
      let free = true;
      for (let word = 0; word < node.width; word++) {
        free &&= occupied[slot + word] !== true;
      }
      if (free) {
        break;
      }
      slot++;
    }
    slots[ref] = slot;
    for (let word = 0; word < node.width; word++) {
      occupied[slot + word] = true;
    }
    liveWords = Math.max(liveWords, slot + node.width);
    const inputs =
      node.op === APPEARANCE_DAG_OPS.input
        ? node.inputs
        : node.inputs.map((arg, operand) => slots[arg]! + (node.components?.[operand] ?? 0));
    let control =
      node.channel | (node.points << 16) | ((node.semanticWidth ?? 1) << 28) | ((node.broadcasts ?? 0) << 8);
    if (node.op !== APPEARANCE_DAG_OPS.input) {
      for (let operand = 0; operand < node.inputs.length; operand++) {
        const producer = lowered[node.inputs[operand]!]!;
        const stride =
          producer.op === APPEARANCE_DAG_OPS.sample ||
          producer.op === APPEARANCE_DAG_OPS.product ||
          producer.op === APPEARANCE_DAG_OPS.constantProduct
            ? 4
            : producer.op === APPEARANCE_DAG_OPS.normalDecode
              ? 5
              : (producer.semanticWidth ?? 1);
        control |= (stride - 1) << (18 + operand * 3);
      }
    }
    packed.set(
      [
        node.op,
        slot,
        inputs[0] ?? 0,
        inputs[1] ?? 0,
        inputs[2] ?? 0,
        node.mask,
        node.auxiliary,
        control >>> 0
      ],
      ref * APPEARANCE_DAG_INSTRUCTION_WORDS
    );
    // Release AFTER this instruction's write: destination never aliases an
    // input while three sample points are still being consumed.
    for (let previous = releaseHeads[ref]!; previous >= 0; previous = releaseNext[previous]!) {
      for (let word = 0; word < lowered[previous]!.width; word++) {
        occupied[slots[previous]! + word] = false;
      }
    }
  }
  for (let at = 2; at < outputs.length; at += APPEARANCE_DAG_OUTPUT_WORDS) {
    outputs[at] = slots[outputs[at]!]! + outputRecords[(at - 2) / APPEARANCE_DAG_OUTPUT_WORDS]![4]!;
  }
  return Object.freeze({
    instructions: packed,
    outputs: Uint32Array.from(outputs),
    liveWords: Math.max(1, liveWords),
    geometryMask,
    fieldMask,
    neighborMask
  });
}

/** Bound concurrency by real live ranges; reducing lanes never reduces work. */
export function planExactAppearanceLanes(
  liveWords: number,
  storageLimit: number,
  requestedLanes = 4096
): Readonly<{ lanes: number; stride: number; bytes: number }> {
  if (
    ![liveWords, storageLimit, requestedLanes].every(Number.isSafeInteger) ||
    liveWords < 1 ||
    storageLimit < 1 ||
    requestedLanes < 1
  ) {
    throw new RangeError("Invalid Exact Appearance scratch capacity");
  }
  const stride = liveWords * APPEARANCE_DAG_WORD_BYTES;
  const lanes = Math.min(requestedLanes, Math.floor(storageLimit / stride));
  if (lanes < 1 || !Number.isSafeInteger(stride)) {
    throw new RangeError("Complete Appearance DAG cannot fit one lane in negotiated storage");
  }
  return Object.freeze({ lanes, stride, bytes: lanes * stride });
}
