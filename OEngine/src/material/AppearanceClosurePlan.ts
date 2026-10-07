import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import type { AppearanceExecutionPlan } from "./ExactAppearanceDag.js";
import type { AppearanceWgslProgram } from "../shaders/appearance_program.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { APPEARANCE_ROUTE_STRIDE } from "../shaders/appearance_resident_kernel.js";

/** Each record reads one exact u32 from the current producer. Geometry points
 * are C, X and Y, never quantized coordinates or derivative classes. */
export const APPEARANCE_CLOSURE_READ = Object.freeze({
  constant: 0,
  uniform: 1,
  input: 2,
  route: 3,
  routeIdentity: 4,
});
export const APPEARANCE_CLOSURE_READ_WORDS = 5;
export const APPEARANCE_CLOSURE_KEY_PREFIX_WORDS = 2;

export interface AppearanceClosurePlan {
  /** Equality-interned descriptor, local to its immutable publication namespace. */
  readonly handle: number;
  readonly field: number;
  readonly valueWords: number;
  readonly keyWords: number;
  /** kind, local index, geometry semantic, channel, C/X/Y point. */
  readonly reads: Uint32Array;
  readonly geometryMask: number;
  readonly neighborMask: number;
  /** Work removed on a hit after subtracting all sibling consumers. Compiler
   * weights select candidates; a real OFF/ON check still proves net benefit. */
  readonly exclusiveOperationCost: number;
  readonly exclusiveTextureQueries: number;
}

/** Publication-local identity. The complete descriptor is compared by Map;
 * object identity distinguishes immutable resource products within this owner.
 * No hash, material count or camera epoch can stand in for value equality. */
export class AppearanceClosureInterner {
  private readonly descriptors = new Map<string, number>();
  private readonly objects = new WeakMap<object, number>();
  private objectCount = 0;

  intern(descriptor: string): number {
    const found = this.descriptors.get(descriptor);
    if (found !== undefined) {
      return found;
    }
    if (this.descriptors.size >= 0xfffffffe) {
      throw new RangeError("Appearance closure namespace exhausted");
    }
    const handle = this.descriptors.size + 1;
    this.descriptors.set(descriptor, handle);
    return handle;
  }

  objectIdentity(value: object): number {
    const found = this.objects.get(value);
    if (found !== undefined) {
      return found;
    }
    const handle = ++this.objectCount;
    this.objects.set(value, handle);
    return handle;
  }

  get size(): number {
    return this.descriptors.size;
  }
}

/** Exact Closure Cache Publication's compiler boundary. Operation weights only
 * select candidates; runtime capacity/admission still decides whether to reuse.
 * Constant/uniform and ordinary Product/cheap work retain their direct recipes.
 * No key is truncated here: a profile that cannot hold it must run direct. */
export function compileAppearanceClosurePlans(
  program: CompiledAppearanceGraph,
  lowered: AppearanceWgslProgram,
  execution: AppearanceExecutionPlan,
  interner: AppearanceClosureInterner,
  routeIdentityBase?: number,
): readonly AppearanceClosurePlan[] {
  const result: AppearanceClosurePlan[] = [];
  const float = new DataView(new ArrayBuffer(4));
  const bits = (value: number): number => {
    float.setFloat32(0, value, true);
    return float.getUint32(0, true);
  };
  const coordinates = (ref: number): readonly number[] => {
    const node = program.instructions[ref]!;
    if (node.sample !== undefined) {
      return program.samples[node.sample]!.uv;
    }
    if (node.product !== undefined) {
      return program.productReads![node.product!]!.uv ?? [];
    }
    return [];
  };

  for (const field of execution.workPlan.fields) {
    if (field.category !== "expensive-sample") {
      continue;
    }
    const siblingDependencies = new Set<number>();
    const siblingQueries = new Set<number>();
    for (const sibling of execution.workPlan.fields) {
      if (sibling.field === field.field || sibling.frequency < 3) {
        continue;
      }
      sibling.dependencies.forEach((ref) => siblingDependencies.add(ref));
      sibling.textureQueries.forEach((query) => siblingQueries.add(query));
    }
    let exclusiveOperationCost = 0;
    const exclusiveTextures = new Set<number>();
    const exclusiveProducts = new Set<number>();
    for (const ref of field.dependencies) {
      if (siblingDependencies.has(ref) || execution.uniformRefs.has(ref)) {
        continue;
      }
      const node = program.instructions[ref]!;
      if (node.sample !== undefined && !siblingQueries.has(node.sample) && !exclusiveTextures.has(node.sample)) {
        exclusiveTextures.add(node.sample);
        exclusiveOperationCost += 4;
      } else if (node.product !== undefined && !exclusiveProducts.has(node.product)) {
        exclusiveProducts.add(node.product);
        exclusiveOperationCost += node.kind === "normal-product" ? 12 : 4;
      } else if (node.kind === "operation") {
        exclusiveOperationCost += ["pow", "sin", "cos", "sqrt"].includes(node.op!) ? 8 : 1;
      }
    }
    // Canonical postorder follows operand order, not authored instruction IDs.
    // Explicit coordinate edges are retained even for substituted Products.
    const local = new Map<number, number>();
    const ordered: number[] = [];
    const stack = field.roots
      .slice()
      .reverse()
      .map((ref) => ({ ref, finish: false }));
    while (stack.length > 0) {
      const visit = stack.pop()!;
      if (local.has(visit.ref)) {
        continue;
      }
      if (!visit.finish) {
        stack.push({ ref: visit.ref, finish: true });
        const dependencies = [...program.instructions[visit.ref]!.args, ...coordinates(visit.ref)];
        for (let index = dependencies.length - 1; index >= 0; index--) {
          stack.push({ ref: dependencies[index]!, finish: false });
        }
      } else {
        local.set(visit.ref, ordered.length);
        ordered.push(visit.ref);
      }
    }

    // Stop dynamic key traversal at the already published exact uniform value.
    // A source query may require neighbor coordinates even for a center sink.
    const points = new Map<number, number>();
    const pending = field.roots.map((ref) => ({ ref, mask: 1 }));
    while (pending.length > 0) {
      const { ref, mask } = pending.pop()!;
      const previous = points.get(ref) ?? 0;
      if ((previous | mask) === previous) {
        continue;
      }
      points.set(ref, previous | mask);
      if (execution.uniformRefs.has(ref)) {
        continue;
      }
      for (const arg of program.instructions[ref]!.args) {
        pending.push({ ref: arg, mask });
      }
      for (const arg of coordinates(ref)) {
        pending.push({ ref: arg, mask: 7 });
      }
    }

    const reads: number[] = [];
    const nodes: unknown[] = [];
    const resources = new Set<number>();
    let geometryMask = 0;
    let neighborMask = 0;
    const read = (kind: number, index: number, semantic = 0, channel = 0, point = 0): void => {
      reads.push(kind, index, semantic, channel, point);
    };
    for (const ref of ordered) {
      const node = program.instructions[ref]!;
      const uniform = execution.uniformRefs.get(ref);
      const pointMask = points.get(ref) ?? 0;
      let identity: unknown;
      switch (node.kind) {
        case "constant": {
          identity = [node.kind, bits(node.value!)];
          break;
        }
        case "parameter": {
          identity = [node.kind, node.parameter, node.channel];
          if (pointMask !== 0 && uniform === undefined) {
            read(APPEARANCE_CLOSURE_READ.constant, lowered.instructionConstantSlots[ref]!);
          }
          break;
        }
        case "input": {
          const index = program.inputs.findIndex((input) => input.name === node.input);
          const input = program.inputs[index]!;
          const semantic = appearanceGeometryInputKind(input, program);
          identity = [node.kind, input.name, input.width, input.domain, semantic, node.channel];
          if (pointMask !== 0 && uniform === undefined) {
            for (let point = 0; point < 3; point++) {
              if ((pointMask & (1 << point)) !== 0) {
                read(APPEARANCE_CLOSURE_READ.input, index, semantic, node.channel!, point);
              }
            }
            if (semantic !== 0) {
              geometryMask |= 1 << semantic;
              if ((pointMask & 6) !== 0) {
                neighborMask |= 1 << semantic;
              }
            }
          }
          break;
        }
        case "texture": {
          const sample = program.samples[node.sample!]!;
          const binding = sample.binding;
          identity = [
            node.kind,
            node.channel,
            interner.objectIdentity(binding.source),
            binding.contentVersion,
            binding.decode,
            binding.sampler,
            [...binding.offset, ...binding.scale, binding.rotation, ...binding.fallback].map(bits),
          ];
          // Include the complete current route even when a uniform subgraph has
          // absorbed the query. Residency/content changes never alias old keys.
          if (!resources.has(node.sample!)) {
            resources.add(node.sample!);
            if (routeIdentityBase !== undefined) {
              read(APPEARANCE_CLOSURE_READ.routeIdentity, routeIdentityBase + node.sample!);
            } else {
              for (let word = 0; word < APPEARANCE_ROUTE_STRIDE / 4; word++) {
                read(APPEARANCE_CLOSURE_READ.route, node.sample!, 0, word);
              }
            }
          }
          break;
        }
        case "product":
        case "normal-product": {
          const product = program.productReads![node.product!]!;
          identity = [
            node.kind,
            node.channel,
            interner.objectIdentity(product.field),
            product.field.width,
            product.field.contentKey,
            [...product.asset.domainMin, ...product.asset.domainMax].map(bits),
            product.field.constant === undefined ? null : product.field.constant.map(bits),
          ];
          break;
        }
        case "operation": {
          identity = [node.kind, node.op];
          break;
        }
      }
      if (pointMask !== 0 && uniform !== undefined) {
        read(APPEARANCE_CLOSURE_READ.uniform, uniform);
      }
      nodes.push([
        identity,
        node.args.map((arg) => local.get(arg)!),
        coordinates(ref).map((arg) => local.get(arg)!),
        node.coordinateDomains,
        uniform !== undefined,
      ]);
    }
    const descriptor = JSON.stringify([
      "exact-closure-f32-cxy-v1",
      nodes,
      field.roots.map((ref) => local.get(ref)!),
      // Read addresses are instance-local. Their semantic shape is immutable.
      reads.filter((_value, index) => index % APPEARANCE_CLOSURE_READ_WORDS !== 1),
    ]);
    result.push(
      Object.freeze({
        handle: interner.intern(descriptor),
        field: field.field,
        valueWords: field.roots.length,
        keyWords: APPEARANCE_CLOSURE_KEY_PREFIX_WORDS + reads.length / APPEARANCE_CLOSURE_READ_WORDS,
        reads: Uint32Array.from(reads),
        geometryMask,
        neighborMask,
        exclusiveOperationCost,
        exclusiveTextureQueries: exclusiveTextures.size,
      }),
    );
  }
  return Object.freeze(result);
}
