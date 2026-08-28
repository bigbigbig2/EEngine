import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const examplesRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(examplesRoot, "..");

function gitOutput(args: string[], fallback: string): string {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8"
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const dirtyReasons = gitOutput(["status", "--porcelain"], "")
  .split(/\r?\n/)
  .filter((line) => line.length > 0);

export default defineConfig({
  root: examplesRoot,
  publicDir: false,
  define: {
    __BUILD_COMMIT__: JSON.stringify(gitOutput(["rev-parse", "HEAD"], "unknown")),
    __BUILD_DIRTY__: JSON.stringify(dirtyReasons.length > 0),
    __BUILD_DIRTY_REASONS__: JSON.stringify(dirtyReasons)
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
