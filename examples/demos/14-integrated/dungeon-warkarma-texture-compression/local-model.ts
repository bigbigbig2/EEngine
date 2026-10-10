import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Plugin } from "vite";

const assetRoute = "/demos/14-integrated/dungeon-warkarma-texture-compression/assets/";

/** The dungeon owns its assets in both development and static builds. */
export function dungeonLocalModel(examplesRoot: string): Plugin {
  const root = resolve(examplesRoot, "demos/14-integrated/dungeon-warkarma-texture-compression/assets");
  return {
    name: "dungeon-local-model",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        if (!url.startsWith(assetRoute) || (request.method !== "GET" && request.method !== "HEAD"))
          return next();
        let source: string;
        try {
          source = resolve(root, decodeURIComponent(url.slice(assetRoute.length)));
        } catch {
          response.writeHead(400).end();
          return;
        }
        const path = relative(root, source);
        if (path.startsWith("..") || path.includes(":")) {
          response.writeHead(403).end();
          return;
        }
        try {
          const size = (await stat(source)).size;
          const range = request.headers.range;
          const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
          const start = match ? Number(match[1]) : 0;
          const end = match?.[2] ? Number(match[2]) : size - 1;
          if (
            (range && !match) ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end >= size
          ) {
            response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
            return;
          }
          response.writeHead(match ? 206 : 200, {
            "Accept-Ranges": "bytes",
            "Content-Type": source.endsWith(".json") ? "application/json" : "application/octet-stream",
            "Content-Length": end - start + 1,
            "Cache-Control": "no-store",
            ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(source, { start, end });
          response.on("close", () => stream.destroy());
          stream.on("error", (error) => response.destroy(error));
          stream.pipe(response);
        } catch (error) {
          if (response.headersSent)
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          else response.writeHead(404).end("Dungeon asset unavailable");
        }
      });
    },
    async generateBundle() {
      const emitDirectory = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) await emitDirectory(path);
          else
            this.emitFile({
              type: "asset",
              fileName: assetRoute.slice(1) + relative(root, path).replaceAll("\\", "/"),
              source: await readFile(path)
            });
        }
      };
      await emitDirectory(root);
    }
  };
}
