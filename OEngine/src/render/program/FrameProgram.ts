import { shadingProgramUsesTextures } from "../../gpu/GpuShadingProgramAbi.js";

/** The finite set of products with real Module A producers and consumers. */
export type FrameProduct =
  | "swapchain" | "reconstructed-color" | "aerial-radiance" | "sky-radiance"
  | "surface-radiance" | "surface-motion" | "shading-work"
  | "visibility" | "depth" | "meshlet-work" | "hzb";

export type FrameProgramStage =
  | "clear-present" | "visibility" | "hzb" | "shading-work" | "light-cluster"
  | "surface" | "physical-sky" | "aerial" | "fsr3" | "present";

export type FrameProductFact = Readonly<{
  product: FrameProduct;
  producer: FrameProgramStage;
  consumers: readonly (FrameProgramStage | "canvas")[];
  domain: "internal-full" | "internal-half" | "output-full" | "gpu-work";
  extent: readonly [number, number] | null;
  format: GPUTextureFormat | "structured-buffer";
  value: string;
  coverage: string;
  invalid: string;
  version: "frame" | "history-role";
}>;

type FrameProgramBase = Readonly<{
  intent: "present";
  viewFamily: "main";
  outputWidth: number;
  outputHeight: number;
  outputFormat: GPUTextureFormat;
  /** One negotiated device epoch; all feature/limit choices are immutable inside it. */
  capabilityProfile: string;
}>;

export type FrameProgramRequest = FrameProgramBase & (
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "scene";
      internalWidth: number;
      internalHeight: number;
      virtualGeometry: boolean;
      virtualBankCount: number;
      previousHzb: boolean;
      currentHzbLateRecheck: boolean;
      activeClasses: readonly number[];
      textureBankMasks: readonly number[];
      physicalEnvironment: boolean;
    }>
);

export type FrameProgram = Readonly<{
  request: FrameProgramRequest;
  key: string;
  products: readonly FrameProduct[];
  facts: readonly FrameProductFact[];
  stages: readonly FrameProgramStage[];
  bindingRoles: readonly string[];
  directLighting: boolean;
  buildHzb: boolean;
}>;

const PRODUCT_SPEC: Readonly<Record<FrameProduct, Readonly<{
  producer: FrameProgramStage;
  domain: FrameProductFact["domain"];
  format: FrameProductFact["format"];
  value: string;
  coverage: string;
  invalid: string;
  version: FrameProductFact["version"];
}>>> = Object.freeze({
  swapchain: { producer: "present", domain: "output-full", format: "bgra8unorm",
    value: "display color", coverage: "full output", invalid: "clear color", version: "frame" },
  "reconstructed-color": { producer: "fsr3", domain: "output-full", format: "rgba16float",
    value: "working-linear pre-exposed", coverage: "full output", invalid: "history reset", version: "history-role" },
  "aerial-radiance": { producer: "aerial", domain: "internal-full", format: "rgba16float",
    value: "working-linear pre-exposed", coverage: "full internal", invalid: "surface fallback", version: "frame" },
  "sky-radiance": { producer: "physical-sky", domain: "internal-full", format: "rgba16float",
    value: "working-linear pre-exposed", coverage: "background plus surface", invalid: "surface fallback", version: "frame" },
  "surface-radiance": { producer: "surface", domain: "internal-full", format: "rgba16float",
    value: "working-linear pre-exposed", coverage: "full internal", invalid: "clear color", version: "frame" },
  "surface-motion": { producer: "surface", domain: "internal-full", format: "rg16float",
    value: "current-minus-previous UV", coverage: "visible surface", invalid: "zero background", version: "frame" },
  "shading-work": { producer: "shading-work", domain: "gpu-work", format: "structured-buffer",
    value: "bounded GPU work records", coverage: "visible surface", invalid: "queue count zero", version: "frame" },
  visibility: { producer: "visibility", domain: "internal-full", format: "r32uint",
    value: "packed VisibilityKey", coverage: "visible geometry", invalid: "background sentinel", version: "frame" },
  depth: { producer: "visibility", domain: "internal-full", format: "depth32float",
    value: "reverse depth", coverage: "visible geometry", invalid: "depth clear", version: "frame" },
  "meshlet-work": { producer: "visibility", domain: "gpu-work", format: "structured-buffer",
    value: "bounded GPU MeshletWork", coverage: "candidate geometry", invalid: "queue count zero", version: "frame" },
  hzb: { producer: "hzb", domain: "internal-half", format: "rg16float",
    value: "hierarchical depth range", coverage: "full internal pyramid", invalid: "history invalid", version: "history-role" }
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function normalizeRequest(request: FrameProgramRequest): FrameProgramRequest {
  positiveInteger(request.outputWidth, "outputWidth");
  positiveInteger(request.outputHeight, "outputHeight");
  if (request.intent !== "present" || request.viewFamily !== "main" ||
      !request.capabilityProfile || !request.outputFormat) {
    throw new Error("Frame Program requires Present, main view, capability profile and output format");
  }
  if (request.kind === "empty") return Object.freeze({ ...request });
  positiveInteger(request.internalWidth, "internalWidth");
  positiveInteger(request.internalHeight, "internalHeight");
  if (!Number.isSafeInteger(request.virtualBankCount) || request.virtualBankCount < 0 ||
      (!request.virtualGeometry && request.virtualBankCount !== 0)) {
    throw new RangeError("virtualBankCount does not match virtualGeometry");
  }
  const activeClasses = [...new Set(request.activeClasses)].sort((a, b) => a - b);
  if (activeClasses.some(id => !Number.isInteger(id) || id < 0 || id >= 64)) {
    throw new RangeError("activeClasses contains an invalid execution class");
  }
  const textureBankMasks = [...request.textureBankMasks];
  if (textureBankMasks.length !== 4 || textureBankMasks.some(mask => !Number.isSafeInteger(mask) || mask < 0)) {
    throw new RangeError("textureBankMasks must contain four non-negative masks");
  }
  // Only textured classes materialize bank imports or alter Surface layouts.
  const texturedSets = new Set(activeClasses.filter(id => shadingProgramUsesTextures(id & 15))
    .map(id => id >> 4));
  for (let setId = 0; setId < textureBankMasks.length; setId++) {
    if (!texturedSets.has(setId)) textureBankMasks[setId] = 0;
  }
  return Object.freeze({
    ...request,
    activeClasses: Object.freeze(activeClasses),
    textureBankMasks: Object.freeze(textureBankMasks)
  });
}

/** Only pass/resource shape enters the key. Resource identity stays in frame bindings. */
function structuralKey(request: FrameProgramRequest): string {
  const base = [2, request.kind, request.intent, request.viewFamily,
    request.outputWidth, request.outputHeight, request.outputFormat, request.capabilityProfile];
  if (request.kind === "empty") return JSON.stringify(base);
  return JSON.stringify([
    ...base, request.internalWidth, request.internalHeight,
    request.virtualGeometry, request.virtualBankCount,
    request.previousHzb, request.currentHzbLateRecheck,
    request.activeClasses, request.textureBankMasks, request.physicalEnvironment
  ]);
}

function dependencies(product: FrameProduct, request: FrameProgramRequest): readonly FrameProduct[] {
  if (request.kind === "empty") return [];
  switch (product) {
    case "swapchain": return ["reconstructed-color"];
    case "reconstructed-color": return [
      request.physicalEnvironment ? "aerial-radiance" : "surface-radiance", "depth", "surface-motion"
    ];
    case "aerial-radiance": return ["sky-radiance", "depth"];
    case "sky-radiance": return ["surface-radiance", "depth"];
    case "surface-radiance":
    case "surface-motion": return ["shading-work", "depth"];
    case "shading-work": return ["visibility", "meshlet-work"];
    case "visibility": return ["meshlet-work", "depth"];
    case "hzb": return ["depth"];
    case "depth":
    case "meshlet-work": return [];
  }
}

function createProgram(request: FrameProgramRequest, key: string): FrameProgram {
  if (request.kind === "empty") {
    const fact: FrameProductFact = Object.freeze({ ...PRODUCT_SPEC.swapchain,
      product: "swapchain", producer: "clear-present", consumers: Object.freeze(["canvas"] as const),
      extent: Object.freeze([request.outputWidth, request.outputHeight] as const), format: request.outputFormat });
    return Object.freeze({ request, key, products: Object.freeze(["swapchain"] as FrameProduct[]),
      facts: Object.freeze([fact]), stages: Object.freeze(["clear-present"] as FrameProgramStage[]),
      bindingRoles: Object.freeze(["swapchain"]), directLighting: false, buildHzb: false });
  }
  const directLighting = request.activeClasses.some(id => (id & 15) >= 4);
  const buildHzb = request.previousHzb || request.currentHzbLateRecheck || directLighting;
  const visiting = new Set<FrameProduct>();
  const visited = new Set<FrameProduct>();
  const ordered: FrameProduct[] = [];
  const requireProduct = (product: FrameProduct): void => {
    if (visited.has(product)) return;
    if (visiting.has(product)) throw new Error(`Frame Program product dependency cycle at ${product}`);
    if (!PRODUCT_SPEC[product]) throw new Error(`Frame Program has no producer for ${product}`);
    visiting.add(product);
    for (const dependency of dependencies(product, request)) requireProduct(dependency);
    visiting.delete(product);
    visited.add(product);
    ordered.push(product);
  };
  requireProduct("swapchain");
  if (buildHzb) requireProduct("hzb");
  const stages: FrameProgramStage[] = [
    "visibility", ...(buildHzb ? ["hzb" as const] : []), "shading-work",
    ...(directLighting ? ["light-cluster" as const] : []), "surface",
    ...(request.physicalEnvironment ? ["physical-sky" as const, "aerial" as const] : []),
    "fsr3", "present"
  ];
  const facts = ordered.map((product): FrameProductFact => {
    const spec = PRODUCT_SPEC[product];
    if (!stages.includes(spec.producer)) throw new Error(`Frame Program lacks producer ${spec.producer} for ${product}`);
    const consumers: (FrameProgramStage | "canvas")[] = ordered
      .filter(candidate => dependencies(candidate, request).includes(product))
      .map(candidate => PRODUCT_SPEC[candidate].producer);
    if (product === "swapchain") consumers.push("canvas");
    if (product === "hzb") {
      if (request.previousHzb || request.currentHzbLateRecheck) consumers.push("visibility");
      if (directLighting) consumers.push("light-cluster");
    }
    const extent: readonly [number, number] | null = spec.domain === "gpu-work" ? null :
      spec.domain === "output-full" ? [request.outputWidth, request.outputHeight] :
        spec.domain === "internal-half" ? [Math.max(1, request.internalWidth >>> 1),
          Math.max(1, request.internalHeight >>> 1)] : [request.internalWidth, request.internalHeight];
    return Object.freeze({ ...spec, product, consumers: Object.freeze([...new Set(consumers)]),
      extent: extent === null ? null : Object.freeze(extent),
      format: product === "swapchain" ? request.outputFormat : spec.format });
  });
  return Object.freeze({ request, key, products: Object.freeze(ordered), facts: Object.freeze(facts),
    stages: Object.freeze(stages), bindingRoles: Object.freeze([
      "job", "camera", "view", "depth", "swapchain", "fsr3-history", "fsr3-constants",
      ...(buildHzb ? ["hzb"] : []), ...(request.physicalEnvironment ? ["environment"] : [])
    ]), directLighting, buildHzb });
}

export function buildFrameProgram(request: FrameProgramRequest): FrameProgram {
  const normalized = normalizeRequest(request);
  return createProgram(normalized, structuralKey(normalized));
}

/** Small device-local LRU: demand closure and fact construction only run on a shape miss. */
export class FrameProgramCache {
  private readonly entries = new Map<string, FrameProgram>();

  constructor(private readonly capacity = 8) {
    positiveInteger(capacity, "Frame Program cache capacity");
  }

  getOrCreate(request: FrameProgramRequest): FrameProgram {
    const normalized = normalizeRequest(request);
    const key = structuralKey(normalized);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const program = createProgram(normalized, key);
    this.entries.set(key, program);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return program;
  }

  clear(): void { this.entries.clear(); }
}
