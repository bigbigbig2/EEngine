import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/** Serve the existing 45 GiB cook in place, including bounded OEGPACK range reads. */
export function zorahLocalModel(examplesRoot: string): Plugin {
  const root = resolve(examplesRoot, "../.local/validation/nyx-zorah/cooked");
  const prefix = "/assets/local-zorah/cooked/";
  return {
    name: "zorah-local-model",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        if (!url.startsWith(prefix)) {
          next();
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { Allow: "GET, HEAD" });
          response.end();
          return;
        }
        let path: string;
        try {
          path = decodeURIComponent(url.slice(prefix.length));
        } catch {
          response.writeHead(400);
          response.end("Invalid asset path");
          return;
        }
        const source = resolve(root, path);
        const local = relative(root, source);
        if (
          isAbsolute(local) ||
          local.startsWith("..") ||
          !/^(?:scene\.(?:oescene|materials\.json)|cook-report\.json|meshes[/\\]\d{5}[/\\]geometry-[0-9a-f]{20}\.oegpack)$/u.test(
            local
          )
        ) {
          response.writeHead(403);
          response.end("Asset path is outside the cooked scene");
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
            response.writeHead(416, { "Content-Range": `bytes */${size}` });
            response.end();
            return;
          }
          response.writeHead(match ? 206 : 200, {
            "Accept-Ranges": "bytes",
            "Content-Type": source.endsWith(".oegpack") ? "application/octet-stream" : "application/json",
            "Content-Length": end - start + 1,
            "Cache-Control": "no-store",
            ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(source, { start, end, highWaterMark: 256 * 1024 });
          response.on("close", () => stream.destroy());
          stream.on("error", (error) => response.destroy(error));
          stream.pipe(response);
        } catch (error) {
          if (response.headersSent) {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          } else {
            response.writeHead(404);
            response.end("Zorah cooked asset unavailable");
          }
        }
      });
    }
  };
}
