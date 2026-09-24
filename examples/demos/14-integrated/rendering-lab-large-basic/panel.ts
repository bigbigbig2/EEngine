import { LargeBasicTelemetry } from "./telemetry.ts";

const tabs = ["概览", "离线加载", "运行时", "帧性能", "诊断"] as const;
const formatMs = (value?: number) => value === undefined ? "--" : `${(value / 1000).toFixed(2)} s`;
const formatBytes = (value?: number) => value === undefined ? "--" : `${(value / 1048576).toFixed(1)} MiB`;
const integer = (value?: number) => value === undefined ? "--" : value.toLocaleString("en-US");
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const rows = (items: readonly (readonly [string, string])[]) => `<dl class="facts">${items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
const json = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;

export class LargeBasicPanel {
  private readonly content: HTMLElement;
  private readonly summary: HTMLElement;
  private activeTab = 0;
  private colorMode: "meshlet" | "solid" = "meshlet";

  constructor(private readonly telemetry: LargeBasicTelemetry, actions: { center: () => void; overview: () => void; reload: () => void; release: () => void }) {
    this.summary = document.querySelector<HTMLElement>("#summary")!;
    this.content = document.querySelector<HTMLElement>("#panel-content")!;
    const tabbar = document.querySelector<HTMLElement>("#tabs")!;
    tabbar.innerHTML = tabs.map((tab, index) => `<button type="button" data-tab="${index}" aria-selected="${index === 0}">${tab}</button>`).join("");
    tabbar.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
      if (!button) return;
      this.activeTab = Number(button.dataset.tab);
      for (const item of tabbar.querySelectorAll<HTMLButtonElement>("button")) item.setAttribute("aria-selected", String(item === button));
      this.paint();
    });
    document.querySelector("#center-view")!.addEventListener("click", actions.center);
    document.querySelector("#overview-view")!.addEventListener("click", actions.overview);
    document.querySelector("#reload")!.addEventListener("click", actions.reload);
    document.querySelector("#release")!.addEventListener("click", actions.release);
    document.querySelector("#export")!.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(this.telemetry.capture(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `large-basic-offline-${new Date().toISOString().replaceAll(":", "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    this.paint();
  }

  setColorMode(value: "meshlet" | "solid"): void { this.colorMode = value; this.paint(); }

  paint(): void {
    const t = this.telemetry;
    const state = t.error ? "失败" : t.disposedAt !== undefined ? "已释放" : t.settledAt !== undefined ? "加载完成" : t.firstPublishedAt !== undefined ? "已发布" : t.openedAt !== undefined ? "正在上传" : "读取离线包";
    document.querySelector<HTMLElement>("#load-state")!.textContent = state;
    document.querySelector<HTMLElement>("#progress-caption")!.textContent = t.offline ? `${integer(t.offline.rangeReads)} range reads / ${formatBytes(t.offline.rangeReadBytes)}` : "等待 OEGPACK";
    document.querySelector<HTMLElement>("#progress-fill")!.style.width = `${t.settledAt !== undefined ? 100 : t.firstPublishedAt !== undefined ? 85 : t.openedAt !== undefined ? 45 : 5}%`;
    this.summary.innerHTML = [
      ["打开离线包", formatMs(t.openedAt)], ["首次提交", formatMs(t.firstSubmittedAt)],
      ["完整加载", formatMs(t.settledAt)], ["实例", integer(t.sourceCount)]
    ].map(([label, value]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("");
    this.content.innerHTML = [
      () => this.overview(), () => this.offline(), () => this.runtime(),
      () => this.frames(), () => this.diagnostics()
    ][this.activeTab]!();
  }

  private overview(): string {
    const t = this.telemetry, manifest = t.manifest, offline = t.offline;
    return `<h2>离线资产</h2>${rows([
      ["入口", t.sourceUrl], ["格式", manifest?.schema ?? "等待 manifest"],
      ["Pack", integer(manifest?.packs.length)], ["资产 / 实例", `${integer(manifest?.assets.length)} / ${integer(manifest?.instances.length)}`],
      ["文件大小", formatBytes(offline?.fileBytes)], ["Page / Bootstrap", `${integer(offline?.pageCount)} / ${integer(offline?.bootstrapPageCount)}`],
      ["显示模式", this.colorMode === "meshlet" ? "Meshlet ID" : "Unlit"]
    ])}<h2>关键时间</h2>${rows([
      ["打开 OEGPACK", formatMs(t.openedAt)], ["Product 发布", formatMs(t.firstPublishedAt)],
      ["首次画面提交", formatMs(t.firstSubmittedAt)], ["全部 settled", formatMs(t.settledAt)]
    ])}<p class="note">该示例直接读取 Native Offline Cooker 生成的 scene.oescene 和 OEGPACK，不在浏览器中执行几何 Cook。</p>`;
  }

  private offline(): string {
    const e = this.telemetry.offline;
    return `<h2>OEGPACK Range Source</h2>${rows([
      ["选择", e?.selection ?? "--"], ["状态", e?.state ?? "--"], ["Product ID", e?.productId ?? "--"],
      ["Revision", integer(e?.revision)], ["文件字节", formatBytes(e?.fileBytes)],
      ["Range 读取", integer(e?.rangeReads)], ["Range 字节", formatBytes(e?.rangeReadBytes)],
      ["Page", integer(e?.pageCount)], ["Activation Page", integer(e?.activationPageCount)],
      ["Manifest", e?.manifestReady ? "ready" : "--"]
    ])}`;
  }

  private runtime(): string {
    const t = this.telemetry;
    const streaming = t.streaming as { scheduler?: Record<string, number>; readback?: Record<string, number> } | null;
    return `<h2>需求与驻留</h2>${rows([
      ["GPU demand readback", integer(streaming?.readback?.submitted)],
      ["Requested / Resident", `${integer(streaming?.scheduler?.requested)} / ${integer(streaming?.scheduler?.resident)}`],
      ["上传字节", formatBytes(streaming?.scheduler?.uploadedBytes)], ["GPU resident 峰值", formatBytes(t.peakGpuBytes)],
      ["GPU Owner 峰值", formatBytes(t.peakOwnerBytes)]
    ])}<details><summary>完整 runtime / streaming / memory evidence</summary>${json({ runtime: t.runtime, streaming: t.streaming, memory: t.memory })}</details>`;
  }

  private frames(): string {
    const t = this.telemetry, frames = t.frameStats();
    return `<h2>固定窗口帧采样</h2>${rows([
      ["CPU Render P50 / P95", stat(frames.cpu)], ["GPU Pass P50 / P95", stat(frames.gpu)],
      ["RAF P50 / P95", stat(frames.raf)], ["采样", `${frames.raf?.count ?? 0} 帧`]
    ])}`;
  }

  private diagnostics(): string {
    const t = this.telemetry;
    return `<h2>诊断</h2>${rows([
      ["状态", t.error ?? (t.disposedAt !== undefined ? "已释放" : "运行中")],
      ["资源路线", "offline-native → OEGPACK → shared Product admission"],
      ["设备错误", integer((t.adapter as { deviceErrors?: number } | null)?.deviceErrors)]
    ])}<h2>事件</h2><ol class="events">${[...t.events].reverse().slice(0, 40).map(item => `<li><time>${formatMs(item.atMs)}</time><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></li>`).join("")}</ol>`;
  }
}

function stat(value: { p50: number; p95: number; count: number } | null): string {
  return value ? `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)} ms (N=${value.count})` : "--";
}
