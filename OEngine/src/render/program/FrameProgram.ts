/** Semantic products with real producers and consumers in Module A. */
export type FrameProduct =
  | "swapchain" | "reconstructed-color" | "aerial-radiance" | "sky-radiance"
  | "surface-radiance" | "surface-motion" | "shading-work"
  | "visibility" | "depth" | "meshlet-work" | "hzb";

export type FrameProgramStage =
  | "clear-present" | "visibility" | "hzb" | "shading-work" | "light-cluster"
  | "surface" | "physical-sky" | "aerial" | "fsr3" | "present";

type FrameProgramBase = Readonly<{
  outputWidth: number;
  outputHeight: number;
  outputFormat: GPUTextureFormat;
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
      meshletWorkCapacity: number;
      meshletWorkCompaction: "auto" | "portable" | "subgroup";
      primitiveIndex: "auto" | "portable";
      coneCulling: boolean;
      activeClasses: readonly number[];
      textureBankMasks: readonly number[];
      physicalEnvironment: boolean;
    }>
);

export type FrameProgram = Readonly<{
  request: FrameProgramRequest;
  key: string;
  products: readonly FrameProduct[];
  stages: readonly FrameProgramStage[];
  directLighting: boolean;
  buildHzb: boolean;
}>;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

/** Only structural shape enters the key. Per-frame resources live in bindings. */
export function buildFrameProgram(request: FrameProgramRequest): FrameProgram {
  positiveInteger(request.outputWidth, "outputWidth");
  positiveInteger(request.outputHeight, "outputHeight");
  if (!request.capabilityProfile || !request.outputFormat) throw new Error("Frame Program requires a capability profile and output format");
  if (request.kind === "empty") {
    return Object.freeze({
      request,
      key: JSON.stringify([1, "empty", request.outputWidth, request.outputHeight, request.outputFormat, request.capabilityProfile]),
      products: Object.freeze(["swapchain"] as FrameProduct[]),
      stages: Object.freeze(["clear-present"] as FrameProgramStage[]),
      directLighting: false,
      buildHzb: false
    });
  }

  positiveInteger(request.internalWidth, "internalWidth");
  positiveInteger(request.internalHeight, "internalHeight");
  if (!Number.isSafeInteger(request.meshletWorkCapacity) || request.meshletWorkCapacity < 0) {
    throw new RangeError("meshletWorkCapacity must be a non-negative integer");
  }
  if (!Number.isSafeInteger(request.virtualBankCount) || request.virtualBankCount < 0 ||
      (!request.virtualGeometry && request.virtualBankCount !== 0)) {
    throw new RangeError("virtualBankCount does not match virtualGeometry");
  }
  const activeClasses = [...new Set(request.activeClasses)].sort((a, b) => a - b);
  if (activeClasses.some(id => !Number.isInteger(id) || id < 0 || id >= 64)) {
    throw new RangeError("activeClasses contains an invalid execution class");
  }
  const bankMasks = [...request.textureBankMasks];
  if (bankMasks.length !== 4 || bankMasks.some(mask => !Number.isInteger(mask) || mask < 0)) {
    throw new RangeError("textureBankMasks must contain four non-negative masks");
  }
  const directLighting = activeClasses.some(id => (id & 15) >= 4);
  const buildHzb = request.previousHzb || request.currentHzbLateRecheck || directLighting;
  const demands = new Set<FrameProduct>();
  const requireProduct = (product: FrameProduct): void => {
    if (demands.has(product)) return;
    demands.add(product);
    switch (product) {
      case "swapchain": requireProduct("reconstructed-color"); break;
      case "reconstructed-color":
        requireProduct(request.physicalEnvironment ? "aerial-radiance" : "surface-radiance");
        requireProduct("depth");
        requireProduct("surface-motion");
        break;
      case "aerial-radiance": requireProduct("sky-radiance"); requireProduct("depth"); break;
      case "sky-radiance": requireProduct("surface-radiance"); requireProduct("depth"); break;
      case "surface-radiance":
      case "surface-motion": requireProduct("shading-work"); requireProduct("depth"); break;
      case "shading-work": requireProduct("visibility"); requireProduct("meshlet-work"); break;
      case "visibility": requireProduct("meshlet-work"); requireProduct("depth"); break;
      case "hzb": requireProduct("depth"); break;
      case "depth":
      case "meshlet-work": break;
    }
  };
  requireProduct("swapchain");
  if (buildHzb) requireProduct("hzb");
  const normalized: FrameProgramRequest = Object.freeze({
    ...request,
    activeClasses: Object.freeze(activeClasses),
    textureBankMasks: Object.freeze(bankMasks)
  });
  return Object.freeze({
    request: normalized,
    key: JSON.stringify([
      1, "scene", request.internalWidth, request.internalHeight,
      request.outputWidth, request.outputHeight, request.outputFormat, request.capabilityProfile,
      request.virtualGeometry, request.virtualBankCount,
      request.previousHzb, request.currentHzbLateRecheck, request.meshletWorkCapacity,
      request.meshletWorkCompaction, request.primitiveIndex, request.coneCulling,
      activeClasses, bankMasks, request.physicalEnvironment
    ]),
    products: Object.freeze([...demands]),
    stages: Object.freeze([
      "visibility", ...(buildHzb ? ["hzb"] : []), "shading-work",
      ...(directLighting ? ["light-cluster"] : []), "surface",
      ...(request.physicalEnvironment ? ["physical-sky", "aerial"] : []),
      "fsr3", "present"
    ] as FrameProgramStage[]),
    directLighting,
    buildHzb
  });
}
