import type { ImageTextureDirectory } from "./ImageTextureProduct.js";
import { ImageTexturePages, imagePageSource, type ImagePagePlan } from "./ImageTexturePages.js";
import { cookedAssetPreparation, type CookedAssetPreparation } from "./codec/CookedAssetPreparation.js";
import type { ImageTextureLease } from "./codec/ImageTexturePreparation.js";
import { imageTextureHash, writeImageTextureDirectory } from "./ImageTextureProduct.js";
import type { ImageTextureImportTask } from "./codec/ImageTextureImport.js";

/** Device-independent immutable ordinary/VT source. Owns one session in the existing
 * CPU preparation owner, never a GPU object or a second Worker pool. close retires
 * outstanding work and exclusive ready images; re-open to establish a new lifetime.
 * Directory bytes/hash and complete source domains are checked before registration. */
export class ImageTextureSource {
  readonly directory: ImageTextureDirectory;
  readonly pages: ImageTexturePages;
  readonly #session: string;
  #closed = false;

  private constructor(
    readonly identity: string,
    readonly url: string,
    directory: ImageTextureDirectory,
    private readonly preparation: CookedAssetPreparation
  ) {
    this.pages = new ImageTexturePages(directory);
    this.directory = this.pages.directory;
    this.#session = this.preparation.openSession();
    try {
      this.preparation.registerImageSource(this.#session, this.directory, this.pages.indexBytes);
    } catch (error) {
      this.preparation.closeSession(this.#session);
      throw error;
    }
  }

  static async open(
    url: string,
    identity: string,
    byteLength: number,
    signal?: AbortSignal,
    preparation = cookedAssetPreparation()
  ): Promise<ImageTextureSource> {
    const directory = await preparation.readImageDirectory(url, identity, byteLength, signal);
    return new ImageTextureSource(identity, new URL(url).href, directory, preparation);
  }

  static async importWeb(
    input: Omit<ImageTextureImportTask, "version" | "session" | "task">,
    signal?: AbortSignal,
    preparation = cookedAssetPreparation()
  ): Promise<{ source: ImageTextureSource; decodeMs: number }> {
    const session = preparation.openSession();
    try {
      const result = await preparation.importImage(session, input, signal);
      try {
        signal?.throwIfAborted();
        const identity = await imageTextureHash(writeImageTextureDirectory(result.directory));
        signal?.throwIfAborted();
        const source = new ImageTextureSource(identity, "https://local.invalid/image-import/", result.directory, preparation);
        try {
          preparation.registerLocalImagePayloads(source.#session, source.directory, result.payloads);
        } catch (error) {
          source.close();
          throw error;
        }
        return { source, decodeMs: result.decodeMs };
      } finally {
        result.release();
      }
    } finally {
      preparation.closeSession(session);
    }
  }

  read(
    items: readonly number[],
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<readonly ImageTextureLease[]> {
    if (this.#closed) {
      return Promise.reject(new Error("Image texture source is closed"));
    }
    return this.preparation.readImageItems(this.#session, this.directory, items, this.url, signal, priority);
  }

  readPage(
    page: ImagePagePlan,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<readonly ImageTextureLease[]> {
    if (imagePageSource(page) !== this.directory) {
      throw new Error("Image page belongs to another immutable source lifetime");
    }
    return this.read(page.owners, signal, priority);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.preparation.closeSession(this.#session);
    }
  }

  evidence() {
    return this.preparation.evidence();
  }
}
