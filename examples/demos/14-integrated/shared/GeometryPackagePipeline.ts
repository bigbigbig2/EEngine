import {
  GEOMETRY_COOKER_VERSION,
  createGeometryCookRecipe,
  geometryCookRecipeKey,
  openGeometryAssetPackage,
  type GeometryAssetPackage,
  type GeometryCookRecipe,
  type SourceGeometry
} from "../../../../OEngine/src/index.ts";

const CACHE_DATABASE = "oengine-example-geometry-v1";
const CACHE_STORE = "packages";
const MANIFEST_FORMAT = "oengine-geometry-set-v1";
const PRECOOK_FETCH_CONCURRENCY = 8;

export interface GeometryPackageProgress {
  readonly stage: "pre-cooked" | "cache" | "cook";
  readonly completed: number;
  readonly total: number;
}

export interface GeometryPackagePipelineOptions {
  readonly cacheKey?: string;
  readonly manifestUrl?: string;
  readonly onProgress?: (progress: GeometryPackageProgress) => void;
}

interface GeometrySetManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly cookerVersion: string;
  readonly recipeKey: string;
  readonly geometries: readonly {
    readonly sourceId: string;
    readonly uri: string;
    readonly byteLength: number;
  }[];
}

type WorkerResponse =
  | Readonly<{ id: number; ok: true; bytes: ArrayBuffer }>
  | Readonly<{ id: number; ok: false; name: string; message: string; stack?: string }>;

export class GeometryPackagePipeline {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private disposed = false;

  async prepare(
    sources: readonly SourceGeometry[],
    options: Readonly<GeometryPackagePipelineOptions> = {}
  ): Promise<readonly GeometryAssetPackage[]> {
    const recipe = createGeometryCookRecipe();
    if (options.manifestUrl !== undefined) {
      try {
        return await loadPreCookedSet(
          options.manifestUrl,
          sources,
          recipe,
          options.onProgress
        );
      } catch (error) {
        console.warn(
          `Pre-cooked geometry set is unavailable; falling back to the Worker cooker cache.`,
          error
        );
      }
    }
    return this.prepareFromWorkerCache(sources, recipe, options);
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
  }

  private async prepareFromWorkerCache(
    sources: readonly SourceGeometry[],
    recipe: GeometryCookRecipe,
    options: Readonly<GeometryPackagePipelineOptions>
  ): Promise<readonly GeometryAssetPackage[]> {
    const recipeKey = geometryCookRecipeKey(recipe);
    const cache = options.cacheKey === undefined
      ? undefined
      : await openGeometryCache().catch(() => undefined);
    const packages: GeometryAssetPackage[] = [];
    for (let index = 0; index < sources.length; index++) {
      this.assertActive();
      const source = sources[index]!;
      const key = options.cacheKey === undefined
        ? undefined
        : geometryCacheEntryKey(options.cacheKey, recipeKey, index, source.sourceId);
      let asset: GeometryAssetPackage | undefined;
      if (cache !== undefined && key !== undefined) {
        const cached = await readCachedPackage(cache, key);
        if (cached !== undefined) {
          try {
            const opened = await openGeometryAssetPackage(cached);
            if (opened.runtime.manifest.sourceProvenance.uri !== source.sourceId) {
              throw new Error("cached geometry source identity does not match");
            }
            asset = opened;
            options.onProgress?.({ stage: "cache", completed: index + 1, total: sources.length });
          } catch {
            await deleteCachedPackage(cache, key);
          }
        }
      }
      if (asset === undefined) {
        options.onProgress?.({ stage: "cook", completed: index, total: sources.length });
        const bytes = await this.cookInWorker(source, recipe);
        asset = await openGeometryAssetPackage(bytes);
        if (cache !== undefined && key !== undefined) {
          await writeCachedPackage(cache, key, bytes).catch(() => undefined);
        }
        options.onProgress?.({ stage: "cook", completed: index + 1, total: sources.length });
      }
      packages.push(asset);
    }
    cache?.close();
    return Object.freeze(packages);
  }

  private cookInWorker(source: SourceGeometry, recipe: GeometryCookRecipe): Promise<ArrayBuffer> {
    this.assertActive();
    this.worker ??= new Worker(new URL("./GeometryCookWorker.ts", import.meta.url), {
      type: "module",
      name: "oengine-geometry-cooker"
    });
    const worker = this.worker;
    const id = this.nextRequestId++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponse>): void => {
        if (event.data.id !== id) return;
        cleanup();
        if (event.data.ok) {
          resolve(event.data.bytes);
          return;
        }
        const error = new Error(event.data.message);
        error.name = event.data.name;
        if (event.data.stack !== undefined) error.stack = event.data.stack;
        reject(error);
      };
      const onError = (event: ErrorEvent): void => {
        cleanup();
        reject(event.error instanceof Error ? event.error : new Error(event.message));
      };
      const cleanup = (): void => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ id, source, recipe });
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Geometry package preparation was cancelled");
  }
}

async function loadPreCookedSet(
  manifestUrl: string,
  sources: readonly SourceGeometry[],
  recipe: GeometryCookRecipe,
  onProgress: GeometryPackagePipelineOptions["onProgress"]
): Promise<readonly GeometryAssetPackage[]> {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch geometry manifest: HTTP ${response.status}`);
  }
  const manifest = await response.json() as GeometrySetManifest;
  if (
    manifest.format !== MANIFEST_FORMAT ||
    manifest.cookerVersion !== GEOMETRY_COOKER_VERSION ||
    manifest.recipeKey !== geometryCookRecipeKey(recipe) ||
    manifest.geometries.length !== sources.length
  ) {
    throw new Error("Pre-cooked geometry manifest does not match the current source/recipe ABI");
  }
  for (let index = 0; index < sources.length; index++) {
    if (manifest.geometries[index]!.sourceId !== sources[index]!.sourceId) {
      throw new Error(`Pre-cooked geometry source identity differs at index ${index}`);
    }
  }

  const output = new Array<GeometryAssetPackage>(sources.length);
  let next = 0;
  let completed = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= manifest.geometries.length) return;
      const entry = manifest.geometries[index]!;
      const packageResponse = await fetch(new URL(entry.uri, manifestUrl));
      if (!packageResponse.ok) {
        throw new Error(`Failed to fetch geometry package ${index}: HTTP ${packageResponse.status}`);
      }
      const bytes = await packageResponse.arrayBuffer();
      if (bytes.byteLength !== entry.byteLength) {
        throw new Error(`Geometry package ${index} byte length does not match its manifest`);
      }
      const asset = await openGeometryAssetPackage(bytes);
      if (asset.runtime.manifest.sourceProvenance.uri !== entry.sourceId) {
        throw new Error(`Geometry package ${index} source identity does not match its manifest`);
      }
      output[index] = asset;
      completed++;
      onProgress?.({ stage: "pre-cooked", completed, total: sources.length });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(PRECOOK_FETCH_CONCURRENCY, sources.length) },
    () => run()
  ));
  return Object.freeze(output);
}

function geometryCacheEntryKey(
  sourceSetKey: string,
  recipeKey: string,
  index: number,
  sourceId: string
): string {
  return `${sourceSetKey}\0${GEOMETRY_COOKER_VERSION}\0${recipeKey}\0${index}\0${sourceId}`;
}

function openGeometryCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
        request.result.createObjectStore(CACHE_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function readCachedPackage(database: IDBDatabase, key: string): Promise<ArrayBuffer | undefined> {
  return cacheRequest<ArrayBuffer | undefined>(database, "readonly", (store) => store.get(key));
}

function writeCachedPackage(database: IDBDatabase, key: string, bytes: ArrayBuffer): Promise<void> {
  return cacheRequest(database, "readwrite", (store) => store.put(bytes, key)).then(() => undefined);
}

function deleteCachedPackage(database: IDBDatabase, key: string): Promise<void> {
  return cacheRequest(database, "readwrite", (store) => store.delete(key)).then(() => undefined);
}

function cacheRequest<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  create: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = create(database.transaction(CACHE_STORE, mode).objectStore(CACHE_STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}
