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

const INLINE_CSS = `
:host{all:initial;contain:content;color:var(--inspector-text-primary);font:12px/1.4 system-ui,sans-serif;--inspector-bg:#111923f2;--inspector-panel:#172333;--inspector-border:#3a4b63;--inspector-border-soft:#2b3b50;--inspector-text-primary:#e7edf6;--inspector-text-secondary:#9aabc1;--inspector-accent:#36a3ff;--inspector-warning:#facc15;--inspector-error:#fb7185}
.inspector{position:fixed;z-index:2147483647;overflow:auto;padding:10px;border:1px solid var(--inspector-border);border-radius:10px;background:var(--inspector-bg);box-shadow:0 8px 30px #0008;backdrop-filter:blur(8px);min-width:320px;min-height:220px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);resize:none}
.toolbar,.tabs,.summary{display:flex;align-items:center;gap:6px}.toolbar{justify-content:space-between;margin-bottom:8px;cursor:move;user-select:none}.toolbar button{cursor:pointer}.tabs{margin-bottom:8px;flex-wrap:wrap}.actions{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}button{border:1px solid var(--inspector-border);border-radius:5px;padding:4px 8px;color:var(--inspector-text-primary);background:#1a2635;cursor:pointer}button:hover{border-color:var(--inspector-accent);background:#263852}.tabs button[aria-pressed="true"]{border-color:var(--inspector-accent);color:#fff;background:#14527d}.title{font-weight:700;letter-spacing:.01em}.muted{color:var(--inspector-text-secondary)}.summary{justify-content:space-between;padding:8px;border-radius:6px;background:var(--inspector-panel);font-variant-numeric:tabular-nums}.summary[data-severity="warning"]{color:var(--inspector-warning)}.summary[data-severity="error"]{color:var(--inspector-error)}.panel{position:relative;min-height:52px;padding:8px;border:1px solid var(--inspector-border-soft);border-radius:6px}
.panel h3{margin:0 0 6px;font-size:13px}.panel-tabs{margin-top:2px}.overview-stats{white-space:pre-line;color:#c4d0df;margin-bottom:6px}.inspector-chart{display:block;width:100%;height:64px;margin:4px 0;background:#0b121b;border-radius:4px}.timeline-warning{min-height:18px;color:var(--inspector-warning)}.timeline-details{white-space:pre-wrap;margin:6px 0 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}.timeline-strip{height:72px}.domain-panel pre,.domain-panel div{white-space:pre-wrap;margin:4px 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}.resize-handle{position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.7;background:linear-gradient(135deg,transparent 45%,var(--inspector-accent) 46%,var(--inspector-accent) 54%,transparent 55%),linear-gradient(135deg,transparent 62%,var(--inspector-accent) 63%,var(--inspector-accent) 71%,transparent 72%)}
:host{pointer-events:none}.profiler-toggle{pointer-events:auto;position:fixed;top:15px;right:15px;z-index:1001;display:flex;align-items:center;gap:8px;padding:0 12px;height:36px;border:1px solid #4a4a5a54;border-radius:12px 6px 6px 12px;background:#1e1e24d9;color:var(--inspector-text-primary);font:600 13px 'Segoe UI',Tahoma,sans-serif;box-shadow:0 4px 15px #0005;backdrop-filter:blur(8px);transition:all .2s ease-in-out;overflow:hidden}.profiler-toggle:hover{border-color:var(--inspector-accent);background:#252532e8}.profiler-toggle.panel-open{color:var(--inspector-accent);box-shadow:0 0 0 1px #00aaff33,0 4px 15px #0005}.profiler-toggle-graph{position:absolute;inset:0;width:100%;height:100%;opacity:.5;pointer-events:none}.toggle-text{position:relative;z-index:1;min-width:70px;text-align:right}.inspector.profiler-panel{pointer-events:auto;left:0!important;right:0!important;top:auto!important;bottom:0!important;width:auto!important;height:350px;max-width:none;max-height:calc(100vh - 50px);padding:0;border-width:2px 0 0;border-radius:8px 8px 0 0;display:flex;flex-direction:column;overflow:hidden;transform:translateY(100%);transition:transform .35s cubic-bezier(.25,.46,.45,.94),height .3s ease-out}.inspector.profiler-panel.visible{transform:translateY(0)}.inspector.profiler-panel.position-right{left:auto!important;right:0!important;top:0!important;bottom:0!important;width:350px!important;height:100%!important;border-width:0 0 0 2px;border-radius:8px 0 0 8px;transform:translateX(100%)}.inspector.profiler-panel.position-right.visible{transform:translateX(0)}.inspector.profiler-panel.maximized{left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;height:100vh!important;border-radius:0}.inspector.profiler-panel .toolbar{height:32px;min-height:32px;padding:0 8px;margin:0;background:#2a2a33aa;border-bottom:1px solid var(--inspector-border);font-family:'Segoe UI',Tahoma,sans-serif;cursor:default}.inspector.profiler-panel .toolbar>.title{flex:0 0 auto;margin-right:10px;font-size:12px;white-space:nowrap}.inspector.profiler-panel .toolbar>.panel-tabs{flex:1 1 auto;min-width:0;margin:0;padding:0;background:transparent}.profiler-controls{display:flex;align-items:stretch;height:100%;margin-left:auto}.profiler-controls button{height:100%;min-width:32px;padding:0 9px;border:0;border-left:1px solid var(--inspector-border);border-radius:0;background:transparent}.inspector.profiler-panel .control-strip{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:3px 8px;background:#1e1e24aa;border-bottom:1px solid #2a2a33}.inspector.profiler-panel .control-strip .tabs,.inspector.profiler-panel .control-strip .actions{padding:0;margin:0;background:transparent}.inspector.profiler-panel .control-strip button{padding:3px 7px;font-size:11px}.inspector.profiler-panel .control-strip .icon-button{width:30px;min-width:30px;padding:0;font-size:13px;border:0;border-radius:3px;color:var(--inspector-text-secondary);background:transparent}.inspector.profiler-panel .control-strip .icon-button:hover{color:var(--inspector-text-primary);background:rgba(255,255,255,.08)}.inspector.profiler-panel>.panel{flex:1;overflow:auto;margin:0 8px 8px}.inspector.profiler-panel .resize-handle{top:0;bottom:auto;left:0;right:0;width:100%;height:5px;cursor:ns-resize}.inspector.profiler-panel.position-right .resize-handle{top:0;bottom:0;left:-2px;right:auto;width:5px;height:100%;cursor:ew-resize}.inspector.profiler-panel .panel-tabs{overflow-x:auto;flex-wrap:nowrap}.inspector.profiler-panel .panel-tabs button{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 15px;font:600 13px 'Segoe UI',Tahoma,sans-serif;color:var(--inspector-text-secondary);white-space:nowrap}.inspector.profiler-panel .panel-tabs button[aria-pressed="true"]{border-bottom-color:var(--inspector-accent);color:#fff;background:transparent}
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
    this.toggleLabel.textContent = "Inspector";
    this.floatingToggle.append(this.toggleGraph, this.toggleLabel);
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "OEngine Performance Inspector";
    const controls = document.createElement("span");
    controls.className = "profiler-controls";
    this.positionButton = this.button("⇆", () => this.toggleDockMode());
    this.positionButton.title = "Switch dock position";
    this.maximizeButton = this.button("□", () => this.toggleMaximize());
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
    for (const mode of ["live", "record", "deep-capture"] as const) {
      const button = this.button(mode, () => options.onMode(mode));
      this.modeButtons.set(mode, button);
      tabs.append(button);
    }
    tabs.append(this.button("Pause", options.onPause), this.button("Resume", options.onResume));

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      this.iconButton("●", "Start recording", options.onStartRecording),
      this.iconButton("■", "Stop recording", options.onStopRecording),
      this.iconButton("◉", "Capture next frame", options.onCaptureNextFrame),
      this.iconButton("↓", "Export capture", options.onExportCapture),
      this.iconButton("⇩", "Export Chrome Trace", options.onExportTrace),
      this.iconButton("⌫", "Clear frames", options.onClear)
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
    actions.append(this.iconButton("↑", "Import capture", () => importInput.click()), importInput);

    const panelTabs = document.createElement("div");
    panelTabs.className = "tabs panel-tabs";
    for (const [panel, label] of [["overview", "Overview"], ["timeline", "Timeline"], ["gpu-driven", "GPU-driven"], ["framegraph", "FrameGraph"], ["resources", "Resources"], ["diagnostics", "Diagnostics"]] as const) {
      const button = this.button(label, () => this.showPanel(panel));
      this.panelButtons.set(panel, button);
      panelTabs.append(button);
    }
    toolbar.insertBefore(panelTabs, controls);

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
    wrapper.append(toolbar, summary, controlStrip, this.panel, this.resizeHandle);
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
    this.status.textContent = `${state.mode}${state.paused ? " · paused" : ""} · ${state.source} · ${state.frames.length} frames`;
    const cpuFrame = state.latest?.samples["cpu.frameMs"];
    const fps = cpuFrame?.availability === "available" && cpuFrame.value !== null && cpuFrame.value > 0
      ? Math.round(1000 / cpuFrame.value)
      : null;
    this.toggleLabel.textContent = fps === null ? "Inspector" : `${fps} FPS`;
    this.drawToggleGraph(state);
    this.status.dataset.mode = state.mode;
    this.modeButtons.forEach((button, mode) => button.setAttribute("aria-pressed", String(mode === state.mode)));
    this.panelButtons.forEach((button, panel) => button.setAttribute("aria-pressed", String(panel === this.activePanel)));
    this.selected.textContent = state.selectedFrameIndex === null
      ? "no frame selected"
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

  private iconButton(icon: string, label: string, callback: () => void): HTMLButtonElement {
    const button = this.button(icon, callback);
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
    this.positionButton.textContent = this.dockMode === "right" ? "⇄" : "⇆";
  }

  private toggleMaximize(): void {
    const element = this.root.querySelector<HTMLElement>(".inspector");
    if (element === null) return;
    this.maximized = !this.maximized;
    element.classList.toggle("maximized", this.maximized);
    this.maximizeButton.textContent = this.maximized ? "❐" : "□";
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
      const sample = frame.samples["cpu.frameMs"];
      const value = sample?.availability === "available" && sample.value !== null ? sample.value : 16.67;
      const x = index / (frames.length - 1) * width;
      const y = Math.max(2, Math.min(height - 2, height - Math.min(32, 1000 / Math.max(1, value))));
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
