import { GLB_CHUNK_BIN, GLB_CHUNK_JSON, GLB_MAGIC } from "../GltfLoader.js";

export interface GlbRangeSourceOptions {
  readonly wholeSourceFallbackBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly init?: Omit<RequestInit, "headers">;
  /** Base URL used when a JSON glTF contains relative external resources. */
  readonly baseUrl?: string;
  /** Maximum span pulled in one authored-image prefetch; defaults to 8 MiB. */
  readonly imagePrefetchMaxBytes?: number;
  /** Maximum unused gap tolerated inside one authored-image prefetch; defaults to 256 KiB. */
  readonly imagePrefetchMaxGapBytes?: number;
}

export interface GlbRangeReadableSource {
  readonly url: string;
  readonly byteLength: number;
  readonly json: unknown;
  readonly jsonBytes: Uint8Array;
  readonly binByteOffset: number;
  readonly binByteLength: number;
  readonly buffers: readonly GlbBufferDescriptor[];
  readonly transferMode: "range" | "whole-source-fallback";
  readonly sourceIdentity: GlbSourceIdentity;
  readRange(byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  readBufferRange(bufferIndex: number, byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  release(): void;
}

export interface GlbBufferDescriptor {
  readonly index: number;
  readonly byteLength: number;
  readonly embedded: boolean;
  readonly uri?: string;
}

export interface GlbSourceIdentity {
  readonly kind: "strong-http-validator" | "session";
  readonly hash: Uint8Array;
  readonly etag?: string;
  readonly finalUrl: string;
}

const DEFAULT_FALLBACK_BYTES = 64 * 1024 * 1024;

export async function openGlbRangeSource(url: string, options: GlbRangeSourceOptions = {}): Promise<GlbRangeReadableSource> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fallbackBudget = options.wholeSourceFallbackBytes ?? DEFAULT_FALLBACK_BYTES;
  if (!Number.isInteger(fallbackBudget) || fallbackBudget <= 0) throw new RangeError("wholeSourceFallbackBytes must be positive");
  const source = new HttpGlbRangeSource(url, fetchImpl, options.init ?? {}, fallbackBudget, options.baseUrl);
  try { await source.initialize(); return source; } catch (error) { source.release(); throw error; }
}

class HttpGlbRangeSource implements GlbRangeReadableSource {
  #wholeBytes: Uint8Array | undefined;
  #released = false;
  #byteLength = 0;
  #jsonBytes = new Uint8Array();
  #json: unknown = undefined;
  #binByteOffset = -1;
  #binByteLength = 0;
  #identity!: GlbSourceIdentity;
  #buffers: GlbBufferDescriptor[] = [];
  #etag: string | undefined;
  #finalUrl: string;
  constructor(readonly url: string, readonly fetchImpl: typeof globalThis.fetch, readonly init: RequestInit, readonly fallbackBudget: number, readonly resourceBaseUrl?: string) { this.#finalUrl = url; }
  get byteLength(): number { return this.#byteLength; }
  get json(): unknown { return this.#json; }
  get jsonBytes(): Uint8Array { return this.#jsonBytes.slice(); }
  get binByteOffset(): number { return this.#binByteOffset; }
  get binByteLength(): number { return this.#binByteLength; }
  get buffers(): readonly GlbBufferDescriptor[] { return this.#buffers.map(buffer => Object.freeze({ ...buffer })); }
  get transferMode(): "range" | "whole-source-fallback" { return this.#wholeBytes === undefined ? "range" : "whole-source-fallback"; }
  get sourceIdentity(): GlbSourceIdentity { return Object.freeze({ ...this.#identity, hash: this.#identity.hash.slice() }); }

  async initialize(): Promise<void> {
    const header = new Uint8Array(await this.readRange(0, 12));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
      await this.initializeJsonGltf();
      return;
    }
    if (view.getUint32(4, true) !== 2) throw new Error("GLB range source only supports glTF 2.0");
    this.#byteLength = view.getUint32(8, true);
    if (this.#byteLength < 20) throw new Error("GLB declared length is too small");
    const chunks: { readonly type: number; readonly offset: number; readonly length: number }[] = [];
    let offset = 12;
    while (offset < this.#byteLength) {
      if (offset + 8 > this.#byteLength) throw new Error("GLB chunk header exceeds declared length");
      const chunkHeader = new DataView(await this.readRange(offset, 8));
      const length = chunkHeader.getUint32(0, true), type = chunkHeader.getUint32(4, true);
      if (length > this.#byteLength - offset - 8) throw new Error("GLB chunk exceeds declared length");
      chunks.push({ type, offset: offset + 8, length });
      offset += 8 + length;
    }
    if (offset !== this.#byteLength) throw new Error("GLB chunks do not cover declared length");
    const jsonChunk = chunks.find(chunk => chunk.type === GLB_CHUNK_JSON);
    if (!jsonChunk) throw new Error("GLB contains no JSON chunk");
    this.#jsonBytes = new Uint8Array(await this.readRange(jsonChunk.offset, jsonChunk.length));
    try { this.#json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#jsonBytes)); } catch (error) { throw new Error(`GLB JSON chunk is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    const binChunk = chunks.find(chunk => chunk.type === GLB_CHUNK_BIN);
    this.#binByteOffset = binChunk?.offset ?? -1;
    this.#binByteLength = binChunk?.length ?? 0;
    this.#buffers = parseBufferDescriptors(this.#json, this.#binByteLength, this.#finalUrl);
    if (this.#etag) this.#identity = await makeValidatorIdentity(this.#finalUrl, this.#byteLength, this.#etag);
    else this.#identity = await makeSessionIdentity(this.url, this.#byteLength);
  }

  async readBufferRange(bufferIndex: number, byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const buffer = this.#buffers[bufferIndex];
    if (!buffer) throw new RangeError(`GLB buffer ${bufferIndex} is out of range`);
    if (!Number.isInteger(byteOffset) || !Number.isInteger(byteLength) || byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > buffer.byteLength) throw new RangeError("GLB buffer range is outside the declared buffer");
    if (buffer.embedded) return this.readRange(this.#binByteOffset + byteOffset, byteLength, signal);
    if (!buffer.uri) throw new Error(`GLB buffer ${bufferIndex} has no source URI`);
    const cached = this.#externalBytes.get(bufferIndex);
    if (cached) return cached.slice(byteOffset, byteOffset + byteLength).buffer;
    if (buffer.uri.startsWith("data:")) {
      const bytes = decodeDataUri(buffer.uri);
      if (bytes.byteLength !== buffer.byteLength) throw new Error(`GLTF buffer ${bufferIndex} data URI length does not match byteLength`);
      this.#externalBytes.set(bufferIndex, bytes);
      return bytes.slice(byteOffset, byteOffset + byteLength).buffer;
    }
    return this.readExternalRange(buffer.uri, buffer.byteLength, byteOffset, byteLength, signal);
  }

  async initializeJsonGltf(): Promise<void> {
    let bytes = this.#wholeBytes;
    if (!bytes) {
      const response = await this.fetchImpl(this.url, { ...this.init, headers: { ...(this.init.headers ?? {}), "Accept-Encoding": "identity" } });
      if (!response.ok) throw new Error(`glTF JSON source failed with HTTP ${response.status}`);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > this.fallbackBudget) throw new Error(`glTF JSON source exceeds wholeSourceFallbackBytes=${this.fallbackBudget}`);
      this.#wholeBytes = body;
      this.#byteLength = body.byteLength;
      this.#captureIdentity(response, body.byteLength);
      bytes = body;
    }
    this.#byteLength = bytes.byteLength;
    this.#jsonBytes = bytes.slice();
    try { this.#json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (error) { throw new Error(`glTF JSON source is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    const baseUrl = (this.resourceBaseUrl ?? this.#finalUrl) || this.url;
    this.#buffers = parseBufferDescriptors(this.#json, 0, baseUrl);
    const declaredBytes = this.#buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    this.#byteLength = bytes.byteLength + declaredBytes;
    this.#binByteOffset = -1;
    this.#binByteLength = 0;
    this.#identity = await makeSessionIdentity(this.url, this.#byteLength);
  }

  async readRange(byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.#released) throw new Error("GLB range source has been released");
    if (!Number.isInteger(byteOffset) || !Number.isInteger(byteLength) || byteOffset < 0 || byteLength < 0 || (this.#byteLength > 0 && byteOffset + byteLength > this.#byteLength)) throw new RangeError("GLB range is outside the declared source");
    if (signal?.aborted) throw abortError(signal);
    if (this.#wholeBytes) return this.#wholeBytes.slice(byteOffset, byteOffset + byteLength).buffer;
    const end = byteOffset + byteLength - 1;
    if (byteLength === 0) return new ArrayBuffer(0);
    const response = await this.fetchImpl(this.url, { ...this.init, signal, headers: { ...(this.init.headers ?? {}), Range: `bytes=${byteOffset}-${end}`, "Accept-Encoding": "identity", ...(this.#etag === undefined ? {} : { "If-Range": this.#etag }) } });
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") throw new Error(`GLB range used forbidden Content-Encoding '${encoding}'`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/u);
      if (!match || Number(match[1]) !== byteOffset || Number(match[2]) !== end || bytes.byteLength !== byteLength || match[3] === "*") throw new Error("GLB range response Content-Range/length mismatch");
      const total = Number(match[3]);
      if (total < end + 1 || (this.#byteLength > 0 && total !== this.#byteLength)) throw new Error("GLB range response total length does not match the source");
      this.#captureIdentity(response, total);
      return bytes.buffer;
    }
    if (response.status !== 200) throw new Error(`GLB range request failed with HTTP ${response.status}`);
    if (this.#etag !== undefined) throw new Error("GLB source validator changed while reading ranges");
    if (bytes.byteLength > this.fallbackBudget) throw new Error(`GLB server ignored Range and returned ${bytes.byteLength} bytes above wholeSourceFallbackBytes=${this.fallbackBudget}`);
    this.#wholeBytes = bytes;
    this.#byteLength = bytes.byteLength;
    this.#captureIdentity(response, bytes.byteLength);
    if (byteOffset + byteLength > bytes.byteLength) throw new Error("GLB 200 fallback is shorter than requested range");
    return bytes.slice(byteOffset, byteOffset + byteLength).buffer;
  }

  #externalBytes = new Map<number, Uint8Array>();
  async readExternalRange(uri: string, declaredLength: number, byteOffset: number, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) throw abortError(signal);
    if (byteLength === 0) return new ArrayBuffer(0);
    const end = byteOffset + byteLength - 1;
    const response = await this.fetchImpl(uri, { ...this.init, signal, headers: { ...(this.init.headers ?? {}), Range: `bytes=${byteOffset}-${end}`, "Accept-Encoding": "identity" } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/u);
      if (!match || Number(match[1]) !== byteOffset || Number(match[2]) !== end || bytes.byteLength !== byteLength || match[3] === "*" || Number(match[3]) !== declaredLength) throw new Error("glTF external range response Content-Range/length mismatch");
      return bytes.buffer;
    }
    if (response.status !== 200) throw new Error(`glTF external buffer request failed with HTTP ${response.status}`);
    if (bytes.byteLength > this.fallbackBudget || bytes.byteLength !== declaredLength) throw new Error(`glTF external buffer fallback exceeds declared/budgeted length for ${uri}`);
    this.#externalBytes.set(this.#buffers.findIndex(buffer => buffer.uri === uri), bytes);
    return bytes.slice(byteOffset, byteOffset + byteLength).buffer;
  }

  release(): void { this.#released = true; this.#wholeBytes = undefined; this.#jsonBytes = new Uint8Array(); this.#json = undefined; this.#buffers = []; this.#externalBytes.clear(); }
  #captureIdentity(response: Response, totalLength: number | undefined): void { const etag = response.headers.get("etag") ?? undefined; if (this.#etag !== undefined && etag !== this.#etag) throw new Error("GLB source ETag changed while reading ranges"); if (etag && !etag.startsWith("W/") && totalLength !== undefined) { this.#etag = etag; this.#finalUrl = response.url || this.url; } }
}

function parseBufferDescriptors(json: unknown, embeddedBytes: number, baseUrl: string): GlbBufferDescriptor[] {
  if (!json || typeof json !== "object") throw new Error("GLB JSON root is invalid");
  const table = (json as { buffers?: unknown }).buffers;
  if (table === undefined && embeddedBytes === 0) return [];
  if (!Array.isArray(table)) throw new Error("GLB JSON has no valid buffers table");
  return table.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`GLB buffer ${index} is invalid`);
    const value = entry as { byteLength?: unknown; uri?: unknown };
    if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) throw new Error(`GLB buffer ${index} has an invalid byteLength`);
    const rawUri = typeof value.uri === "string" ? value.uri : undefined;
    const uri = rawUri === undefined ? undefined : resolveResourceUri(rawUri, baseUrl);
    const embedded = uri === undefined && index === 0 && embeddedBytes >= (value.byteLength as number);
    if (!embedded && uri === undefined) throw new Error(`GLB buffer ${index} is missing an embedded BIN chunk`);
    return Object.freeze({ index, byteLength: value.byteLength as number, embedded, ...(uri === undefined ? {} : { uri }) });
  });
}

function resolveResourceUri(uri: string, baseUrl: string): string { return uri.startsWith("data:") ? uri : new URL(uri, baseUrl).href; }
function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) throw new Error("Invalid data URI");
  const metadata = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);
  if (metadata.split(";").includes("base64")) {
    const binary = globalThis.atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

async function makeSessionIdentity(url: string, byteLength: number): Promise<GlbSourceIdentity> { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}\0${byteLength}\0${Math.random().toString(36)}`).buffer)); return { kind: "session", hash: digest, finalUrl: url }; }
async function makeValidatorIdentity(url: string, byteLength: number, etag: string): Promise<GlbSourceIdentity> { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}\0${byteLength}\0${etag}`).buffer)); return { kind: "strong-http-validator", hash: digest, etag, finalUrl: url }; }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"); }
