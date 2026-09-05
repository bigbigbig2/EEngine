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
  private readonly onWindowResize = (): void => this.applyLayout(this.layoutModel.layout);
  private activePanel: InspectorPanel = "overview";
  private dragState: { pointerId: number; left: number; top: number; x: number; y: number } | null = null;
  private resizeState: { pointerId: number; width: number; height: number; x: number; y: number } | null = null;
  private disposed = false;

  constructor(private readonly options: InspectorShellOptions) {
    this.host = document.createElement("oengine-inspector");
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.append(this.createStyle(options.styles, options.nonce));

    const wrapper = document.createElement("div");
    wrapper.className = "inspector";
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "OEngine Performance Inspector";
    const close = this.button("Close", options.onClose);
    const reset = this.button("Reset", () => this.layoutModel.reset());
    toolbar.append(title, reset, close);
    toolbar.addEventListener("pointerdown", (event) => this.beginDrag(event));

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
    wrapper.append(toolbar, tabs, actions, panelTabs, summary, this.panel, this.resizeHandle);
    this.root.append(wrapper);
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

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0 || event.target instanceof HTMLButtonElement) return;
    const target = event.currentTarget as HTMLElement;
    const layout = this.layoutModel.layout;
    this.dragState = { pointerId: event.pointerId, left: layout.left, top: layout.top, x: event.clientX, y: event.clientY };
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (this.dragState === null || moveEvent.pointerId !== this.dragState.pointerId) return;
      this.layoutModel.setLayout({ left: this.dragState.left + moveEvent.clientX - this.dragState.x, top: this.dragState.top + moveEvent.clientY - this.dragState.y }, false);
    };
    const end = (): void => {
      if (this.dragState === null) return;
      if (target.hasPointerCapture(this.dragState.pointerId)) target.releasePointerCapture(this.dragState.pointerId);
      this.layoutModel.setLayout(this.layoutModel.layout, true);
      this.dragState = null;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  private beginResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    const layout = this.layoutModel.layout;
    this.resizeState = { pointerId: event.pointerId, width: layout.width, height: layout.height, x: event.clientX, y: event.clientY };
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      if (this.resizeState === null || moveEvent.pointerId !== this.resizeState.pointerId) return;
      this.layoutModel.setLayout({ width: this.resizeState.width + moveEvent.clientX - this.resizeState.x, height: this.resizeState.height + moveEvent.clientY - this.resizeState.y }, false);
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
