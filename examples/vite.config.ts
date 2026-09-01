import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { captureGitBuildProvenance } from "./scripts/r5-fx01-gate-contract.mjs";

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
        index: path.resolve(examplesRoot, "index.html"),
        r0Observability: path.resolve(
          examplesRoot,
          "r0-observability/index.html"
        ),
        r0FrameSmoke: path.resolve(
          examplesRoot,
          "r0-frame-smoke/index.html"
        ),
        r1ComputeHzb: path.resolve(
          examplesRoot,
          "r1-compute-hzb/index.html"
        ),
        r2PackageKernel: path.resolve(
          examplesRoot,
          "r2-package-kernel/index.html"
        ),
        r2MeshletCooker: path.resolve(
          examplesRoot,
          "r2-meshlet-cooker/index.html"
        ),
        r2GeometryPackage: path.resolve(
          examplesRoot,
          "r2-geometry-package/index.html"
        ),
        r2GpuResidency: path.resolve(
          examplesRoot,
          "r2-gpu-residency/index.html"
        ),
        r2PackedScene: path.resolve(
          examplesRoot,
          "r2-packed-scene/index.html"
        ),
        r3HierarchicalWorkGeneration: path.resolve(
          examplesRoot,
          "r3-hierarchical-work-generation/index.html"
        ),
        r4HardwareOpaqueProducer: path.resolve(
          examplesRoot,
          "r4-hardware-opaque-producer/index.html"
        ),
        r4AlphaTestedVisibility: path.resolve(
          examplesRoot,
          "r4-alpha-tested-visibility/index.html"
        ),
        r4DebugResolve: path.resolve(
          examplesRoot,
          "r4-debug-resolve/index.html"
        ),
        r4VisibilityLifecycle: path.resolve(
          examplesRoot,
          "r4-visibility-lifecycle/index.html"
        ),
        r5SurfaceDebug: path.resolve(
          examplesRoot,
          "r5-surface-debug/index.html"
        ),
        r5ClusteredDirect: path.resolve(
          examplesRoot,
          "r5-clustered-direct/index.html"
        ),
        r5ShadingOracle: path.resolve(
          examplesRoot,
          "r5-shading-oracle/index.html"
        ),
        r5PackedCsmShadow: path.resolve(
          examplesRoot,
          "r5-packed-csm-shadow/index.html"
        ),
        r5PackedTransparency: path.resolve(
          examplesRoot,
          "r5-packed-transparency/index.html"
        ),
        r5TemporalFoundation: path.resolve(
          examplesRoot,
          "r5-temporal-foundation/index.html"
        ),
        r5AmbientOcclusion: path.resolve(
          examplesRoot,
          "r5-ambient-occlusion/index.html"
        ),
        r5ScreenSpaceReflections: path.resolve(
          examplesRoot,
          "r5-screen-space-reflections/index.html"
        ),
        integratedShowcase: path.resolve(
          examplesRoot,
          "integrated-showcase/index.html"
        ),
        benchmarkA: path.resolve(
          examplesRoot,
          "benchmark-a/index.html"
        ),
        benchmarkB: path.resolve(
          examplesRoot,
          "benchmark-b/index.html"
        ),
        benchmarkC: path.resolve(
          examplesRoot,
          "benchmark-c/index.html"
        )
      }
    }
  }
});
