/**
 * Versioned, device-independent Runtime Asset Package kernel.
 *
 * The v1 content identity is SHA-256 over canonical metadata plus each full
 * section SHA-256. It excludes padding and the stored hash field while the
 * validator separately requires canonical offsets and zero padding.
 */

export const RUNTIME_ASSET_FORMAT_VERSION = 1;
export const RUNTIME_ASSET_PACKAGE_SCHEMA_HASH = 0x76f894fa;
export const RUNTIME_ASSET_HEADER_SIZE = 96;
export const RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE = 48;

const RUNTIME_ASSET_ENDIANNESS_MARKER = 0x01020304;
const RUNTIME_ASSET_SECTION_REQUIRED = 1;
const RUNTIME_ASSET_KNOWN_SECTION_FLAGS = RUNTIME_ASSET_SECTION_REQUIRED;
const RUNTIME_ASSET_COMPRESSION_NONE = 0;
const MAX_SECTION_COUNT = 65535;
const MAX_ALIGNMENT = 1 << 20;
const CONTENT_HASH_OFFSET = 48;
const CONTENT_HASH_BYTES = 32;
const HEADER_RESERVED_OFFSET = CONTENT_HASH_OFFSET + CONTENT_HASH_BYTES;
const PACKAGE_MAGIC = new Uint8Array([
  0x4f, 0x45, 0x4e, 0x47, 0x49, 0x4e, 0x45, 0x00
]);

export type RuntimeAssetValidationSeverity = "warning" | "error";

export interface RuntimeAssetValidationIssue {
  readonly severity: RuntimeAssetValidationSeverity;
  readonly code: string;
  readonly message: string;
  readonly sectionType?: number;
}

export interface RuntimeAssetValidationReport {
  readonly valid: boolean;
  readonly issues: readonly RuntimeAssetValidationIssue[];
}

export interface RuntimeAssetManifest {
  readonly formatVersion: number;
  readonly schemaHash: number;
  readonly flags: number;
  readonly sectionCount: number;
  readonly totalByteLength: number;
  readonly contentHash: string;
}

export interface RuntimeAssetSectionView {
  readonly type: number;
  readonly required: boolean;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly elementStride: number;
  readonly elementCount: number;
  readonly alignment: number;
  readonly compression: number;
  readonly checksum: number;
  /** Read-only by contract; mutating package bytes invalidates the package. */
  readonly bytes: Uint8Array;
}

export interface RuntimeAssetPackage {
  readonly manifest: RuntimeAssetManifest;
  readonly sections: readonly RuntimeAssetSectionView[];
  section(type: number): RuntimeAssetSectionView | undefined;
  validate(): RuntimeAssetValidationReport;
}

export interface RuntimeAssetPackageOpenOptions {
  /** Every required section type understood by the calling consumer. */
  readonly supportedSectionTypes: ReadonlySet<number>;
}

export interface RuntimeAssetSectionInput {
  readonly type: number;
  readonly required?: boolean;
  readonly data: ArrayBuffer | ArrayBufferView;
  readonly elementStride: number;
  readonly elementCount: number;
  readonly alignment?: number;
  readonly compression?: number;
}

export interface RuntimeAssetPackageWriteInput {
  readonly flags?: number;
  readonly sections: readonly RuntimeAssetSectionInput[];
}

export class RuntimeAssetPackageError extends Error {
  readonly report: RuntimeAssetValidationReport;

  constructor(report: RuntimeAssetValidationReport) {
    const first = report.issues.find((issue) => issue.severity === "error");
    super(first?.message ?? "Runtime Asset Package validation failed");
    this.name = "RuntimeAssetPackageError";
    this.report = report;
  }
}

interface SectionDescriptor {
  type: number;
  flags: number;
  byteOffset: number;
  byteLength: number;
  elementStride: number;
  elementCount: number;
  alignment: number;
  compression: number;
  checksum: number;
  rangeRepresentable?: boolean;
}

interface WritableSection extends SectionDescriptor {
  bytes: Uint8Array;
  digest: Uint8Array;
}

interface ParsedPackage {
  report: RuntimeAssetValidationReport;
  manifest: RuntimeAssetManifest | null;
  sections: RuntimeAssetSectionView[];
}

export async function writeRuntimeAssetPackage(
  input: RuntimeAssetPackageWriteInput
): Promise<ArrayBuffer> {
  const flags = input.flags ?? 0;
  assertU32(flags, "Package flags");
  if (flags !== 0) {
    throw new RangeError("Package flags must be zero for format v1");
  }
  if (input.sections.length > MAX_SECTION_COUNT) {
    throw new RangeError(
      `Package section count exceeds ${MAX_SECTION_COUNT}`
    );
  }

  const sorted = [...input.sections].sort((left, right) => left.type - right.type);
  const sections = new Array<WritableSection>(sorted.length);
  let cursor = safeAdd(
    RUNTIME_ASSET_HEADER_SIZE,
    safeMultiply(sorted.length, RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE)
  );
  let previousType = -1;
  for (let index = 0; index < sorted.length; index++) {
    const source = sorted[index]!;
    assertU32(source.type, `sections[${index}].type`);
    if (source.type === 0) {
      throw new RangeError("Section type 0 is reserved");
    }
    if (source.type === previousType) {
      throw new RangeError(`Duplicate section type ${source.type}`);
    }
    previousType = source.type;
    const alignment = source.alignment ?? 4;
    assertAlignment(alignment, `sections[${index}].alignment`);
    const compression = source.compression ?? RUNTIME_ASSET_COMPRESSION_NONE;
    if (compression !== RUNTIME_ASSET_COMPRESSION_NONE) {
      throw new RangeError(
        `sections[${index}].compression is unsupported in format v1`
      );
    }
    assertPositiveU32(source.elementStride, `sections[${index}].elementStride`);
    assertU32(source.elementCount, `sections[${index}].elementCount`);
    const bytes = copyBytes(source.data);
    const expectedByteLength = safeMultiply(
      source.elementStride,
      source.elementCount
    );
    if (bytes.byteLength !== expectedByteLength) {
      throw new RangeError(
        `Section byte length ${bytes.byteLength} must equal elementStride × elementCount (${expectedByteLength})`
      );
    }
    cursor = alignUp(cursor, alignment);
    const digest = await sha256(bytes);
    sections[index] = {
      type: source.type,
      flags: source.required === false ? 0 : RUNTIME_ASSET_SECTION_REQUIRED,
      byteOffset: cursor,
      byteLength: bytes.byteLength,
      elementStride: source.elementStride,
      elementCount: source.elementCount,
      alignment,
      compression,
      checksum: digestU32(digest),
      bytes,
      digest
    };
    cursor = safeAdd(cursor, bytes.byteLength);
  }

  const output = new ArrayBuffer(cursor);
  const view = new DataView(output);
  const outputBytes = new Uint8Array(output);
  outputBytes.set(PACKAGE_MAGIC, 0);
  view.setUint32(8, RUNTIME_ASSET_FORMAT_VERSION, true);
  view.setUint32(12, RUNTIME_ASSET_PACKAGE_SCHEMA_HASH, true);
  view.setUint32(16, RUNTIME_ASSET_ENDIANNESS_MARKER, true);
  view.setUint32(20, flags, true);
  view.setUint32(24, sections.length, true);
  view.setUint32(28, RUNTIME_ASSET_HEADER_SIZE, true);
  view.setUint32(
    32,
    sections.length * RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE,
    true
  );
  view.setUint32(36, 0, true);
  view.setBigUint64(40, BigInt(output.byteLength), true);

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    writeDirectoryEntry(
      view,
      RUNTIME_ASSET_HEADER_SIZE + index * RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE,
      section
    );
    outputBytes.set(section.bytes, section.byteOffset);
  }
  const contentHash = await calculateContentHash(
    RUNTIME_ASSET_FORMAT_VERSION,
    RUNTIME_ASSET_PACKAGE_SCHEMA_HASH,
    flags,
    sections,
    sections.map((section) => section.digest)
  );
  outputBytes.set(contentHash, CONTENT_HASH_OFFSET);
  return output;
}

export async function validateRuntimeAssetPackage(
  bytes: ArrayBuffer,
  options: RuntimeAssetPackageOpenOptions
): Promise<RuntimeAssetValidationReport> {
  return (await parseAndValidate(bytes, options)).report;
}

export async function openRuntimeAssetPackage(
  bytes: ArrayBuffer,
  options: RuntimeAssetPackageOpenOptions
): Promise<RuntimeAssetPackage> {
  const parsed = await parseAndValidate(bytes, options);
  if (!parsed.report.valid || parsed.manifest === null) {
    throw new RuntimeAssetPackageError(parsed.report);
  }
  return new OpenedRuntimeAssetPackage(
    parsed.manifest,
    parsed.sections,
    parsed.report
  );
}

class OpenedRuntimeAssetPackage implements RuntimeAssetPackage {
  readonly manifest: RuntimeAssetManifest;
  readonly sections: readonly RuntimeAssetSectionView[];
  private readonly sectionsByType = new Map<number, RuntimeAssetSectionView>();

  constructor(
    manifest: RuntimeAssetManifest,
    sections: RuntimeAssetSectionView[],
    private readonly report: RuntimeAssetValidationReport
  ) {
    this.manifest = Object.freeze(manifest);
    this.sections = Object.freeze(sections);
    for (const section of sections) this.sectionsByType.set(section.type, section);
  }

  section(type: number): RuntimeAssetSectionView | undefined {
    return this.sectionsByType.get(type);
  }

  validate(): RuntimeAssetValidationReport {
    return this.report;
  }
}

async function parseAndValidate(
  buffer: ArrayBuffer,
  options: RuntimeAssetPackageOpenOptions
): Promise<ParsedPackage> {
  const issues: RuntimeAssetValidationIssue[] = [];
  const error = (code: string, message: string, sectionType?: number): void => {
    issues.push({ severity: "error", code, message, sectionType });
  };
  const warning = (code: string, message: string, sectionType?: number): void => {
    issues.push({ severity: "warning", code, message, sectionType });
  };
  if (buffer.byteLength < RUNTIME_ASSET_HEADER_SIZE) {
    error(
      "header-too-small",
      `Package is ${buffer.byteLength} bytes; header requires ${RUNTIME_ASSET_HEADER_SIZE}`
    );
    return parsedResult(issues, null, []);
  }

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let index = 0; index < PACKAGE_MAGIC.length; index++) {
    if (bytes[index] !== PACKAGE_MAGIC[index]) {
      error("invalid-magic", "Runtime Asset Package magic is invalid");
      break;
    }
  }
  const formatVersion = view.getUint32(8, true);
  const schemaHash = view.getUint32(12, true);
  const endianness = view.getUint32(16, true);
  const flags = view.getUint32(20, true);
  const sectionCount = view.getUint32(24, true);
  const directoryOffset = view.getUint32(28, true);
  const directoryByteLength = view.getUint32(32, true);
  const headerReserved = view.getUint32(36, true);
  const totalByteLengthBig = view.getBigUint64(40, true);
  const storedContentHash = bytes.slice(
    CONTENT_HASH_OFFSET,
    CONTENT_HASH_OFFSET + CONTENT_HASH_BYTES
  );
  if (formatVersion !== RUNTIME_ASSET_FORMAT_VERSION) {
    error(
      "unsupported-format-version",
      `Unsupported package format version ${formatVersion}`
    );
  }
  if (schemaHash !== RUNTIME_ASSET_PACKAGE_SCHEMA_HASH) {
    error(
      "schema-hash-mismatch",
      `Package schema hash 0x${schemaHash.toString(16)} is not supported`
    );
  }
  if (endianness !== RUNTIME_ASSET_ENDIANNESS_MARKER) {
    error("endianness-mismatch", "Package endianness marker is invalid");
  }
  if (flags !== 0 || headerReserved !== 0) {
    error("unsupported-header-flags", "Package v1 header flags/reserved fields must be zero");
  }
  if (!paddingIsZero(bytes, HEADER_RESERVED_OFFSET, RUNTIME_ASSET_HEADER_SIZE)) {
    error(
      "nonzero-header-reserved",
      "Package v1 trailing header reserved bytes must be zero"
    );
  }
  if (sectionCount > MAX_SECTION_COUNT) {
    error("section-count-overflow", `Package section count exceeds ${MAX_SECTION_COUNT}`);
  }
  if (directoryOffset !== RUNTIME_ASSET_HEADER_SIZE) {
    error(
      "directory-offset-noncanonical",
      `Package directory offset must be ${RUNTIME_ASSET_HEADER_SIZE}`
    );
  }
  const expectedDirectoryBytes = sectionCount * RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE;
  if (directoryByteLength !== expectedDirectoryBytes) {
    error(
      "directory-length-mismatch",
      `Directory byte length ${directoryByteLength} does not match section count`
    );
  }
  const totalByteLength = safeBigIntToNumber(totalByteLengthBig);
  if (totalByteLength === null || totalByteLength !== buffer.byteLength) {
    error(
      "total-length-mismatch",
      `Header total byte length ${totalByteLengthBig} does not match ${buffer.byteLength}`
    );
  }
  const directoryEnd = directoryOffset + directoryByteLength;
  if (
    directoryOffset > buffer.byteLength ||
    directoryByteLength > buffer.byteLength - directoryOffset
  ) {
    error("directory-out-of-range", "Package section directory is out of range");
    return parsedResult(issues, null, []);
  }

  const descriptors: SectionDescriptor[] = [];
  const digests: Uint8Array[] = [];
  const sectionViews: RuntimeAssetSectionView[] = [];
  const seenTypes = new Set<number>();
  let canonicalCursor = directoryEnd;
  let previousType = -1;
  for (let index = 0; index < sectionCount; index++) {
    const entryOffset = directoryOffset + index * RUNTIME_ASSET_DIRECTORY_ENTRY_SIZE;
    const descriptor = readDirectoryEntry(view, entryOffset);
    descriptors.push(descriptor);
    if (view.getUint32(entryOffset + 44, true) !== 0) {
      error("nonzero-directory-reserved", "Section directory reserved field must be zero", descriptor.type);
    }
    if (descriptor.type === 0) {
      error("reserved-section-type", "Section type 0 is reserved", descriptor.type);
    }
    if (seenTypes.has(descriptor.type)) {
      error("duplicate-section-type", `Duplicate section type ${descriptor.type}`, descriptor.type);
    }
    seenTypes.add(descriptor.type);
    if (descriptor.type <= previousType) {
      error(
        "section-order-noncanonical",
        "Section directory must be sorted by ascending type",
        descriptor.type
      );
    }
    previousType = descriptor.type;
    if ((descriptor.flags & ~RUNTIME_ASSET_KNOWN_SECTION_FLAGS) !== 0) {
      error("unsupported-section-flags", "Section contains unsupported flags", descriptor.type);
    }
    if (descriptor.compression !== RUNTIME_ASSET_COMPRESSION_NONE) {
      error("unsupported-compression", "Section compression is unsupported in v1", descriptor.type);
    }
    if (!isValidAlignment(descriptor.alignment)) {
      error("invalid-section-alignment", "Section alignment is invalid", descriptor.type);
    }
    if (descriptor.elementStride === 0) {
      error("invalid-element-stride", "Section element stride must be positive", descriptor.type);
    }
    const expectedLength = BigInt(descriptor.elementStride) * BigInt(descriptor.elementCount);
    if (expectedLength !== BigInt(descriptor.byteLength)) {
      error(
        "section-element-range-mismatch",
        "Section byte length does not equal stride × count",
        descriptor.type
      );
    }
    const paddingBegin = canonicalCursor;
    canonicalCursor = alignUp(canonicalCursor, Math.max(4, descriptor.alignment));
    if (descriptor.rangeRepresentable === false) {
      error(
        "section-range-overflow",
        "Section offset or length cannot be represented safely by the runtime",
        descriptor.type
      );
    }
    if (descriptor.byteOffset !== canonicalCursor) {
      error(
        "section-offset-noncanonical",
        `Section ${descriptor.type} offset ${descriptor.byteOffset} must be ${canonicalCursor}`,
        descriptor.type
      );
    }
    if (descriptor.byteOffset % Math.max(4, descriptor.alignment) !== 0) {
      error("section-offset-misaligned", "Section offset is not aligned", descriptor.type);
    }
    const rangeValid =
      descriptor.rangeRepresentable !== false &&
      descriptor.byteOffset >= directoryEnd &&
      descriptor.byteOffset <= buffer.byteLength &&
      descriptor.byteLength <= buffer.byteLength - descriptor.byteOffset;
    if (!rangeValid) {
      error("section-range-out-of-bounds", "Section byte range is out of package bounds", descriptor.type);
      digests.push(new Uint8Array(CONTENT_HASH_BYTES));
    } else {
      if (!paddingIsZero(bytes, paddingBegin, canonicalCursor)) {
        error("nonzero-section-padding", "Section alignment padding must be zero", descriptor.type);
      }
      const sectionBytes = new Uint8Array(
        buffer,
        descriptor.byteOffset,
        descriptor.byteLength
      );
      const digest = await sha256(sectionBytes);
      digests.push(digest);
      if (digestU32(digest) !== descriptor.checksum) {
        error(
          "section-checksum-mismatch",
          `Section ${descriptor.type} checksum does not match payload`,
          descriptor.type
        );
      }
      sectionViews.push(Object.freeze({
        type: descriptor.type,
        required: (descriptor.flags & RUNTIME_ASSET_SECTION_REQUIRED) !== 0,
        byteOffset: descriptor.byteOffset,
        byteLength: descriptor.byteLength,
        elementStride: descriptor.elementStride,
        elementCount: descriptor.elementCount,
        alignment: descriptor.alignment,
        compression: descriptor.compression,
        checksum: descriptor.checksum,
        bytes: sectionBytes
      }));
    }
    const nextCanonicalCursor = checkedSafeAdd(canonicalCursor, descriptor.byteLength);
    if (nextCanonicalCursor === null) {
      error("section-range-overflow", "Canonical section range overflows", descriptor.type);
      canonicalCursor = buffer.byteLength;
    } else {
      canonicalCursor = nextCanonicalCursor;
    }

    const supported = options.supportedSectionTypes;
    if (!supported.has(descriptor.type)) {
      if ((descriptor.flags & RUNTIME_ASSET_SECTION_REQUIRED) !== 0) {
        error(
          "unknown-required-section",
          `Required section type ${descriptor.type} is not supported`,
          descriptor.type
        );
      } else {
        warning(
          "unknown-optional-section",
          `Optional section type ${descriptor.type} is not supported and will be ignored by consumers`,
          descriptor.type
        );
      }
    }
  }
  if (canonicalCursor !== buffer.byteLength) {
    error(
      "trailing-or-missing-bytes",
      `Canonical section layout ends at ${canonicalCursor}, package ends at ${buffer.byteLength}`
    );
  }

  if (digests.length === descriptors.length) {
    const calculatedContentHash = await calculateContentHash(
      formatVersion,
      schemaHash,
      flags,
      descriptors,
      digests
    );
    if (!bytesEqual(storedContentHash, calculatedContentHash)) {
      error("content-hash-mismatch", "Package content hash does not match sections");
    }
  }

  const manifest: RuntimeAssetManifest = {
    formatVersion,
    schemaHash,
    flags,
    sectionCount,
    totalByteLength: totalByteLength ?? buffer.byteLength,
    contentHash: toHex(storedContentHash)
  };
  return parsedResult(issues, manifest, sectionViews);
}

function parsedResult(
  issues: RuntimeAssetValidationIssue[],
  manifest: RuntimeAssetManifest | null,
  sections: RuntimeAssetSectionView[]
): ParsedPackage {
  const frozenIssues = Object.freeze(issues.map((issue) => Object.freeze(issue)));
  return {
    report: Object.freeze({
      valid: !issues.some((issue) => issue.severity === "error"),
      issues: frozenIssues
    }),
    manifest,
    sections
  };
}

function writeDirectoryEntry(
  view: DataView,
  offset: number,
  section: SectionDescriptor
): void {
  view.setUint32(offset, section.type, true);
  view.setUint32(offset + 4, section.flags, true);
  view.setBigUint64(offset + 8, BigInt(section.byteOffset), true);
  view.setBigUint64(offset + 16, BigInt(section.byteLength), true);
  view.setUint32(offset + 24, section.elementStride, true);
  view.setUint32(offset + 28, section.elementCount, true);
  view.setUint32(offset + 32, section.alignment, true);
  view.setUint32(offset + 36, section.compression, true);
  view.setUint32(offset + 40, section.checksum, true);
  view.setUint32(offset + 44, 0, true);
}

function readDirectoryEntry(view: DataView, offset: number): SectionDescriptor {
  const byteOffset = safeBigIntToNumber(view.getBigUint64(offset + 8, true));
  const byteLength = safeBigIntToNumber(view.getBigUint64(offset + 16, true));
  return {
    type: view.getUint32(offset, true),
    flags: view.getUint32(offset + 4, true),
    byteOffset: byteOffset ?? Number.MAX_SAFE_INTEGER,
    byteLength: byteLength ?? Number.MAX_SAFE_INTEGER,
    elementStride: view.getUint32(offset + 24, true),
    elementCount: view.getUint32(offset + 28, true),
    alignment: view.getUint32(offset + 32, true),
    compression: view.getUint32(offset + 36, true),
    checksum: view.getUint32(offset + 40, true),
    rangeRepresentable: byteOffset !== null && byteLength !== null
  };
}

async function calculateContentHash(
  formatVersion: number,
  schemaHash: number,
  flags: number,
  sections: readonly SectionDescriptor[],
  digests: readonly Uint8Array[]
): Promise<Uint8Array> {
  const bytes = new Uint8Array(16 + 72 * sections.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, formatVersion, true);
  view.setUint32(4, schemaHash, true);
  view.setUint32(8, flags, true);
  view.setUint32(12, sections.length, true);
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    const offset = 16 + index * 72;
    view.setUint32(offset, section.type, true);
    view.setUint32(offset + 4, section.flags, true);
    view.setBigUint64(offset + 8, BigInt(section.byteOffset), true);
    view.setBigUint64(offset + 16, BigInt(section.byteLength), true);
    view.setUint32(offset + 24, section.elementStride, true);
    view.setUint32(offset + 28, section.elementCount, true);
    view.setUint32(offset + 32, section.alignment, true);
    view.setUint32(offset + 36, section.compression, true);
    bytes.set(digests[index]!, offset + 40);
  }
  return sha256(bytes);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // All package views are backed by ArrayBuffer, so Web Crypto can consume the
  // existing range without a second full-section allocation during open.
  const view = bytes as Uint8Array<ArrayBuffer>;
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", view));
}

function digestU32(digest: Uint8Array): number {
  return new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, true);
}

function copyBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

function safeBigIntToNumber(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError("Package byte range overflow");
  return value;
}

function checkedSafeAdd(left: number, right: number): number | null {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : null;
}

function safeMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new RangeError("Package byte range overflow");
  return value;
}

function alignUp(value: number, alignment: number): number {
  return safeMultiply(Math.ceil(value / alignment), alignment);
}

function assertAlignment(value: number, name: string): void {
  if (!isValidAlignment(value)) {
    throw new RangeError(`${name} must be a power of two in [4, ${MAX_ALIGNMENT}]`);
  }
}

function isValidAlignment(value: number): boolean {
  return Number.isInteger(value) &&
    value >= 4 &&
    value <= MAX_ALIGNMENT &&
    (value & (value - 1)) === 0;
}

function assertU32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be a u32`);
  }
}

function assertPositiveU32(value: number, name: string): void {
  assertU32(value, name);
  if (value === 0) throw new RangeError(`${name} must be positive`);
}

function paddingIsZero(bytes: Uint8Array, begin: number, end: number): boolean {
  if (begin < 0 || end < begin || end > bytes.length) return false;
  for (let index = begin; index < end; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}
