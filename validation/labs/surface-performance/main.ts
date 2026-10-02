// Separate Document/device lifecycle. Reuse the example's controls and scene,
// while the local runner specializes WGSL at build time on its private server.
export {};
const response = await fetch("/demos/14-integrated/next-renderer-showcase/index.html");
if (!response.ok) throw new Error(`Showcase template HTTP ${response.status}`);
const template = new DOMParser().parseFromString(await response.text(), "text/html");
for (const script of template.querySelectorAll("script")) script.remove();
document.body.replaceChildren(...Array.from(template.body.childNodes).map(node => document.importNode(node, true)));
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet"; stylesheet.href = "/demos/14-integrated/next-renderer-showcase/style.css";
document.head.append(stylesheet);
const configuration = await fetch("/__surface-performance/config.json").then(response => response.json()) as { mode: string; asyncPrewarm: boolean; vsm?: boolean };
const mode = configuration.mode;
const requestedMode = new URL(location.href).searchParams.get("mode");
if (requestedMode && requestedMode !== mode) throw new Error("Diagnostic shader mode does not match host configuration");
document.title = `Surface V3 measurement · ${mode}`;
const banner = document.createElement("div");
banner.textContent = `SURFACE V3 MEASUREMENT · ${mode} · coverage + work + GPU timing`;
banner.style.cssText = "position:fixed;top:40px;left:12px;z-index:100;color:#ffd38a;background:#18202ddd;padding:5px;font:12px monospace;pointer-events:none";
document.body.append(banner);
Object.assign(globalThis, { __surfaceDiagnostic: { evidenceRole: "diagnostic", accepted: false, mode, vsm: configuration.vsm ?? false, rewrites: [], prewarmCacheHits: [], prewarmCacheMisses: [],
  pipelineInitialization: configuration.asyncPrewarm ? "async-prewarm-diagnostic" : "production-sync",
  prepare: configuration.asyncPrewarm ? (renderer: { diagnosticPrewarmSurface(): Promise<void> }) => renderer.diagnosticPrewarmSurface() : undefined } });
await import("../../../examples/demos/14-integrated/next-renderer-showcase/main.ts");
