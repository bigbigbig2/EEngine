import {
  createGeometryCookRecipeV3,
  type GeometryCookRecipeV3
} from "../../GeometryCookRecipe.js";

export const WEB_GEOMETRY_COOKER_ABI_VERSION = 2;
export const WEB_GEOMETRY_CANONICAL_HEADER_BYTES = 128;
export const WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES = 32;
export const WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS = 18;
export const WEB_GEOMETRY_CANONICAL_VERTEX_BYTES = WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS * 4;
export const WEB_GEOMETRY_RECIPE_BYTES = 96;
export const WEB_GEOMETRY_PAGE_BYTES = 262144;

export const WEB_GEOMETRY_ATTRIBUTE_POSITION = 1 << 0;
export const WEB_GEOMETRY_ATTRIBUTE_NORMAL = 1 << 1;
export const WEB_GEOMETRY_ATTRIBUTE_TANGENT = 1 << 2;
export const WEB_GEOMETRY_ATTRIBUTE_UV0 = 1 << 3;
export const WEB_GEOMETRY_ATTRIBUTE_UV1 = 1 << 4;
export const WEB_GEOMETRY_ATTRIBUTE_COLOR = 1 << 5;
export const WEB_GEOMETRY_MESHLET_OPAQUE = 1 << 0;
export const WEB_GEOMETRY_MESHLET_MASK = 1 << 1;
export const WEB_GEOMETRY_MESHLET_BLEND = 1 << 2;
export const WEB_GEOMETRY_MESHLET_TWO_SIDED = 1 << 3;
export const WEB_GEOMETRY_MESHLET_CASTS_SHADOW = 1 << 4;

const CANONICAL_MAGIC = new Uint8Array([0x4f, 0x45, 0x57, 0x47, 0x43, 0x41, 0x4e, 0x00]);
const RECIPE_MAGIC = new Uint8Array([0x4f, 0x45, 0x57, 0x47, 0x52, 0x43, 0x50, 0x00]);
const DOMAIN_GENERATE_NORMALS = 1;

const enum Section {
  AssetRecords = 1,
  RootNodeIds = 2,
  HierarchyNodes = 3,
  GroupDirectory = 4,
  PageRecords = 5,
  BootstrapPageIds = 6,
  VertexFormats = 7,
  RecipeHash = 8,
  PageBytes = 9,
  ContentManifestHash = 10
}

/** Result codes for the two-phase payload stage (ADR-0017). */
export const WEB_GEOMETRY_COOK_PAGE_READY = 1;
/** The descriptor declares this PageID but its payload is not produced yet. */
export const WEB_GEOMETRY_COOK_PAGE_PENDING = 2;
/** The descriptor does not declare this PageID; the ID graph is not extended. */
export const WEB_GEOMETRY_COOK_PAGE_UNDECLARED = 3;

export interface WebCanonicalGeometryDomainV1 {
  readonly materialId: number;
  readonly meshletFlags: number;
  readonly attributeMask: number;
  readonly generateNormals: boolean;
  /** 18 f32 values per vertex: position, normal, tangent, uv0, uv1, color. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export interface WebGeometryCookDescriptorSectionsV1 {
  readonly assetRecords: Uint8Array;
  readonly rootNodeIds: Uint32Array;
  readonly hierarchyNodes: Uint8Array;
  readonly groupDirectory: Uint8Array;
  readonly pageRecords: Uint8Array;
  readonly bootstrapPageIds: Uint32Array;
  readonly activationPageIds: Uint32Array;
  readonly vertexFormats: Uint8Array;
  readonly recipeHash: Uint8Array;
  readonly contentManifestHash: Uint8Array;
}

export interface EmscriptenWebGeometryCookerModuleV1 {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(address: number): void;
  _oengine_web_geometry_cook_abi_version(): number;
  _oengine_web_geometry_cook(canonical: number, canonicalBytes: number, recipe: number, recipeBytes: number, maxDecodedProductBytes: bigint): number;
  _oengine_web_geometry_cook_plan(canonical: number, canonicalBytes: number, recipe: number, recipeBytes: number, maxDecodedProductBytes: bigint): number;
  _oengine_web_geometry_cook_produce_page(handle: number, pageId: number, output: number, outputBytes: number): number;
  _oengine_web_geometry_cook_page_status(handle: number, pageId: number): number;
  _oengine_web_geometry_cook_destroy(handle: number): void;
  _oengine_web_geometry_cook_section_size(handle: number, section: number, index: number): number;
  _oengine_web_geometry_cook_copy_section(handle: number, section: number, index: number, output: number, outputBytes: number): number;
  _oengine_web_geometry_cook_page_count(handle: number): number;
  _oengine_web_geometry_cook_last_error_size(): number;
  _oengine_web_geometry_cook_copy_last_error(output: number, outputBytes: number): number;
}

/**
 * Creates the pinned Nyx-derived cooker for an explicit main-thread/tool
 * Product cook. Runtime GLB loading continues to use the bounded Worker
 * factory; this helper is reserved for procedural Scene and validation paths
 * that deliberately own the cook call.
 */
export async function createDefaultWebGeometryCookerModule(): Promise<EmscriptenWebGeometryCookerModuleV1> {
  const moduleUrl = new URL("./vendor/oengine-web-geometry-cooker.mjs", import.meta.url);
  const wasmUrl = new URL("./vendor/oengine-web-geometry-cooker.wasm", import.meta.url);
  const loaded = await import(/* @vite-ignore */ moduleUrl.href) as {
    default?: (options?: Readonly<Record<string, unknown>>) => Promise<EmscriptenWebGeometryCookerModuleV1>;
  };
  const factory = loaded.default;
  if (factory === undefined) throw new Error("Web geometry cooker module has no default factory");
  return factory({
    locateFile: (file: string) => file.endsWith(".wasm") ? wasmUrl.href : new URL(file, moduleUrl).href
  });
}

export function encodeWebCanonicalGeometryV1(domains: readonly WebCanonicalGeometryDomainV1[]): ArrayBuffer {
  if (domains.length === 0 || domains.length > 0xffffffff) throw new RangeError("canonical geometry requires a non-empty u32 domain count");
  let vertexCount = 0, indexCount = 0;
  for (const domain of domains) {
    assertU32(domain.materialId, "materialId");
    assertU32(domain.meshletFlags, "meshletFlags");
    const knownAttributes = WEB_GEOMETRY_ATTRIBUTE_POSITION | WEB_GEOMETRY_ATTRIBUTE_NORMAL | WEB_GEOMETRY_ATTRIBUTE_TANGENT | WEB_GEOMETRY_ATTRIBUTE_UV0 | WEB_GEOMETRY_ATTRIBUTE_UV1 | WEB_GEOMETRY_ATTRIBUTE_COLOR;
    if (!Number.isInteger(domain.attributeMask) || (domain.attributeMask & WEB_GEOMETRY_ATTRIBUTE_POSITION) === 0 || (domain.attributeMask & ~knownAttributes) !== 0) throw new RangeError("attributeMask must contain POSITION and only known V3 attributes");
    const alphaModes = domain.meshletFlags & (WEB_GEOMETRY_MESHLET_OPAQUE | WEB_GEOMETRY_MESHLET_MASK | WEB_GEOMETRY_MESHLET_BLEND);
    const knownMeshletFlags = WEB_GEOMETRY_MESHLET_OPAQUE | WEB_GEOMETRY_MESHLET_MASK | WEB_GEOMETRY_MESHLET_BLEND | WEB_GEOMETRY_MESHLET_TWO_SIDED | WEB_GEOMETRY_MESHLET_CASTS_SHADOW;
    if ((domain.meshletFlags & ~knownMeshletFlags) !== 0 || alphaModes === 0 || (alphaModes & (alphaModes - 1)) !== 0) throw new RangeError("meshletFlags must contain exactly one alpha mode and only known V3 flags");
    if (!(domain.vertices instanceof Float32Array) || domain.vertices.length % WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS !== 0 || domain.vertices.length < WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS * 3) throw new RangeError("canonical domain vertices must contain at least three 18-f32 records");
    if (!(domain.indices instanceof Uint32Array) || domain.indices.length === 0 || domain.indices.length % 3 !== 0) throw new RangeError("canonical domain indices must be a non-empty triangle list");
    if (domain.generateNormals === ((domain.attributeMask & WEB_GEOMETRY_ATTRIBUTE_NORMAL) !== 0)) throw new RangeError("generateNormals must be the inverse of the normal attribute bit");
    const domainVertexCount = domain.vertices.length / WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    for (const value of domain.vertices) if (!Number.isFinite(value)) throw new RangeError("canonical vertex data must be finite");
    for (const index of domain.indices) if (index >= domainVertexCount) throw new RangeError("canonical index exceeds its domain vertex count");
    vertexCount = checkedU32Sum(vertexCount, domainVertexCount, "canonical vertex count");
    indexCount = checkedU32Sum(indexCount, domain.indices.length, "canonical index count");
  }
  const domainOffset = WEB_GEOMETRY_CANONICAL_HEADER_BYTES;
  const vertexOffset = alignUp(domainOffset + domains.length * WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES, 16);
  const indexOffset = alignUp(vertexOffset + vertexCount * WEB_GEOMETRY_CANONICAL_VERTEX_BYTES, 16);
  const totalBytes = alignUp(indexOffset + indexCount * 4, 16);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 0xffffffff) throw new RangeError("canonical geometry binary exceeds u32 ABI");
  const bytes = new Uint8Array(totalBytes), view = new DataView(bytes.buffer);
  bytes.set(CANONICAL_MAGIC);
  view.setUint32(8, WEB_GEOMETRY_COOKER_ABI_VERSION, true);
  view.setUint32(12, WEB_GEOMETRY_CANONICAL_HEADER_BYTES, true);
  view.setUint32(16, totalBytes, true);
  view.setUint32(20, domains.length, true);
  view.setUint32(24, vertexCount, true);
  view.setUint32(28, indexCount, true);
  view.setUint32(32, domainOffset, true);
  view.setUint32(36, vertexOffset, true);
  view.setUint32(40, indexOffset, true);
  view.setUint32(44, WEB_GEOMETRY_CANONICAL_VERTEX_BYTES, true);
  view.setUint32(48, WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES, true);
  let vertexBegin = 0, indexBegin = 0;
  for (let domainIndex = 0; domainIndex < domains.length; domainIndex++) {
    const domain = domains[domainIndex]!, domainVertexCount = domain.vertices.length / WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    const at = domainOffset + domainIndex * WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES;
    view.setUint32(at, domain.materialId, true);
    view.setUint32(at + 4, domain.meshletFlags, true);
    view.setUint16(at + 8, domain.attributeMask, true);
    view.setUint16(at + 10, domain.generateNormals ? DOMAIN_GENERATE_NORMALS : 0, true);
    view.setUint32(at + 12, vertexBegin, true);
    view.setUint32(at + 16, domainVertexCount, true);
    view.setUint32(at + 20, indexBegin, true);
    view.setUint32(at + 24, domain.indices.length, true);
    const domainVertexOffset = vertexOffset + vertexBegin * WEB_GEOMETRY_CANONICAL_VERTEX_BYTES;
    domain.vertices.forEach((value, index) => view.setFloat32(domainVertexOffset + index * 4, value, true));
    domain.indices.forEach((value, index) => view.setUint32(indexOffset + (indexBegin + index) * 4, value, true));
    vertexBegin += domainVertexCount;
    indexBegin += domain.indices.length;
  }
  return bytes.buffer;
}

export function encodeWebGeometryCookRecipeV1(input: Partial<GeometryCookRecipeV3> = {}): ArrayBuffer {
  const recipe = createGeometryCookRecipeV3(input);
  if (!Number.isSafeInteger(recipe.bootstrapGeometryBudgetBytes) || recipe.bootstrapGeometryBudgetBytes < 0) throw new RangeError("bootstrapGeometryBudgetBytes must be a non-negative safe integer");
  const bytes = new Uint8Array(WEB_GEOMETRY_RECIPE_BYTES), view = new DataView(bytes.buffer);
  bytes.set(RECIPE_MAGIC);
  view.setUint32(8, WEB_GEOMETRY_COOKER_ABI_VERSION, true);
  view.setUint32(12, WEB_GEOMETRY_RECIPE_BYTES, true);
  view.setUint32(16, recipe.meshletMaxVertices, true);
  view.setUint32(20, recipe.meshletMinTriangles, true);
  view.setUint32(24, recipe.meshletMaxTriangles, true);
  view.setUint32(28, recipe.groupTargetMeshlets, true);
  view.setFloat32(32, recipe.coneWeight, true);
  view.setFloat32(36, recipe.clusterSplitFactor, true);
  view.setFloat32(40, recipe.simplifyTargetRatio, true);
  view.setFloat32(44, recipe.simplifyFailureRatio, true);
  view.setFloat32(48, recipe.simplifySloppyFailureRatio, true);
  view.setUint32(52, (recipe.simplifyPermissive ? 1 : 0) | (recipe.sloppyFallback ? 2 : 0), true);
  view.setFloat32(56, recipe.sloppyErrorFactor, true);
  view.setFloat32(60, recipe.minimumLodReduction, true);
  view.setFloat32(64, recipe.lodErrorMergeFactor, true);
  view.setUint32(68, recipe.hierarchyFanout, true);
  view.setUint32(72, recipe.pageShift, true);
  view.setUint32(76, recipe.rawCodecThresholdBytes, true);
  const bootstrap = BigInt(recipe.bootstrapGeometryBudgetBytes);
  view.setUint32(80, Number(bootstrap & 0xffffffffn), true);
  view.setUint32(84, Number(bootstrap >> 32n), true);
  view.setUint32(88, recipe.deterministicSeed, true);
  return bytes.buffer;
}

/**
 * Owns one WASM cooker handle and copies sections only when output credit
 * exists. The handle may be a monolithic result, a descriptor-stage plan, or a
 * payload-stage handle; the concrete subclass decides what the handle promises.
 */
export class WebGeometryCookWasmHandleV1 {
  readonly #module: EmscriptenWebGeometryCookerModuleV1;
  #handle: number;
  readonly pageCount: number;

  constructor(module: EmscriptenWebGeometryCookerModuleV1, handle: number) {
    if (!Number.isInteger(handle) || handle <= 0) throw new RangeError("invalid Web geometry cook handle");
    this.#module = module;
    this.#handle = handle;
    this.pageCount = module._oengine_web_geometry_cook_page_count(handle);
    if (!Number.isInteger(this.pageCount) || this.pageCount <= 0) {
      const error = readLastError(module);
      this.release();
      throw new Error(error || "Web geometry cook returned no pages");
    }
  }

  descriptorSections(): WebGeometryCookDescriptorSectionsV1 {
    this.requireOpen();
    const bootstrapPageIds = asU32(this.copySection(Section.BootstrapPageIds), "bootstrapPageIds");
    // bootstrapPageIds keeps the per-asset ranges; the activation cut is the
    // sorted unique union, matching the OEGPACK Product adapter.
    const activationPageIds = Uint32Array.from([...new Set(bootstrapPageIds)].sort((left, right) => left - right));
    return Object.freeze({
      assetRecords: this.copySection(Section.AssetRecords),
      rootNodeIds: asU32(this.copySection(Section.RootNodeIds), "rootNodeIds"),
      hierarchyNodes: this.copySection(Section.HierarchyNodes),
      groupDirectory: this.copySection(Section.GroupDirectory),
      pageRecords: this.copySection(Section.PageRecords),
      bootstrapPageIds,
      activationPageIds,
      vertexFormats: this.copySection(Section.VertexFormats),
      recipeHash: requireHash(this.copySection(Section.RecipeHash), "recipeHash"),
      contentManifestHash: requireHash(this.copySection(Section.ContentManifestHash), "contentManifestHash")
    });
  }

  copyPage(pageId: number): ArrayBuffer {
    this.requireOpen();
    this.requirePageId(pageId);
    const bytes = this.copySection(Section.PageBytes, pageId);
    if (bytes.byteLength !== WEB_GEOMETRY_PAGE_BYTES) throw new Error("Web geometry cooker emitted a non-256-KiB page");
    return bytes.buffer;
  }

  release(): void {
    if (this.#handle === 0) return;
    this.#module._oengine_web_geometry_cook_destroy(this.#handle);
    this.#handle = 0;
  }

  protected get module(): EmscriptenWebGeometryCookerModuleV1 { return this.#module; }
  protected get handle(): number { this.requireOpen(); return this.#handle; }

  protected requirePageId(pageId: number): void {
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= this.pageCount) throw new RangeError("Web geometry pageId is out of range");
  }

  private copySection(section: Section, index = 0): Uint8Array<ArrayBuffer> {
    const size = this.#module._oengine_web_geometry_cook_section_size(this.#handle, section, index);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(readLastError(this.#module) || "Web geometry cook section is empty");
    const address = this.#module._malloc(size);
    if (!address) throw new Error("Web geometry cooker output allocation failed");
    try {
      if (this.#module._oengine_web_geometry_cook_copy_section(this.#handle, section, index, address, size) !== 1) throw new Error(readLastError(this.#module) || "Web geometry cook section copy failed");
      const output = new Uint8Array(size);
      output.set(this.#module.HEAPU8.subarray(address, address + size));
      return output;
    } finally {
      this.#module._free(address);
    }
  }

  private requireOpen(): void { if (this.#handle === 0) throw new Error("Web geometry cook result is released"); }
}

/**
 * Monolithic cook result: every page payload already exists, so
 * `descriptorSections()` is complete and `copyPage` works for every PageID.
 */
export class WebGeometryCookWasmResultV1 extends WebGeometryCookWasmHandleV1 {}

/** Outcome of one payload-stage advance. */
export interface WebGeometryProducedPageV1 {
  readonly status: number;
  /** Present only when `status` is `WEB_GEOMETRY_COOK_PAGE_READY`. */
  readonly bytes: ArrayBuffer | null;
}

/**
 * Descriptor-stage handle of the two-phase ABI (ADR-0017).
 *
 * The ID graph — page count, per-PageID identity, page-to-Group mapping and the
 * activation cut — is already frozen and readable here, but no page payload
 * exists yet. Payloads are advanced one PageID at a time with
 * {@link producePage}, which tolerates out-of-order, repeated and interleaved
 * requests.
 *
 * `descriptorSections()` deliberately still exposes `contentManifestHash` as an
 * all-zero placeholder: the digest covers every page payload, so a true value
 * cannot exist until the payload stage has produced all pages.
 */
export class WebGeometryCookWasmPlanV1 extends WebGeometryCookWasmHandleV1 {
  /**
   * Reports readiness for one PageID without producing anything.
   *
   * A PageID the descriptor never declared is reported as
   * `WEB_GEOMETRY_COOK_PAGE_UNDECLARED` rather than rejected here: refusing it
   * is the ABI's contract, not a caller-side range check.
   */
  pageStatus(pageId: number): number {
    if (!Number.isInteger(pageId) || pageId < 0) throw new RangeError("Web geometry pageId must be a non-negative integer");
    return this.module._oengine_web_geometry_cook_page_status(this.handle, pageId);
  }

  /**
   * Advances one PageID and copies its payload when it becomes ready.
   *
   * Declared pages may be produced in any order, and repeating a PageID returns
   * the byte-identical payload. A PageID the descriptor never declared is
   * reported as `WEB_GEOMETRY_COOK_PAGE_UNDECLARED` and does not extend the ID
   * graph.
   */
  producePage(pageId: number): WebGeometryProducedPageV1 {
    if (!Number.isInteger(pageId) || pageId < 0) throw new RangeError("Web geometry pageId must be a non-negative integer");
    const module = this.module;
    const address = module._malloc(WEB_GEOMETRY_PAGE_BYTES);
    if (!address) throw new Error("Web geometry cooker page allocation failed");
    try {
      const status = module._oengine_web_geometry_cook_produce_page(this.handle, pageId, address, WEB_GEOMETRY_PAGE_BYTES);
      if (status === WEB_GEOMETRY_COOK_PAGE_READY) {
        const output = new Uint8Array(WEB_GEOMETRY_PAGE_BYTES);
        output.set(module.HEAPU8.subarray(address, address + WEB_GEOMETRY_PAGE_BYTES));
        return Object.freeze({ status, bytes: output.buffer });
      }
      if (status !== WEB_GEOMETRY_COOK_PAGE_PENDING && status !== WEB_GEOMETRY_COOK_PAGE_UNDECLARED) {
        throw new Error(readLastError(module) || "Web geometry page production failed");
      }
      return Object.freeze({ status, bytes: null });
    } finally {
      module._free(address);
    }
  }

  /**
   * Produces every declared-but-pending page and returns how many were newly
   * materialized. Use it to reach the monolithic state before reading
   * `contentManifestHash`.
   */
  produceAll(): number {
    let produced = 0;
    for (let pageId = 0; pageId < this.pageCount; pageId++) {
      if (this.pageStatus(pageId) === WEB_GEOMETRY_COOK_PAGE_PENDING) {
        const page = this.producePage(pageId);
        if (page.status === WEB_GEOMETRY_COOK_PAGE_READY) produced++;
      }
    }
    return produced;
  }
}

export function cookWebGeometryWasmV1(module: EmscriptenWebGeometryCookerModuleV1, canonicalInput: ArrayBuffer, recipeInput: ArrayBuffer, maxDecodedProductBytes: number): WebGeometryCookWasmResultV1 {
  return withStagedInputs(module, canonicalInput, recipeInput, maxDecodedProductBytes, (canonicalAddress, recipeAddress) =>
    new WebGeometryCookWasmResultV1(
      module,
      requireHandle(
        module._oengine_web_geometry_cook(canonicalAddress, canonicalInput.byteLength, recipeAddress, recipeInput.byteLength, BigInt(maxDecodedProductBytes)),
        module)));
}

/**
 * Descriptor stage of the two-phase ABI (ADR-0017).
 *
 * Freezes the complete ID graph without producing any page payload, so the
 * caller can publish the descriptor immediately and then advance payloads
 * incrementally through {@link WebGeometryCookWasmPlanV1.producePage}.
 */
export function planWebGeometryWasmV1(module: EmscriptenWebGeometryCookerModuleV1, canonicalInput: ArrayBuffer, recipeInput: ArrayBuffer, maxDecodedProductBytes: number): WebGeometryCookWasmPlanV1 {
  return withStagedInputs(module, canonicalInput, recipeInput, maxDecodedProductBytes, (canonicalAddress, recipeAddress) =>
    new WebGeometryCookWasmPlanV1(
      module,
      requireHandle(
        module._oengine_web_geometry_cook_plan(canonicalAddress, canonicalInput.byteLength, recipeAddress, recipeInput.byteLength, BigInt(maxDecodedProductBytes)),
        module)));
}

function withStagedInputs<T>(
  module: EmscriptenWebGeometryCookerModuleV1,
  canonicalInput: ArrayBuffer,
  recipeInput: ArrayBuffer,
  maxDecodedProductBytes: number,
  run: (canonicalAddress: number, recipeAddress: number) => T): T {
  if (module._oengine_web_geometry_cook_abi_version() !== WEB_GEOMETRY_COOKER_ABI_VERSION) throw new Error("Web geometry cooker ABI version mismatch");
  if (!(canonicalInput instanceof ArrayBuffer) || !(recipeInput instanceof ArrayBuffer) || recipeInput.byteLength !== WEB_GEOMETRY_RECIPE_BYTES) throw new TypeError("Web geometry cooker inputs are invalid");
  if (!Number.isSafeInteger(maxDecodedProductBytes) || maxDecodedProductBytes < WEB_GEOMETRY_PAGE_BYTES) throw new RangeError("maxDecodedProductBytes must admit at least one page");
  const canonicalAddress = module._malloc(canonicalInput.byteLength), recipeAddress = module._malloc(recipeInput.byteLength);
  if (!canonicalAddress || !recipeAddress) {
    if (canonicalAddress) module._free(canonicalAddress);
    if (recipeAddress) module._free(recipeAddress);
    throw new Error("Web geometry cooker input allocation failed");
  }
  try {
    module.HEAPU8.set(new Uint8Array(canonicalInput), canonicalAddress);
    module.HEAPU8.set(new Uint8Array(recipeInput), recipeAddress);
    return run(canonicalAddress, recipeAddress);
  } finally {
    module._free(recipeAddress);
    module._free(canonicalAddress);
  }
}

function requireHandle(handle: number, module: EmscriptenWebGeometryCookerModuleV1): number {
  if (!handle) throw new Error(readLastError(module) || "Web geometry cook failed");
  return handle;
}

function readLastError(module: EmscriptenWebGeometryCookerModuleV1): string {
  const size = module._oengine_web_geometry_cook_last_error_size();
  if (!Number.isSafeInteger(size) || size <= 0) return "";
  const address = module._malloc(size);
  if (!address) return "Web geometry cooker error allocation failed";
  try {
    if (module._oengine_web_geometry_cook_copy_last_error(address, size) !== 1) return "Web geometry cooker error copy failed";
    return new TextDecoder().decode(module.HEAPU8.slice(address, address + size));
  } finally {
    module._free(address);
  }
}

function asU32(bytes: Uint8Array, name: string): Uint32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error(`${name} is not u32-aligned`);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

function requireHash(bytes: Uint8Array<ArrayBuffer>, name: string): Uint8Array<ArrayBuffer> { if (bytes.byteLength !== 32) throw new Error(`${name} must be exactly 32 bytes`); return bytes; }

function alignUp(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
function assertU32(value: number, name: string): void { if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be a u32`); }
function checkedU32Sum(a: number, b: number, name: string): number { const value = a + b; if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError(`${name} exceeds u32`); return value; }
