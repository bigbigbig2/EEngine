import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const examplesRoot = fileURLToPath(new URL(".", import.meta.url));
const demosRoot = resolve(examplesRoot, "demos");

function collectExamplePages(directory: string): Record<string, string> {
  const pages: Record<string, string> = {};

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = resolve(directory, entry.name);
    const nested = readdirSync(child, { withFileTypes: true });
    const hasPage = nested.some((candidate) => candidate.isFile() && candidate.name === "index.html");

    if (hasPage) {
      const relativeName = child
        .slice(demosRoot.length + 1)
        .replaceAll("\\", "/");
      pages[relativeName] = resolve(child, "index.html");
    }

    Object.assign(pages, collectExamplePages(child));
  }

  return pages;
}

export default defineConfig({
  root: examplesRoot,
  build: {
    outDir: resolve(examplesRoot, "examples-static"),
    emptyOutDir: true,
    rollupOptions: {
      input: collectExamplePages(demosRoot)
    }
  }
});
