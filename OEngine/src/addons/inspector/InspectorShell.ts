import type { InspectorViewState } from "./InspectorViewModel.js";

export type InspectorStyleMode = "inline" | "external" | "none";

export interface InspectorShellOptions {
  readonly container: HTMLElement;
  readonly styles: InspectorStyleMode;
  readonly nonce?: string;
  readonly onMode: (mode: "live" | "record" | "deep-capture") => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onClose: () => void;
}

const INLINE_CSS = `
:host{all:initial;contain:content;color:#e7edf6;font:12px/1.4 system-ui,sans-serif}
.inspector{position:fixed;inset:auto 12px 12px auto;z-index:2147483647;width:min(520px,calc(100vw - 24px));max-height:min(70vh,640px);overflow:auto;padding:10px;border:1px solid #3a4b63;border-radius:8px;background:#111923ee;box-shadow:0 8px 30px #0008;backdrop-filter:blur(8px)}
.toolbar,.tabs,.summary{display:flex;align-items:center;gap:6px}.toolbar{justify-content:space-between;margin-bottom:8px}.tabs{margin-bottom:8px;flex-wrap:wrap}button{border:1px solid #43556e;border-radius:4px;padding:3px 7px;color:inherit;background:#1a2635;cursor:pointer}button:hover{background:#263852}.title{font-weight:650}.muted{color:#9aabc1}.summary{justify-content:space-between;padding:8px;border-radius:5px;background:#172333}.panel{min-height:52px;padding:8px;border:1px solid #2b3b50;border-radius:5px}
`;

/** Framework-free Shadow DOM shell. All user-visible text is assigned via textContent. */
export class InspectorShell {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly status: HTMLElement;
  private readonly selected: HTMLElement;
  private readonly panel: HTMLElement;
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

    const summary = document.createElement("div");
    summary.className = "summary";
    this.status = document.createElement("span");
    this.selected = document.createElement("span");
    this.selected.className = "muted";
    summary.append(this.status, this.selected);
    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.textContent = "Overview";
    wrapper.append(toolbar, tabs, summary, this.panel);
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
}
