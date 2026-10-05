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
});
export const APPEARANCE_DAG_INSTRUCTION_WORDS = 8;
export const APPEARANCE_DAG_OUTPUT_WORDS = 4;
export const APPEARANCE_DAG_POINT_BYTES = 16;

export interface ExactAppearanceDag {
  readonly instructions: Uint32Array;
  /** field, channel, live slot, output mask; absent fields have no records. */
  readonly outputs: Uint32Array;
  readonly liveSlots: number;
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
}

/** Publication-time liveness over the COMPLETE graph. One lane owns its whole
 * live range. Center-only values occupy one vec4; sampled C/X/Y use three.
 * Union field masks include texture/product coordinates, including nested reads.
 * No node, input, output or coordinate count is truncated. */
export function compileExactAppearanceDag(
  program: CompiledAppearanceGraph,
  constants: AppearanceWgslProgram,
): ExactAppearanceDag {
  const masks = new Uint32Array(program.instructions.length);
  const neighbors = new Uint8Array(program.instructions.length);
  const mark = (ref: number, mask: number, neighbor: boolean): void => {
    if (!Number.isInteger(ref) || ref < 0 || ref >= program.instructions.length) {
      throw new RangeError("Exact Appearance DAG has an invalid instruction reference");
    }
    const previous = masks[ref]!;
    const previousNeighbor = neighbors[ref]!;
    masks[ref] = previous | mask;
    neighbors[ref] = previousNeighbor | Number(neighbor);
    if (previous === masks[ref] && previousNeighbor === neighbors[ref]) {
      return;
    }
    const node = program.instructions[ref]!;
    for (const arg of node.args) {
      if (arg >= ref) {
        throw new RangeError("Exact Appearance DAG must be topologically ordered");
      }
      mark(arg, mask, neighbor);
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
      mark(arg, mask, true);
    }
  };
  let fieldMask = 0;
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length; field++) {
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
  const lowered: LoweredInstruction[] = [];
  const refs = new Int32Array(program.instructions.length).fill(-1);
  const samples = new Map<string, number>();
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
    const instruction: LoweredInstruction = {
      op: 0,
      inputs: [],
      auxiliary: 0,
      channel: 0,
      mask: masks[ref]!,
      points: neighbors[ref]!,
      width: 1,
    };
    if (node.kind === "constant" || node.kind === "parameter") {
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
          auxiliary: index,
          channel: 0,
          mask: 0,
          points: 0,
          width: 3,
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
          sampleInstruction.inputs = [];
          sampleInstruction.channel = constants.productConstantSlots[index]![0]! + 1;
        }
        // Reserve only points actually read. Their coordinate ancestors still
        // retain C/X/Y so the original textureSampleGrad footprint is exact.
        sampleInstruction.width = sampleInstruction.points !== 0 ? 3 : 1;
        sample = emit(sampleInstruction);
        samples.set(key, sample);
      }
      instruction.op =
        node.kind === "normal-product" ? APPEARANCE_DAG_OPS.normal : APPEARANCE_DAG_OPS.channel;
      instruction.inputs = [sample];
      instruction.channel = node.channel!;
    } else {
      instruction.op = APPEARANCE_DAG_OPS[node.op!];
      instruction.inputs = node.args.map((arg) => refs[arg]!);
    }
    refs[ref] = emit(instruction);
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
  const outputs: number[] = [];
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length; field++) {
    const roots = program.outputs[APPEARANCE_FIELD_NAMES[field]!] ?? [];
    for (let channel = 0; channel < roots.length; channel++) {
      const ref = refs[roots[channel]!]!;
      finalUse[ref] = lowered.length;
      outputs.push(field, channel, ref, 1 << field);
    }
  }
  const slots = new Uint32Array(lowered.length);
  const occupied: boolean[] = [];
  const packed = new Uint32Array(lowered.length * APPEARANCE_DAG_INSTRUCTION_WORDS);
  let liveSlots = 0;
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
    liveSlots = Math.max(liveSlots, slot + node.width);
    const inputs = node.op === APPEARANCE_DAG_OPS.input ? node.inputs : node.inputs.map((arg) => slots[arg]!);
    packed.set(
      [
        node.op,
        slot,
        inputs[0] ?? 0,
        inputs[1] ?? 0,
        inputs[2] ?? 0,
        node.mask,
        node.auxiliary,
        node.channel | (node.points << 16),
      ],
      ref * APPEARANCE_DAG_INSTRUCTION_WORDS,
    );
    // Release AFTER this instruction's write: destination never aliases an
    // input while three sample points are still being consumed.
    for (let previous = 0; previous <= ref; previous++) {
      if (finalUse[previous] === ref || (previous === ref && finalUse[previous] === -1)) {
        for (let word = 0; word < lowered[previous]!.width; word++) {
          occupied[slots[previous]! + word] = false;
        }
      }
    }
  }
  for (let at = 2; at < outputs.length; at += APPEARANCE_DAG_OUTPUT_WORDS) {
    outputs[at] = slots[outputs[at]!]!;
  }
  return Object.freeze({
    instructions: packed,
    outputs: Uint32Array.from(outputs),
    liveSlots: Math.max(1, liveSlots),
    geometryMask,
    fieldMask,
    neighborMask,
  });
}

/** Bound concurrency by real live ranges; reducing lanes never reduces work. */
export function planExactAppearanceLanes(
  liveSlots: number,
  storageLimit: number,
  requestedLanes = 4096,
): Readonly<{ lanes: number; stride: number; bytes: number }> {
  if (
    ![liveSlots, storageLimit, requestedLanes].every(Number.isSafeInteger) ||
    liveSlots < 1 ||
    storageLimit < 1 ||
    requestedLanes < 1
  ) {
    throw new RangeError("Invalid Exact Appearance scratch capacity");
  }
  const stride = liveSlots * APPEARANCE_DAG_POINT_BYTES;
  const lanes = Math.min(requestedLanes, Math.floor(storageLimit / stride));
  if (lanes < 1 || !Number.isSafeInteger(stride)) {
    throw new RangeError("Complete Appearance DAG cannot fit one lane in negotiated storage");
  }
  return Object.freeze({ lanes, stride, bytes: lanes * stride });
}
