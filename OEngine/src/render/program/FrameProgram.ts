/** The finite set of products with real Module A producers and consumers. */
import type { RenderDebugView } from "../../debug/RenderDebugView.js";
import {
  isRenderableRenderDebugView,
  RenderDebugView as RenderDebugViewValue,
} from "../../debug/RenderDebugView.js";

export type FrameProduct =
  | "swapchain"
  | "display-color"
  | "reconstructed-color"
  | "bloom-hdr"
  | "adapted-exposure"
  | "aerial-radiance"
  | "sky-radiance"
  | "surface-radiance"
  | "debug-color"
  | "temporal-motion"
  | "temporal-mask"
  | "temporal-identity"
  | "visibility"
  | "depth"
  | "meshlet-work"
  | "hzb"
  | "light-cluster"
  | "indirect-visibility"
  | "shadow-demand"
  | "shadow-allocation"
  | "shadow-visibility";

export type FrameProgramStage =
  | "clear-present"
  | "visibility"
  | "hzb"
  | "light-cluster"
  | "xe-gtao"
  | "vsm"
  | "surface"
  | "physical-sky"
  | "aerial"
  | "temporal-facts"
  | "fsr3"
  | "radiometry"
  | "bloom"
  | "debug-view"
  | "present";

/** Finite physical AO profiles; only off is requested by production until C4–C6. */
export type FrameAoProfile = "off" | "scalar-high";
export type FrameVsmProfile = "off" | "vsm-directional-high" | "vsm-directional-bounded" | "shadow-disabled";

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

export type FrameProgramRequest = FrameProgramBase &
  (
    | Readonly<{ kind: "empty" }>
    | Readonly<{
        kind: "scene";
        internalWidth: number;
        internalHeight: number;
        virtualGeometry: boolean;
        virtualBankCount: number;
        previousHzb: boolean;
        currentHzbLateRecheck: boolean;
        activeSets: readonly number[];
        /** Union of the texture banks referenced by the active resident sets. */
        textureBankMask?: number;
        hasLit: boolean;
        aoProfile?: FrameAoProfile;
        shadowProfile?: FrameVsmProfile;
        physicalEnvironment: boolean;
        authoredEnvironment?: boolean;
        /** Perf-host diagnostic: keep the semantic reconstruction edge but bypass FSR3 passes. */
        fsr3Enabled?: boolean;
        /** Perf-host diagnostic: keep the semantic bloom edge but bypass Bloom passes. */
        bloomEnabled?: boolean;
        /** Optional final debug resolve. `none` keeps the production presentation. */
        debugView?: RenderDebugView;
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

const PRODUCT_SPEC: Readonly<
  Record<
    FrameProduct,
    Readonly<{
      producer: FrameProgramStage;
      domain: FrameProductFact["domain"];
      format: FrameProductFact["format"];
      value: string;
      coverage: string;
      invalid: string;
      version: FrameProductFact["version"];
    }>
  >
> = Object.freeze({
  swapchain: {
    producer: "present",
    domain: "output-full",
    format: "bgra8unorm",
    value: "display color",
    coverage: "full output",
    invalid: "clear color",
    version: "frame",
  },
  "display-color": {
    producer: "present",
    domain: "output-full",
    format: "bgra8unorm",
    value: "tone-mapped display color",
    coverage: "full output",
    invalid: "clear color",
    version: "frame",
  },
  "adapted-exposure": {
    producer: "radiometry",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "GPU adapted exposure E_t",
    coverage: "one scalar",
    invalid: "bootstrap 1",
    version: "history-role",
  },
  "bloom-hdr": {
    producer: "bloom",
    domain: "output-full",
    format: "rgba16float",
    value: "scene HDR plus Filament-profile bloom",
    coverage: "full output",
    invalid: "scene HDR",
    version: "frame",
  },
  "reconstructed-color": {
    producer: "fsr3",
    domain: "output-full",
    format: "rgba16float",
    value: "working-linear pre-exposed",
    coverage: "full output",
    invalid: "history reset",
    version: "history-role",
  },
  "aerial-radiance": {
    producer: "aerial",
    domain: "internal-full",
    format: "rgba16float",
    value: "working-linear pre-exposed",
    coverage: "full internal",
    invalid: "surface fallback",
    version: "frame",
  },
  "sky-radiance": {
    producer: "physical-sky",
    domain: "internal-full",
    format: "rgba16float",
    value: "working-linear pre-exposed",
    coverage: "background plus surface",
    invalid: "surface fallback",
    version: "frame",
  },
  "surface-radiance": {
    producer: "surface",
    domain: "internal-full",
    format: "rgba16float",
    value: "working-linear pre-exposed",
    coverage: "full internal",
    invalid: "clear color",
    version: "frame",
  },
  "debug-color": {
    producer: "debug-view",
    domain: "output-full",
    format: "rgba16float",
    value: "geometry diagnostic resolve",
    coverage: "full output",
    invalid: "black background",
    version: "frame",
  },
  "temporal-motion": {
    producer: "temporal-facts",
    domain: "internal-full",
    format: "rg16float",
    value: "valid current-minus-previous UV including sky rotation",
    coverage: "full internal",
    invalid: "zero with validity zero",
    version: "frame",
  },
  "temporal-mask": {
    producer: "temporal-facts",
    domain: "internal-full",
    format: "rgba8unorm",
    value: "opaque reactive, motion validity, identity mismatch, local change bits",
    coverage: "full internal",
    invalid: "reactive one, validity zero",
    version: "frame",
  },
  "temporal-identity": {
    producer: "temporal-facts",
    domain: "internal-full",
    format: "rgba32uint",
    value: "instance slot, geometry/LOD, material, transform revision",
    coverage: "full internal",
    invalid: "zero identity",
    version: "history-role",
  },
  "light-cluster": {
    producer: "light-cluster",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "clustered direct-light lookup",
    coverage: "lit surface",
    invalid: "zero lights",
    version: "frame",
  },
  "indirect-visibility": {
    producer: "xe-gtao",
    domain: "internal-full",
    format: "structured-buffer",
    value: "unexposed indirect visibility [0,1]",
    coverage: "visible opaque surface",
    invalid: "visibility one",
    version: "frame",
  },
  "shadow-visibility": {
    producer: "vsm",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "directional VSM visibility with page fallback",
    coverage: "lit opaque surface",
    invalid: "neutral visibility one",
    version: "frame",
  },
  "shadow-demand": {
    producer: "vsm",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "bounded directional VSM receiver demand",
    coverage: "visible opaque receivers",
    invalid: "zero demand header",
    version: "frame",
  },
  "shadow-allocation": {
    producer: "vsm",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "bounded directional VSM page allocation and work records",
    coverage: "requested directional pages",
    invalid: "allocation overflow with coarse fallback",
    version: "frame",
  },
  visibility: {
    producer: "visibility",
    domain: "internal-full",
    format: "r32uint",
    value: "packed VisibilityKey",
    coverage: "visible geometry",
    invalid: "background sentinel",
    version: "frame",
  },
  depth: {
    producer: "visibility",
    domain: "internal-full",
    format: "depth32float",
    value: "reverse depth",
    coverage: "visible geometry",
    invalid: "depth clear",
    version: "frame",
  },
  "meshlet-work": {
    producer: "visibility",
    domain: "gpu-work",
    format: "structured-buffer",
    value: "bounded GPU MeshletWork",
    coverage: "candidate geometry",
    invalid: "queue count zero",
    version: "frame",
  },
  hzb: {
    producer: "hzb",
    domain: "internal-half",
    format: "rg16float",
    value: "hierarchical depth range",
    coverage: "full internal pyramid",
    invalid: "history invalid",
    version: "history-role",
  },
});

/** Finite semantic input contracts. A new edge must name its domain and value
 * (including exposure convention) before lowering may register GPU work. */
const INPUT_CONTRACTS: Readonly<
  Record<
    FrameProduct,
    Readonly<Partial<Record<FrameProduct, Readonly<Pick<FrameProductFact, "domain" | "value">>>>>
  >
> = {
  swapchain: {
    "display-color": { domain: "output-full", value: "tone-mapped display color" },
  },
  "reconstructed-color": {
    "aerial-radiance": { domain: "internal-full", value: "working-linear pre-exposed" },
    "surface-radiance": { domain: "internal-full", value: "working-linear pre-exposed" },
    depth: { domain: "internal-full", value: "reverse depth" },
    "temporal-motion": {
      domain: "internal-full",
      value: "valid current-minus-previous UV including sky rotation",
    },
    "temporal-mask": {
      domain: "internal-full",
      value: "opaque reactive, motion validity, identity mismatch, local change bits",
    },
  },
  "display-color": {
    "bloom-hdr": { domain: "output-full", value: "scene HDR plus Filament-profile bloom" },
    "debug-color": { domain: "output-full", value: "geometry diagnostic resolve" },
    "adapted-exposure": { domain: "gpu-work", value: "GPU adapted exposure E_t" },
  },
  "debug-color": {
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    depth: { domain: "internal-full", value: "reverse depth" },
    "meshlet-work": { domain: "gpu-work", value: "bounded GPU MeshletWork" },
  },
  "bloom-hdr": { "reconstructed-color": { domain: "output-full", value: "working-linear pre-exposed" } },
  "adapted-exposure": {
    "reconstructed-color": { domain: "output-full", value: "working-linear pre-exposed" },
  },
  "temporal-motion": {
    "meshlet-work": { domain: "gpu-work", value: "bounded GPU MeshletWork" },
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "temporal-mask": {
    "temporal-motion": {
      domain: "internal-full",
      value: "valid current-minus-previous UV including sky rotation",
    },
    "temporal-identity": {
      domain: "internal-full",
      value: "instance slot, geometry/LOD, material, transform revision",
    },
  },
  "temporal-identity": {
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    "meshlet-work": { domain: "gpu-work", value: "bounded GPU MeshletWork" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "aerial-radiance": {
    "sky-radiance": { domain: "internal-full", value: "working-linear pre-exposed" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "sky-radiance": {
    "surface-radiance": { domain: "internal-full", value: "working-linear pre-exposed" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "surface-radiance": {
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    "meshlet-work": { domain: "gpu-work", value: "bounded GPU MeshletWork" },
    "light-cluster": { domain: "gpu-work", value: "clustered direct-light lookup" },
    "indirect-visibility": { domain: "internal-full", value: "unexposed indirect visibility [0,1]" },
    "shadow-visibility": { domain: "gpu-work", value: "directional VSM visibility with page fallback" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "indirect-visibility": {
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "shadow-visibility": {
    visibility: { domain: "internal-full", value: "packed VisibilityKey" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  "shadow-demand": {},
  "shadow-allocation": {
    "shadow-demand": { domain: "gpu-work", value: "bounded directional VSM receiver demand" },
  },
  "light-cluster": { hzb: { domain: "internal-half", value: "hierarchical depth range" } },
  visibility: {
    "meshlet-work": { domain: "gpu-work", value: "bounded GPU MeshletWork" },
    depth: { domain: "internal-full", value: "reverse depth" },
  },
  hzb: { depth: { domain: "internal-full", value: "reverse depth" } },
  depth: {},
  "meshlet-work": {},
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function normalizeRequest(request: FrameProgramRequest): FrameProgramRequest {
  positiveInteger(request.outputWidth, "outputWidth");
  positiveInteger(request.outputHeight, "outputHeight");
  if (
    request.intent !== "present" ||
    request.viewFamily !== "main" ||
    !request.capabilityProfile ||
    !request.outputFormat
  ) {
    throw new Error("Frame Program requires Present, main view, capability profile and output format");
  }
  if (request.kind === "empty") return Object.freeze({ ...request });
  positiveInteger(request.internalWidth, "internalWidth");
  positiveInteger(request.internalHeight, "internalHeight");
  if (
    !Number.isSafeInteger(request.virtualBankCount) ||
    request.virtualBankCount < 0 ||
    (!request.virtualGeometry && request.virtualBankCount !== 0)
  ) {
    throw new RangeError("virtualBankCount does not match virtualGeometry");
  }
  const activeSets = [...new Set(request.activeSets)].sort((a, b) => a - b);
  if (activeSets.some((id) => !Number.isInteger(id) || id < 0 || id >= 4)) {
    throw new RangeError("activeSets contains an invalid resident set");
  }
  if (
    !Number.isInteger(request.textureBankMask ?? 0x1ff) ||
    (request.textureBankMask ?? 0x1ff) < 1 ||
    ((request.textureBankMask ?? 0x1ff) & ~0x1ff) !== 0
  ) {
    throw new RangeError("Frame Program texture bank mask is invalid");
  }
  if (request.aoProfile !== undefined && request.aoProfile !== "off" && request.aoProfile !== "scalar-high") {
    throw new RangeError("Frame Program AO profile is invalid");
  }
  if (request.aoProfile === "scalar-high" && (!request.hasLit || activeSets.length === 0)) {
    throw new RangeError("XeGTAO requires a lit Surface consumer");
  }
  const shadowProfile = request.shadowProfile ?? "off";
  if (
    shadowProfile !== "off" &&
    shadowProfile !== "vsm-directional-high" &&
    shadowProfile !== "vsm-directional-bounded" &&
    shadowProfile !== "shadow-disabled"
  ) {
    throw new RangeError("Frame Program shadow profile is invalid");
  }
  if (shadowProfile !== "off" && !request.hasLit) {
    throw new RangeError("VSM requires a lit Surface consumer");
  }
  const debugView = request.debugView ?? RenderDebugViewValue.None;
  if (!isRenderableRenderDebugView(debugView) && debugView !== RenderDebugViewValue.None) {
    throw new RangeError(`Unsupported Frame Program debug view '${debugView}'`);
  }
  return Object.freeze({
    ...request,
    activeSets: Object.freeze(activeSets),
    textureBankMask: request.textureBankMask ?? 0x1ff,
    shadowProfile,
    fsr3Enabled: request.fsr3Enabled !== false,
    bloomEnabled: request.bloomEnabled !== false,
    debugView,
  });
}

/** Only pass/resource shape enters the key. Resource identity stays in frame bindings. */
function structuralKey(request: FrameProgramRequest): string {
  const base = [
    4,
    request.kind,
    request.intent,
    request.viewFamily,
    request.outputWidth,
    request.outputHeight,
    request.outputFormat,
    request.capabilityProfile,
  ];
  if (request.kind === "empty") return JSON.stringify(base);
  return JSON.stringify([
    ...base,
    request.internalWidth,
    request.internalHeight,
    request.virtualGeometry,
    request.virtualBankCount,
    request.previousHzb,
    request.currentHzbLateRecheck,
    request.activeSets,
    request.textureBankMask ?? 0x1ff,
    request.hasLit,
    request.aoProfile ?? "off",
    request.shadowProfile ?? "off",
    request.physicalEnvironment,
    request.authoredEnvironment === true,
    request.fsr3Enabled !== false,
    request.bloomEnabled !== false,
    request.debugView ?? RenderDebugViewValue.None,
  ]);
}

function dependencies(product: FrameProduct, request: FrameProgramRequest): readonly FrameProduct[] {
  if (request.kind === "empty") return [];
  switch (product) {
    case "swapchain":
      return ["display-color"];
    case "display-color":
      return request.debugView !== undefined && request.debugView !== RenderDebugViewValue.None
        ? ["debug-color", "bloom-hdr", "adapted-exposure"]
        : ["bloom-hdr", "adapted-exposure"];
    case "bloom-hdr":
      return ["reconstructed-color"];
    case "debug-color":
      return ["visibility", "depth", "meshlet-work"];
    case "adapted-exposure":
      return ["reconstructed-color"];
    case "reconstructed-color":
      return [
        request.physicalEnvironment ? "aerial-radiance" : "surface-radiance",
        "depth",
        "temporal-motion",
        "temporal-mask",
      ];
    case "temporal-motion":
      return ["visibility", "meshlet-work", "depth"];
    case "temporal-mask":
      return ["temporal-motion", "temporal-identity"];
    case "temporal-identity":
      return ["visibility", "meshlet-work", "depth"];
    case "aerial-radiance":
      return ["sky-radiance", "depth"];
    case "sky-radiance":
      return ["surface-radiance", "depth"];
    case "surface-radiance":
      return [
        "visibility",
        "meshlet-work",
        "depth",
        ...(request.hasLit ? ["light-cluster" as const] : []),
        ...(request.aoProfile === "scalar-high" ? ["indirect-visibility" as const] : []),
      ];
    case "indirect-visibility":
      return ["visibility", "depth"];
    case "shadow-demand":
      return [];
    case "shadow-allocation":
      return ["shadow-demand"];
    case "shadow-visibility":
      return ["visibility", "depth"];
    case "light-cluster":
      return ["hzb"];
    case "visibility":
      return ["meshlet-work", "depth"];
    case "hzb":
      return ["depth"];
    case "depth":
    case "meshlet-work":
      return [];
  }
}

function createProgram(request: FrameProgramRequest, key: string): FrameProgram {
  if (request.kind === "empty") {
    const fact: FrameProductFact = Object.freeze({
      ...PRODUCT_SPEC.swapchain,
      product: "swapchain",
      producer: "clear-present",
      consumers: Object.freeze(["canvas"] as const),
      extent: Object.freeze([request.outputWidth, request.outputHeight] as const),
      format: request.outputFormat,
    });
    return Object.freeze({
      request,
      key,
      products: Object.freeze(["swapchain"] as FrameProduct[]),
      facts: Object.freeze([fact]),
      stages: Object.freeze(["clear-present"] as FrameProgramStage[]),
      bindingRoles: Object.freeze(["swapchain"]),
      directLighting: false,
      buildHzb: false,
    });
  }
  const directLighting = request.hasLit;
  const buildHzb = request.previousHzb || request.currentHzbLateRecheck || directLighting;
  const visiting = new Set<FrameProduct>();
  const visited = new Set<FrameProduct>();
  const ordered: FrameProduct[] = [];
  const requireProduct = (product: FrameProduct): void => {
    if (visited.has(product)) return;
    if (visiting.has(product)) throw new Error(`Frame Program product dependency cycle at ${product}`);
    if (!PRODUCT_SPEC[product]) throw new Error(`Frame Program has no producer for ${product}`);
    visiting.add(product);
    for (const dependency of dependencies(product, request)) {
      const expected = INPUT_CONTRACTS[product][dependency];
      const actual = PRODUCT_SPEC[dependency];
      if (!expected || !actual) {
        throw new Error(`Frame Program ${product} has undeclared input or producer ${dependency}`);
      }
      if (actual.domain !== expected.domain || actual.value !== expected.value) {
        throw new Error(`Frame Program ${dependency} → ${product} needs an explicit domain/value conversion`);
      }
      requireProduct(dependency);
    }
    visiting.delete(product);
    visited.add(product);
    ordered.push(product);
  };
  requireProduct("swapchain");
  if (buildHzb) requireProduct("hzb");
  if (
    request.shadowProfile !== undefined &&
    request.shadowProfile !== "off" &&
    request.shadowProfile !== "shadow-disabled"
  ) {
    requireProduct("shadow-demand");
    requireProduct("shadow-allocation");
  }
  const stages: FrameProgramStage[] = [
    "visibility",
    ...(buildHzb ? ["hzb" as const] : []),
    ...(directLighting ? ["light-cluster" as const] : []),
    ...(request.shadowProfile !== undefined &&
    request.shadowProfile !== "off" &&
    request.shadowProfile !== "shadow-disabled"
      ? ["vsm" as const]
      : []),
    ...(request.aoProfile === "scalar-high" ? ["xe-gtao" as const] : []),
    "surface",
    ...(request.physicalEnvironment ? ["physical-sky" as const, "aerial" as const] : []),
    "temporal-facts",
    "fsr3",
    "radiometry",
    "bloom",
    ...(request.debugView !== undefined && request.debugView !== RenderDebugViewValue.None
      ? ["debug-view" as const]
      : []),
    "present",
  ];
  const facts = ordered.map((product): FrameProductFact => {
    const spec = PRODUCT_SPEC[product];
    if (!stages.includes(spec.producer))
      throw new Error(`Frame Program lacks producer ${spec.producer} for ${product}`);
    const consumers: (FrameProgramStage | "canvas")[] = ordered
      .filter((candidate) => dependencies(candidate, request).includes(product))
      .map((candidate) => PRODUCT_SPEC[candidate].producer);
    if (product === "swapchain") consumers.push("canvas");
    if (product === "hzb") {
      if (request.previousHzb || request.currentHzbLateRecheck) consumers.push("visibility");
    }
    const extent: readonly [number, number] | null =
      spec.domain === "gpu-work"
        ? null
        : spec.domain === "output-full"
          ? [request.outputWidth, request.outputHeight]
          : spec.domain === "internal-half"
            ? [Math.max(1, request.internalWidth >>> 1), Math.max(1, request.internalHeight >>> 1)]
            : [request.internalWidth, request.internalHeight];
    return Object.freeze({
      ...spec,
      product,
      consumers: Object.freeze([...new Set(consumers)]),
      extent: extent === null ? null : Object.freeze(extent),
      format: product === "swapchain" ? request.outputFormat : spec.format,
    });
  });
  return Object.freeze({
    request,
    key,
    products: Object.freeze(ordered),
    facts: Object.freeze(facts),
    stages: Object.freeze(stages),
    bindingRoles: Object.freeze([
      "job",
      "camera",
      "view",
      "depth",
      "swapchain",
      "fsr3-history",
      "fsr3-constants",
      "temporal-facts-history",
      ...(buildHzb ? ["hzb"] : []),
      ...(request.shadowProfile !== undefined &&
      request.shadowProfile !== "off" &&
      request.shadowProfile !== "shadow-disabled"
        ? ["vsm"]
        : []),
      ...(request.physicalEnvironment || request.authoredEnvironment ? ["environment"] : []),
    ]),
    directLighting,
    buildHzb,
  });
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

  clear(): void {
    this.entries.clear();
  }
}
