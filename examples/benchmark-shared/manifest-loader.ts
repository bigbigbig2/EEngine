import {
  validateBenchmarkSceneManifest,
  type BenchmarkSceneManifest
} from "../../OEngine/src/index.ts";

export async function loadBenchmarkSceneManifest(
  url: URL
): Promise<BenchmarkSceneManifest> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load benchmark manifest: ${response.status} ${url}`);
  }
  return validateBenchmarkSceneManifest(await response.json());
}
