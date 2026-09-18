import { OegPackV3Error, openOegPackV3, type OegPackV3, type RangeReadablePackV3 } from "../OegPackV3.js";
import { MemoryRangeReadablePackV3, HttpRangeReadablePackV3 } from "../OegPackV3.js";
import type { GeometryProductDescriptorV1, GeometryProductProviderV1, GeometryProductRevisionSourceV1 } from "./GeometryProductV1.js";
import { descriptorFromOegPack, OegPackProductProvider } from "./OegPackProductProvider.js";
import { parseOegPackSceneManifestV3, type OegPackSceneManifestV3 } from "./OegPackSceneManifestV3.js";

/**
 * Offline second-route source selection.
 *
 * The fork between the Web Runtime Cooker and the Native Offline Cooker happens
 * here and nowhere later: both produce a `GeometryProductProviderV1` that the
 * shared admission, residency, streaming and renderer path consumes.
 */
export type OegPackProductSourceSelectionV3 =
  | Readonly<{ kind: "http-range"; url: string; init?: Omit<RequestInit, "headers">; manifestUrl?: string }>
  | Readonly<{ kind: "memory"; bytes: ArrayBuffer | Uint8Array; manifest?: string | ArrayBuffer | Uint8Array }>;

export interface OegPackProductAssetOptions {
  /** Explicit `scene.oescene` payload, overriding any selection-provided source. */
  readonly manifest?: string | ArrayBuffer | Uint8Array;
  readonly signal?: AbortSignal;
}

export interface OegPackProductAssetEvidenceV1 {
  readonly selection: "http-range" | "memory";
  readonly state: "open" | "released" | "failed";
  readonly productId: string;
  readonly revision: number;
  readonly pageCount: number;
  readonly bootstrapPageCount: number;
  readonly activationPageCount: number;
  readonly fileBytes: number;
  readonly rangeReads: number;
  readonly rangeReadBytes: number;
  readonly revisionsOffered: number;
  readonly manifestReady: boolean;
}

/**
 * Runtime-side handle for the pre-cooked OEGPACK Offline route.
 *
 * It owns only the range source and the parsed pack/manifest; GPU admission,
 * residency and Scene publication stay explicit renderer-owner operations, so
 * releasing this handle can never destroy a GPU resource. Source failures
 * propagate unchanged - the loader never substitutes another source or a lower
 * quality pack.
 */
export class OegPackProductAsset implements GeometryProductProviderV1 {
  readonly #pack: OegPackV3;
  readonly #descriptor: GeometryProductDescriptorV1;
  readonly #provider: OegPackProductProvider;
  readonly #source: InstrumentedRangeSource;
  readonly #selectionKind: "http-range" | "memory";
  readonly #manifest: OegPackSceneManifestV3 | undefined;
  #state: "open" | "released" | "failed" = "open";
  #revisionsOffered = 0;

  private constructor(pack: OegPackV3, descriptor: GeometryProductDescriptorV1, source: InstrumentedRangeSource, selectionKind: "http-range" | "memory", manifest: OegPackSceneManifestV3 | undefined) {
    this.#pack = pack;
    this.#descriptor = descriptor;
    this.#provider = new OegPackProductProvider(pack);
    this.#source = source;
    this.#selectionKind = selectionKind;
    this.#manifest = manifest;
  }

  static async open(selection: OegPackProductSourceSelectionV3, options: OegPackProductAssetOptions = {}): Promise<OegPackProductAsset> {
    throwIfAborted(options.signal);
    const { source, selectionKind, defaultManifestUrl } = createSelectionSource(selection);
    let manifest: OegPackSceneManifestV3 | undefined;
    try {
      const pack = await openOegPackV3(source);
      throwIfAborted(options.signal);
      const descriptor = descriptorFromOegPack(pack);
      const payload = options.manifest ?? ("manifest" in selection ? selection.manifest : undefined);
      if (payload !== undefined) manifest = parseOegPackSceneManifestV3(payload);
      else if (defaultManifestUrl !== undefined) manifest = parseOegPackSceneManifestV3(await fetchManifest(defaultManifestUrl, options.signal));
      return new OegPackProductAsset(pack, descriptor, source, selectionKind, manifest);
    } catch (error) {
      throw error instanceof OegPackV3Error ? error : new OegPackV3Error(`OEGPACK Offline Product source failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get descriptor(): GeometryProductDescriptorV1 { return this.#descriptor; }
  get manifest(): OegPackSceneManifestV3 | undefined { return this.#manifest; }
  get pack(): OegPackV3 { return this.#pack; }
  get source(): RangeReadablePackV3 { return this.#source; }

  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    if (this.#state !== "open") throw new Error(`OEGPACK Product asset is ${this.#state}`);
    const inner = this.#provider.revisions(signal);
    const asset = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<GeometryProductRevisionSourceV1> {
        const iterator = inner[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<GeometryProductRevisionSourceV1>> {
            const result = await iterator.next();
            if (!result.done) asset.#revisionsOffered++;
            return result;
          }
        };
      }
    };
  }

  evidence(): OegPackProductAssetEvidenceV1 {
    return Object.freeze({
      selection: this.#selectionKind,
      state: this.#state,
      productId: hex(this.#descriptor.productId),
      revision: this.#descriptor.revision,
      pageCount: this.#pack.pages.length,
      bootstrapPageCount: this.#pack.header.bootstrapPageCount,
      activationPageCount: this.#descriptor.activationPageIds.length,
      fileBytes: Number(this.#pack.header.fileBytes),
      rangeReads: this.#source.reads,
      rangeReadBytes: this.#source.readBytes,
      revisionsOffered: this.#revisionsOffered,
      manifestReady: this.#manifest !== undefined
    });
  }

  release(): void {
    if (this.#state === "released") return;
    this.#state = "released";
    this.#provider.release();
  }
}

/**
 * Opens the Offline second route from an explicit source selection. The
 * returned handle yields exactly one frozen revision: an OEGPACK pack is a
 * distributed artifact, not a live cook session.
 */
export function load_oegpack_product(selection: OegPackProductSourceSelectionV3, options: OegPackProductAssetOptions = {}): Promise<OegPackProductAsset> {
  return OegPackProductAsset.open(selection, options);
}

function createSelectionSource(selection: OegPackProductSourceSelectionV3): { readonly source: InstrumentedRangeSource; readonly selectionKind: "http-range" | "memory"; readonly defaultManifestUrl: string | undefined } {
  if (!selection || typeof selection !== "object") throw new OegPackV3Error("OEGPACK Product source selection must be an object");
  if (selection.kind === "memory") {
    if (!(selection.bytes instanceof Uint8Array) && !(selection.bytes instanceof ArrayBuffer)) throw new OegPackV3Error("memory source selection requires bytes");
    return { source: new InstrumentedRangeSource(new MemoryRangeReadablePackV3(selection.bytes)), selectionKind: "memory", defaultManifestUrl: undefined };
  }
  if (selection.kind === "http-range") {
    if (typeof selection.url !== "string" || selection.url.length === 0) throw new OegPackV3Error("HTTP range source selection requires a URL");
    const manifestUrl = selection.manifestUrl ?? new URL("scene.oescene", new URL(selection.url, globalThis.location?.href ?? "http://localhost/")).href;
    return { source: new InstrumentedRangeSource(new HttpRangeReadablePackV3(selection.url, selection.init)), selectionKind: "http-range", defaultManifestUrl: manifestUrl };
  }
  throw new OegPackV3Error(`OEGPACK Product source selection kind '${String((selection as { kind?: unknown }).kind)}' is not supported`);
}

async function fetchManifest(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { "Accept-Encoding": "identity" } });
  if (!response.ok) throw new OegPackV3Error(`scene manifest request failed (${response.status})`);
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") throw new OegPackV3Error(`scene manifest used forbidden Content-Encoding '${encoding}'`);
  return await response.text();
}

class InstrumentedRangeSource implements RangeReadablePackV3 {
  #reads = 0;
  #readBytes = 0;
  constructor(private readonly inner: RangeReadablePackV3) {}
  get reads(): number { return this.#reads; }
  get readBytes(): number { return this.#readBytes; }
  async read(byteOffset: bigint, byteLength: number): Promise<ArrayBuffer> {
    const bytes = await this.inner.read(byteOffset, byteLength);
    this.#reads++;
    this.#readBytes += bytes.byteLength;
    return bytes;
  }
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"); }
