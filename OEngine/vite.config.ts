import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const sourcePackage = JSON.parse(readFileSync(path.resolve(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  description: string;
  exports: Record<string, string>;
};

const distributableExports = Object.fromEntries(
  Object.entries(sourcePackage.exports).map(([subpath, sourceTarget]) => {
    if (sourceTarget.endsWith(".css")) {
      return [subpath, "./addons/inspector/inspector.css"];
    }
    return [
      subpath,
      {
        types: sourceTarget.replace(/^\.\/src\//, "./types/").replace(/\.ts$/, ".d.ts"),
        import: subpath === "." ? "./shade-reconstructed.js" : "./addons/inspector/index.js",
      },
    ];
  }),
);

const distributablePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  type: "module",
  main: "./shade-reconstructed.js",
  module: "./shade-reconstructed.js",
  types: "./types/index.d.ts",
  exports: distributableExports,
  sideEffects: ["./shade-reconstructed.js"],
};

const nativeAssets = [
  ["avif_dec.wasm", "src/loaders/avif_dec.wasm"],
  [
    "web-cook/oengine-web-geometry-cooker.mjs",
    "src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs",
  ],
  [
    "web-cook/oengine-web-geometry-cooker.wasm",
    "src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.wasm",
  ],
  ["assets/textures/stbn_unitvec1.bin", "src/render/assets/textures/stbn_unitvec1.bin"],
  ["assets/textures/stbn_unitvec2.bin", "src/render/assets/textures/stbn_unitvec2.bin"],
  ["assets/textures/stbn_unitvec3.bin", "src/render/assets/textures/stbn_unitvec3.bin"],
  ["assets/textures/stbn_vec1.bin", "src/render/assets/textures/stbn_vec1.bin"],
  ["assets/textures/stbn_vec2.bin", "src/render/assets/textures/stbn_vec2.bin"],
  ["assets/textures/stbn_vec3.bin", "src/render/assets/textures/stbn_vec3.bin"],
  ["assets/textures/split_sum.bin", "src/render/assets/textures/split_sum.bin"],
] as const;

const textureAssetUrlSource = "new URL(`./assets/textures/${name}`, import.meta.url).href";
const textureAssetUrlPlaceholder = "globalThis.__shade_re_texture_asset_url__(name)";
const avifWasmUrlSource = 'new URL("avif_dec.wasm", import.meta.url).href';
const avifWasmUrlPlaceholder = "globalThis.__shade_re_avif_wasm_url__";

/**
 * Native asset URLs must remain relative to the installed module so a
 * consuming bundler can collect them. Protect the expressions during this
 * library build, then restore them in the emitted bundle.
 */
const preserveConsumerAssetUrls = {
  name: "shade-preserve-consumer-asset-urls",
  enforce: "pre" as const,
  load(id: string) {
    if (id.endsWith("/render/STATIC_GRAPHICS_ENGINE_ASSETS.ts")) {
      const code = readFileSync(id, "utf8");
      if (!code.includes(textureAssetUrlSource)) {
        throw new Error("STATIC_GRAPHICS_ENGINE_ASSETS URL contract not found");
      }
      return code.replace(textureAssetUrlSource, textureAssetUrlPlaceholder);
    }
    if (id.endsWith("/loaders/avifDecoderModule.ts")) {
      const code = readFileSync(id, "utf8");
      if (!code.includes(avifWasmUrlSource)) {
        throw new Error("avif_dec.wasm URL contract not found");
      }
      return code.replace(avifWasmUrlSource, avifWasmUrlPlaceholder);
    }
    return null;
  },
  renderChunk(code: string) {
    const texturePattern = /globalThis\.__shade_re_texture_asset_url__\(([^)]+)\)/g;
    let restored = code.replace(
      texturePattern,
      (_match, name: string) => `new URL(\`./assets/textures/\${${name}}\`, import.meta.url).href`,
    );
    restored = restored.replaceAll(avifWasmUrlPlaceholder, avifWasmUrlSource);
    return restored === code ? null : { code: restored, map: null };
  },
};

// Library-mode URL rewriting otherwise inlines WASM, bypassing the bounded
// HTTP loader and duplicating the binary inside the generated Worker script.
function tiledZstdWorkerAsset(): Plugin {
  return {
    name: "shade-tiled-zstd-worker-asset",
    enforce: "pre",
    resolveFileUrl({ relativePath }) {
      return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`;
    },
    load(id) {
      const decoder = id.endsWith("/codec/TiledTextureDecoder.ts");
      const vendor = id.endsWith("/vendor/tiled-zstd/tiled_zstd.js");
      if (!decoder && !vendor) return null;
      const code = readFileSync(id, "utf8");
      const expression = decoder
        ? 'new URL("./vendor/tiled-zstd/tiled_zstd.wasm", import.meta.url)'
        : 'new URL("tiled_zstd.wasm",import.meta.url).href';
      if (!code.includes(expression)) throw new Error("Tiled Zstd WASM URL contract not found");
      const asset = this.emitFile({
        type: "asset",
        name: "tiled_zstd.wasm",
        source: readFileSync(path.resolve(root, "src/assets/codec/vendor/tiled-zstd/tiled_zstd.wasm")),
      });
      return code.replace(expression, `import.meta.ROLLUP_FILE_URL_${asset}`);
    },
  };
}

export default defineConfig({
  root,
  publicDir: false,
  worker: { format: "es", plugins: () => [tiledZstdWorkerAsset()] },
  plugins: [
    preserveConsumerAssetUrls,
    {
      name: "shade-native-assets",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: `${JSON.stringify(distributablePackage, null, 2)}\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: "addons/inspector/inspector.css",
          source: readFileSync(path.resolve(root, "src/addons/inspector/inspector.css")),
        });
        for (const [fileName, sourcePath] of nativeAssets) {
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(path.resolve(root, sourcePath)),
          });
        }
      },
    },
  ],
  build: {
    lib: {
      entry: {
        index: path.resolve(root, "src/index.ts"),
        "addons/inspector/index": path.resolve(root, "src/addons/inspector/index.ts"),
      },
      name: "ShadeReconstructed",
      formats: ["es"],
      fileName: (_format, entryName) =>
        entryName === "index" ? "shade-reconstructed.js" : `${entryName}.js`,
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name ?? "";
          if (name === "avif_dec.wasm") return "avif_dec.wasm";
          if (name.endsWith(".bin")) return "assets/textures/[name][extname]";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
