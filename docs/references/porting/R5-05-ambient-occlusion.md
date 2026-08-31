# R5-05 · Ambient Occlusion / FX-07

## 登记结论

- **Reference ID**：`R5-05-ambient-occlusion`
- **decision**：`保留并修复当前实现 / port algorithm invariants / independently adapt WebGPU owner`
- **当前算法**：OEngine authored WGSL 的 horizon-based GTAO visibility、bent normal、edge-aware spatial filter 与可选 temporal resolve。
- **替换结论**：当前实现经修复后进入同输入 half/full、temporal off/on 和 camera sequence Gate；本轮不替换为 XeGTAO，也不建立第二条 AO 管线。

初始 reconstructed 提交没有为 `OEngine/src/shaders/ssao.ts` 留下可接受的上游记录。其 horizon slice、R2/Hilbert noise、sample distribution、visibility integral 与 bent-normal 结构明显属于 GTAO/XeGTAO 算法家族，因此不能把算法来源标成 OEngine 原创。本轮未直接复制、翻译或改写外部 HLSL/WGSL 的表达性代码；保留现有 authored WGSL，并只针对 OEngine 已有代码中的参数错接、数值边界、half-resolution 坐标、共享 history 和 WebGPU owner 做独立修复。

## 上游算法与实现来源

### Intel GameTechDev / XeGTAO 1.30

```text
repository: https://github.com/GameTechDev/XeGTAO
commit: 0d177ce06bfa642f64d8af4de1197ad1bcb862d4
source paths:
  Source/Rendering/Shaders/XeGTAO.hlsli
  Source/Rendering/Shaders/XeGTAO.h
license: MIT
source header: SPDX-License-Identifier: MIT
decision: concept and algorithm-invariant reference; no direct shader port
```

保留的不变量：从 depth 重建位置、按 horizon slice/step 估计 visibility、屏幕半径随 view depth 变化、低差异时空采样、bent normal 可参与间接光照、深度/法线边缘感知滤波。拒绝直接采用 XeGTAO 的 D3D owner、UAV layout、FP16/平台宏、独立 command submission、depth mip prefilter 与 autotune 工具链。

### Jimenez et al. / Practical Real-Time Strategies for Accurate Indirect Occlusion

```text
authority: Activision Research, SIGGRAPH 2016
paper: Practical Real-Time Strategies for Accurate Indirect Occlusion
url: https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf
decision: mathematical reference only; no source code copied
```

论文用于解释 GTAO visibility、距离衰减与 bent-normal 语义，不决定 OEngine 的资源生命周期或 Pass 拓扑。

## OEngine 适配与所有权

- 输入只消费统一主管线的 final reverse-Z Depth、Surface normal、Velocity、disocclusion confidence 与 Camera；不创建第二套 GBuffer。
- raw 与 spatial 在 `1.0` 或 `0.5` internal resolution 工作；half 模式按归一化坐标回查 full-resolution Depth/normal/Velocity/confidence，并将 bent normal 显式恢复到 full-resolution consumer ABI。
- AO temporal 复用 FX-06 `TemporalHistoryRegistry` 的 cut/resize/render-scale/feature/view/abort invalidation；物理 ping-pong texture 由 AO pass 持有，但不存在第二个全局 invalidation owner。
- history read/write slot 只由已提交 producer 推进，不再由 frame parity 猜测；invalid history 在 shader 中把 history weight 精确置零。
- temporal 关闭时无 temporal Pass、history texture、history bytes 或 occlusion-confidence consumer；AO feature 关闭时 owner、Pass、transient、history 与 timestamp label 全部为零。
- raw、denoised、temporal visibility 和 final linear HDR 通过 production Render Debug View 保存；证据 API 只暴露计数与字节，不暴露 GPU handle。

## 修复的当前实现缺陷

1. spatial filter 调用曾把 `(depth, normal, visibility)` 传给 `(visibility, normal, depth)` 参数 ABI，导致 edge weight 语义错误；现按声明顺序传递。
2. temporal history 曾按 `frameIndex` parity 私自翻转，camera cut、resize、abort 后仍可能采样旧 history；现由共享 registry late-bound。
3. raw/spatial/temporal/composite 假定输入输出同尺寸，无法合法验证 half resolution；现分别定义 AO/full 坐标映射。
4. raw Pass 曾把 full-resolution Depth 同时作为 half-resolution render attachment，尺寸不一致；现只作为采样输入并显式处理 reverse-Z background。
5. 零距离、退化 projected normal 与边界 textureLoad 曾可能产生非有限值或边缘污染；现使用合法范围、epsilon 与 clamp。

## 性能假设与门禁

- full：raw + spatial + optional temporal + composite，bent normal 不增加 upsample Pass。
- half：AO visibility/history 像素数为 internal pixels 的约 25%，代价是一个 full-resolution bent-normal upsample Pass；是否更快只由同机 GPU phase P50/P95/P99 决定。
- `rg16float` history 为 4 B/pixel、双缓冲；`historyBytes = aoWidth × aoHeight × 4 × 2`，必须与 runtime evidence 一致。
- focused Gate 固定 DPR 1、相同 camera/scene/画质与 warm-up，分别报告 raw/spatial/temporal/composite GPU phase、history bytes、AO pixels 与 main submit/readback。
- 若 current fixed 实现在 flat/corner、near/far、camera pan/disocclusion 或预算中失败，才允许建立 XeGTAO replacement paired artifact；不能仅凭候选算法更新而替换。

## 本地实现与验证

- shader：`OEngine/src/shaders/ssao.ts`
- pass：`OEngine/src/render/passes/ScreenSpaceAmbientOcclusionPass.ts`
- shared history：`OEngine/src/render/TemporalHistoryRegistry.ts`
- owner/debug/evidence：`OEngine/src/render/Renderer.ts`、`OEngine/src/render/passes/RenderDebugViewPass.ts`
- automated seam：`OEngine/tests/r5-fx07-ambient-occlusion.test.mjs`
- production page：`examples/r5-ambient-occlusion/`
- runner：`examples/scripts/run-r5-fx07-gate.mjs`
