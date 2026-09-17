import type { GeometryProductProviderV1, GeometryProductRevisionSourceV1 } from "../geometry-product/GeometryProductV1.js";
import { WebCookClient, type WebCookClientEvidence, type WebCookClientOptions, type WebCookSceneCatalogSnapshot } from "./WebCookClient.js";

/**
 * Runtime-side handle for a Web GLB CookSession.
 *
 * The handle owns only the Worker transport and CPU Product provider. GPU
 * admission, residency and Scene publication remain explicit renderer-owner
 * operations, so disposing this handle can never destroy a GPU resource.
 */
export class WebCookRuntimeAsset implements GeometryProductProviderV1 {
  readonly #client: WebCookClient;
  readonly #url: string;

  private constructor(url: string, client: WebCookClient) {
    this.#url = url;
    this.#client = client;
  }

  static open(url: string, options: WebCookClientOptions): WebCookRuntimeAsset {
    if (typeof url !== "string" || url.length === 0) throw new TypeError("Web Cook asset URL must be a non-empty string");
    const client = new WebCookClient(options);
    try {
      client.open(url);
      return new WebCookRuntimeAsset(url, client);
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  get url(): string { return this.#url; }
  get state(): WebCookClientEvidence["state"] { return this.#client.state; }
  get catalog(): WebCookSceneCatalogSnapshot | undefined { return this.#client.catalog; }

  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    return this.#client.revisions(signal);
  }

  requestPages(productId: Uint8Array, revision: number, pageIds: Uint32Array, priority = 0): void {
    this.#client.requestPages(productId, revision, pageIds, priority);
  }

  setSourcePriority(assetKey: string, score: number, cameraHintRevision: number): void {
    this.#client.setSourcePriority(assetKey, score, cameraHintRevision);
  }

  cancel(reason = "asset-cancelled"): void { this.#client.cancel(reason); }
  dispose(): void { this.#client.dispose(); }
  evidence(): WebCookClientEvidence { return this.#client.evidence(); }
}
