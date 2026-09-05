import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { captureGitBuildProvenance } from "./build-provenance.mjs";

const examplesRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(examplesRoot, "..");

const buildProvenance = captureGitBuildProvenance(repositoryRoot);

export default defineConfig({
  root: examplesRoot,
  // Keep every multi-page example relocatable (for example under Storybook's
  // /runtime/ mount) instead of baking root-relative asset URLs into HTML.
  base: "./",
  publicDir: false,
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildProvenance.commit),
    __BUILD_DIRTY__: JSON.stringify(buildProvenance.dirty),
    __BUILD_DIRTY_REASONS__: JSON.stringify(buildProvenance.dirtyReasons),
    __BUILD_CONTENT_HASH__: JSON.stringify(buildProvenance.contentHash)
  },
  server: {
    fs: { allow: [repositoryRoot] }
  },
  build: {
    outDir: path.resolve(examplesRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        basicScene: path.resolve(
          examplesRoot,
          "basic-scene/index.html"
        ),
        renderingLab: path.resolve(
          examplesRoot,
          "rendering-lab/index.html"
        ),
        modelLoading: path.resolve(
          examplesRoot,
          "model-loading/index.html"
        ),
        geometryPreprocess: path.resolve(
          examplesRoot,
          "geometry-preprocess/index.html"
        )
      }
    }
  }
});
