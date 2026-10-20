import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Preserve bounded canonical resampler HTTP assets in bundled Workers.
export function imageWorkerAssets() {
  return {
    name: "shade-image-worker-assets",
    apply: "build",
    enforce: "pre",
    resolveFileUrl({ relativePath }) {
      return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`;
    },
    load(id) {
      const assets = id.endsWith("/codec/ImageTextureResample.ts")
        ? ["image-resample/source.json", "image-resample/image_resample.wasm"]
        : id.endsWith("/codec/ImageTextureKtxImport.ts")
          ? ["image-ktx/source.json", "image-ktx/ktx_pc.wasm", "image-import/source.json", "image-import/image_decode.wasm"]
          : id.endsWith("/codec/GeometryZstd.ts")
            ? ["geometry-zstd/source.json", "geometry-zstd/geometry_zstd.wasm"]
            : null;
      if (!assets) return null;
      let code = readFileSync(id, "utf8");
      for (const name of assets) {
        const expression = `new URL("./vendor/${name}", import.meta.url)`;
        if (!code.includes(expression)) throw new Error("Canonical image Worker asset URL missing");
        const asset = this.emitFile({ type: "asset", name,
          source: readFileSync(path.resolve(root, "src/assets/codec/vendor/" + name)) });
        code = code.replaceAll(expression, `import.meta.ROLLUP_FILE_URL_${asset}`);
      }
      return code;
    }
  };
}

