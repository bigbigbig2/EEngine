import type { OrbitControls, PerspectiveCamera, Renderer } from "../../../../OEngine/src/index.ts";
import { distribution, frameSeries, gpuRows, shadingDispatchEvidence, shadingExecutionModeLabel, type Distribution, type ExperimentFrame } from "./PerformanceMetrics.ts";

interface PanelOptions {
  renderer: Renderer;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  variant: "basic" | "full";
  scene: { model: string; instances: number; geometries: number; materials: number };
  resetCamera: () => void;
}
type Conditions = ReturnType<PerformancePanel["conditions"]>;
interface Capture {
  schema: "oengine-lab-experiment-v1";
  createdAt: string;
  conditions: Conditions;
  warmupSeconds: number;
  sampleSeconds: number;
  actualSampleSeconds: number;
  frames: ExperimentFrame[];
  diagnostics: Renderer["profiler"]["diagnostics"];
  graph: ReturnType<Renderer["mainFrameGraphEvidence"]>;
  memory: ReturnType<Renderer["memoryEvidence"]>;
  textureResidency?: ReturnType<Renderer["textureResidencyEvidence"]>;
  completion: "completed" | "interrupted";
  warnings: string[];
  summary: { gpu: Distribution | null; cpu: Distribution | null; raf: Distribution | null; phases: Record<string, Distribution>; passes: Record<string, Distribution> };
}
const STORAGE_KEY = "oengine-lab-experiment-comparison-v1";
const FEATURES = [
  ["shadows", "Shadow"], ["screenSpaceReflections", "SSR"], ["temporalAntiAliasing", "TAA"],
  ["bloom", "Bloom"], ["automaticExposure", "Exposure"], ["motionBlur", "Motion Blur"], ["sharpening", "Sharpen"]
] as const;

export class PerformancePanel {
  private readonly root = document.createElement("aside");
  private readonly live = new Map<number, ExperimentFrame>();
  private readonly recorded = new Map<number, ExperimentFrame>();
  private readonly unsubscribe: () => void;
  private state: "idle" | "warming" | "sampling" | "draining" | "done" = "idle";
  private startedAt = 0;
  private sampleStartedAt = 0;
  private sampleEndedAt = 0;
  private startFrame = Infinity;
  private endFrame = Infinity;
  private warmupSeconds = 2;
  private sampleSeconds = 10;
  private captureConditions: Conditions | null = null;
  private result: Capture | null = null;
  private comparison: Capture | null = null;
  private lastPaint = -Infinity;
  private lastConditions = "";
  private message = "实时观察 · 点击采样固定视角，预热后记录";
  private interrupted = false;
  private previousControlsEnabled = true;
  private readonly onVisibility = () => {
    if (document.hidden && this.busy) this.stop("页面进入后台，采样中断");
  };

  constructor(private readonly options: PanelOptions) {
    const profiler = options.renderer.profiler;
    profiler.configure({ enabled: true, gpuSampleInterval: 4, gpuCounterSampleInterval: 12, historyCapacity: 2048, readbackRingSlots: 8, cpuPassTimings: true });
    // Both examples use exactly the same instrumentation. Explicit configure
    // enables bounded counter sampling without the live mode's counter-off policy.
    profiler.setMode("record");
    this.root.className = "lab-performance";
    this.root.setAttribute("aria-label", "详细性能面板");
    this.root.innerHTML = `
      <header><div><small>VISIBILITY → SPARSE SHADING</small><h2>${options.variant === "basic" ? "Unlit / Basic" : "PBR / Full"}<span>性能实验</span></h2></div><button data-action="collapse" aria-expanded="true" title="收起性能面板">−</button></header>
      <div class="lab-performance-body">
        <div class="lab-toolbar"><button data-action="record">开始采样</button><button data-action="stop" disabled>停止</button><button data-action="reset-camera">重置视角</button><button data-action="clear">清空</button></div>
        <div class="lab-sampling"><label>预热 <input data-input="warmup" type="number" min="0" max="20" value="2"> 秒</label><label>记录 <input data-input="duration" type="number" min="1" max="30" value="10"> 秒</label><label><input data-input="heavy" type="checkbox"> 每帧 GPU counters</label></div>
        <p class="lab-status" data-view="status" role="status"></p>
        <div class="lab-cards" data-view="cards"></div>
        <canvas class="lab-trend" data-view="trend" width="800" height="150" aria-label="GPU Pass Sum、CPU 和 RAF 趋势"></canvas>
        <div class="lab-legend"><span>● GPU Pass Sum</span><span>● CPU Render</span><span>● RAF 间隔</span></div>
        <p class="lab-note">GPU 为已测 Pass 之和，不含全部 copy/clear/Pass 间成本；RAF 含显示刷新等待。</p>
        <details open><summary>对照条件与功能</summary><div data-view="conditions"></div>
          <div class="lab-features">${FEATURES.map(([key, label]) => `<label><input type="checkbox" data-feature="${key}">${label}</label>`).join("")}<label>Diffuse <select data-input="diffuse"><option value="off">Off</option><option value="gtao">GTAO</option><option value="ssgi">SSGI</option></select></label></div>
          <div class="lab-toolbar"><button data-action="effects-off">全部效果关闭</button><button data-action="defaults">恢复默认效果</button><a href="../${options.variant === "basic" ? "rendering-lab" : "rendering-lab-basic"}/index.html">打开 ${options.variant === "basic" ? "PBR / Full" : "Unlit / Basic"}</a></div>
        </details>
        <details open><summary>Sparse 队列、覆盖率与输出</summary><div data-view="sparse"></div><p class="lab-note">64×W/P 是总 invocation 放大，含 tile 覆盖不满、多 bin 重复与 dispatch 补齐。不同非空 tile 数 T、每 bin 像素密度尚未采集，无法单独算 R/T。</p><p class="lab-note">三角形重建、材质采样、GGX 与阴影采样融合在 resolve 中，当前不能分别计时。</p></details>
        <details open><summary>GPU 阶段 · P50 / P95</summary><div data-view="phases"></div></details>
        <details open><summary>全部 GPU Pass · P50 / P95</summary><div data-view="passes"></div></details>
        <details><summary>CPU 分段、提交与 I/O</summary><div data-view="cpu"></div></details>
        <details><summary>资源与 GPU diagnostics</summary><div data-view="resources"></div></details>
        <details><summary>最新 GPU counters（原始值）</summary><div data-view="counters"></div></details>
        <details open><summary>记录与两份结果对照</summary><div class="lab-toolbar"><button data-action="export" disabled>导出 JSON</button><button data-action="save" disabled>保存为对照</button><button data-action="import">导入对照 JSON</button><button data-action="load">读取已保存对照</button></div><input type="file" accept="application/json,.json" data-input="file" hidden><div data-view="comparison"></div></details>
      </div>`;
    document.body.append(this.root);
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (button) this.action(button.dataset.action!);
    });
    this.root.addEventListener("change", (event) => this.change(event.target as HTMLInputElement | HTMLSelectElement));
    document.addEventListener("visibilitychange", this.onVisibility);
    this.unsubscribe = profiler.subscribe((snapshot) => {
      const metric = profiler.historyStore?.get(snapshot.frameIndex)?.samples["gpu.passSumMs"];
      const frame: ExperimentFrame = { ...snapshot, gpuValid: metric?.availability === "available" && snapshot.gpu.segments.length > 0 };
      // A GPU timing/counter callback updates the original frame; never append a
      // second sample or combine a late result with the latest frame.
      if (this.live.has(frame.frameIndex) || frame.frameIndex >= (this.live.keys().next().value ?? -1)) {
        this.live.set(frame.frameIndex, frame);
        if (this.live.size > 600) this.live.delete(this.live.keys().next().value!);
      }
      if ((this.state === "sampling" || this.state === "draining") && frame.frameIndex >= this.startFrame && frame.frameIndex <= this.endFrame) {
        if (this.recorded.size >= 5000 && !this.recorded.has(frame.frameIndex)) this.stop("已达到 5000 帧记录上限");
        else this.recorded.set(frame.frameIndex, frame);
      }
    });
    this.lastConditions = this.conditionKey();
    this.paint();
  }

  private get busy(): boolean { return this.state === "warming" || this.state === "sampling" || this.state === "draining"; }

  conditions() {
    const { renderer, camera, controls, scene, variant, canvas } = this.options;
    const temporal = renderer.temporalEvidence();
    return {
      variant, scene, revision: import.meta.env.VITE_OENGINE_REVISION ?? "unlabeled-working-tree",
      adapter: renderer.adapter_info, capabilities: renderer.capabilities,
      browser: navigator.userAgent, dpr: renderer.pixel_ratio,
      cssExtent: [canvas.clientWidth, canvas.clientHeight],
      internalExtent: [temporal.internalWidth, temporal.internalHeight], outputExtent: [temporal.outputWidth, temporal.outputHeight],
      camera: { position: [camera.transform.position.x, camera.transform.position.y, camera.transform.position.z], target: [controls.target.x, controls.target.y, controls.target.z], near: camera.near, far: camera.far, fov: camera.fov },
      settings: renderer.render_settings,
      visibility: { cone: renderer.packed_visibility_cone_enabled, hzb: renderer.packed_visibility_hzb_enabled, sse: renderer.packed_visibility_sse_threshold },
      lighting: variant === "full" ? "HDR environment + Sun 2.8, azimuth -36°, elevation 65°" : "Unlit, no environment / Sun",
      instrumentation: { gpuInterval: renderer.profiler.gpuSampleInterval, counterInterval: renderer.profiler.gpuCounterSampleInterval, readbackRingSlots: renderer.profiler.readbackRingSlots, cpuPassTimings: renderer.profiler.cpuPassTimings }
    };
  }

  /** Read-only automation hook; export and comparison keep the same capture. */
  captureJson(): string | null {
    return this.result === null ? null : JSON.stringify(this.result, null, 2);
  }

  private conditionKey(): string { return JSON.stringify(this.conditions()); }

  beforeFrame(time: number): void {
    const key = this.conditionKey();
    if (key !== this.lastConditions) {
      this.lastConditions = key;
      this.live.clear();
      if (this.busy) this.stop("分辨率、视角或配置发生变化，采样中断");
    }
    if (this.state === "warming" && time - this.startedAt >= this.warmupSeconds * 1000) {
      this.state = "sampling";
      this.sampleStartedAt = time;
      this.startFrame = this.options.renderer.frame_count;
      this.captureConditions = this.conditions();
    }
    if (this.state === "sampling" && time - this.sampleStartedAt >= this.sampleSeconds * 1000) this.drain(time);
  }

  afterFrame(time: number): void {
    if (this.state === "draining") {
      const pending = [...this.recorded.values()].some((frame) => frame.gpu.pending || frame.gpuCounters.pending);
      if (!pending || time - this.sampleEndedAt > 4000) this.finish();
    }
    if (time - this.lastPaint >= 500) { this.lastPaint = time; this.paint(); }
  }

  private record(): void {
    if (this.busy || document.hidden) return;
    const { controls, renderer } = this.options;
    this.warmupSeconds = boundedNumber(this.input("warmup").value, 0, 20, 2);
    this.sampleSeconds = boundedNumber(this.input("duration").value, 1, 30, 10);
    this.result = null;
    this.recorded.clear();
    this.startFrame = Infinity;
    this.endFrame = Infinity;
    this.interrupted = false;
    this.previousControlsEnabled = controls.enabled;
    controls.reset();
    controls.enabled = false;
    renderer.profiler.configure({ gpuCounterSampleInterval: this.input("heavy").checked ? 1 : 12 });
    renderer.profiler.setMode("record");
    this.live.clear();
    this.startedAt = performance.now();
    this.captureConditions = this.conditions();
    this.lastConditions = this.conditionKey();
    this.state = "warming";
    this.message = "";
    this.paint();
  }

  private drain(time: number): void {
    this.state = "draining";
    this.endFrame = Math.max(this.startFrame, this.options.renderer.frame_count - 1);
    this.sampleEndedAt = time;
  }

  private stop(reason = "手动停止，记录窗口未完成"): void {
    if (!this.busy) return;
    this.interrupted = true;
    this.message = reason;
    if (this.state === "draining") return;
    if (this.state === "warming") {
      this.state = "idle";
      this.options.controls.enabled = this.previousControlsEnabled;
      this.paint();
    } else this.drain(performance.now());
  }

  private finish(): void {
    const frames = [...this.recorded.values()].sort((a, b) => a.frameIndex - b.frameIndex);
    const warnings: string[] = [];
    if (!this.options.renderer.profiler.gpuTimestampAvailable) warnings.push("GPU timestamp 不可用，GPU 时间未测量");
    if (frames.some((frame) => frame.gpu.pending || frame.gpuCounters.pending)) warnings.push("部分异步 readback 未完成");
    if (frames.some((frame) => frame.gpuCounters.dropped)) warnings.push("存在丢弃的 GPU counter 样本");
    if (frames.some((frame) => frame.gpu.sampled && !frame.gpuValid)) warnings.push("部分 GPU timing 样本无效或待完成");
    if (frames.some((frame) => ["shadingBinFrameFlags", "shadingBinErrors", "shadingBinOverflow", "invalidVisibilityKeys"].some((key) => (frame.gpuCounters.values[key] ?? 0) !== 0))) warnings.push("GPU queue / Visibility counter 存在异常");
    const diagnostics = this.options.renderer.profiler.diagnostics;
    if (diagnostics.validationErrorCount || diagnostics.uncapturedErrorCount || diagnostics.deviceLostCount) warnings.push("GPU diagnostics 存在错误");
    if (this.interrupted) warnings.push(this.message);
    this.result = {
      schema: "oengine-lab-experiment-v1", createdAt: new Date().toISOString(),
      conditions: this.captureConditions!, warmupSeconds: this.warmupSeconds, sampleSeconds: this.sampleSeconds,
      actualSampleSeconds: (this.sampleEndedAt - this.sampleStartedAt) / 1000,
      frames, diagnostics, graph: this.options.renderer.mainFrameGraphEvidence(), memory: this.options.renderer.memoryEvidence(),
      textureResidency: this.options.renderer.textureResidencyEvidence(),
      completion: this.interrupted ? "interrupted" : "completed", warnings,
      summary: { gpu: distribution(frameSeries(frames, "gpu")), cpu: distribution(frameSeries(frames, "cpu")), raf: distribution(frameSeries(frames, "raf")), phases: Object.fromEntries(gpuRows(frames, "phase")), passes: Object.fromEntries(gpuRows(frames, "pass")) }
    };
    this.options.controls.enabled = this.previousControlsEnabled;
    this.state = "done";
    this.message = `记录${this.interrupted ? "中断" : "完成"} · ${frames.length} 帧 · ${frames.filter((frame) => frame.gpuValid).length} 个有效 GPU 样本`;
    this.paint();
  }

  private action(action: string): void {
    try {
      if (action === "collapse") {
        const collapsed = this.root.classList.toggle("is-collapsed");
        const button = this.root.querySelector<HTMLButtonElement>('[data-action="collapse"]')!;
        button.textContent = collapsed ? "+" : "−";
        button.setAttribute("aria-expanded", String(!collapsed));
      } else if (action === "record") this.record();
      else if (action === "stop") this.stop();
      else if (action === "reset-camera" && !this.busy) { this.options.resetCamera(); this.reset(); }
      else if (action === "clear" && !this.busy) this.reset();
      else if ((action === "effects-off" || action === "defaults") && !this.busy) {
        const on = action === "defaults" && this.options.variant === "full";
        this.options.renderer.configure({ features: { shadows: on, screenSpaceDiffuseMode: on ? "gtao" : "off", screenSpaceReflections: on, temporalAntiAliasing: on, bloom: on, automaticExposure: on, motionBlur: on, sharpening: on } });
        this.reset();
      } else if (action === "export" && this.result) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(this.result, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `oengine-${this.options.variant}-${Date.now()}.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (action === "save" && this.result) {
        // Persist only bounded summaries. Raw frames remain in exported JSON.
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.result, graph: null, frames: [] }));
        this.message = "已保存对照；另一示例点击“读取已保存对照”";
        this.paint();
      } else if (action === "load") {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) throw new Error("还没有保存对照结果");
        this.comparison = parseCapture(saved);
        this.paint();
      } else if (action === "import") this.input("file").click();
    } catch (error) { this.message = error instanceof Error ? error.message : String(error); this.paint(); }
  }

  private change(input: HTMLInputElement | HTMLSelectElement): void {
    if (input.dataset.feature && !this.busy) {
      this.options.renderer.configure({ features: { [input.dataset.feature]: (input as HTMLInputElement).checked } });
      this.reset();
    } else if (input.dataset.input === "diffuse" && !this.busy) {
      this.options.renderer.configure({ features: { screenSpaceDiffuseMode: input.value as "off" | "gtao" | "ssgi" } });
      this.reset();
    } else if (input.dataset.input === "file") {
      const file = (input as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { this.message = "文件超过 25 MiB 上限"; this.paint(); return; }
      void file.text().then((value) => { this.comparison = parseCapture(value); this.paint(); }).catch((error: unknown) => {
        this.message = error instanceof Error ? error.message : String(error); this.paint();
      });
      input.value = "";
    }
  }

  private reset(): void {
    this.result = null; this.recorded.clear(); this.live.clear(); this.state = "idle";
    this.lastConditions = this.conditionKey();
    this.message = "统计已重置 · 配置稳定后开始采样";
    this.paint();
  }

  private input(name: string): HTMLInputElement { return this.root.querySelector<HTMLInputElement>(`[data-input="${name}"]`)!; }
  private view(name: string, html: string): void { this.root.querySelector<HTMLElement>(`[data-view="${name}"]`)!.innerHTML = html; }

  private paint(): void {
    const frames = this.result?.frames ?? (this.state === "sampling" || this.state === "draining" ? [...this.recorded.values()] : [...this.live.values()]);
    const latest = [...frames].sort((a, b) => b.frameIndex - a.frameIndex)[0];
    const gpu = distribution(frameSeries(frames, "gpu"));
    const cpu = distribution(frameSeries(frames, "cpu"));
    const raf = distribution(frameSeries(frames, "raf"));
    const now = performance.now();
    const status = this.state === "warming" ? `预热中 · ${Math.max(0, this.warmupSeconds - (now - this.startedAt) / 1000).toFixed(1)} 秒 · 视角已锁定`
      : this.state === "sampling" ? `记录中 · ${Math.max(0, this.sampleSeconds - (now - this.sampleStartedAt) / 1000).toFixed(1)} 秒 · ${frames.length} 帧`
      : this.state === "draining" ? "等待异步 GPU timing / counters…" : this.message;
    this.view("status", escapeHtml(status));
    this.view("cards", card("GPU Pass Sum", gpu, "ms") + card("CPU Render", cpu, "ms") + card("RAF / FPS", raf, "ms", raf ? `${(1000 / raf.p50).toFixed(1)} FPS` : undefined));
    this.drawTrend(frames);
    const condition = this.result?.conditions ?? this.conditions();
    const adapter = Object.values(condition.adapter ?? {}).filter((value) => typeof value === "string" && value).join(" · ") || "未提供 adapter identity";
    this.view("conditions", keyValues([
      ["GPU", adapter], ["Internal / Output", `${condition.internalExtent.join("×")} / ${condition.outputExtent.join("×")}`],
      ["CSS / DPR", `${condition.cssExtent.join("×")} / ${condition.dpr}`], ["模型实例 / 几何 / 材质", `${condition.scene.instances} / ${condition.scene.geometries} / ${condition.scene.materials}`],
      ["视角 position", condition.camera.position.map((n) => n.toFixed(3)).join(", ")], ["视角 target", condition.camera.target.map((n) => n.toFixed(3)).join(", ")],
      ["GPU / Counter cadence", `每 ${condition.instrumentation.gpuInterval} / ${condition.instrumentation.counterInterval} 帧`],
      ["GPU timestamp", this.options.renderer.profiler.gpuTimestampAvailable ? "可用" : "不可用"], ["统计窗口", this.result ? "已完成记录（固定）" : `最近 ${frames.length} 帧`]
    ]));
    for (const [key] of FEATURES) this.root.querySelector<HTMLInputElement>(`[data-feature="${key}"]`)!.checked = this.options.renderer.render_settings.features[key];
    this.root.querySelector<HTMLSelectElement>('[data-input="diffuse"]')!.value = this.options.renderer.render_settings.features.screenSpaceDiffuseMode;
    const counterFrame = [...frames].sort((a, b) => b.frameIndex - a.frameIndex).find((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.pending && Object.keys(frame.gpuCounters.values).length > 0);
    const values = counterFrame?.gpuCounters.values ?? {};
    const executionMode = counterFrame?.counters["sparseShading.executionMode"] ?? latest?.counters["sparseShading.executionMode"];
    const dispatch = counterFrame
      ? shadingDispatchEvidence(
          counterFrame,
          executionMode,
          condition.internalExtent
        )
      : null;
    const queueBased = dispatch?.queueBased ?? executionMode === 2;
    const bpp = counterFrame?.counters["sparseShading.surfaceBytesPerPixel"] ?? latest?.counters["sparseShading.surfaceBytesPerPixel"];
    const activeBins = counterFrame?.counters["sparseShading.activeBins"] ?? latest?.counters["sparseShading.activeBins"];
    const internalPixels = counterFrame?.counters["sparseShading.internalPixels"] ?? latest?.counters["sparseShading.internalPixels"];
    const demand = (name: string): number | undefined =>
      counterFrame?.counters[`sparseShading.${name}`] ?? latest?.counters[`sparseShading.${name}`];
    this.view("sparse", keyValues([
      ["Counter 来源帧", counterFrame ? `#${counterFrame.frameIndex}` : "尚未完成 / 未采样"],
      ["Execution mode", shadingExecutionModeLabel(executionMode)],
      ["Opaque demand mask", num(demand("demandMask"))],
      ["Demand HDR / Surface / Diffuse / Velocity",
        `${num(demand("demandHdr"))} / ${num(demand("demandSurface"))} / ${num(demand("demandDiffuseSurface"))} / ${num(demand("demandVelocity"))}`],
      ["Demand indirect / lighting debug / receiver IBL / shadow",
        `${num(demand("demandIndirectComponents"))} / ${num(demand("demandLightingDebug"))} / ${num(demand("demandEnvironmentIbl"))} / ${num(demand("demandShadowSampling"))}`],
      ["场景 bin / active indirect args", `${num(activeBins)} / ${executionMode === 1 ? "不适用（direct）" : num(values.shadingBinIndirectNonzeroWords)}`],
      ["有效可见像素 P / 内部像素 N", `${num(values.geometryVisiblePixels)} / ${num(internalPixels)}`],
      ["Tile records R / Workgroups W", `${queueBased ? num(dispatch?.records ?? undefined) : "不适用"} / ${num(dispatch?.workgroups)}`],
      ["Invocations 64×W", dispatch ? num(dispatch.invocations) : "不可用"], ["总 invocation 放大 64×W/P", dispatch ? `${dispatch.amplification.toFixed(3)}×` : "不可用（待采样或队列异常）"],
      ["Dispatch 补齐 W/R", dispatch?.padding === null || dispatch?.padding === undefined ? "不适用" : `${dispatch.padding.toFixed(3)}×`],
      ["前景覆盖率", dispatch ? `${(dispatch.pixels / (condition.internalExtent[0] * condition.internalExtent[1]) * 100).toFixed(2)}%` : "不可用"],
      ["输出格式字节", bpp === undefined ? "不可用" : `${bpp} B/有效着色像素`],
      ["前景逻辑 store 估算", dispatch && bpp !== undefined ? bytes(dispatch.pixels * bpp) : "不可用"],
      ["输出 attachment 字节核算", bytes(counterFrame?.counters["sparseShading.surfaceAttachmentBytes"] ?? latest?.counters["sparseShading.surfaceAttachmentBytes"])],
      ["Attempted / Written / Overflow", queueBased ? `${num(values.shadingBinAttempted)} / ${num(values.shadingBinWritten)} / ${num(values.shadingBinOverflow)}` : "不适用（direct status 无 queue）"],
      ["Frame flags / Errors", `${num(values.shadingBinFrameFlags)} / ${num(values.shadingBinErrors)}`]
    ]));
    this.view("phases", timingTable(gpuRows(frames, "phase")));
    this.view("passes", timingTable(gpuRows(frames, "pass")));
    const cpuKeys = new Set(frames.flatMap((frame) => Object.keys(frame.cpuMs)));
    const cpuStats = new Map([...cpuKeys].map((key) => [key, distribution(frames.flatMap((frame) => frame.cpuMs[key] === undefined ? [] : [frame.cpuMs[key]]))!] as const));
    this.view("cpu", timingTable(cpuStats) + keyValues([
      ["最新帧 / submits", latest ? `#${latest.frameIndex} / ${latest.submits.count}` : "不可用"],
      ["Upload / Readback", `${bytes(latest?.uploads.bytes)} / ${bytes(latest?.readbacks.bytes)}`],
      ["Graph cache hits / misses", `${num(latest?.graph?.cacheHits)} / ${num(latest?.graph?.cacheMisses)}`]
    ]));
    const memory = this.result?.memory ?? this.options.renderer.memoryEvidence();
    const textureResidency = this.result
      ? this.result.textureResidency
      : this.options.renderer.textureResidencyEvidence();
    const diagnostics = this.result?.diagnostics ?? this.options.renderer.profiler.diagnostics;
    const textureSummary = textureResidency == null
      ? '<p class="lab-note">TextureResidency 尚未创建或旧导出未包含 ledger。</p>'
      : keyValues([
          ["Logical resident bytes", bytes(textureResidency.logicalResidentBytes)],
          ["Resident payload bytes", bytes(textureResidency.residentTextureBytes)],
          ["Physical allocated bytes", bytes(textureResidency.physicalAllocatedBytes)],
          ["Allocated bytes", bytes(textureResidency.allocatedBytes)],
          ["Resident / retiring textures", `${num(textureResidency.residentTextureCount)} / ${num(textureResidency.retiringTextureCount)}`],
          ["Segments", num(textureResidency.segmentCount)],
          ["Binding sets", num(textureResidency.bindingSetCount)],
          ["Uncompressed fallbacks", num(textureResidency.uncompressedFallbackCount)],
          ["Binding preflight failures", num(textureResidency.bindingSetPreflightFailures)]
        ]) + textureLedgerTable(textureResidency.textureLedger);
    this.view("resources", `<p class="lab-note">Owner 字节核算，不是物理显存利用率。</p><h4>Texture residency</h4>${textureSummary}<details><summary>完整 memory / diagnostics JSON</summary><pre>${escapeHtml(JSON.stringify({ memory, diagnostics }, null, 2))}</pre></details>`);
    this.view("counters", keyValues(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, num(value)])));
    this.paintComparison();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      const action = button.dataset.action;
      button.disabled = action === "stop" ? !this.busy || this.state === "draining"
        : action === "export" || action === "save" ? !this.result : action === "collapse" || action === "import" || action === "load" ? false : this.busy;
    }
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-feature], [data-input]:not([data-input=file])")) input.disabled = this.busy;
  }

  private paintComparison(): void {
    if (!this.result) { this.view("comparison", '<p class="lab-note">先完成采样。保存一份结果，然后到另一示例读取；也可以导入 JSON。请分别运行两个页面。</p>'); return; }
    const warnings = this.result.warnings.map((warning) => `<p class="lab-warning">${escapeHtml(warning)}</p>`).join("");
    if (!this.comparison) { this.view("comparison", warnings + '<p class="lab-note">记录可导出。读取或导入另一份结果后显示对照。</p>'); return; }
    const a = this.comparison;
    const b = this.result;
    const conditionDifferences = comparisonDifferences(a.conditions, b.conditions);
    if (a.warmupSeconds !== b.warmupSeconds || a.sampleSeconds !== b.sampleSeconds) conditionDifferences.push("预热或记录时长不同");
    const qualityDifferences = [a, b].flatMap((capture) => capture.warnings.map((warning) => `${capture.conditions.variant}: ${warning}`));
    if (a.completion !== "completed" || b.completion !== "completed") qualityDifferences.push("至少一份记录窗口被中断");
    const row = (label: string, left: Distribution | null | undefined, right: Distribution | null | undefined) => `<tr><td>${escapeHtml(label)}</td><td>${left ? `${left.p50.toFixed(3)}<br><small>${left.p95.toFixed(3)} / N${left.count}</small>` : "—"}</td><td>${right ? `${right.p50.toFixed(3)}<br><small>${right.p95.toFixed(3)} / N${right.count}</small>` : "—"}</td><td>${left && right ? (right.p50 - left.p50).toFixed(3) : "—"}</td></tr>`;
    const left = new Map(Object.entries(a.summary.phases));
    const right = new Map(Object.entries(b.summary.phases));
    const passKeys = [...new Set([...Object.keys(a.summary.passes), ...Object.keys(b.summary.passes)])];
    this.view("comparison", warnings + `<p>${escapeHtml(a.conditions.variant)} → ${escapeHtml(b.conditions.variant)} · P50（下行 P95 / N）· ms</p>` +
      [...conditionDifferences, ...qualityDifferences].map((item) => `<p class="lab-warning">${escapeHtml(item)}</p>`).join("") +
      `<p class="lab-note">材质与功能差异是本次实验变量；差值包含上游生产和下游消费，不能直接作为纯 PBR 成本。</p><table><thead><tr><th>指标</th><th>对照</th><th>当前</th><th>差值</th></tr></thead><tbody>` +
      row("GPU Pass Sum", a.summary.gpu, b.summary.gpu) +
      row("CPU Render", a.summary.cpu, b.summary.cpu) +
      row("RAF 间隔", a.summary.raf, b.summary.raf) +
      [...new Set([...left.keys(), ...right.keys()])].map((key) => row(key, left.get(key), right.get(key))).join("") +
      '</tbody></table><details><summary>逐 Pass 对照</summary><table><thead><tr><th>Pass</th><th>对照</th><th>当前</th><th>差值</th></tr></thead><tbody>' +
      passKeys.map((key) => row(key, a.summary.passes[key], b.summary.passes[key])).join("") + "</tbody></table></details>");
  }

  private drawTrend(frames: readonly ExperimentFrame[]): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('[data-view="trend"]')!;
    const context = canvas.getContext("2d");
    if (!context) return;
    const selected = [...frames].sort((a, b) => a.frameIndex - b.frameIndex).slice(-160);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const all = ["gpu", "cpu", "raf"].flatMap((metric) => frameSeries(selected, metric as "gpu" | "cpu" | "raf"));
    const max = Math.max(20, ...all);
    context.font = "18px system-ui";
    for (const value of [0, 16.667, max]) {
      const y = 130 - value / max * 110;
      context.strokeStyle = "#ffffff16"; context.beginPath(); context.moveTo(65, y); context.lineTo(790, y); context.stroke();
      context.fillStyle = "#8f9caa"; context.fillText(`${value.toFixed(1)}`, 5, y + 5);
    }
    ["#74dfc6", "#81b7ff", "#efc67d"].forEach((color, series) => {
      context.strokeStyle = color; context.lineWidth = 2; context.beginPath();
      let open = false;
      selected.forEach((frame, index) => {
        const value = frameSeries([frame], (["gpu", "cpu", "raf"] as const)[series])[0];
        if (value === undefined) { open = false; return; }
        const x = 65 + index / Math.max(1, selected.length - 1) * 725;
        const y = 130 - value / max * 110;
        if (open) context.lineTo(x, y); else context.moveTo(x, y);
        open = true;
      });
      context.stroke();
    });
  }

  dispose(): void {
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.busy) this.options.controls.enabled = this.previousControlsEnabled;
    this.root.remove();
  }
}

function parseCapture(text: string): Capture {
  const capture = JSON.parse(text) as Capture;
  if (capture.schema !== "oengine-lab-experiment-v1" || !Array.isArray(capture.frames) || capture.frames.length > 5000 || !capture.conditions || !capture.conditions.camera || !capture.conditions.settings || !capture.summary || !capture.summary.phases || !capture.summary.passes || !Array.isArray(capture.warnings)) throw new Error("不是有效的 Rendering Lab 对照文件");
  if (capture.frames.some((frame) => !Number.isInteger(frame.frameIndex) || !frame.cpuMs || !frame.counters || !Array.isArray(frame.gpu?.segments) || frame.gpu.segments.some((segment) => typeof segment.label !== "string" || typeof segment.phase !== "string" || !Number.isFinite(segment.durationMs) || segment.durationMs < 0))) throw new Error("对照文件包含无效样本");
  return capture;
}

function comparisonDifferences(a: Conditions, b: Conditions): string[] {
  const differences: string[] = [];
  for (const key of ["scene", "adapter", "capabilities", "browser", "dpr", "cssExtent", "internalExtent", "outputExtent", "camera", "visibility", "instrumentation"] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) differences.push(`对照条件不一致：${key}`);
  }
  if (JSON.stringify(a.settings) !== JSON.stringify(b.settings)) differences.push("材质/效果之外的画质参数也应核对：完整 render settings 已保存在 JSON");
  return differences;
}

function timingTable(rows: Map<string, Distribution>): string {
  if (!rows.size) return '<p class="lab-note">尚无有效样本。GPU timestamp 不可用时不会用 CPU 时间替代。</p>';
  return `<table><thead><tr><th>阶段 / Pass</th><th>P50 ms</th><th>P95 ms</th><th>N</th></tr></thead><tbody>${[...rows].map(([label, stats]) => `<tr><td title="${escapeHtml(label)}">${escapeHtml(label)}</td><td>${stats.p50.toFixed(3)}</td><td>${stats.p95.toFixed(3)}</td><td>${stats.count}</td></tr>`).join("")}</tbody></table>`;
}
function card(label: string, stats: Distribution | null, unit: string, extra?: string): string {
  return `<div><small>${label}</small><strong>${stats ? stats.p50.toFixed(2) : "—"}<span> ${unit}</span></strong><small>${extra ?? (stats ? `P95 ${stats.p95.toFixed(2)} · N ${stats.count}` : "不可用 / 待采样")}</small></div>`;
}
function keyValues(rows: [string, string][]): string { return `<dl>${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`; }
function textureLedgerTable(entries: readonly { assetIdentity: string; state: string; format: string; sourceWidth: number; sourceHeight: number; gpuWidth: number; gpuHeight: number; mipLevelCount: number; logicalBytes: number; residentBytes: number; allocatedBytes: number }[]): string {
  if (entries.length === 0) return '<p class="lab-note">没有逐纹理 resident/retiring 条目。</p>';
  return '<details><summary>逐纹理 textureLedger</summary><table><thead><tr><th>Asset</th><th>State / format</th><th>Source → GPU</th><th>Mips</th><th>Logical</th><th>Resident</th><th>Allocated</th></tr></thead><tbody>' +
    entries.map((entry) => `<tr><td title="${escapeHtml(entry.assetIdentity)}">${escapeHtml(entry.assetIdentity)}</td><td>${escapeHtml(entry.state)} / ${escapeHtml(entry.format)}</td><td>${entry.sourceWidth}×${entry.sourceHeight} → ${entry.gpuWidth}×${entry.gpuHeight}</td><td>${entry.mipLevelCount}</td><td>${bytes(entry.logicalBytes)}</td><td>${bytes(entry.residentBytes)}</td><td>${bytes(entry.allocatedBytes)}</td></tr>`).join("") +
    '</tbody></table></details>';
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }
function num(value: number | undefined): string { return value === undefined ? "不可用" : value.toLocaleString("en-US"); }
function bytes(value: number | undefined): string { return value === undefined ? "不可用" : `${(value / 1048576).toFixed(2)} MiB`; }
function boundedNumber(value: string, min: number, max: number, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
