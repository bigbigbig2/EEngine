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

export default defineConfig({
  root: examplesRoot,
  publicDir: false,
  define: {
    __BUILD_COMMIT__: JSON.stringify(gitOutput(["rev-parse", "HEAD"], "unknown")),
    __BUILD_DIRTY__: JSON.stringify(gitOutput(["status", "--porcelain"], "") !== "")
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
        )
      }
    }
  }
});
