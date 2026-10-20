import { OegPackV4Error, openOegPackV4, type OegPackV4, type RangeReadablePackV4 } from "../OegPackV4.js";
import { MemoryRangeReadablePackV4, HttpRangeReadablePackV4 } from "../OegPackV4.js";
import type {
  GeometryProductDescriptorV1,
  GeometryProductProviderV1,
  GeometryProductRevisionSourceV1,
} from "./GeometryProductV1.js";
import { descriptorFromOegPack, OegPackProductProvider } from "./OegPackProductProvider.js";
import { parseOegPackSceneManifestV4, type OegPackSceneManifestV4 } from "./OegPackSceneManifestV4.js";
import { cookedAssetPreparation } from "../codec/CookedAssetPreparation.js";

/**
 * Offline second-route source selection.
 *
 * The fork between the Web Runtime Cooker and the Native Offline Cooker happens
 * here and nowhere later: both produce a `GeometryProductProviderV1` that the
 * shared admission, residency, streaming and renderer path consumes.
 */
export type OegPackProductSourceSelectionV4 =
  | Readonly<{ kind: "http-range"; url: string; init?: Omit<RequestInit, "headers">; manifestUrl?: string }>
  | Readonly<{
      kind: "memory";
      bytes: ArrayBuffer | Uint8Array;
      manifest?: string | ArrayBuffer | Uint8Array;
    }>;

export interface OegPackProductAssetOptions {
  /** Explicit `scene.oescene` payload, overriding any selection-provided source. */
  readonly manifest?: string | ArrayBuffer | Uint8Array;
  readonly signal?: AbortSignal;
  /** When false, skips redundant whole-page SHA-256 after compressed CRC32 validation. Defaults to true. */
  readonly verifyPageSha256?: boolean;
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
  readonly #pack: OegPackV4;
  readonly #descriptor: GeometryProductDescriptorV1;
  readonly #provider: OegPackProductProvider;
  readonly #source: InstrumentedRangeSource;
  readonly #selectionKind: "http-range" | "memory";
  readonly #manifest: OegPackSceneManifestV4 | undefined;
  #state: "open" | "released" | "failed" = "open";
  #revisionsOffered = 0;
  #workerEvidence: () => { ranges?: number; encodedBytes?: number } = () => ({});

  private constructor(
    pack: OegPackV4,
    descriptor: GeometryProductDescriptorV1,
    source: InstrumentedRangeSource,
    selectionKind: "http-range" | "memory",
    manifest: OegPackSceneManifestV4 | undefined,
    selection: OegPackProductSourceSelectionV4,
    verifyPageSha256: boolean
  ) {
    this.#pack = pack;
    this.#descriptor = descriptor;
    if (selection.kind === "http-range") {
      const preparation = cookedAssetPreparation();
      const { signal: sourceSignal, ...init } = selection.init ?? {};
      const registration = {
        descriptor,
        pages: pack.pages,
        groups: pack.groups,
        formats: pack.vertexFormats,
        url: new URL(selection.url, globalThis.location?.href).href,
        init,
        verifyPageSha256
      };
      const sessions = new Map<string, () => void>();
      let completedRanges = 0;
      let completedBytes = 0;
      this.#workerEvidence = () => {
        let ranges = completedRanges;
        let encodedBytes = completedBytes;
        for (const session of sessions.keys()) {
          const metrics = preparation.sessionEvidence(session);
          ranges += metrics.ranges ?? 0;
          encodedBytes += metrics.encodedBytes ?? 0;
        }
        return { ranges, encodedBytes };
      };
      this.#provider = new OegPackProductProvider(pack, {
        open: () => {
          const session = preparation.openSession();
          const release = () => {
            if (!sessions.delete(session)) {
              return;
            }
            const metrics = preparation.sessionEvidence(session);
            completedRanges += metrics.ranges ?? 0;
            completedBytes += metrics.encodedBytes ?? 0;
            preparation.closeSession(session);
          };
          sessions.set(session, release);
          return {
            readPages: (ids, signal, priority) => {
              const combined =
                sourceSignal && signal ? AbortSignal.any([sourceSignal, signal]) : (sourceSignal ?? signal);
              return preparation.readGeometry(session, registration, ids, combined, priority);
            },
            release
          };
        },
        release: () => {
          for (const release of sessions.values()) {
            release();
          }
        }
      });
    } else {
      this.#provider = new OegPackProductProvider(pack);
    }
    this.#source = source;
    this.#selectionKind = selectionKind;
    this.#manifest = manifest;
  }

  static async open(
    selection: OegPackProductSourceSelectionV4,
    options: OegPackProductAssetOptions = {}
  ): Promise<OegPackProductAsset> {
    throwIfAborted(options.signal);
    const { source, selectionKind, defaultManifestUrl } = createSelectionSource(selection);
    let manifest: OegPackSceneManifestV4 | undefined;
    try {
      const pack = await openOegPackV4(source, {
        verifyPageSha256: options.verifyPageSha256,
        signal: options.signal
      });
      throwIfAborted(options.signal);
      const descriptor = descriptorFromOegPack(pack);
      const payload = options.manifest ?? ("manifest" in selection ? selection.manifest : undefined);
      if (payload !== undefined) manifest = parseOegPackSceneManifestV4(payload);
      else if (defaultManifestUrl !== undefined)
        manifest = parseOegPackSceneManifestV4(await fetchManifest(defaultManifestUrl, options.signal));
      return new OegPackProductAsset(
        pack,
        descriptor,
        source,
        selectionKind,
        manifest,
        selection,
        options.verifyPageSha256 !== false
      );
    } catch (error) {
      throw error instanceof OegPackV4Error
        ? error
        : new OegPackV4Error(
            `OEGPACK Offline Product source failed: ${error instanceof Error ? error.message : String(error)}`
          );
    }
  }

  get descriptor(): GeometryProductDescriptorV1 {
    return this.#descriptor;
  }
  get manifest(): OegPackSceneManifestV4 | undefined {
    return this.#manifest;
  }
  get pack(): OegPackV4 {
    return this.#pack;
  }
  get source(): RangeReadablePackV4 {
    return this.#source;
  }

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
      rangeReads: this.#source.reads + (this.#workerEvidence().ranges ?? 0),
      rangeReadBytes: this.#source.readBytes + (this.#workerEvidence().encodedBytes ?? 0),
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
export function load_oegpack_product(
  selection: OegPackProductSourceSelectionV4,
  options: OegPackProductAssetOptions = {},
): Promise<OegPackProductAsset> {
  return OegPackProductAsset.open(selection, options);
}

function createSelectionSource(selection: OegPackProductSourceSelectionV4): {
  readonly source: InstrumentedRangeSource;
  readonly selectionKind: "http-range" | "memory";
  readonly defaultManifestUrl: string | undefined;
} {
  if (!selection || typeof selection !== "object")
    throw new OegPackV4Error("OEGPACK Product source selection must be an object");
  if (selection.kind === "memory") {
    if (!(selection.bytes instanceof Uint8Array) && !(selection.bytes instanceof ArrayBuffer))
      throw new OegPackV4Error("memory source selection requires bytes");
    return {
      source: new InstrumentedRangeSource(new MemoryRangeReadablePackV4(selection.bytes)),
      selectionKind: "memory",
      defaultManifestUrl: undefined,
    };
  }
  if (selection.kind === "http-range") {
    if (typeof selection.url !== "string" || selection.url.length === 0)
      throw new OegPackV4Error("HTTP range source selection requires a URL");
    const manifestUrl =
      selection.manifestUrl ??
      new URL("scene.oescene", new URL(selection.url, globalThis.location?.href ?? "http://localhost/")).href;
    return {
      source: new InstrumentedRangeSource(new HttpRangeReadablePackV4(selection.url, selection.init)),
      selectionKind: "http-range",
      defaultManifestUrl: manifestUrl,
    };
  }
  throw new OegPackV4Error("unsupported OEGPACK Product source selection");
}

class InstrumentedRangeSource implements RangeReadablePackV4 {
  reads = 0;
  readBytes = 0;
  constructor(readonly inner: RangeReadablePackV4) {}
  async read(byteOffset: bigint, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const bytes = await this.inner.read(byteOffset, byteLength, signal);
    this.reads++;
    this.readBytes += bytes.byteLength;
    return bytes;
  }
}

async function fetchManifest(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, headers: { "Accept-Encoding": "identity" } });
  if (!response.ok) throw new OegPackV4Error(`failed to fetch scene.oescene (${response.status})`);
  return response.arrayBuffer();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
}
