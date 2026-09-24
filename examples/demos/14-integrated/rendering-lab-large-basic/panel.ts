import { LargeBasicTelemetry } from "./telemetry.ts";

const tabs = ["概览", "加载阶段", "Product", "运行时", "诊断"] as const;
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
  private sort = "ordinal";
  private colorMode: "meshlet" | "solid" = "meshlet";
  private lastContentKey = "";
  private readonly telemetry: LargeBasicTelemetry;

  constructor(telemetry: LargeBasicTelemetry, actions: { center: () => void; overview: () => void; reload: () => void; release: () => void }) {
    this.telemetry = telemetry;
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
      link.download = `large-basic-${new Date().toISOString().replaceAll(":", "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    this.content.addEventListener("change", event => {
      const target = event.target as HTMLSelectElement;
      if (target.id === "product-sort") { this.sort = target.value; this.paint(); }
    });
    this.paint();
  }

  setColorMode(value: "meshlet" | "solid"): void {
    this.colorMode = value;
    this.paint();
  }

  paint(): void {
    const t = this.telemetry;
    const catalog = t.catalog;
    const published = t.publications.length;
    const percent = catalog?.primitiveCount ? Math.min(100, t.covered.size / catalog.primitiveCount * 100) : 0;
    const state = t.error ? "失败" : t.disposedAt !== undefined ? "已释放" : t.settledAt !== undefined ? "加载完成" : t.firstPublishedAt !== undefined ? "持续追加" : catalog ? "正在处理" : "读取目录";
    document.querySelector<HTMLElement>("#load-state")!.textContent = state;
    document.querySelector<HTMLElement>("#progress-caption")!.textContent = `${integer(t.covered.size)} / ${integer(catalog?.primitiveCount)} primitive`;
    document.querySelector<HTMLElement>("#progress-fill")!.style.width = `${percent}%`;
    this.summary.innerHTML = [
      ["首次提交", formatMs(t.firstSubmittedAt)], ["完整加载", formatMs(t.settledAt)],
      ["Product", integer(published)], ["覆盖", `${percent.toFixed(1)}%`]
    ].map(([label, value]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("");
    const contentKey = `${this.activeTab}:${this.sort}:${t.products.size}:${t.publications.length}:${t.covered.size}`;
    if (this.activeTab === 2 && this.lastContentKey === contentKey) return;
    this.lastContentKey = contentKey;
    const content = [
      () => this.overview(), () => this.loading(), () => this.products(),
      () => this.runtime(), () => this.diagnostics()
    ][this.activeTab]!();
    this.content.innerHTML = content!;
    const select = this.content.querySelector<HTMLSelectElement>("#product-sort");
    if (select) select.value = this.sort;
  }

  private overview(): string {
    const t = this.telemetry;
    const c = t.catalog;
    const frames = t.frameStats();
    const product = [...t.products.values()].filter(row => row.phase === "completed").sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
    return `<h2>源与结果</h2>${rows([
      ["文件", t.sourceUrl], ["传输", c?.sourceTransferMode ?? "待确认"],
      ["源大小", formatBytes(c?.sourceBytes)], ["三角形", integer(c?.primitives.reduce((sum, item) => sum + item.triangleCount, 0))],
      ["目录 primitive", integer(c?.primitiveCount)], ["已完成覆盖", `${integer(t.covered.size)} / ${integer(c?.primitiveCount)}`],
      ["已发布 Product", integer(t.publications.length)], ["最慢 Product", product ? `#${product.ordinal} ${formatMs(product.elapsedMs)}` : "--"],
      ["显示模式", this.colorMode === "meshlet" ? "Meshlet ID 分色 / 几何调试视图" : "青绿色 Unlit / 单色"],
      ["基础材质", "Unlit / 双面 / 无纹理读取"]
    ])}<h2>关键时间</h2>${rows([
      ["目录就绪", formatMs(t.catalogAt)], ["首次发布", formatMs(t.firstPublishedAt)],
      ["首次画面提交", formatMs(t.firstSubmittedAt)], ["Cook 结束", formatMs(t.progress?.timings.totalCookMs || undefined)],
      ["全部 settled", formatMs(t.settledAt)], ["GPU resident 峰值", formatBytes(t.peakGpuBytes || undefined)],
      ["Owner 内存峰值", formatBytes(t.peakOwnerBytes)]
    ])}<h2>固定窗口帧采样</h2>${rows([
      ["CPU Render P50 / P95", stat(frames.cpu)], ["GPU Pass P50 / P95", stat(frames.gpu)],
      ["RAF P50 / P95", stat(frames.raf)], ["采样", `${frames.raf?.count ?? 0} 帧；GPU timestamp ${t.adapter && (t.adapter as { gpuTimestamp?: boolean }).gpuTimestamp ? "可用" : "不可用"}`]
    ])}<p class="note">Cook 与 Scene publication 会重叠，阶段耗时不能相加当作总加载时间。首次提交只表示 Renderer 提交画面，不等于已经证明有可见像素。</p>`;
  }

  private loading(): string {
    const t = this.telemetry;
    const p = t.progress;
    const timing = Object.entries(p?.timings ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const pub = t.publications;
    const sum = (key: keyof (typeof pub)[number]) => pub.reduce((value, item) => value + (typeof item[key] === "number" ? item[key] as number : 0), 0);
    return `<h2>Cook Session</h2>${rows([
      ["阶段", p?.stage ?? "等待目录"], ["已处理", `${integer(p?.units)} / ${integer(p?.catalogPrimitives)}`],
      ["当前源窗口", formatBytes(p?.bytes)], ["总源字节", formatBytes(p?.totalBytes)],
      ["Canonicalize / WASM / Spill / Publish", `${formatMs([...t.products.values()].reduce((n, r) => n + r.canonicalizeMs, 0))} / ${formatMs([...t.products.values()].reduce((n, r) => n + r.wasmPlanMs, 0))} / ${formatMs([...t.products.values()].reduce((n, r) => n + r.spillMs, 0))} / ${formatMs([...t.products.values()].reduce((n, r) => n + r.publishMs, 0))}`],
      ["Spill 峰值", formatBytes(t.peakHeapBytes)]
    ])}<h2>生产者计时</h2>${rows(timing.map(([key, value]) => [key, formatMs(value)]))}<h2>Scene publication</h2>${rows([
      ["发布 Product", integer(pub.length)], ["GPU admission 累计", formatMs(sum("runtimeLoadMs"))],
      ["Scene mapping 累计", formatMs(sum("sceneMapMs"))], ["Source merge 累计", formatMs(sum("sourceMergeMs"))],
      ["Scene publish 累计", formatMs(sum("scenePublishMs"))],
      ["纹理读取 / 解码", `${pub.reduce((n, x) => n + x.mapping.imageReadMs, 0)} / ${pub.reduce((n, x) => n + x.mapping.imageDecodeMs, 0)} ms`]
    ])}<p class="note">各项是 Product 诊断计时。总耗时以页面时钟的 settled 为准。</p>`;
  }

  private products(): string {
    const values = [...this.telemetry.products.values()];
    values.sort(this.sort === "slowest" ? (a, b) => b.elapsedMs - a.elapsedMs : (a, b) => a.ordinal - b.ordinal);
    return `<div class="section-head"><h2>Product 任务</h2><select id="product-sort" aria-label="Product 排序"><option value="ordinal">任务顺序</option><option value="slowest">最慢优先</option></select></div><p class="note">${values.length} 个任务记录，${this.telemetry.publications.length} 个 Scene publication。</p><div class="table-scroll"><table><thead><tr><th>#</th><th>状态</th><th>Primitive</th><th>数量</th><th>三角形</th><th>页</th><th>耗时</th><th>Spill</th></tr></thead><tbody>${values.map(row => `<tr><td>${row.ordinal}</td><td>${escapeHtml(row.phase)}</td><td>${escapeHtml(row.primitive.split("|")[0])}</td><td>${integer(row.assets)}</td><td>${integer(row.triangles)}</td><td>${integer(row.pages)}</td><td>${formatMs(row.elapsedMs)}</td><td>${formatBytes(row.spillBytes)}</td></tr>`).join("")}</tbody></table></div><h2>发布时序</h2><div class="table-scroll"><table><thead><tr><th>#</th><th>等待</th><th>GPU</th><th>映射</th><th>合并</th><th>发布</th></tr></thead><tbody>${this.telemetry.publications.map(row => `<tr><td>${row.shardIndex}</td><td>${Math.round(row.sourceWaitMs)} ms</td><td>${Math.round(row.runtimeLoadMs)} ms</td><td>${Math.round(row.sceneMapMs)} ms</td><td>${Math.round(row.sourceMergeMs)} ms</td><td>${Math.round(row.scenePublishMs)} ms</td></tr>`).join("")}</tbody></table></div>`;
  }

  private runtime(): string {
    const t = this.telemetry;
    const streaming = t.streaming as { scheduler?: Record<string, number>; readback?: Record<string, number>; residency?: unknown } | null;
    const runtime = t.runtime as Record<string, number> | null;
    const frames = [...t.frames.values()];
    const last = frames.at(-1);
    const counters = [...frames].reverse().find(frame => frame.gpuCounters.sampled && !frame.gpuCounters.pending)?.gpuCounters.values ?? {};
    return `<h2>需求与驻留</h2>${rows([
      ["GPU demand readback", integer(streaming?.readback?.submitted)], ["Readback overflow", integer(streaming?.readback?.overflow)],
      ["Requested / Resident", `${integer(streaming?.scheduler?.requested)} / ${integer(streaming?.scheduler?.resident)}`],
      ["Demand overflow", integer(streaming?.scheduler?.demandOverflow)], ["失败 / 重试", `${integer(streaming?.scheduler?.failed)} / ${integer(streaming?.scheduler?.retries)}`],
      ["上传字节", formatBytes(streaming?.scheduler?.uploadedBytes)], ["活跃 Product", integer(runtime?.active)],
      ["容量 / 峰值", `${integer(runtime?.slotCapacity)} / ${integer(runtime?.peakActive)}`]
    ])}<h2>帧与 GPU 队列</h2>${rows([
      ["最后帧", integer(last?.frameIndex)], ["提交 / 上传 / 回读", `${integer(last?.submits.count)} / ${formatBytes(last?.uploads.bytes)} / ${formatBytes(last?.readbacks.bytes)}`],
      ["Queue mask / shading overflow", `${integer(counters.queueOverflowMask)} / ${integer(counters.shadingBinOverflow)}`],
      ["GPU Owner 当前 / 峰值", `${formatBytes((t.memory as { allocatedBytes?: number } | null)?.allocatedBytes)} / ${formatBytes(t.peakOwnerBytes)}`],
      ["设备错误", integer((t.adapter as { deviceErrors?: number } | null)?.deviceErrors)]
    ])}<details><summary>完整 streaming / runtime / memory evidence</summary>${json({ streaming: t.streaming, runtime: t.runtime, memory: t.memory })}</details>`;
  }

  private diagnostics(): string {
    const t = this.telemetry;
    return `<h2>诊断</h2>${rows([
      ["状态", t.error ?? (t.disposedAt !== undefined ? "已释放" : "运行中")],
      ["目录", t.catalog ? "已就绪" : "待就绪"], ["释放时间", formatMs(t.disposedAt)],
      ["数据类型", "探索性 demo；不是正式 validation evidence"]
    ])}<h2>事件</h2><ol class="events">${[...t.events].reverse().slice(0, 40).map(item => `<li><time>${formatMs(item.atMs)}</time><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></li>`).join("")}</ol><details><summary>Cook / Adapter 摘要</summary>${json({ cook: compactCook(t.cook), adapter: t.adapter })}</details>`;
  }
}

function stat(value: { p50: number; p95: number; count: number } | null): string {
  return value ? `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)} ms (N=${value.count})` : "--";
}

function compactCook(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const cook = value as Record<string, unknown>;
  const { productTaskTrace: _trace, ...summary } = cook;
  return { ...summary, productTaskTraceCount: Array.isArray(_trace) ? _trace.length : 0 };
}
