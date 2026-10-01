import type { ShadeTexture } from "../texture/ShadeTexture.js";

/** Device-independent numeric IR. No GPU objects or frame scheduling live here. */
export type AppearanceWidth = 1 | 2 | 3 | 4;
export type AppearanceRef = number;
export type AppearanceInputDomain = "surface" | "geometry" | "dynamic" | "view" | "nonlocal";
export type AppearanceDecode = "srgb-rgb" | "linear-rgb" | "linear-alpha";
export type AppearanceBinaryOp = "add" | "subtract" | "multiply" | "divide" | "min" | "max" | "pow";
export type AppearanceUnaryOp = "sin" | "cos" | "abs" | "sqrt";
export type AppearanceOp = AppearanceBinaryOp | AppearanceUnaryOp | "mix" | "clamp";
export interface AppearanceRange { readonly low: number; readonly high: number }
export const APPEARANCE_F32_MAX = 3.4028234663852886e38;
export const APPEARANCE_FINITE_RANGE: AppearanceRange = Object.freeze({
  low: -APPEARANCE_F32_MAX, high: APPEARANCE_F32_MAX
});

export interface AppearanceTextureBinding {
  /** Resource reference for publication; numeric/sampling state below is a snapshot. */
  readonly texture: ShadeTexture;
  readonly source: object;
  readonly contentVersion: string | null;
  readonly decode: AppearanceDecode;
  readonly sampler: readonly number[];
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  readonly fallback: readonly [number, number, number, number];
  /** Source publication guarantees finite texels; tighter bounds enable exact elision. */
  readonly range: AppearanceRange;
}

export function snapshotAppearanceTexture(texture: ShadeTexture, decode: AppearanceDecode,
  offset: readonly [number, number] = [0, 0], scale: readonly [number, number] = [1, 1],
  rotation = 0, range: AppearanceRange = APPEARANCE_FINITE_RANGE,
  fallback: readonly [number, number, number, number] = [1, 1, 1, 1]): AppearanceTextureBinding {
  const rawVersion = texture.appearance_content_version;
  if (rawVersion !== undefined && (typeof rawVersion !== "string" || rawVersion.length === 0)) throw new RangeError("Appearance raw content version must be nonempty");
  return Object.freeze({ texture, source: texture.runtime_asset_package_v2 ?? texture.image ?? texture,
    contentVersion: texture.runtime_asset_package_v2 === undefined ? rawVersion === undefined ? null : `raw:${rawVersion}` :
      `asset:${texture.runtime_asset_package_v2.runtime.manifest.assetId}`,
    decode, sampler: Object.freeze([texture.flags, texture.minFilter, texture.magFilter,
      texture.mipmapFilter, texture.wrapS, texture.wrapT, texture.wrapR, texture.dimensions,
      texture.mipmapGenerationFilter]),
    offset: Object.freeze([...offset]) as readonly [number, number],
    scale: Object.freeze([...scale]) as readonly [number, number], rotation,
    fallback: Object.freeze([...fallback]) as readonly [number, number, number, number],
    range: Object.freeze({ ...range }) });
}

interface AppearanceNodeBase { readonly width: AppearanceWidth }
export type AppearanceNode =
  | (AppearanceNodeBase & { readonly kind: "constant"; readonly value: readonly number[] })
  | (AppearanceNodeBase & { readonly kind: "parameter"; readonly name: string;
      readonly value: readonly number[]; readonly range: AppearanceRange })
  | (AppearanceNodeBase & { readonly kind: "input"; readonly name: string;
      readonly domain: AppearanceInputDomain; readonly coordinateDomain?: string;
      readonly range: AppearanceRange })
  | (AppearanceNodeBase & { readonly kind: "texture"; readonly uv: AppearanceRef;
      readonly binding: AppearanceTextureBinding })
  | (AppearanceNodeBase & { readonly kind: "swizzle"; readonly source: AppearanceRef;
      readonly channels: readonly number[] })
  | (AppearanceNodeBase & { readonly kind: "combine"; readonly sources: readonly AppearanceRef[] })
  | (AppearanceNodeBase & { readonly kind: "operation"; readonly op: AppearanceOp;
      readonly args: readonly AppearanceRef[] });

export interface AppearanceGraph {
  readonly nodes: readonly AppearanceNode[];
  readonly outputs: Readonly<Record<string, AppearanceRef>>;
}

/** Authoring/lowering helper. Validation occurs once at compilation/publication. */
export class AppearanceGraphBuilder {
  private readonly nodes: AppearanceNode[] = [];
  private readonly outputs: Record<string, AppearanceRef> = Object.create(null);

  constant(value: number | readonly number[]): AppearanceRef {
    const values = typeof value === "number" ? [value] : [...value];
    return this.push({ kind: "constant", width: values.length as AppearanceWidth,
      value: Object.freeze(values) });
  }

  /** Publication-time material data with stable provenance, never a shader literal. */
  parameter(name: string, value: number | readonly number[],
    range: AppearanceRange = APPEARANCE_FINITE_RANGE): AppearanceRef {
    const values = typeof value === "number" ? [value] : [...value];
    return this.push({ kind: "parameter", name, width: values.length as AppearanceWidth,
      value: Object.freeze(values), range: Object.freeze({ ...range }) });
  }

  input(name: string, width: AppearanceWidth, domain: AppearanceInputDomain,
    range: AppearanceRange = APPEARANCE_FINITE_RANGE, coordinateDomain?: string): AppearanceRef {
    return this.push({ kind: "input", name, width, domain, coordinateDomain,
      range: Object.freeze({ ...range }) });
  }

  texture(binding: AppearanceTextureBinding, uv: AppearanceRef): AppearanceRef {
    return this.push({ kind: "texture", width: 4, binding, uv });
  }

  swizzle(source: AppearanceRef, channels: readonly number[]): AppearanceRef {
    return this.push({ kind: "swizzle", width: channels.length as AppearanceWidth,
      source, channels: Object.freeze([...channels]) });
  }

  combine(...sources: AppearanceRef[]): AppearanceRef {
    const width = sources.reduce((sum, source) => sum + this.nodes[source]!.width, 0);
    return this.push({ kind: "combine", width: width as AppearanceWidth,
      sources: Object.freeze(sources) });
  }

  operation(op: AppearanceOp, ...args: AppearanceRef[]): AppearanceRef {
    const width = Math.max(...args.map(arg => this.nodes[arg]!.width)) as AppearanceWidth;
    return this.push({ kind: "operation", width, op, args: Object.freeze(args) });
  }

  output(name: string, ref: AppearanceRef): void { this.outputs[name] = ref; }

  build(): AppearanceGraph {
    return Object.freeze({ nodes: Object.freeze([...this.nodes]),
      outputs: Object.freeze({ ...this.outputs }) });
  }

  private push(node: AppearanceNode): AppearanceRef {
    this.nodes.push(Object.freeze(node));
    return this.nodes.length - 1;
  }
}

export function appearanceNodeArguments(node: AppearanceNode): readonly AppearanceRef[] {
  switch (node.kind) {
    case "texture": return [node.uv];
    case "swizzle": return [node.source];
    case "combine": return node.sources;
    case "operation": return node.args;
    default: return [];
  }
}

/** f32 scalar semantics shared by constant evaluation and the CPU program oracle. */
export function evaluateAppearanceOperation(op: AppearanceOp, args: readonly number[]): number {
  const [a, b, c] = args as readonly [number, number, number];
  const f = Math.fround;
  switch (op) {
    case "add": return f(a + b);
    case "subtract": return f(a - b);
    case "multiply": return f(a * b);
    case "divide": return f(a / b);
    case "min": return Math.min(a, b);
    case "max": return Math.max(a, b);
    case "pow": return f(Math.pow(a, b));
    case "sin": return f(Math.sin(a));
    case "cos": return f(Math.cos(a));
    case "abs": return Math.abs(a);
    case "sqrt": return f(Math.sqrt(a));
    case "clamp": return Math.min(Math.max(a, b), c);
    case "mix": return f(f(a * f(1 - c)) + f(b * c));
  }
}
