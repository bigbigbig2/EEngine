export const SSSR_NOISE_TABLE_SHA256 = "11b613c467f85e4ad558dc7d3e5b046f0fc3207c607dbb289623fdff922cf612";

/** Immutable AMD 1spp Sobol + scrambling data. No ranking table is consumed.
 * Loading performs no GPU allocation; the reflection owner owns the upload. */
export async function loadSssrNoiseTables(): Promise<ArrayBuffer> {
  const response = await fetch(new URL("../assets/sssr/blue-noise.bin", import.meta.url));
  if (!response.ok) {
    throw new Error(`SSSR noise data fetch failed: ${response.status}`);
  }
  const data = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (data.byteLength !== 786432 || hash !== SSSR_NOISE_TABLE_SHA256) {
    throw new Error("SSSR fixed-source noise tables failed integrity verification");
  }
  return data;
}
