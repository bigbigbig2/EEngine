import {
  createGeometryCookRecipeV3,
  type GeometryCookRecipeV3
} from "../../GeometryCookRecipe.js";

export const WEB_GEOMETRY_COOKER_ABI_VERSION = 1;
export const WEB_GEOMETRY_CANONICAL_HEADER_BYTES = 128;
export const WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES = 32;
export const WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS = 18;
export const WEB_GEOMETRY_CANONICAL_VERTEX_BYTES = WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS * 4;
export const WEB_GEOMETRY_RECIPE_BYTES = 96;
export const WEB_GEOMETRY_PAGE_BYTES = 262144;

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
  PageBytes = 9
}

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
}

export interface EmscriptenWebGeometryCookerModuleV1 {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(address: number): void;
  _oengine_web_geometry_cook_abi_version(): number;
  _oengine_web_geometry_cook(canonical: number, canonicalBytes: number, recipe: number, recipeBytes: number, maxDecodedProductBytes: bigint): number;
  _oengine_web_geometry_cook_destroy(handle: number): void;
  _oengine_web_geometry_cook_section_size(handle: number, section: number, index: number): number;
  _oengine_web_geometry_cook_copy_section(handle: number, section: number, index: number, output: number, outputBytes: number): number;
  _oengine_web_geometry_cook_page_count(handle: number): number;
  _oengine_web_geometry_cook_last_error_size(): number;
  _oengine_web_geometry_cook_copy_last_error(output: number, outputBytes: number): number;
}

export function encodeWebCanonicalGeometryV1(domains: readonly WebCanonicalGeometryDomainV1[]): ArrayBuffer {
  if (domains.length === 0 || domains.length > 0xffffffff) throw new RangeError("canonical geometry requires a non-empty u32 domain count");
  let vertexCount = 0, indexCount = 0;
  for (const domain of domains) {
    assertU32(domain.materialId, "materialId");
    assertU32(domain.meshletFlags, "meshletFlags");
    if (!Number.isInteger(domain.attributeMask) || domain.attributeMask <= 0 || domain.attributeMask > 0xffff) throw new RangeError("attributeMask must be a non-zero u16");
    if (!(domain.vertices instanceof Float32Array) || domain.vertices.length % WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS !== 0 || domain.vertices.length < WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS * 3) throw new RangeError("canonical domain vertices must contain at least three 18-f32 records");
    if (!(domain.indices instanceof Uint32Array) || domain.indices.length === 0 || domain.indices.length % 3 !== 0) throw new RangeError("canonical domain indices must be a non-empty triangle list");
    if (domain.generateNormals === ((domain.attributeMask & 2) !== 0)) throw new RangeError("generateNormals must be the inverse of the normal attribute bit");
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

/** Owns a Product in WASM memory and copies pages only when output credit exists. */
export class WebGeometryCookWasmResultV1 {
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
    return Object.freeze({
      assetRecords: this.copySection(Section.AssetRecords),
      rootNodeIds: asU32(this.copySection(Section.RootNodeIds), "rootNodeIds"),
      hierarchyNodes: this.copySection(Section.HierarchyNodes),
      groupDirectory: this.copySection(Section.GroupDirectory),
      pageRecords: this.copySection(Section.PageRecords),
      bootstrapPageIds,
      activationPageIds: bootstrapPageIds.slice(),
      vertexFormats: this.copySection(Section.VertexFormats),
      recipeHash: this.copySection(Section.RecipeHash)
    });
  }

  copyPage(pageId: number): ArrayBuffer {
    this.requireOpen();
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= this.pageCount) throw new RangeError("Web geometry pageId is out of range");
    const bytes = this.copySection(Section.PageBytes, pageId);
    if (bytes.byteLength !== WEB_GEOMETRY_PAGE_BYTES) throw new Error("Web geometry cooker emitted a non-256-KiB page");
    return bytes.buffer;
  }

  release(): void {
    if (this.#handle === 0) return;
    this.#module._oengine_web_geometry_cook_destroy(this.#handle);
    this.#handle = 0;
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

export function cookWebGeometryWasmV1(module: EmscriptenWebGeometryCookerModuleV1, canonicalInput: ArrayBuffer, recipeInput: ArrayBuffer, maxDecodedProductBytes: number): WebGeometryCookWasmResultV1 {
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
    const handle = module._oengine_web_geometry_cook(canonicalAddress, canonicalInput.byteLength, recipeAddress, recipeInput.byteLength, BigInt(maxDecodedProductBytes));
    if (!handle) throw new Error(readLastError(module) || "Web geometry cook failed");
    return new WebGeometryCookWasmResultV1(module, handle);
  } finally {
    module._free(recipeAddress);
    module._free(canonicalAddress);
  }
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

function alignUp(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
function assertU32(value: number, name: string): void { if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be a u32`); }
function checkedU32Sum(a: number, b: number, name: string): number { const value = a + b; if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError(`${name} exceeds u32`); return value; }
