import { BasicTelemetry } from "./telemetry.ts";

const tabs = ["管线", "Worker Cook", "虚拟几何", "材质", "帧性能", "诊断"] as const;
const seconds = (value?: number) => value === undefined ? "--" : `${(value / 1000).toFixed(2)} s`;
const bytes = (value?: number) => value === undefined ? "--" : `${(value / 1048576).toFixed(1)} MiB`;
const integer = (value?: number) => value === undefined ? "--" : value.toLocaleString("en-US");
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const rows = (items: readonly (readonly [string, string])[]) => `<dl class="facts">${items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
const json = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const stat = (value: { p50: number; p95: number; count: number } | null) => value ? `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)} ms (N=${value.count})` : "--";

export class BasicPanel {
  private readonly inspector = document.querySelector<HTMLElement>("#inspector")!;
  private readonly summary = document.querySelector<HTMLElement>("#summary")!;
  private readonly content = document.querySelector<HTMLElement>("#panel-content")!;
  private activeTab = 0;
  private colorMode: "meshlet" | "pbr" = "pbr";
  private gpuCountersEnabled = false;

  constructor(private readonly telemetry: BasicTelemetry, actions: { center: () => void; overview: () => void; reload: () => void; release: () => void; gpuCounters: (enabled: boolean) => void }) {
    document.querySelector<HTMLButtonElement>("#panel-toggle")!.addEventListener("click", () => {
      const collapsed = this.inspector.classList.toggle("collapsed");
      document.querySelector(".workspace")!.classList.toggle("panel-collapsed", collapsed);
      document.querySelector("#panel-toggle")!.setAttribute("aria-expanded", String(!collapsed));
      document.querySelector("#panel-toggle")!.textContent = collapsed ? "展开" : "收起";
    });
    document.querySelector<HTMLInputElement>("#gpu-pixel-counters")!.addEventListener("change", event => {
      this.gpuCountersEnabled = (event.target as HTMLInputElement).checked;
      actions.gpuCounters(this.gpuCountersEnabled);
      this.paint();
    });
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
      link.download = `rendering-lab-basic-${new Date().toISOString().replaceAll(":", "-")}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    this.paint();
  }

  setColorMode(value: "meshlet" | "pbr"): void { this.colorMode = value; this.paint(); }

  paint(): void {
    const t = this.telemetry;
    const state = t.error ? "失败" : t.disposedAt !== undefined ? "已释放" : t.releasingAt !== undefined ? "正在释放" : t.settledAt !== undefined ? "Cook 完成" : t.firstPublishedAt !== undefined ? "已发布，继续烘焙" : t.catalog ? "Worker Cook 中" : "读取 GLB 目录";
    const total = t.catalog?.primitiveCount;
    const done = t.progress?.units ?? 0;
    const percent = t.settledAt !== undefined ? 100 : total ? Math.min(95, done / total * 90) : 5;
    document.querySelector<HTMLElement>("#load-state")!.textContent = state;
    document.querySelector<HTMLElement>("#progress-caption")!.textContent = `${integer(done)} / ${integer(total)} primitive`;
    document.querySelector<HTMLElement>("#progress-fill")!.style.width = `${percent}%`;
    this.summary.innerHTML = [
      ["目录就绪", seconds(t.catalogAt)], ["首次提交", seconds(t.firstSubmittedAt)],
      ["Cook 完成", seconds(t.settledAt)], ["当前实例", integer(t.sourceCount)]
    ].map(([label, value]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("");
    this.content.innerHTML = [
      () => this.overview(), () => this.worker(), () => this.geometry(),
      () => this.materials(), () => this.frames(), () => this.diagnostics()
    ][this.activeTab]!();
  }

  private overview(): string {
    const t = this.telemetry;
    const frames = t.frameStats();
    const graph = t.graph;
    const finalOutput = record(t.finalOutput);
    return `<h2>固定渲染路径</h2><ol class="pipeline-flow"><li>Visibility</li><li>Sparse Material Resolve</li><li>PBR Direct + IBL</li><li>线性 HDR</li><li>Post effects：关闭</li></ol>${rows([
      ["内部光照", "rgba16float HDR"],
      ["DPR / 内部分辨率比例", "1 / 1"],
      ["显示输出", graph ? `${graph.outputMode.toUpperCase()} / ${graph.outputFormat}` : "--"],
      ["最终输出 Pass", integer(number(finalOutput.finalOutputPasses))],
      ["Bloom / 调色 / 锐化融合", `${String(finalOutput.bloomFused ?? false)} / ${String(finalOutput.colorGradingFused ?? false)} / ${String(finalOutput.sharpeningFused ?? false)}`]
    ])}<p class="note">普通 SDR 屏幕仍需最终输出映射；这一步不代表 Bloom、曝光或时域后处理已开启。</p><h2>实际 FrameGraph Pass</h2><ol class="pass-list">${(graph?.passes ?? []).map(name => `<li>${escapeHtml(name)}</li>`).join("") || "<li>等待首次提交</li>"}</ol><h2>源与画面</h2>${rows([
      ["模型", "dungeon_warkarma.glb"], ["路线", "GLB → Web Worker/WASM → Product → 虚拟几何"],
      ["源大小", bytes(t.catalog?.sourceBytes)], ["Primitive / 实例节点", `${integer(t.catalog?.primitiveCount)} / ${integer(t.catalog?.instances.length)}`],
      ["当前 Product 资产 / 实例", `${integer(t.assetCount)} / ${integer(t.sourceCount)}`], ["已发布 Product", integer(t.shardCount)],
      ["显示", this.colorMode === "meshlet" ? "Meshlet ID" : "PBR 着色"],
      ["材质槽位", integer(t.materialCount)],
      ["源 BaseColor 贴图", `${t.materialDomains.filter(item => item.baseColorTexture).length} / ${t.materialDomains.length}`]
    ])}<h2>加载时序</h2>${rows([
      ["目录就绪", seconds(t.catalogAt)], ["首个 Product 发布", seconds(t.firstPublishedAt)],
      ["首次画面提交", seconds(t.firstSubmittedAt)], ["Cook settled", seconds(t.settledAt)]
    ])}<h2>最近 360 帧</h2>${rows([
      ["CPU Render P50 / P95", stat(frames.cpu)], ["GPU Pass P50 / P95", stat(frames.gpu)],
      ["RAF P50 / P95", stat(frames.raf)]
    ])}<p class="note">Worker 运行时烘焙几何；画面可以在完整 Cook 结束前使用首个 Product。请在 Cook 完成后比较稳定帧，Meshlet ID 与 PBR 的 GPU 工作量不同。</p>`;
  }

  private worker(): string {
    const t = this.telemetry;
    const timing = Object.entries(t.progress?.timings ?? {}).sort(([left], [right]) => left.localeCompare(right));
    return `<h2>Cook Session</h2>${rows([
      ["阶段", t.progress?.stage ?? "等待目录"], ["已处理", `${integer(t.progress?.units)} / ${integer(t.progress?.catalogPrimitives)}`],
      ["源传输", t.catalog?.sourceTransferMode ?? "--"], ["源字节", bytes(t.catalog?.sourceBytes)],
      ["当前读取 / 总量", `${bytes(t.progress?.bytes)} / ${bytes(t.progress?.totalBytes)}`]
    ])}<h2>Worker 阶段计时</h2>${rows(timing.map(([key, value]) => [key, seconds(value)]))}<details><summary>完整 Cook evidence</summary>${json(t.cook)}</details>`;
  }

  private geometry(): string {
    const t = this.telemetry;
    const streaming = record(t.streaming);
    const scheduler = record(streaming.scheduler);
    const readback = record(streaming.readback);
    const residency = record(streaming.residency);
    return `<h2>Product 与驻留</h2>${rows([
      ["发布实例 / 资产", `${integer(t.sourceCount)} / ${integer(t.assetCount)}`], ["已发布 Product", integer(t.shardCount)],
      ["GPU 需求回读", integer(number(readback.submitted))], ["回读溢出", integer(number(readback.overflow))],
      ["请求 / 驻留", `${integer(number(scheduler.requested))} / ${integer(number(scheduler.resident))}`],
      ["需求溢出", integer(number(scheduler.demandOverflow))], ["补页上传", bytes(number(scheduler.uploadedBytes))],
      ["驻留页", integer(number(residency.residentPages))],
      ["GPU Owner 当前 / 峰值", `${bytes(number(record(t.memory).allocatedBytes))} / ${bytes(t.peakOwnerBytes)}`],
      ["GPU resident 峰值", bytes(t.peakGpuBytes)]
    ])}<details><summary>完整 runtime / streaming / memory evidence</summary>${json({ runtime: t.runtime, streaming: t.streaming, memory: t.memory })}</details>`;
  }

  private materials(): string {
    const t = this.telemetry;
    const texture = record(t.texture);
    const features = record(t.features);
    const sum = (read: (item: (typeof t.publications)[number]) => number) => t.publications.reduce((total, item) => total + read(item), 0);
    const authored = t.materialDomains;
    const baseColorTextureCount = authored.filter(item => item.baseColorTexture).length;
    const ormTextureCount = authored.filter(item => item.ormTexture).length;
    const occlusionTextureCount = authored.filter(item => item.occlusionTexture).length;
    const metallicZeroCount = authored.filter(item => item.metallic === 0).length;
    const surfaceCounterActive = t.graph?.passes.includes("R4-B GPU Surface counters") === true;
    const sampled = this.gpuCountersEnabled
      ? [...t.frames.values()].reverse().find(frame => frame.gpuCounters.sampled && !frame.gpuCounters.pending)?.gpuCounters.values
      : undefined;
    const surfaceSampled = surfaceCounterActive ? sampled : undefined;
    const swatch = (values: readonly number[]) => `rgb(${values.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(1, value)) * 255)).join(",")})`;
    return `<h2>材质与贴图驻留</h2>${rows([
      ["材质槽位", integer(t.materialCount)],
      ["源材质", integer(authored.length)],
      ["BaseColor / 金属粗糙度贴图", `${integer(baseColorTextureCount)} / ${integer(ormTextureCount)}`],
      ["源 AO 贴图", integer(occlusionTextureCount)],
      ["金属系数为 0 的材质", `${integer(metallicZeroCount)} / ${integer(authored.length)}`],
      ["驻留贴图", integer(number(texture.residentTextureCount))],
      ["贴图逻辑 / 物理字节", `${bytes(number(texture.logicalResidentBytes))} / ${bytes(number(texture.physicalAllocatedBytes))}`],
      ["运行时贴图池拷贝", integer(number(texture.resizeDispatchCount))],
      ["绑定集", integer(number(texture.bindingSetCount))],
      ["绑定预检失败", integer(number(texture.bindingSetPreflightFailures))]
    ])}<h2>GPU 像素诊断</h2>${!surfaceCounterActive ? '<p class="note">当前固定管线不生成 SurfaceLite，因此这组表面像素计数不可用；“--”不代表纹理未采样。</p>' : ''}${rows([
      ["着色像素", integer(sampled?.shadedPixels)],
      ["ORM 纹理表面像素", integer(surfaceSampled?.ormTexturePixels)],
      ["Unlit 表面像素", integer(surfaceSampled?.unlitSurfacePixels)],
      ["环境光采样像素", integer(surfaceSampled?.iblSampledPixels)]
    ])}<h2>逐批发布耗时（累计）</h2>${rows([
      ["场景映射", seconds(sum(item => item.sceneMapMs))],
      ["图片读取 / 解码", `${seconds(sum(item => item.mapping.imageReadMs))} / ${seconds(sum(item => item.mapping.imageDecodeMs))}`],
      ["贴图缓存命中 / 未命中", `${integer(sum(item => item.mapping.textureCacheHits))} / ${integer(sum(item => item.mapping.textureCacheMisses))}`],
      ["场景发布", seconds(sum(item => item.scenePublishMs))]
    ])}<h2>当前效果</h2>${rows([
      ["阴影", String(features.shadows ?? "--")], ["漫反射", String(features.screenSpaceDiffuseMode ?? "--")],
      ["SSR", String(features.screenSpaceReflections ?? "--")], ["TAA", String(features.temporalAntiAliasing ?? "--")],
      ["Bloom", String(features.bloom ?? "--")], ["自动曝光", String(features.automaticExposure ?? "--")]
    ])}<p class="note">这个 GLB 的 ${authored.length} 个材质中，${metallicZeroCount} 个显式设置金属系数为 0；金属贴图 B 通道乘以该系数后仍为 0。${occlusionTextureCount} 个材质带 AO 贴图，R 通道只影响环境间接光；屏幕空间 AO 依固定管线设置关闭。</p><details open><summary>源材质参数</summary><div class="table-scroll"><table class="material-table"><thead><tr><th>索引</th><th>基础色系数</th><th>金属度</th><th>粗糙度</th><th>AO 强度</th><th>纹理</th></tr></thead><tbody>${authored.map(item => `<tr><td>${item.index}</td><td><i class="swatch" style="background:${swatch(item.baseColor)}"></i>${item.baseColor.slice(0, 3).map(value => value.toFixed(2)).join(" / ")}</td><td>${item.metallic.toFixed(2)}</td><td>${item.roughness.toFixed(2)}</td><td>${item.occlusionStrength.toFixed(2)}</td><td>${[item.baseColorTexture && "颜色", item.ormTexture && "金属粗糙", item.occlusionTexture && "AO", item.normalTexture && "法线", item.emissiveTexture && "自发光"].filter(Boolean).join(" / ") || "无"}</td></tr>`).join("")}</tbody></table></div></details><p class="note">运行时图片通过 GPU 源纹理和渲染拷贝进入贴图池；“离线纹理包上传”只统计离线包路径，所以本示例为 0。贴图最长边限制为 1024 像素，物理字节包含贴图池预分配。</p><details><summary>完整贴图 evidence</summary>${json(t.texture)}</details>`;
  }

  private frames(): string {
    const t = this.telemetry;
    const stats = t.frameStats();
    const last = [...t.frames.values()].at(-1);
    const counters = [...t.frames.values()].reverse().find(frame => frame.gpuCounters.sampled && !frame.gpuCounters.pending)?.gpuCounters.values ?? {};
    return `<h2>最近 360 帧</h2>${rows([
      ["CPU Render P50 / P95", stat(stats.cpu)], ["GPU Pass P50 / P95", stat(stats.gpu)],
      ["RAF P50 / P95", stat(stats.raf)], ["GPU timestamp", record(t.adapter).gpuTimestamp === true ? "可用" : "不可用"],
      ["最后帧", integer(last?.frameIndex)], ["提交 / 上传 / 回读", `${integer(last?.submits.count)} / ${bytes(last?.uploads.bytes)} / ${bytes(last?.readbacks.bytes)}`],
      ["Queue overflow mask", integer(number(counters.queueOverflowMask))]
    ])}<p class="note">GPU 数值是采样 Pass 的耗时和；首次提交时间不代表 GPU 完成呈现。切换显示模式后请重新观察稳定帧。</p>`;
  }

  private diagnostics(): string {
    const t = this.telemetry;
    return `<h2>诊断</h2>${rows([
      ["状态", t.error ?? (t.disposedAt !== undefined ? "已释放" : "运行中")],
      ["WebGPU 错误", integer(number(record(t.adapter).deviceErrors))],
      ["Worker", "独立 portable-single 会话"], ["验证等级", "探索性示例，不是正式 Browser Case"]
    ])}<h2>事件</h2><ol class="events">${[...t.events].reverse().slice(0, 30).map(item => `<li><time>${seconds(item.atMs)}</time><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></li>`).join("")}</ol>`;
  }
}
