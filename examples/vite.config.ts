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
        pureGeometry: path.resolve(
          examplesRoot,
          "runtime/00-foundations/pure-geometry/index.html"
        ),
        directionalLight: path.resolve(
          examplesRoot,
          "runtime/00-foundations/directional-light/index.html"
        ),
        baseColorSanity: path.resolve(
          examplesRoot,
          "runtime/00-foundations/base-color-sanity/index.html"
        ),
        sourceGeometry: path.resolve(
          examplesRoot,
          "runtime/01-geometry/source-geometry/index.html"
        ),
        vertexAttributes: path.resolve(
          examplesRoot,
          "runtime/01-geometry/vertex-attributes/index.html"
        ),
        meshletPartition: path.resolve(
          examplesRoot,
          "runtime/01-geometry/meshlet-partition/index.html"
        ),
        meshletBounds: path.resolve(
          examplesRoot,
          "runtime/01-geometry/meshlet-bounds/index.html"
        ),
        meshletCone: path.resolve(
          examplesRoot,
          "runtime/01-geometry/meshlet-cone/index.html"
        ),
        clusterBuild: path.resolve(
          examplesRoot,
          "runtime/01-geometry/cluster-build/index.html"
        ),
        clusterHierarchy: path.resolve(
          examplesRoot,
          "runtime/01-geometry/cluster-hierarchy/index.html"
        ),
        sseLodSelection: path.resolve(
          examplesRoot,
          "runtime/01-geometry/sse-lod-selection/index.html"
        ),
        bvh8: path.resolve(
          examplesRoot,
          "runtime/01-geometry/bvh8/index.html"
        ),
        runtimeAssetPackage: path.resolve(
          examplesRoot,
          "runtime/01-geometry/runtime-asset-package/index.html"
        ),
        packageValidation: path.resolve(
          examplesRoot,
          "runtime/01-geometry/package-validation/index.html"
        ),
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
        ),
        minimalScene: path.resolve(
          examplesRoot,
          "minimal-scene/index.html"
        )
      }
    }
  }
});
