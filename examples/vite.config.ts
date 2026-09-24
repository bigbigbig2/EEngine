import { createReadStream, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const examplesRoot = fileURLToPath(new URL(".", import.meta.url));
const demosRoot = resolve(examplesRoot, "demos");
const largeBasicSource = resolve(examplesRoot, "assets/oengine/web-authored-large/large.glb");
const largeBasicOfflineRoot = resolve(examplesRoot, "../.local/offline-large");
const pineForestSource = resolve(examplesRoot, "../.local/validation/pine-forest/pine_forest_render_geometry.glb");

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
  plugins: [{
    name: "large-basic-offline-source",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const route = request.url?.split("?")[0] ?? "";
        const match = /^\/assets\/oengine\/offline-large\/(scene\.oescene|geometry-[0-9a-f]{20}\.oegpack)$/u.exec(route);
        if (!match || (request.method !== "GET" && request.method !== "HEAD")) return next();
        const source = resolve(largeBasicOfflineRoot, match[1]!);
        let size: number;
        try { size = (await stat(source)).size; }
        catch { response.statusCode = 404; response.end("offline large-model artifact is not mounted"); return; }
        const range = request.headers.range;
        const byteRange = range?.match(/^bytes=(\d+)-(\d*)$/u);
        if (range && !byteRange) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
        const start = byteRange ? Number(byteRange[1]) : 0;
        const end = byteRange ? (byteRange[2] ? Number(byteRange[2]) : size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return;
        }
        response.writeHead(byteRange ? 206 : 200, {
          "Accept-Ranges": "bytes",
          "Content-Type": match[1] === "scene.oescene" ? "application/json" : "application/octet-stream",
          "Content-Encoding": "identity",
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
          ...(byteRange ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
        });
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(source, { start, end, highWaterMark: 256 * 1024 });
        stream.on("error", error => response.destroy(error));
        stream.pipe(response);
      });
    }
  }, {
    name: "large-basic-range-source",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== "/assets/oengine/web-authored-large/large.glb" ||
            (request.method !== "GET" && request.method !== "HEAD")) return next();
        let size: number;
        try { size = (await stat(largeBasicSource)).size; }
        catch { response.statusCode = 404; response.end("large.glb is not mounted"); return; }
        const range = request.headers.range;
        const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
        if (range && !match) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
        const start = match ? Number(match[1]) : 0;
        const end = match ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return;
        }
        response.writeHead(match ? 206 : 200, {
          "Accept-Ranges": "bytes",
          "Content-Type": "model/gltf-binary",
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
          ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
        });
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(largeBasicSource, { start, end, highWaterMark: 256 * 1024 });
        stream.on("error", error => response.destroy(error));
        stream.pipe(response);
      });
    }
  }, {
    name: "pine-forest-range-source",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== "/assets/oengine/pine-forest/pine_forest_render_geometry.glb" ||
            (request.method !== "GET" && request.method !== "HEAD")) return next();
        let size: number;
        try { size = (await stat(pineForestSource)).size; }
        catch { response.statusCode = 404; response.end("Pine Forest GLB is not mounted"); return; }
        const range = request.headers.range;
        const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
        if (range && !match) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
        const start = match ? Number(match[1]) : 0;
        const end = match ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return;
        }
        response.writeHead(match ? 206 : 200, {
          "Accept-Ranges": "bytes",
          "Content-Type": "model/gltf-binary",
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
          ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
        });
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(pineForestSource, { start, end, highWaterMark: 256 * 1024 });
        stream.on("error", error => response.destroy(error));
        stream.pipe(response);
      });
    }
  }],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    fs: {
      allow: [examplesRoot, resolve(examplesRoot, "../OEngine")]
    }
  },
  build: {
    outDir: resolve(examplesRoot, "examples-static"),
    emptyOutDir: true,
    rollupOptions: {
      input: collectExamplePages(demosRoot)
    }
  }
});
