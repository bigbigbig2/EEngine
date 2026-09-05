import type { InspectorMode, InspectorViewState } from "./InspectorViewModel.js";
import { OverviewPanel } from "./panels/OverviewPanel.js";
import { TimelinePanel } from "./panels/TimelinePanel.js";
import { GpuDrivenPanel } from "./panels/GpuDrivenPanel.js";
import { FrameGraphPanel, type FrameGraphEvidenceLike } from "./panels/FrameGraphPanel.js";
import { ResourcesPanel, type RendererMemoryEvidenceLike } from "./panels/ResourcesPanel.js";
import { DiagnosticsPanel, type DiagnosticsInput } from "./panels/DiagnosticsPanel.js";
import type { ResourceAccountingSnapshot } from "../../debug/profiling/ResourceAccounting.js";
import { InspectorLayoutModel, type InspectorLayout } from "./InspectorLayoutModel.js";

export type InspectorStyleMode = "inline" | "external" | "none";

export interface InspectorShellOptions {
  readonly container: HTMLElement;
  readonly styles: InspectorStyleMode;
  readonly nonce?: string;
  readonly onMode: (mode: "live" | "record" | "deep-capture") => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onClose: () => void;
  readonly onStartRecording: () => void;
  readonly onStopRecording: () => void;
  readonly onCaptureNextFrame: () => void;
  readonly onExportCapture: () => void;
  readonly onExportTrace: () => void;
  readonly onClear: () => void;
  readonly onImportCapture: (file: File) => void;
  readonly onSelectFrame: (frameIndex: number) => void;
  readonly onSelectRange: (startFrameIndex: number, endFrameIndex: number) => void;
  readonly onDomainState: () => InspectorDomainState;
}

export interface InspectorDomainState {
  readonly frameGraph: FrameGraphEvidenceLike | null;
  readonly resources: ResourceAccountingSnapshot | null;
  readonly memory: RendererMemoryEvidenceLike | null;
  readonly diagnostics: DiagnosticsInput;
}

type InspectorPanel = "overview" | "timeline" | "gpu-driven" | "framegraph" | "resources" | "diagnostics";

const ICON_DOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>';
const ICON_MAXIMIZE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const ICON_INSPECTOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.5 20h-6.5a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5.5"></path><path d="M9 17h2"></path><circle cx="18" cy="18" r="3"></circle><path d="m20.2 20.2 1.8 1.8"></path></svg>';

const INLINE_CSS = `
:host{all:initial;contain:content;color:var(--inspector-text-primary);font:12px/1.4 system-ui,sans-serif;--inspector-bg:#111923f2;--inspector-panel:#172333;--inspector-border:#3a4b63;--inspector-border-soft:#2b3b50;--inspector-text-primary:#e7edf6;--inspector-text-secondary:#9aabc1;--inspector-accent:#36a3ff;--inspector-warning:#facc15;--inspector-error:#fb7185}
.inspector{position:fixed;z-index:2147483647;overflow:auto;padding:10px;border:1px solid var(--inspector-border);border-radius:10px;background:var(--inspector-bg);box-shadow:0 8px 30px #0008;backdrop-filter:blur(8px);min-width:320px;min-height:220px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:none}
.toolbar,.tabs,.summary{display:flex;align-items:center;gap:6px}.toolbar{justify-content:space-between;margin-bottom:8px;cursor:move;user-select:none}.toolbar button{cursor:pointer}.tabs{margin-bottom:8px;flex-wrap:wrap}.actions{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}button{border:1px solid var(--inspector-border);border-radius:5px;padding:4px 8px;color:var(--inspector-text-primary);background:#1a2635;cursor:pointer}button:hover{border-color:var(--inspector-accent);background:#263852}.tabs button[aria-pressed="true"]{border-color:var(--inspector-accent);color:#fff;background:#14527d}.title{font-weight:700;letter-spacing:.01em}.muted{color:var(--inspector-text-secondary)}.summary{justify-content:space-between;padding:8px;border-radius:6px;background:var(--inspector-panel);font-variant-numeric:tabular-nums}.summary[data-severity="warning"]{color:var(--inspector-warning)}.summary[data-severity="error"]{color:var(--inspector-error)}.panel{position:relative;min-height:52px;padding:8px;border:1px solid var(--inspector-border-soft);border-radius:6px}
.panel h3{margin:0 0 6px;font-size:13px}.panel-tabs{margin-top:2px}.overview-stats{white-space:pre-line;color:#c4d0df;margin-bottom:6px}.inspector-chart{display:block;width:100%;height:64px;margin:4px 0;background:#0b121b;border-radius:4px}.timeline-warning{min-height:18px;color:var(--inspector-warning)}.timeline-details{white-space:pre-wrap;margin:6px 0 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}.timeline-strip{height:72px}.domain-panel pre,.domain-panel div{white-space:pre-wrap;margin:4px 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}.resize-handle{position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.7;background:linear-gradient(135deg,transparent 45%,var(--inspector-accent) 46%,var(--inspector-accent) 54%,transparent 55%),linear-gradient(135deg,transparent 62%,var(--inspector-accent) 63%,var(--inspector-accent) 71%,transparent 72%)}
:host{pointer-events:none}.profiler-toggle{pointer-events:auto;position:fixed;top:15px;right:15px;z-index:1001;display:flex;align-items:center;gap:8px;padding:0 12px;height:36px;border:1px solid #4a4a5a54;border-radius:12px 6px 6px 12px;background:#1e1e24d9;color:var(--inspector-text-primary);font:600 13px 'Segoe UI',Tahoma,sans-serif;box-shadow:0 4px 15px #0005;backdrop-filter:blur(8px);transition:all .2s ease-in-out;overflow:hidden}.profiler-toggle:hover{border-color:var(--inspector-accent);background:#252532e8}.profiler-toggle.panel-open{color:var(--inspector-accent);box-shadow:0 0 0 1px #00aaff33,0 4px 15px #0005}.profiler-toggle-graph{position:absolute;inset:0;width:100%;height:100%;opacity:.5;pointer-events:none}.toggle-text{position:relative;z-index:1;min-width:70px;text-align:right}.inspector.profiler-panel{pointer-events:auto;left:0!important;right:0!important;top:auto!important;bottom:0!important;width:auto!important;height:350px;max-width:none;max-height:calc(100vh - 50px);padding:0;border-width:2px 0 0;border-radius:8px 8px 0 0;display:flex;flex-direction:column;overflow:hidden;transform:translateY(100%);transition:transform .35s cubic-bezier(.25,.46,.45,.94),height .3s ease-out}.inspector.profiler-panel.visible{transform:translateY(0)}.inspector.profiler-panel.position-right{left:auto!important;right:0!important;top:0!important;bottom:0!important;width:350px!important;height:100%!important;border-width:0 0 0 2px;border-radius:8px 0 0 8px;transform:translateX(100%)}.inspector.profiler-panel.position-right.visible{transform:translateX(0)}.inspector.profiler-panel.maximized{left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;height:100vh!important;border-radius:0}.inspector.profiler-panel .toolbar{height:32px;min-height:32px;padding:0 8px;margin:0;background:#2a2a33aa;border-bottom:1px solid var(--inspector-border);font-family:'Segoe UI',Tahoma,sans-serif;cursor:default}.inspector.profiler-panel .toolbar>.title{flex:0 0 auto;margin-right:10px;font-size:12px;white-space:nowrap}.inspector.profiler-panel .toolbar>.panel-tabs{flex:1 1 auto;min-width:0;margin:0;padding:0;background:transparent}.profiler-controls{display:flex;align-items:stretch;height:100%;margin-left:auto}.profiler-controls button{height:100%;min-width:32px;padding:0 9px;border:0;border-left:1px solid var(--inspector-border);border-radius:0;background:transparent}.inspector.profiler-panel .control-strip{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:3px 8px;background:#1e1e24aa;border-bottom:1px solid #2a2a33}.inspector.profiler-panel .control-strip .tabs,.inspector.profiler-panel .control-strip .actions{padding:0;margin:0;background:transparent}.inspector.profiler-panel .control-strip button{padding:3px 7px;font-size:11px}.inspector.profiler-panel .control-strip .icon-button{width:30px;min-width:30px;padding:0;font-size:13px;border:0;border-radius:3px;color:var(--inspector-text-secondary);background:transparent}.inspector.profiler-panel .control-strip .icon-button:hover{color:var(--inspector-text-primary);background:rgba(255,255,255,.08)}.inspector.profiler-panel>.panel{flex:1;overflow:auto;margin:0 8px 8px}.inspector.profiler-panel .resize-handle{top:0;bottom:auto;left:0;right:0;width:100%;height:5px;cursor:ns-resize}.inspector.profiler-panel.position-right .resize-handle{top:0;bottom:0;left:-2px;right:auto;width:5px;height:100%;cursor:ew-resize}.inspector.profiler-panel .panel-tabs{overflow-x:auto;flex-wrap:nowrap}.inspector.profiler-panel .panel-tabs button{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 15px;font:600 13px 'Segoe UI',Tahoma,sans-serif;color:var(--inspector-text-secondary);white-space:nowrap}.inspector.profiler-panel .panel-tabs button[aria-pressed="true"]{border-bottom-color:var(--inspector-accent);color:#fff;background:transparent}
:host{--inspector-bg:#151a22f5;--inspector-panel:#1d2632;--inspector-border:#334155;--inspector-border-soft:#2a3748;--inspector-text-primary:#e5edf7;--inspector-text-secondary:#91a0b5;--inspector-accent:#4ea1ff}
.inspector.profiler-panel{height:min(360px,55vh);background:var(--inspector-bg);border-color:var(--inspector-border);box-shadow:0 -12px 40px #0009}
.inspector.profiler-panel .toolbar{display:flex;gap:12px;height:38px;min-height:38px;padding:0 10px;background:#192231;border-bottom:1px solid var(--inspector-border)}
.inspector.profiler-panel .toolbar>.title{font-size:12px;letter-spacing:.02em}.inspector.profiler-panel .toolbar>.panel-tabs{display:none}
.profiler-toggle{padding:0 0 0 10px;border-radius:10px 5px 5px 10px}.profiler-toggle .toggle-icon{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;width:34px;height:36px;background:#1d2e45;color:var(--inspector-accent)}.profiler-toggle .toggle-icon svg,.profiler-controls svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.profiler-toggle .toggle-text{min-width:58px;padding-inline:8px;text-align:center;font-variant-numeric:tabular-nums}
.profiler-controls{gap:0}.profiler-controls button{min-width:34px;color:var(--inspector-text-secondary)}
.inspector.profiler-panel .control-strip{display:flex;justify-content:space-between;gap:12px;padding:6px 10px;background:#111923;border-bottom:1px solid var(--inspector-border)}
.inspector.profiler-panel .control-strip .tabs,.inspector.profiler-panel .control-strip .actions{display:flex;gap:4px;flex-wrap:nowrap;margin:0}
.inspector.profiler-panel .control-strip button{padding:4px 9px;border-color:transparent;background:transparent;color:var(--inspector-text-secondary);font-size:11px}.inspector.profiler-panel .control-strip button:hover{background:#263447;color:var(--inspector-text-primary)}
.inspector.profiler-panel .control-strip .tabs button[aria-pressed="true"]{border-color:#397fca;background:#173b63;color:#fff}.inspector.profiler-panel .control-strip .actions{margin-left:auto}
.inspector.profiler-panel>.panel-tabs{display:flex;gap:2px;overflow-x:auto;flex-wrap:nowrap;padding:0 10px;background:#182231;border-bottom:1px solid var(--inspector-border)}
.inspector.profiler-panel>.panel-tabs button{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 12px;color:var(--inspector-text-secondary);font-size:11px;white-space:nowrap}.inspector.profiler-panel>.panel-tabs button[aria-pressed="true"]{border-bottom-color:var(--inspector-accent);color:#fff;background:transparent}
.inspector.profiler-panel>.summary{order:4;padding:6px 10px;border-radius:0;background:#111923;font-size:11px}.inspector.profiler-panel>.panel{order:5;margin:0 10px 10px;padding:10px;border-color:var(--inspector-border-soft);background:#141c27}.inspector.profiler-panel>.resize-handle{order:6}
.overview-panel{display:block;max-width:1100px;margin:0 auto}.panel-subtitle{margin:0 0 10px;color:var(--inspector-text-secondary);font-size:11px}.overview-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}
.kpi-card{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--inspector-border-soft);border-radius:6px;background:#1a2431}.kpi-label,.kpi-meta{color:var(--inspector-text-secondary);font-size:10px}.kpi-value{font:600 17px/1.2 ui-monospace,monospace;color:var(--inspector-text-primary);font-variant-numeric:tabular-nums}.overview-meta{margin:6px 0 8px;color:var(--inspector-text-secondary);font:10px/1.5 ui-monospace,monospace;white-space:pre-line}
.inspector-chart{width:100%!important;height:78px!important;margin:6px 0;background:#0d141d;border:1px solid #243244;border-radius:5px}@media (max-width:700px){.overview-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.inspector.profiler-panel .control-strip{gap:4px;overflow-x:auto}.inspector.profiler-panel .control-strip .actions{margin-left:0}.inspector.profiler-panel>.panel-tabs button{padding-inline:9px}}
`;

/** Framework-free Shadow DOM shell. All user-visible text is assigned via textContent. */
export class InspectorShell {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly status: HTMLElement;
  private readonly selected: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly overview: OverviewPanel;
  private readonly timeline: TimelinePanel;
  private readonly gpuDriven: GpuDrivenPanel;
  private readonly frameGraph: FrameGraphPanel;
  private readonly resources: ResourcesPanel;
  private readonly diagnostics: DiagnosticsPanel;
  private readonly layoutModel = new InspectorLayoutModel();
  private readonly modeButtons = new Map<InspectorMode, HTMLButtonElement>();
  private readonly panelButtons = new Map<InspectorPanel, HTMLButtonElement>();
  private readonly resizeHandle: HTMLElement;
  private readonly floatingToggle: HTMLButtonElement;
  private readonly toggleLabel: HTMLSpanElement;
  private readonly toggleGraph: HTMLCanvasElement;
  private readonly positionButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly onWindowResize = (): void => this.applyLayout(this.layoutModel.layout);
  private activePanel: InspectorPanel = "overview";
  private dockMode: "bottom" | "right" = "bottom";
  private maximized = false;
  private resizeState: { pointerId: number; width: number; height: number; x: number; y: number } | null = null;
  private disposed = false;

  constructor(private readonly options: InspectorShellOptions) {
    this.host = document.createElement("oengine-inspector");
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.append(this.createStyle(options.styles, options.nonce));

    const wrapper = document.createElement("div");
    wrapper.className = "inspector profiler-panel visible";
    this.floatingToggle = this.button("", () => this.togglePanel());
    this.floatingToggle.className = "profiler-toggle panel-open";
    this.floatingToggle.setAttribute("aria-expanded", "true");
    this.toggleGraph = document.createElement("canvas");
    this.toggleGraph.className = "profiler-toggle-graph";
    this.toggleGraph.width = 80;
    this.toggleGraph.height = 36;
    this.toggleLabel = document.createElement("span");
    this.toggleLabel.className = "toggle-text";
    this.toggleLabel.textContent = "— FPS";
    const toggleIcon = document.createElement("span");
    toggleIcon.className = "toggle-icon";
    toggleIcon.innerHTML = ICON_INSPECTOR;
    this.floatingToggle.append(this.toggleGraph, this.toggleLabel, toggleIcon);
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "OEngine Performance Inspector";
    const controls = document.createElement("span");
    controls.className = "profiler-controls";
    this.positionButton = this.svgButton(ICON_DOCK, "Switch dock position", () => this.toggleDockMode());
    this.positionButton.title = "Switch dock position";
    this.maximizeButton = this.svgButton(ICON_MAXIMIZE, "Maximize Inspector", () => this.toggleMaximize());
    this.maximizeButton.title = "Maximize Inspector";
    this.hideButton = this.button("−", () => this.togglePanel());
    this.hideButton.title = "Hide Inspector";
    controls.append(this.positionButton, this.maximizeButton, this.hideButton);
    const reset = this.button("Reset", () => this.layoutModel.reset());
    const close = this.button("Close", options.onClose);
    controls.append(reset, close);
    toolbar.append(title, controls);

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    for (const [mode, label] of [["live", "Live"], ["record", "Record"], ["deep-capture", "Deep capture"]] as const) {
      const button = this.button(label, () => options.onMode(mode));
      this.modeButtons.set(mode, button);
      tabs.append(button);
    }
    tabs.append(this.button("Pause", options.onPause), this.button("Resume", options.onResume));

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      this.button("Start", options.onStartRecording),
      this.button("Stop", options.onStopRecording),
      this.button("Capture", options.onCaptureNextFrame),
      this.button("Export", options.onExportCapture),
      this.button("Trace", options.onExportTrace),
      this.button("Clear", options.onClear)
    );
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json,.json";
    importInput.hidden = true;
    importInput.addEventListener("change", () => {
      const file = importInput.files?.[0];
      if (file !== undefined) options.onImportCapture(file);
      importInput.value = "";
    });
    actions.append(this.button("Import", () => importInput.click()), importInput);

    const panelTabs = document.createElement("div");
    panelTabs.className = "tabs panel-tabs";
    for (const [panel, label] of [["overview", "Overview"], ["timeline", "Timeline"], ["gpu-driven", "GPU-driven"], ["framegraph", "FrameGraph"], ["resources", "Resources"], ["diagnostics", "Diagnostics"]] as const) {
      const button = this.button(label, () => this.showPanel(panel));
      this.panelButtons.set(panel, button);
      panelTabs.append(button);
    }
    const controlStrip = document.createElement("div");
    controlStrip.className = "control-strip";
    controlStrip.append(tabs, actions);

    const summary = document.createElement("div");
    summary.className = "summary";
    this.status = document.createElement("span");
    this.selected = document.createElement("span");
    this.selected.className = "muted";
    summary.append(this.status, this.selected);
    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.textContent = "Overview";
    this.overview = new OverviewPanel(document);
    this.timeline = new TimelinePanel(document, options.onSelectFrame, options.onSelectRange);
    this.gpuDriven = new GpuDrivenPanel(document);
    this.frameGraph = new FrameGraphPanel(document);
    this.resources = new ResourcesPanel(document);
    this.diagnostics = new DiagnosticsPanel(document);
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "resize-handle";
    this.resizeHandle.setAttribute("aria-label", "Resize Inspector");
    this.resizeHandle.addEventListener("pointerdown", (event) => this.beginResize(event));
    this.panel.append(this.overview.element, this.timeline.element);
    this.panel.append(this.gpuDriven.element, this.frameGraph.element, this.resources.element, this.diagnostics.element);
    this.timeline.element.hidden = true;
    this.gpuDriven.element.hidden = true;
    this.frameGraph.element.hidden = true;
    this.resources.element.hidden = true;
    this.diagnostics.element.hidden = true;
    wrapper.append(toolbar, controlStrip, panelTabs, summary, this.panel, this.resizeHandle);
    this.root.append(this.floatingToggle, wrapper);
    this.layoutModel.subscribe((layout) => this.applyLayout(layout));
    this.applyLayout(this.layoutModel.layout);
  }

  mount(): void {
    if (this.disposed) throw new Error("InspectorShell has been disposed");
    if (!this.host.isConnected) this.options.container.append(this.host);
    window.addEventListener("resize", this.onWindowResize);
    this.applyLayout(this.layoutModel.layout);
  }

  update(state: InspectorViewState): void {
    if (this.disposed) return;
    const modeLabel = state.mode === "deep-capture" ? "Deep capture" : state.mode === "record" ? "Record" : "Live";
    const sourceLabel = state.source === "capture" ? "imported capture" : "live data";
    this.status.textContent = `${modeLabel}${state.paused ? " · paused" : ""} · ${sourceLabel} · ${state.frames.length} frames`;
    const fps = presentedFps(state.frames);
    this.toggleLabel.textContent = fps === null ? "Inspector" : `${fps} FPS`;
    this.drawToggleGraph(state);
    this.status.dataset.mode = state.mode;
    this.modeButtons.forEach((button, mode) => button.setAttribute("aria-pressed", String(mode === state.mode)));
    this.panelButtons.forEach((button, panel) => button.setAttribute("aria-pressed", String(panel === this.activePanel)));
    this.selected.textContent = state.selectedFrameIndex === null
      ? "select a frame for details"
      : `frame ${state.selectedFrameIndex}`;
    this.overview.update(state.frames, state.range);
    this.timeline.update(state.frames, state.selectedFrameIndex, state.range);
    const domains = this.options.onDomainState();
    this.gpuDriven.update(state.frames);
    this.frameGraph.update(domains.frameGraph, state.selected);
    this.resources.update(domains.resources, domains.memory);
    this.diagnostics.update(domains.diagnostics);
  }

  unmount(): void {
    window.removeEventListener("resize", this.onWindowResize);
    this.host.remove();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onWindowResize);
    this.host.remove();
  }

  private button(label: string, callback: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  private svgButton(icon: string, label: string, callback: () => void): HTMLButtonElement {
    const button = this.button("", callback);
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.classList.add("icon-button");
    return button;
  }

  private createStyle(mode: InspectorStyleMode, nonce?: string): HTMLStyleElement | HTMLLinkElement {
    if (mode === "none") return document.createElement("style");
    if (mode === "external") {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./inspector.css", import.meta.url).href;
      return link;
    }
    const style = document.createElement("style");
    if (nonce !== undefined) style.nonce = nonce;
    style.textContent = INLINE_CSS;
    return style;
  }

  private showPanel(panel: InspectorPanel): void {
    this.activePanel = panel;
    this.overview.element.hidden = panel !== "overview";
    this.timeline.element.hidden = panel !== "timeline";
    this.gpuDriven.element.hidden = panel !== "gpu-driven";
    this.frameGraph.element.hidden = panel !== "framegraph";
    this.resources.element.hidden = panel !== "resources";
    this.diagnostics.element.hidden = panel !== "diagnostics";
    this.panelButtons.forEach((button, candidate) => button.setAttribute("aria-pressed", String(candidate === panel)));
  }

  private applyLayout(layout: InspectorLayout): void {
    const element = this.root.querySelector<HTMLElement>(".inspector");
    if (element === null) return;
    const maxLeft = Math.max(0, window.innerWidth - layout.width - 8);
    const maxTop = Math.max(0, window.innerHeight - layout.height - 8);
    element.style.left = `${Math.min(layout.left, maxLeft)}px`;
    element.style.top = `${Math.min(layout.top, maxTop)}px`;
    element.style.width = `${Math.min(layout.width, Math.max(320, window.innerWidth - 16))}px`;
    element.style.height = `${Math.min(layout.height, Math.max(220, window.innerHeight - 16))}px`;
  }

  private togglePanel(): void {
    const element = this.root.querySelector<HTMLElement>(".inspector");
    if (element === null) return;
    const visible = element.classList.toggle("visible");
    this.floatingToggle.classList.toggle("panel-open", visible);
    this.floatingToggle.setAttribute("aria-expanded", String(visible));
  }

  private toggleDockMode(): void {
    const element = this.root.querySelector<HTMLElement>(".inspector");
    if (element === null) return;
    this.dockMode = this.dockMode === "bottom" ? "right" : "bottom";
    element.classList.toggle("position-right", this.dockMode === "right");
    this.positionButton.innerHTML = ICON_DOCK;
  }

  private toggleMaximize(): void {
    const element = this.root.querySelector<HTMLElement>(".inspector");
    if (element === null) return;
    this.maximized = !this.maximized;
    element.classList.toggle("maximized", this.maximized);
    this.maximizeButton.innerHTML = this.maximized ? ICON_RESTORE : ICON_MAXIMIZE;
  }

  private drawToggleGraph(state: InspectorViewState): void {
    const context = this.toggleGraph.getContext("2d");
    if (context === null) return;
    const width = this.toggleGraph.width;
    const height = this.toggleGraph.height;
    context.clearRect(0, 0, width, height);
    const frames = state.frames.slice(-80);
    if (frames.length < 2) return;
    context.strokeStyle = "#4c4c6b";
    context.lineWidth = 1;
    context.beginPath();
    frames.forEach((frame, index) => {
      const sample = frame.samples["frame.rafIntervalMs"];
      const value = sample?.availability === "available" && sample.value !== null ? sample.value : 16.67;
      const x = index / (frames.length - 1) * width;
      const clampedInterval = Math.min(50, Math.max(0, value));
      const y = 2 + clampedInterval / 50 * (height - 4);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }

  private beginResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    const layout = this.layoutModel.layout;
    this.resizeState = { pointerId: event.pointerId, width: layout.width, height: layout.height, x: event.clientX, y: event.clientY };
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (this.resizeState === null || moveEvent.pointerId !== this.resizeState.pointerId) return;
      if (this.dockMode === "right") {
        this.layoutModel.setLayout({ width: this.resizeState.width - (moveEvent.clientX - this.resizeState.x), height: this.resizeState.height }, false);
      } else {
        this.layoutModel.setLayout({ width: this.resizeState.width, height: this.resizeState.height - (moveEvent.clientY - this.resizeState.y) }, false);
      }
    };
    const end = (): void => {
      if (this.resizeState === null) return;
      if (target.hasPointerCapture(this.resizeState.pointerId)) target.releasePointerCapture(this.resizeState.pointerId);
      this.layoutModel.setLayout(this.layoutModel.layout, true);
      this.resizeState = null;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
}

function presentedFps(frames: readonly InspectorViewState["frames"][number][]): number | null {
  let elapsed = 0;
  let count = 0;
  for (let index = frames.length - 1; index >= 0 && elapsed < 1000; index--) {
    const sample = frames[index]?.samples["frame.rafIntervalMs"];
    if (sample?.availability !== "available" || sample.value === null || sample.value <= 0 || sample.value > 1000) continue;
    elapsed += sample.value;
    count++;
  }
  return count >= 2 && elapsed > 0 ? count * 1000 / elapsed : null;
}
