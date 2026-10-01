import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { lowerAppearanceWgsl } from "./appearance_program.js";
import { appearancePageLayout } from "../gpu/GpuAppearanceCacheAbi.js";
import type { AppearanceKernelIntegration } from "./appearance_resident_kernel.js";

export interface AppearanceCacheField {
  readonly name: string; readonly bit: number; readonly fieldIndex: number;
  readonly outputs: readonly number[]; readonly inputWords: readonly number[];
  readonly base: number; readonly cells: number; readonly stride: number; readonly valueWord: number;
}
export interface AppearanceCachePlan {
  readonly fields: readonly AppearanceCacheField[];
  readonly words: number; readonly inputVectors: number; readonly outputCount: number;
  readonly outputBits: Readonly<Record<string, number>>;
}

/** Cache admission is a compiler decision. Simple source/constant/product reads
 * never allocate pages. Expensive dynamic local roots retain exact f32 inputs
 * and explicit footprints, without interpolating nonlinear outputs. */
export function appearanceCachePlan(program: CompiledAppearanceGraph, inputVectors: number, pagesPerField: number): AppearanceCachePlan {
  const lowered = lowerAppearanceWgsl(program), fields: AppearanceCacheField[] = [];
  const bits: Record<string, number> = {};
  let words = 0;
  Object.entries(program.outputs).forEach(([name, roots], fieldIndex) => {
    if (fieldIndex >= 31) throw new RangeError("Appearance program exceeds the finite field mask");
    const bit = 2 ** fieldIndex; bits[name] = bit;
    const live = new Set<number>(), inputs = new Set<number>(), pending = [...roots];
    let localDynamic = false, perTarget = false;
    for (const root of roots) {
      const product = program.products.find(product => product.instruction === root);
      localDynamic ||= product?.kind === "dynamic-cache-program";
      perTarget ||= product?.kind === "per-target";
    }
    while (pending.length) {
      const ref = pending.pop()!; if (live.has(ref)) continue;
      live.add(ref); const node = program.instructions[ref]!;
      if (node.kind === "input") {
        const index = program.inputs.findIndex(input => input.name === node.input);
        inputs.add(index * 4 + node.channel!);
      }
      if (node.sample !== undefined) for (let i = 0; i < 8; i++) inputs.add((program.inputs.length + node.sample * 2) * 4 + i);
      if (node.product !== undefined) {
        const reads = program.productReads ?? [];
        let sample = program.samples.length;
        for (let i = 0; i < node.product; i++) if (!reads[i]!.field.constant) sample++;
        if (!reads[node.product]!.field.constant) for (let i = 0; i < 8; i++) inputs.add((program.inputs.length + sample * 2) * 4 + i);
      }
      pending.push(...node.args);
    }
    const signature = [...inputs].sort((a, b) => a - b);
    const layout = appearancePageLayout(Math.ceil(signature.length / 4), roots.length, pagesPerField);
    const cells = localDynamic && !perTarget ? layout.samples : 0;
    // Signature is tightly packed; array padding is not part of identity.
    const valueWord = 8 + signature.length, stride = valueWord + roots.length;
    fields.push(Object.freeze({ name, bit, fieldIndex, outputs: lowered.outputSlots[name]!, inputWords: signature,
      base: words, cells, stride, valueWord }));
    words += cells * stride;
  });
  return Object.freeze({ fields, words: Math.max(words, 4), inputVectors, outputCount: lowered.outputCount, outputBits: bits });
}

/** request -> nominate -> publish -> evaluate -> consume. Valid cache values
 * touched by request cannot be evicted in this frame. Candidate election uses
 * atomicMin over a task index; collisions keep one owner and direct-evaluate
 * the rest. No CAS spin, partially published identity or GPU/CPU control. */
export function appearanceCacheIntegration(plan: AppearanceCachePlan): AppearanceKernelIntegration {
  const { fields } = plan;
  const cached = fields.filter(field => field.cells > 0);
  const declarations = /* wgsl */ `
struct AppearanceRoute { identity: vec4u, uv: vec4f, rotation: vec4f, fallback: vec4f }
struct AppearanceCacheSettings { task_capacity: u32, bucket: u32, frame: u32, max_age: u32 }
@group(0) @binding(0) var<storage, read> appearance_constants: array<f32>;
@group(0) @binding(1) var<storage, read> appearance_routes: array<AppearanceRoute>;
@group(0) @binding(2) var<storage, read> appearance_tasks: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> appearance_inputs: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> appearance_outputs: array<f32>;
@group(0) @binding(5) var<uniform> cache_settings: AppearanceCacheSettings;
@group(0) @binding(6) var<storage, read_write> appearance_cache: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> appearance_requests: array<u32>;
@group(0) @binding(8) var<storage, read> appearance_fields: array<vec4u>;
// count, prefix, scatter cursor, indirect X for each program/resource bucket.
@group(0) @binding(9) var<storage, read> appearance_buckets: array<vec4u>;
// material slot, field base, input base, reserved, in scattered task order.
@group(0) @binding(10) var<storage, read> appearance_metadata: array<vec4u>;
@group(0) @binding(11) var<storage, read> appearance_task_program: array<u32>;
var<private> appearance_task: vec4u;
var<private> appearance_missing: u32;
fn appearance_constant(index: u32) -> f32 { return appearance_constants[appearance_task.x + index]; }
fn appearance_input(index: u32, channel: u32) -> f32 { return appearance_inputs[appearance_task.z + index][channel]; }
fn appearance_flat_task(group: vec3u, lane: u32) -> u32 {
  return (group.y * appearance_buckets[2u + cache_settings.bucket * 2u].w + group.x) * 64u + lane;
}
fn appearance_task_index(local: u32) -> u32 { return appearance_buckets[2u + cache_settings.bucket * 2u].y + local; }
fn appearance_task_count() -> u32 { return appearance_buckets[2u + cache_settings.bucket * 2u].x; }
fn appearance_word(task: u32, word: u32) -> u32 {
  return bitcast<u32>(appearance_inputs[appearance_tasks[task].z + word / 4u][word & 3u]);
}
fn appearance_hash(h: u32, word: u32) -> u32 { return (h ^ word) * 16777619u; }
${cached.map(field => /* wgsl */ `
fn field_${field.fieldIndex}_hash(task: u32) -> u32 {
  let meta = appearance_metadata[task];
  var hash = appearance_hash(2166136261u, meta.x);
  hash = appearance_hash(hash, appearance_fields[meta.y + ${field.fieldIndex}u].x);
${field.inputWords.map(word => `  hash = appearance_hash(hash, appearance_word(task, ${word}u));`).join("\n")}
  return hash;
}
fn field_${field.fieldIndex}_equal(task: u32, cell: u32) -> bool {
  let at = ${field.base}u + cell * ${field.stride}u;
  let meta = appearance_metadata[task];
  if atomicLoad(&appearance_cache[at]) == 0u || atomicLoad(&appearance_cache[at + 1u]) != meta.x ||
    atomicLoad(&appearance_cache[at + 2u]) != appearance_fields[meta.y + ${field.fieldIndex}u].x { return false; }
${field.inputWords.map((word, index) => `  if atomicLoad(&appearance_cache[at + ${8 + index}u]) != appearance_word(task, ${word}u) { return false; }`).join("\n")}
  return true;
}
fn field_${field.fieldIndex}_lookup(task: u32) -> u32 {
  let set = (field_${field.fieldIndex}_hash(task) & ${field.cells / 4 - 1}u) * 4u;
  for (var way = 0u; way < 4u; way++) {
    let cell = set + way;
    if field_${field.fieldIndex}_equal(task, cell) { return cell; }
  }
  return 0xffffffffu;
}`).join("\n")}
`;
  const common = (name: string, body: string) => /* wgsl */ `
@compute @workgroup_size(64)
fn ${name}(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let local = appearance_flat_task(group, lane);
  if local >= appearance_task_count() { return; }
  let task = appearance_task_index(local);
  appearance_task = appearance_tasks[task];
  ${body}
}
`;
  const reset = /* wgsl */ `
@compute @workgroup_size(64)
fn cache_reset(@builtin(global_invocation_id) id: vec3u) {
  let cell = id.x + id.y * 64u * 65535u;
${cached.map(field => `  if cell < ${field.cells}u { atomicStore(&appearance_cache[${field.base}u + cell * ${field.stride}u + 4u], 0xffffffffu); }`).join("\n")}
}
`;
  const request = common("cache_request", cached.map(field => /* wgsl */ `
  let hit_${field.fieldIndex} = field_${field.fieldIndex}_lookup(task);
  appearance_requests[task * ${cached.length}u + ${cached.indexOf(field)}u] = hit_${field.fieldIndex};
  if hit_${field.fieldIndex} != 0xffffffffu {
    atomicMax(&appearance_cache[${field.base}u + hit_${field.fieldIndex} * ${field.stride}u + 3u], cache_settings.frame);
  }
`).join("\n"));
  const nominate = common("cache_nominate", cached.map(field => /* wgsl */ `
  if appearance_requests[task * ${cached.length}u + ${cached.indexOf(field)}u] == 0xffffffffu {
    let set = (field_${field.fieldIndex}_hash(task) & ${field.cells / 4 - 1}u) * 4u;
    var candidate = 0xffffffffu; var oldest = 0xffffffffu;
    for (var way = 0u; way < 4u; way++) {
      let cell = set + way; let at = ${field.base}u + cell * ${field.stride}u;
      let age = atomicLoad(&appearance_cache[at + 3u]);
      if age < cache_settings.frame && age < oldest { candidate = cell; oldest = age; }
    }
    if candidate != 0xffffffffu { atomicMin(&appearance_cache[${field.base}u + candidate * ${field.stride}u + 4u], task); }
  }
`).join("\n"));
  const publish = /* wgsl */ `
@compute @workgroup_size(64)
fn cache_publish(@builtin(global_invocation_id) id: vec3u) {
  let cell = id.x + id.y * 64u * 65535u;
${cached.map(field => /* wgsl */ `
  if cell < ${field.cells}u {
    let at = ${field.base}u + cell * ${field.stride}u;
    let owner = atomicLoad(&appearance_cache[at + 4u]);
    if owner != 0xffffffffu {
      let meta = appearance_metadata[owner];
      atomicStore(&appearance_cache[at], 2u);
      atomicStore(&appearance_cache[at + 1u], meta.x);
      atomicStore(&appearance_cache[at + 2u], appearance_fields[meta.y + ${field.fieldIndex}u].x);
      atomicStore(&appearance_cache[at + 3u], cache_settings.frame);
${field.inputWords.map((word, index) => `      atomicStore(&appearance_cache[at + ${8 + index}u], appearance_word(owner, ${word}u));`).join("\n")}
    } else if cache_settings.frame - atomicLoad(&appearance_cache[at + 3u]) > cache_settings.max_age {
      atomicStore(&appearance_cache[at], 0u);
    }
  }
`).join("\n")}
}
`;
  const evaluate = common("cache_evaluate", `
  appearance_missing = 0u;
${fields.map(field => field.cells === 0 ? `  appearance_missing |= ${field.bit}u;` : /* wgsl */ `
  let cell_${field.fieldIndex} = field_${field.fieldIndex}_lookup(task);
  appearance_requests[task * ${cached.length}u + ${cached.indexOf(field)}u] = cell_${field.fieldIndex};
  if cell_${field.fieldIndex} == 0xffffffffu ||
    atomicLoad(&appearance_cache[${field.base}u + cell_${field.fieldIndex} * ${field.stride}u + 4u]) == task { appearance_missing |= ${field.bit}u; }
`).join("\n")}
  if appearance_missing != 0u {
    let value = appearance_evaluate();
${fields.map(field => /* wgsl */ `
    if (appearance_missing & ${field.bit}u) != 0u {
${field.outputs.map(output => `      appearance_outputs[appearance_task.w + ${output}u] = value[${output}];`).join("\n")}
${field.cells === 0 ? "" : /* wgsl */ `
      if cell_${field.fieldIndex} != 0xffffffffu {
        let at = ${field.base}u + cell_${field.fieldIndex} * ${field.stride}u;
${field.outputs.map((output, index) => `        atomicStore(&appearance_cache[at + ${field.valueWord + index}u], bitcast<u32>(value[${output}]));`).join("\n")}
        atomicStore(&appearance_cache[at], 1u);
      }`}
    }
`).join("\n")}
  }
`);
  const consume = common("cache_consume", cached.map(field => /* wgsl */ `
  let cell_${field.fieldIndex} = appearance_requests[task * ${cached.length}u + ${cached.indexOf(field)}u];
  if cell_${field.fieldIndex} != 0xffffffffu {
    let at = ${field.base}u + cell_${field.fieldIndex} * ${field.stride}u;
${field.outputs.map((output, index) => `    appearance_outputs[appearance_task.w + ${output}u] = bitcast<f32>(atomicLoad(&appearance_cache[at + ${field.valueWord + index}u]));`).join("\n")}
  }
`).join("\n"));
  const visibility = GPUShaderStage.COMPUTE;
  const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
  return Object.freeze({ declarations, outputBits: plan.outputBits, entryPoint: "cache_evaluate",
    entrySource: cached.length ? reset + request + nominate + publish + evaluate + consume : evaluate,
    groups: [[...Array.from({ length: 12 }, (_, binding) => buffer(binding,
      binding === 5 ? "uniform" : [3, 4, 6, 7].includes(binding) ? "storage" : "read-only-storage"))]] });
}
