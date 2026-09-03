# R5-07 · Color Grading

## 登记结论

- **Reference ID**：`R5-07-color-grading`
- **decision**：`port algorithm invariants / independently adapt WebGPU owner`
- **当前状态**：此前 OEngine 没有独立的 ColorGrading 阶段——Filament 风格的 ACES 拟合与 sRGB 编码被内嵌在 `tonemap_sdr.ts`，无法在线性 HDR 域做 lift/gamma/gain 与 saturation/contrast 分级。
- **替换结论**：新增常开的线性 HDR ColorGrading 阶段，固定插在 Bloom 之后、Sharpen 之前；保留 Filament ColorGrading 的数学不变量（ASC CDL 风格的 lift/gamma/gain、saturation、log2 contrast），但使用独立 authored WGSL 表达，不复制 Filament 的 3D LUT 生成器与 GLSL 表达性代码。

## 上游算法与实现来源

### Filament / ColorGrading

```text
repository: https://github.com/google/filament
source paths:
  filament/src/filament/ColorGrading.cpp
  filament/src/shaders/color_grading.fs
  filament/src/utilities.cpp
license: Apache-2.0
source header: SPDX-License-Identifier: Apache-2.0
decision: algorithm-invariant reference; no direct shader port
```

保留的不变量：色彩分级全程发生在 tone mapping 之前的线性 HDR 域；lift/gamma/gain 遵循 ASC CDL 的 `out = (in * gain + lift) ^ (1/gamma)`；saturation 通过向 Rec.709 亮度系数混合实现；contrast 在 log2 空间做逐通道斜率缩放。拒绝直接采用 Filament 的 3D LUT 生成、CPU 端 LUT bake、GLSL 代码与 OpenGL owner。

## OEngine 适配与所有权

- 阶段为常开（不属于 `RenderFeatureSettings` feature flag，与 Tonemap 一致），因此不进入 `MainFrameFeatureTopology` 注册表；owner 由 `PostFeature` 懒创建并随 `destroy()` 销毁。
- 输入为 Bloom 合成后的 `rgba16float` 线性 HDR 颜色；输出仍为 `rgba16float` 线性 HDR，供 Sharpen/Tonemap 消费，不破坏「Lighting → Temporal → Post 全程线性 HDR」不变量。
- 单 pass 全屏三角，group0 由 `{texture unfilterable-float @0, uniform @1}` 组成；uniform 为 ASC CDL 三向量 + saturation + contrast，按 WGSL 结构体布局对齐（16×f32）。
- 默认参数 `lift=0 / gamma=1 / gain=1 / saturation=1 / contrast=1` 为严格恒等变换，保证作为常开阶段不改变像素值。

## 修复的当前实现缺陷

1. ACES 拟合与 sRGB 编码此前耦合在 tonemap 单阶段内，无法在 HDR 域做色彩分级；现拆出独立阶段，使分级先于 tone mapping。
2. 缺少 lift/gamma/gain 与 saturation/contrast 的可配置入口；现通过 `RenderSettings.post` 暴露五个新字段。
3. ColorGrading 不在任何 owner 的生命周期管理中，帧图顺序无法被测试断言；现纳入 `PostFeature` 的 obtain/retire/destroy 生命周期。

## 性能假设与门禁

- 单 pass 全屏三角，读一次输入、写一次输出，无额外 history 或 LUT 纹理；代价为一次 `rgba16float` 全分辨率采样与一次 16 字节 uniform 上传。
- 常开阶段在任何画质档位下都只增加一个固定 pass；是否可接受由同一机 GPU phase 决定，不以 pass 数为唯一依据。

## 本地实现与验证

- shader：`OEngine/src/shaders/color_grading.ts`
- pass：`OEngine/src/render/passes/ColorGradingPass.ts`
- owner：`OEngine/src/render/features/PostFeature.ts`
- settings：`OEngine/src/render/pipeline/RenderSettings.ts`
- graph 接入：`OEngine/src/render/Renderer.ts`
- automated seam：`OEngine/tests/p8-post-feature.test.mjs`、`OEngine/tests/r5-composition-rebuild.test.mjs`

## 2026-09-04 P8-B2 migration delta

- 新增 `color_grading.ts`：`COLOR_GRADING_WGSL`（ASC CDL lift/gamma/gain → saturation → log2 contrast）、`COLOR_GRADING_FORMAT = "rgba16float"`。
- 新增 `ColorGradingPass.ts`：镜像 `SharpenPass` 的单 pass 模板，`addToGraph` 返回 `Color graded color` transient 资源，`execute` 上传 16×f32 uniform 并绘制 3 顶点。
- `PostFeature` 新增 `_colorGrading` 字段与 `obtainColorGrading/colorGrading/retireColorGrading/addColorGradingToGraph`，并在 `destroy()` 中销毁。
- `RenderSettings.post` 新增 `colorGradingLift/Gamma/Gain/Saturation/Contrast`（默认恒等）。
- `Renderer` 在 bloom 合成之后、sharpen 之前插入 `addColorGradingToGraph`，并在 `initializeRenderPasses` 中 `obtainColorGrading()`。
