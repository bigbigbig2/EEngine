// Minimal static server for the GPU oracle harness.
//
// Why plain node:http instead of vite (which is already installed):
//   * The oracles are plain ESM and import already-compiled JavaScript from
//     OEngine/.test-dist with explicit `.js` extensions, so no transform,
//     bundling or TS resolution is needed.
//   * No second process to supervise, no fixed port to collide with the
//     validation host on 4178, and no build step before a diagnostic run.
//   * Requests are restricted to an explicit allowlist of path prefixes, which
//     a general-purpose dev server would not give us.
//
// The server binds 127.0.0.1 on an ephemeral port and serves nothing outside
// the allowlisted prefixes, so it stays a private loopback helper.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wgsl", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".bin", "application/octet-stream"],
  [".wasm", "application/wasm"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".ktx2", "image/ktx2"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

const PAGE_PREFIX = "/__gpu-oracle/";
export const SHIM_URL = "/__gpu-oracle/page/assert-strict.mjs";
export const VENDOR_PREFIX = "/__gpu-oracle/vendor/";

/**
 * Bare specifiers the compiled engine imports, mapped to a servable ESM entry.
 *
 * Why this is needed at all: `OEngine/.test-dist` is compiled with
 * `moduleResolution: Bundler`, so it keeps bare imports like `gl-matrix` in the
 * output. Node and Vite resolve those through node_modules, but a browser
 * fetching the same file over http has no resolver and fails with
 * "Failed to resolve module specifier". Two oracles import the virtual-geometry
 * owners, which reach `gl-matrix`, so without this map they cannot run at all.
 *
 * `gl-matrix` ships `esm/index.js`, which is browser-loadable as-is. Packages
 * without an ESM build must not be added here; they need a transform instead.
 *
 * `entry` doubles as the base for the package's own relative imports. Serving
 * `gl-matrix` from `esm/index.js` means the module's `./common.js` arrives as
 * `<vendor prefix>gl-matrix/common.js`, which must resolve to `esm/common.js`.
 * Dropping that segment made every internal import a 404 and the host page never
 * finished loading — the failure surfaced only as a page timeout.
 */
export const VENDOR_MODULES = Object.freeze({
  "gl-matrix": { package: "gl-matrix", entry: "esm/index.js" },
});

/** Rejects percent-encoded traversal and NUL bytes before any path arithmetic. */
function decodeRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const segments = pathname.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  return pathname;
}

/**
 * The harness's own namespace maps onto tools/gpu-oracle/, so the host page and
 * any harness-side fixture (for example the negative-control oracle) are served
 * from one prefix that can never reach repository sources.
 *
 * @param {{root: string, harnessRoot: string, allowPrefixes: readonly string[]}} options
 * @returns {Promise<{origin: string, pageUrl: (file: string) => string, close: () => Promise<void>, requests: string[]}>}
 */
export async function startStaticServer({ root, harnessRoot, allowPrefixes, vendorRoots = [] }) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "cache-control": "no-store", ...headers });
      if (request.method === "HEAD") response.end();
      else response.end(body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "method not allowed");
      return;
    }
    const pathname = decodeRequestPath(request.url ?? "/");
    if (pathname === null) {
      send(400, "bad request path");
      return;
    }

    // Vendored bare specifiers: served out of a node_modules tree that is passed
    // in explicitly, never by escaping the repository allowlist.
    if (pathname.startsWith(VENDOR_PREFIX)) {
      const specifier = pathname.slice(VENDOR_PREFIX.length).split("/")[0];
      const mapping = VENDOR_MODULES[specifier];
      if (!mapping) {
        send(404, "unknown vendored specifier");
        return;
      }

      // A bare request for the package must become the entry *file* URL.
      //
      // Serving `index.js` content at `/vendor/gl-matrix` looks equivalent but is
      // not: with no trailing slash, the URL's base directory is `/vendor/`, so
      // the module's own `./common.js` resolves to `/vendor/common.js` and every
      // internal import 404s. Redirecting makes the browser fetch
      // `/vendor/gl-matrix/esm/index.js`, where `./common.js` correctly resolves
      // to `/vendor/gl-matrix/esm/common.js`. This is HTTP URL semantics, not a
      // harness preference — a static server cannot fix it by rewriting content.
      const suffix = pathname.slice(VENDOR_PREFIX.length + specifier.length);
      if (suffix === "" || suffix === "/") {
        response.writeHead(302, {
          location: `${VENDOR_PREFIX}${specifier}/${mapping.entry}`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      const wanted = suffix.replace(/^\//u, "");
      for (const vendorRoot of vendorRoots) {
        const absolute = resolve(vendorRoot, mapping.package, wanted);
        const relativePath = relative(vendorRoot, absolute);
        if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
        try {
          const stats = await stat(absolute);
          if (!stats.isFile()) continue;
          requests.push(pathname);
          response.writeHead(200, {
            "content-type":
              CONTENT_TYPES.get(extname(absolute).toLowerCase()) ?? "text/javascript; charset=utf-8",
            "content-length": stats.size,
            "cache-control": "no-store",
          });
          if (request.method === "HEAD") response.end();
          else createReadStream(absolute).pipe(response);
          return;
        } catch {
          // Try the next vendor root.
        }
      }
      send(404, `vendored module not found: ${specifier}/${wanted}`);
      return;
    }

    // Two disjoint namespaces: the harness's own assets, and the allowlisted
    // repository prefixes the oracles import from.
    const resolved = pathname.startsWith(PAGE_PREFIX)
      ? (() => {
          const absolute = resolve(harnessRoot, pathname.slice(PAGE_PREFIX.length));
          const relativePath = relative(harnessRoot, absolute);
          const inside = relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
          return { absolute, allowed: inside };
        })()
      : (() => {
          const absolute = resolve(root, `.${pathname}`);
          const relativePath = relative(root, absolute);
          const portable = relativePath.split(sep).join("/");
          const insideRoot =
            relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
          return {
            absolute,
            allowed: insideRoot && allowPrefixes.some((prefix) => portable.startsWith(prefix)),
          };
        })();
    if (!resolved.allowed) {
      send(403, "path not allowed by gpu-oracle static server");
      return;
    }
    let stats;
    try {
      stats = await stat(resolved.absolute);
    } catch {
      send(404, "not found");
      return;
    }
    if (!stats.isFile()) {
      // No directory listing: a diagnostic harness never needs one.
      send(404, "not found");
      return;
    }
    requests.push(pathname);
    const contentType =
      CONTENT_TYPES.get(extname(resolved.absolute).toLowerCase()) ?? "application/octet-stream";
    // Specifier rewriting for JavaScript modules.
    //
    // The rewrite is restricted to module specifiers — the string after `from`
    // or inside a bare `import "..."`. An earlier version replaced every
    // occurrence of `node:assert` in the file, which also rewrote the text
    // *inside a regular expression* in `page/host.mjs`:
    //
    //     if (!/Failed to resolve module specifier|node:assert|assert-strict/.test(message))
    //
    // became a regex containing a `/`, i.e. a syntax error. The page then died at
    // parse time and the only symptom was a 60-second timeout with no useful
    // message. A text substitution over source that does not understand strings
    // and regex literals will always eventually rewrite data as if it were code.
    //
    // Rewriting is a no-op when no specifier matches, so it is applied
    // unconditionally for served diagnostic modules.
    if (pathname !== "/" && /\.(mjs|js)$/u.test(pathname)) {
      const source = await readFile(resolved.absolute, "utf8");
      const rewriteSpecifier = (specifier) => {
        if (specifier === "node:assert/strict" || specifier === "node:assert") return SHIM_URL;
        return VENDOR_MODULES[specifier] ? `${VENDOR_PREFIX}${specifier}` : null;
      };
      const rewritten = source.replace(
        /(\bfrom\s*")([^"]+)(")|(\bimport\s*")([^"]+)(")/gu,
        (whole, fromPrefix, fromSpecifier, fromSuffix, barePrefix, bareSpecifier, bareSuffix) => {
          if (fromSpecifier !== undefined) {
            const replacement = rewriteSpecifier(fromSpecifier);
            return replacement === null ? whole : `${fromPrefix}${replacement}${fromSuffix}`;
          }
          const replacement = rewriteSpecifier(bareSpecifier);
          return replacement === null ? whole : `${barePrefix}${replacement}${bareSuffix}`;
        },
      );
      if (rewritten !== source) {
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": Buffer.byteLength(rewritten),
          "cache-control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : rewritten);
        return;
      }
    }
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": stats.size,
      "cache-control": "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(resolved.absolute);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    pageUrl: (file) => `${origin}${PAGE_PREFIX}${file}`,
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      }),
  };
}

export { PAGE_PREFIX };
export const defaultAllowPrefixes = Object.freeze(["OEngine/tests/", "OEngine/.test-dist/"]);
