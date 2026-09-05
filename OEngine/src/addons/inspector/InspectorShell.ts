import type { InspectorViewState } from "./InspectorViewModel.js";
import { OverviewPanel } from "./panels/OverviewPanel.js";
import { TimelinePanel } from "./panels/TimelinePanel.js";
import { GpuDrivenPanel } from "./panels/GpuDrivenPanel.js";
import { FrameGraphPanel, type FrameGraphEvidenceLike } from "./panels/FrameGraphPanel.js";
import { ResourcesPanel, type RendererMemoryEvidenceLike } from "./panels/ResourcesPanel.js";
import { DiagnosticsPanel, type DiagnosticsInput } from "./panels/DiagnosticsPanel.js";
import type { ResourceAccountingSnapshot } from "../../debug/profiling/ResourceAccounting.js";

export type InspectorStyleMode = "inline" | "external" | "none";

export interface InspectorShellOptions {
  readonly container: HTMLElement;
  readonly styles: InspectorStyleMode;
  readonly nonce?: string;
  readonly onMode: (mode: "live" | "record" | "deep-capture") => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onClose: () => void;
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

const INLINE_CSS = `
:host{all:initial;contain:content;color:#e7edf6;font:12px/1.4 system-ui,sans-serif}
.inspector{position:fixed;inset:auto auto 12px 12px;z-index:2147483647;width:min(520px,calc(100vw - 24px));max-height:min(70vh,640px);overflow:auto;padding:10px;border:1px solid #3a4b63;border-radius:8px;background:#111923ee;box-shadow:0 8px 30px #0008;backdrop-filter:blur(8px)}
.toolbar,.tabs,.summary{display:flex;align-items:center;gap:6px}.toolbar{justify-content:space-between;margin-bottom:8px}.tabs{margin-bottom:8px;flex-wrap:wrap}button{border:1px solid #43556e;border-radius:4px;padding:3px 7px;color:inherit;background:#1a2635;cursor:pointer}button:hover{background:#263852}.title{font-weight:650}.muted{color:#9aabc1}.summary{justify-content:space-between;padding:8px;border-radius:5px;background:#172333}.panel{min-height:52px;padding:8px;border:1px solid #2b3b50;border-radius:5px}
.panel h3{margin:0 0 6px;font-size:13px}.panel-tabs{margin-top:2px}.overview-stats{white-space:pre-line;color:#c4d0df;margin-bottom:6px}.inspector-chart{display:block;width:100%;height:64px;margin:4px 0;background:#0b121b;border-radius:4px}.timeline-warning{color:#facc15;min-height:18px}.timeline-details{white-space:pre-wrap;margin:6px 0 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}.timeline-strip{height:72px}
.domain-panel pre,.domain-panel div{white-space:pre-wrap;margin:4px 0;font:11px/1.45 ui-monospace,monospace;color:#c4d0df}
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
  private activePanel: "overview" | "timeline" | "gpu-driven" | "framegraph" | "resources" | "diagnostics" = "overview";
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
    toolbar.append(title, close);

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    for (const mode of ["live", "record", "deep-capture"] as const) {
      tabs.append(this.button(mode, () => options.onMode(mode)));
    }
    tabs.append(this.button("Pause", options.onPause), this.button("Resume", options.onResume));

    const panelTabs = document.createElement("div");
    panelTabs.className = "tabs panel-tabs";
    panelTabs.append(
      this.button("Overview", () => this.showPanel("overview")),
      this.button("Timeline", () => this.showPanel("timeline")),
      this.button("GPU-driven", () => this.showPanel("gpu-driven")),
      this.button("FrameGraph", () => this.showPanel("framegraph")),
      this.button("Resources", () => this.showPanel("resources")),
      this.button("Diagnostics", () => this.showPanel("diagnostics"))
    );

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
    this.panel.append(this.overview.element, this.timeline.element);
    this.panel.append(this.gpuDriven.element, this.frameGraph.element, this.resources.element, this.diagnostics.element);
    this.timeline.element.hidden = true;
    this.gpuDriven.element.hidden = true;
    this.frameGraph.element.hidden = true;
    this.resources.element.hidden = true;
    this.diagnostics.element.hidden = true;
    wrapper.append(toolbar, tabs, panelTabs, summary, this.panel);
    this.root.append(wrapper);
  }

  mount(): void {
    if (this.disposed) throw new Error("InspectorShell has been disposed");
    if (!this.host.isConnected) this.options.container.append(this.host);
  }

  update(state: InspectorViewState): void {
    if (this.disposed) return;
    this.status.textContent = `${state.mode}${state.paused ? " · paused" : ""} · ${state.frames.length} frames`;
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
    this.host.remove();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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

  private showPanel(panel: "overview" | "timeline" | "gpu-driven" | "framegraph" | "resources" | "diagnostics"): void {
    this.activePanel = panel;
    this.overview.element.hidden = panel !== "overview";
    this.timeline.element.hidden = panel !== "timeline";
    this.gpuDriven.element.hidden = panel !== "gpu-driven";
    this.frameGraph.element.hidden = panel !== "framegraph";
    this.resources.element.hidden = panel !== "resources";
    this.diagnostics.element.hidden = panel !== "diagnostics";
  }
}
