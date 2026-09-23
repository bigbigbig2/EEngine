import { WEB_GEOMETRY_PAGE_BYTES } from "../web-cook/wasm/WebGeometryCookerAbi.js";

/**
 * Page artifacts are the only payload that may outlive a WASM cook call.  The
 * key deliberately contains the complete Product revision identity; a local
 * PageID is never sufficient to address a spill entry.
 */
export interface WebGeometryPageSpillKeyV1 {
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageId: number;
  /** Runtime session generation. It prevents a late retry from mixing epochs. */
  readonly sessionGeneration?: number;
}

export interface WebGeometryPageArtifactInputV1 extends WebGeometryPageSpillKeyV1 {
  readonly decodedHash128: Uint8Array;
  /** Optional transport digest. The store computes and verifies it when present. */
  readonly decodedPageHash128?: Uint8Array;
  readonly bytes: ArrayBuffer;
}

export interface WebGeometryPageArtifactV1 extends WebGeometryPageSpillKeyV1 {
  readonly decodedHash128: Uint8Array;
  readonly decodedPageHash128: Uint8Array;
  /** Full SHA-256 payload checksum persisted in the artifact envelope. */
  readonly payloadChecksum: Uint8Array;
  readonly bytes: ArrayBuffer;
}

export interface WebGeometryPageSpillEvidenceV1 {
  readonly backend: "memory" | "opfs";
  /** Encoded artifact bytes currently owned by this store. */
  readonly currentBytes: number;
  readonly peakBytes: number;
  readonly limitBytes: number;
  readonly ownerCount: number;
  readonly writes: number;
  readonly reads: number;
  readonly releases: number;
  readonly failures: number;
}

/**
 * Producer-neutral page artifact storage.  `put` is idempotent for the same
 * key and checksum, but rejects a mixed-generation or mixed-payload collision.
 * Implementations must return independent ArrayBuffers from `read`.
 */
export interface WebGeometryPageSpillStoreV1 {
  readonly backend: "memory" | "opfs";
  readonly limitBytes: number;
  put(input: WebGeometryPageArtifactInputV1): Promise<WebGeometryPageArtifactV1>;
  read(key: WebGeometryPageSpillKeyV1): Promise<WebGeometryPageArtifactV1 | null>;
  release(key: WebGeometryPageSpillKeyV1): Promise<void>;
  dispose(): Promise<void>;
  evidence(): WebGeometryPageSpillEvidenceV1;
}

export interface WebGeometryPageSpillStoreOptionsV1 {
  readonly maxBytes: number;
}

export const WEB_GEOMETRY_PAGE_ARTIFACT_VERSION_V1 = 1;
const ARTIFACT_MAGIC = new Uint8Array([0x4f, 0x45, 0x47, 0x50, 0x41, 0x47, 0x31, 0x00]);
const ARTIFACT_HEADER_BYTES = 144;
const INVALID_U32 = 0xffffffff;

/** In-memory spill used by tests, small assets, and explicit fallback paths. */
export class MemoryWebGeometryPageSpillStoreV1 implements WebGeometryPageSpillStoreV1 {
  readonly backend = "memory" as const;
  readonly limitBytes: number;
  readonly #entries = new Map<string, { readonly artifact: WebGeometryPageArtifactV1; readonly encodedBytes: number }>();
  #currentBytes = 0;
  #peakBytes = 0;
  #writes = 0;
  #reads = 0;
  #releases = 0;
  #failures = 0;

  constructor(options: WebGeometryPageSpillStoreOptionsV1) {
    this.limitBytes = assertLimit(options.maxBytes);
  }

  async put(input: WebGeometryPageArtifactInputV1): Promise<WebGeometryPageArtifactV1> {
    try {
      const artifact = await normalizeArtifact(input);
      const key = pageKey(artifact);
      const encodedBytes = encodedArtifactBytes(artifact.bytes.byteLength);
      const existing = this.#entries.get(key);
      if (existing !== undefined) {
        if (!sameBytes(existing.artifact.payloadChecksum, artifact.payloadChecksum) || !sameBytes(existing.artifact.decodedHash128, artifact.decodedHash128)) throw new Error("spill artifact key collides with a different payload or generation");
        this.#writes++;
        return cloneArtifact(existing.artifact);
      }
      if (encodedBytes > this.limitBytes - this.#currentBytes) throw new Error(`spill store exceeds maxBytes=${this.limitBytes}`);
      const stored = cloneArtifact(artifact);
      this.#entries.set(key, { artifact: stored, encodedBytes });
      this.#currentBytes += encodedBytes;
      this.#peakBytes = Math.max(this.#peakBytes, this.#currentBytes);
      this.#writes++;
      return cloneArtifact(stored);
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async read(key: WebGeometryPageSpillKeyV1): Promise<WebGeometryPageArtifactV1 | null> {
    try {
      assertKey(key);
      const entry = this.#entries.get(pageKey(key));
      this.#reads++;
      return entry === undefined ? null : cloneArtifact(entry.artifact);
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async release(key: WebGeometryPageSpillKeyV1): Promise<void> {
    try {
      assertKey(key);
      const id = pageKey(key), entry = this.#entries.get(id);
      if (entry !== undefined) {
        this.#entries.delete(id);
        this.#currentBytes -= entry.encodedBytes;
        this.#releases++;
      }
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#entries.clear();
    this.#currentBytes = 0;
  }

  evidence(): WebGeometryPageSpillEvidenceV1 {
    return Object.freeze({ backend: this.backend, currentBytes: this.#currentBytes, peakBytes: this.#peakBytes, limitBytes: this.limitBytes, ownerCount: this.#entries.size, writes: this.#writes, reads: this.#reads, releases: this.#releases, failures: this.#failures });
  }
}

export interface OpfsWebGeometryPageSpillStoreOptionsV1 extends WebGeometryPageSpillStoreOptionsV1 {
  readonly directory: FileSystemDirectoryHandle;
  readonly namespace?: string;
}

/**
 * OPFS-backed spill.  The envelope is self-validating because the File System
 * Access API has no portable atomic rename primitive. A partially written file
 * therefore fails closed on the next read instead of becoming a page.
 */
export class OpfsWebGeometryPageSpillStoreV1 implements WebGeometryPageSpillStoreV1 {
  readonly backend = "opfs" as const;
  readonly limitBytes: number;
  readonly #directory: FileSystemDirectoryHandle;
  readonly #namespace: string;
  readonly #owned = new Map<string, number>();
  #currentBytes = 0;
  #peakBytes = 0;
  #writes = 0;
  #reads = 0;
  #releases = 0;
  #failures = 0;

  constructor(options: OpfsWebGeometryPageSpillStoreOptionsV1) {
    this.limitBytes = assertLimit(options.maxBytes);
    this.#directory = options.directory;
    this.#namespace = sanitizeNamespace(options.namespace ?? "oengine-web-geometry-v1");
  }

  async put(input: WebGeometryPageArtifactInputV1): Promise<WebGeometryPageArtifactV1> {
    try {
      const artifact = await normalizeArtifact(input);
      const id = pageKey(artifact), name = this.fileName(artifact);
      const existing = await this.readFile(name);
      if (existing !== null) {
        if (!sameKey(existing, artifact) || !sameBytes(existing.payloadChecksum, artifact.payloadChecksum) || !sameBytes(existing.decodedHash128, artifact.decodedHash128)) throw new Error("OPFS spill artifact key collides with a different payload or generation");
        this.#writes++;
        return existing;
      }
      const encoded = encodeArtifact(artifact);
      if (encoded.byteLength > this.limitBytes - this.#currentBytes) throw new Error(`OPFS spill store exceeds maxBytes=${this.limitBytes}`);
      const handle = await this.#directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(encoded);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      this.#owned.set(id, encoded.byteLength);
      this.#currentBytes += encoded.byteLength;
      this.#peakBytes = Math.max(this.#peakBytes, this.#currentBytes);
      this.#writes++;
      return cloneArtifact(artifact);
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async read(key: WebGeometryPageSpillKeyV1): Promise<WebGeometryPageArtifactV1 | null> {
    try {
      assertKey(key);
      this.#reads++;
      const artifact = await this.readFile(this.fileName(key));
      if (artifact !== null && !sameKey(artifact, key)) throw new Error("OPFS page artifact key does not match the requested Product revision");
      return artifact;
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async release(key: WebGeometryPageSpillKeyV1): Promise<void> {
    try {
      assertKey(key);
      const id = pageKey(key), name = this.fileName(key), owned = this.#owned.get(id);
      try { await this.#directory.removeEntry(name); } catch (error) { if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error; }
      if (owned !== undefined && this.#owned.delete(id)) {
        this.#currentBytes -= owned;
        this.#releases++;
      }
    } catch (error) {
      this.#failures++;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    for (const id of [...this.#owned.keys()]) {
      const [product, revision, page, generation] = id.split(":");
      await this.release({ productId: fromHex(product!), revision: Number(revision), pageId: Number(page), ...(generation === undefined ? {} : { sessionGeneration: Number(generation) }) });
    }
    this.#owned.clear();
    this.#currentBytes = 0;
  }

  evidence(): WebGeometryPageSpillEvidenceV1 {
    return Object.freeze({ backend: this.backend, currentBytes: this.#currentBytes, peakBytes: this.#peakBytes, limitBytes: this.limitBytes, ownerCount: this.#owned.size, writes: this.#writes, reads: this.#reads, releases: this.#releases, failures: this.#failures });
  }

  private fileName(key: WebGeometryPageSpillKeyV1): string { return `${this.#namespace}-${pageKey(key).replaceAll(":", "-")}.page`; }

  private async readFile(name: string): Promise<WebGeometryPageArtifactV1 | null> {
    let handle: FileSystemFileHandle;
    try { handle = await this.#directory.getFileHandle(name); } catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
    const file = await handle.getFile();
    return decodeArtifact(await file.arrayBuffer());
  }
}

/** Select OPFS when the browser exposes it, with an explicit memory fallback. */
export async function createPreferredWebGeometryPageSpillStoreV1(options: WebGeometryPageSpillStoreOptionsV1): Promise<WebGeometryPageSpillStoreV1> {
  const storage = (globalThis.navigator as Navigator & { readonly storage?: StorageManager }).storage;
  const getDirectory = storage?.getDirectory;
  if (typeof getDirectory === "function") {
    try { return new OpfsWebGeometryPageSpillStoreV1({ maxBytes: options.maxBytes, directory: await getDirectory.call(storage) }); } catch { /* fall through to the bounded memory backend */ }
  }
  return new MemoryWebGeometryPageSpillStoreV1(options);
}

export function pageSpillKeyV1(key: WebGeometryPageSpillKeyV1): string { assertKey(key); return pageKey(key); }

async function normalizeArtifact(input: WebGeometryPageArtifactInputV1): Promise<WebGeometryPageArtifactV1> {
  assertKey(input);
  if (input.decodedHash128.byteLength !== 16) throw new RangeError("decodedHash128 must be exactly 16 bytes");
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength !== WEB_GEOMETRY_PAGE_BYTES) throw new RangeError(`page artifact bytes must be exactly ${WEB_GEOMETRY_PAGE_BYTES} bytes`);
  const bytes = input.bytes.slice(0), checksum = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const decodedPageHash128 = checksum.subarray(0, 16).slice();
  if (input.decodedPageHash128 !== undefined && (input.decodedPageHash128.byteLength !== 16 || !sameBytes(input.decodedPageHash128, decodedPageHash128))) throw new Error("page artifact payload checksum does not match decodedPageHash128");
  return Object.freeze({ productId: input.productId.slice(), revision: input.revision, pageId: input.pageId, ...(input.sessionGeneration === undefined ? {} : { sessionGeneration: input.sessionGeneration }), decodedHash128: input.decodedHash128.slice(), decodedPageHash128, payloadChecksum: checksum, bytes });
}

function encodeArtifact(artifact: WebGeometryPageArtifactV1): ArrayBuffer {
  const total = ARTIFACT_HEADER_BYTES + artifact.bytes.byteLength, output = new Uint8Array(total), view = new DataView(output.buffer);
  output.set(ARTIFACT_MAGIC, 0); view.setUint32(8, WEB_GEOMETRY_PAGE_ARTIFACT_VERSION_V1, true); view.setUint32(12, ARTIFACT_HEADER_BYTES, true); view.setUint32(16, total, true); view.setUint32(20, artifact.revision, true); view.setUint32(24, artifact.pageId, true); view.setUint32(28, artifact.sessionGeneration ?? INVALID_U32, true); view.setUint32(32, artifact.bytes.byteLength, true); output.set(artifact.productId, 36); output.set(artifact.decodedHash128, 68); output.set(artifact.decodedPageHash128, 84); output.set(artifact.payloadChecksum, 100); output.set(new Uint8Array(artifact.bytes), ARTIFACT_HEADER_BYTES); return output.buffer;
}

async function decodeArtifact(bytes: ArrayBuffer): Promise<WebGeometryPageArtifactV1> {
  if (bytes.byteLength < ARTIFACT_HEADER_BYTES || bytes.byteLength < new DataView(bytes).getUint32(16, true)) throw new Error("OPFS page artifact is truncated");
  const view = new DataView(bytes), header = view.getUint32(12, true), total = view.getUint32(16, true), payloadBytes = view.getUint32(32, true);
  if (!sameBytes(new Uint8Array(bytes, 0, 8), ARTIFACT_MAGIC) || view.getUint32(8, true) !== WEB_GEOMETRY_PAGE_ARTIFACT_VERSION_V1 || header !== ARTIFACT_HEADER_BYTES || total !== bytes.byteLength || payloadBytes !== WEB_GEOMETRY_PAGE_BYTES || header + payloadBytes !== total || !new Uint8Array(bytes, 132, ARTIFACT_HEADER_BYTES - 132).every(value => value === 0)) throw new Error("OPFS page artifact header is invalid");
  const productId = new Uint8Array(bytes.slice(36, 68)), decodedHash128 = new Uint8Array(bytes.slice(68, 84)), decodedPageHash128 = new Uint8Array(bytes.slice(84, 100)), payloadChecksum = new Uint8Array(bytes.slice(100, 132)), payload = bytes.slice(header);
  const computed = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", payload));
  if (!sameBytes(computed, payloadChecksum) || !sameBytes(computed.subarray(0, 16), decodedPageHash128)) throw new Error("OPFS page artifact payload checksum is invalid");
  const artifact: WebGeometryPageArtifactV1 = { productId, revision: view.getUint32(20, true), pageId: view.getUint32(24, true), ...(view.getUint32(28, true) === INVALID_U32 ? {} : { sessionGeneration: view.getUint32(28, true) }), decodedHash128, decodedPageHash128, payloadChecksum, bytes: payload };
  assertKey(artifact);
  return Object.freeze(artifact);
}

function cloneArtifact(artifact: WebGeometryPageArtifactV1): WebGeometryPageArtifactV1 { return Object.freeze({ ...artifact, productId: artifact.productId.slice(), decodedHash128: artifact.decodedHash128.slice(), decodedPageHash128: artifact.decodedPageHash128.slice(), payloadChecksum: artifact.payloadChecksum.slice(), bytes: artifact.bytes.slice(0) }); }
function encodedArtifactBytes(payloadBytes: number): number { return ARTIFACT_HEADER_BYTES + payloadBytes; }
function assertLimit(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("spill maxBytes must be a positive safe integer"); return value; }
function assertKey(key: WebGeometryPageSpillKeyV1): void { if (!(key.productId instanceof Uint8Array) || key.productId.byteLength !== 32) throw new RangeError("spill productId must be exactly 32 bytes"); if (!Number.isSafeInteger(key.revision) || key.revision < 0 || key.revision === INVALID_U32) throw new RangeError("spill revision is invalid"); if (!Number.isSafeInteger(key.pageId) || key.pageId < 0 || key.pageId === INVALID_U32) throw new RangeError("spill pageId is invalid"); if (key.sessionGeneration !== undefined && (!Number.isSafeInteger(key.sessionGeneration) || key.sessionGeneration < 0 || key.sessionGeneration === INVALID_U32)) throw new RangeError("spill sessionGeneration is invalid"); }
function pageKey(key: WebGeometryPageSpillKeyV1): string { return `${toHex(key.productId)}:${key.revision}:${key.pageId}${key.sessionGeneration === undefined ? "" : `:${key.sessionGeneration}`}`; }
function sameKey(left: WebGeometryPageSpillKeyV1, right: WebGeometryPageSpillKeyV1): boolean { return left.revision === right.revision && left.pageId === right.pageId && left.sessionGeneration === right.sessionGeneration && sameBytes(left.productId, right.productId); }
function toHex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string): Uint8Array { if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("spill ProductID is invalid"); return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)); }
function sanitizeNamespace(value: string): string { if (!/^[a-zA-Z0-9._-]+$/u.test(value)) throw new RangeError("OPFS spill namespace contains invalid characters"); return value; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }
