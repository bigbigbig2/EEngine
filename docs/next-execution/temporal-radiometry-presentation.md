# Module D 执行：Temporal Facts、Radiometry 与 Presentation

> 状态：2026-09-27 待实施。按[设计文档](../next-design/temporal-radiometry-presentation.md)和[架构层计划](./eengine-next-architecture-layer-plan-2026.md) §6，D0→D6 连续推进。固定来源及逐阶段映射见[Next 来源账本 R12/R24/R25](../porting/next-renderer.md)。本文是人读执行路线，不是逐步许可或逐批测试门禁。

## 0. 模块完成的准确含义

最后必须在**唯一** Frame Program/FrameGraph/submit 中看到真实产品边：

```text
GPU Scene previous state + Visibility depth/identity + Surface material facts
  → internal motion + validity/local change/opaque reactive
  → Surface/Environment pre-exposed HDR + depth/motion/facts
  → pinned FSR3 Upscaler complete chain → output-linear HDR
  ├→ Wicked histogram → GPU adapted E_t
  └→ Filament-profile Bloom → exposure E_t/P_t → SDR grade+GT7+display LUT / HDR 数学路径
       → SDR canvas or negotiated HDR canvas
```

`P_t` 和 `E_t` 只在 GPU；CPU 只持有 epoch、资源句柄和提交状态。FSR3 历史被物理写入后才能被事务标记。局部 patch、正常曝光变化、合法包络内 internal-size 变化不应无条件全屏清历史。透明 composition mask 尚无 producer 时如实保持 absent，不为通过检查制造全零“已覆盖”声明。一次 D6 模块集中检查后更新 workstream 并进入 VSM；全链 browser/画质/性能/formal evidence 后置。

## 1. 开工读图与 owner 分工

先用 `node tools/vibe.mjs context <path>` 看 `RendererCore.ts`、`TemporalFabric.ts`、`Fsr3UpscalerRuntime.ts`、`SurfacePresentPass.ts` 的 owner；沿以下入口读实际读写边，而非依赖旧 effect 名称。`vibe context` 只导航。

| Owner/入口 | 本模块改动 | 切断对象 |
| --- | --- | --- |
| frame-runtime：`pipeline/RendererCore.ts`、`program/FrameProgram.ts`、`FrameProgramLowering.ts`、`FrameProgramBindings.ts`、`FrameCoordinator.ts` | 定义 temporal/radiometry/display 产品及拓扑选择；统一 begin/submit/commit/abort；late binding 本帧资源 | Renderer 手工插隐藏 post pass、第二条 Present 或独立 submit |
| geometry/visibility：`GpuInstanceAbi.ts`、`GpuScene.ts` patch、`VisibilityFeature.ts`、`RenderTargets.ts` | 稳定 instance+generation、depth、previous mapping；给局部变化和非法 motion 提供事实 | frame-local work/primitive index 充当跨帧稳定身份 |
| shading：`surface/SurfaceMaterialPass.ts`、`SurfaceProducts.ts`、`shaders/surface_material_kernel.ts`、`surface_execution.ts` | current-minus-previous motion、有效性/变化/opaque reactive 逐像素产出；HDR 写统一工作空间与 `P_t` | 只写 motion.xy 却假定 valid、coarse 代表点覆盖不同身份 |
| environment：`PhysicalSkyPass.ts`、`AerialPerspectivePass.ts`、天空 LUT producer | 每个新辐射项转换至工作空间并乘 `P_t`；保留已预曝光输入 | 与 Surface 不同曝光域相加 |
| temporal/presentation：`TemporalFabric.ts`、`TemporalHistoryRegistry.ts`、`passes/fsr3/*`、`RadiometryContract.ts`、`SurfacePresentPass.ts` | 共享生命周期、FSR3 adapter、GPU histogram、Bloom、grade、tone/display | 旧 `AutomaticExposurePass`、`ColorGradingPass`、`tonemap_*.ts` 未核源直接挂回生产 |

开始前从当前 Frame Program dump 列出 input/output domain、formats、history 物理写入、swapchain 读写；核对 Surface 最宽 bind group 和设备 limit。owner manifest 中 temporal/FSR3/Present 的当前路由不一致，D1/D2 依真实职责更新，不引入算法大类到 `RendererCore`。

## 2. 总切换顺序和依赖

| 阶段 | 先有的条件 | 可观察产物 | 下一阶段依赖 |
| --- | --- | --- | --- |
| D0 来源与 ABI | C 主链已连通 | pinned profile、source→local 映射、事实/颜色/尺寸约定 | D1–D5 不再猜输入方向 |
| D1 Temporal Facts | 当前 Geometry/Surface producer | motion-valid、stable identity、局部变化、opaque reactive 的真实 GPU producer | FSR3 adapter 与 history invalidation |
| D2 History lifecycle | D1 事实与原有 FSR3 物理纹理 | 原子 begin/commit/abort、按域 resize/recovery | D3/D4 GPU history 正确轮换 |
| D3 FSR3 接线 | D1、D2 | pinned 全阶段消费 motion/depth/mask/previous extent；输出 HDR | D4/D5 使用可信重建产品 |
| D4 Radiometry | D0–D3 | 统一 Rec.2020、GPU `P/E`、sky/aerial、测光 | D5 display 输入 |
| D5 Presentation | D4 | Bloom、静态 grade、GT7、SDR/HDR profile、UI 次序 | D6 收口 |
| D6 模块收口 | D1–D5 原理与生产链连通 | 一次集中检查与准确 currentSlice | VSM |

可在同一阶段内连续改代码。typecheck/build/一个 targeted test 可用于定位具体 bug，不能因此要求每一小步过 verify、browser、evidence 或文档同步。真实不可编译问题及时修复。

## 3. D0：固定 donor、剖开当前 ABI

1. 核对 R12 的 FSR3 v1.1.4 SHA、MIT 子集、host `ffx_fsr3upscaler.cpp`、所选 compute stage、`tools/fsr3-port/upstream/` 与当前 WGSL 的阶段清单。写清选定 **Upscaler** profile、RCAS 参数、内部 luma exposure 与最终摄影曝光的区别。记录 reactive/transparency optional branch 的资源与缺席行为，不把 optional 当作任意删减理由。
2. 核对 R24 Wicked 的 `luminancePass1CS.hlsl`、`luminancePass2CS.hlsl` 与 `wiRenderer.cpp` 创建/调用顺序及 MIT；固定 histogram bin、log luminance 区间、分辨率比例、指数适应与 clear 行为。若 WebGPU 分 dispatch，逐一对应源阶段。中心权重、percentile 先列本地可选扩展，不混入“完整 donor”验收。
3. 核对 R25 Filament 固定 SHA、Apache-2.0 与 Bloom Downsample/Upsample、ColorGrading 静态 LUT、GT7ToneMapper 源入口。选定 High Bloom core、threshold on、flare/dirt off，保留该 profile 的奇偶尺寸分支。明确 SDR `hdrColorAt` 将 grade、tone、gamut/OETF 一起生成 LUT 且会 clamp，HDR 不可复用这一分支；HDR 宽范围适配标 EEngine 本地集成，不宣称上游完整 HDR port。
4. 冻结数学合同：internal/output pixel 与 UV、current-minus-previous motion、当前/上帧 jitter、reverse-Z depth、pre-exposed `rgba16float`、linear Rec.2020、`P_t/E_t`，以及 background/invalid 值。画一张 Graph 产品与生命周期表，标每个资源的 producer、consumer、尺寸、格式、重建条件和 CPU/GPU ownership。

**D0 结束可观察点**：设计表与账本能逐项指出“源函数/阶段→本地目标产物”；缺失透明、HDR 特化和未实现的 consumer 仍显示缺口。D0 是开工定位，不要求 build/browser 或形式化 evidence。

## 4. D1：Temporal Facts 从真实 producer 发布

### D1.1 motion 与 identity

- 沿 `GpuInstanceAbi.ts` 与 `GpuScene.ts` patch 核对稳定 instance ID、generation、动态 revision、current/previous transform 是否穿过 GPU publication。普通/VG 刚体由重建的本地位置计算 previous clip；相机 motion 从当前/上帧 view-projection 进入同一方程。接入 skinned/deformed representation 时若无 previous mapping，输出 `motion-valid=0` 与 local-change，不填可信零速度。
- 保持 Surface 当前 `currentUV−previousUV` 的原始值；对 `clip.w`、背景、近裁剪、无 previous state、非有限坐标和越界显式失效。检查 projection jitter 是否已包含在矩阵，FSR3 adapter 才消掉它；不得在 Surface 和 FSR3 两端各消一次。sky/background 的无限远相机旋转规则另走背景 producer。
- Frame Program 声明 `motion`、`motion-valid`、稳定身份/局部签名及 depth 的 domain/invalid/consumer。物理可将 validity/change 打包为紧凑 sidecar，先核查 sampled/storage limit 和每像素写覆盖；Dense、Binned、overflow、遮挡边缘均写一次。frame-local `VisibilityKey` 仍用于当帧 Surface reconstruction，不能晋升为 history ID。

### D1.2 局部变化与 reactive

- 将 geometry generation、LOD/deformation、材质参数及纹理 residency patch、shading-rate/composition 改变映射到 per-instance/per-pixel change。GPU Scene patch 若当前只给更新 index，补足能区分“哪个 instance 的什么语义改变”的有限记录；上传发生在既有 frame maintenance，不读回本帧 GPU 决策。
- opaque reactive 首先由真实 emissive、材质/纹理突变、几何/频率变化等可知量生产，标 `[0,1]` 与未覆盖范围。`transparency/composition` 尚无 producer 时明确缺席，默认 zero mask 仅表示该 profile 无透明输入，不宣称透明稳定性完成。disocclusion 由 motion/depth/identity 证据供 consumer 决策，不造统一置信度。
- 在 domain manifest 为新的 temporal owner 补正确路径路由。只新增实际被 FSR3 使用的物理数据，不为将来的 SSSR/GI/VSM 预分配全屏 GBuffer。

**D1 结束可观察点**：Graph 的事实产品可追溯到真实 GPU writer；运动无效边界不再与合法静止混淆；局部变更不依赖全局 shading revision 整屏判失效。后续各 consumer 仍可采用不同衰减规则。

## 5. D2：公共 history 事务与物理资源一致

1. 盘点 `TemporalFabric.ts` 默认 color/depth/motion descriptor 与 `Fsr3UpscalerRuntime.ts` 的 color/luma/lumaHistory/accumulation/frameInfo 五组真实纹理。将公共层定位为**事务/epoch/读写句柄协调**，物理资源仍由 backend owner 持有；删掉只被 `markProduced` 但无真实 copy/writer 的“逻辑 history 已生产”声明，或把它们接成实际 writer。每个 committed handle 必须能指向刚被本帧 Graph 写入的物理资源。
2. 改 `TemporalHistoryRegistry.ts::invalidationReason`：强重置保留 device、output format/extent、view/camera cut、完全不兼容 feature；scene/representation/light/material patch 走 D1 局部事实。普通曝光 multiplier 变化不增使 history 作废的 generation；只有色域/资源解释改变或无法重标定才增 epoch。不同 consumer 对 lighting/LOD/roughness 的 invalidation 保持自身策略。
3. begin 时冻结 frame epoch、read/write slot、上帧尺寸/曝光 binding；Graph 编码并提交成功后 backend 分别 report produced，再统一 commit。失败、取消或未提交时 abort，保证 index 与实际 GPU 命令一致。使用 `command.gpuDone` 延迟退休旧尺寸/旧 device 的资源；device loss 重建所有 buffers/textures/pipelines。
4. 分开 output history 与 internal scratch。internal 尺寸变化若在约定 max envelope 内，尽量保留 output color；内部不兼容资源各自 reset；传真实 previous render size、previous output size 与 jitter。超过包络/格式改变可 reset。不能只改 host 常量而让物理纹理尺寸仍与 shader 访问范围不匹配。

**D2 结束可观察点**：一次 begin 对应一次 commit 或 abort；每个 valid history 有物理生产边；曝光平滑变化与局部 patch 不再整屏 reset；resize/device loss 的各域状态解释明确。Camera cut 需区别显式切断与连续大幅运动，保守检测可保留但须具名。

## 6. D3：FSR3 从共享 facts 消费，不删源阶段

1. 在 `Fsr3UpscalerRuntime.ts::prepareFrame/addToGraph` 与 `Fsr3PrepareInputsPass.ts` 接 D1 motion/validity。只在 adapter 做 `current−previous` 到 FSR3 所需方向、motion scale 和 jitter cancellation；用源码和 local shader 数值对照确认符号、unit、reverse-Z linearization、前后帧 internal/output extent。无效 motion 由对应 reactive/disocclusion/reset 分支处理，不能被当正常静止。
2. 把真实 opaque reactive 作为 `PrepareReactivity` 输入。transparency mask 的 absent profile 保持明确 zero，直至透明模块真实生产后替换；FSR3 自身的 shading change、lock/instability 和 luma 分支继续运行。若局部变化需要映射为 reactive，保留源的 mask 组合次序和 scale/阈值。
3. 核对上游 host 的 `deltaPreExposure` 与本地预曝光方向，以 `P_t/P_(t−1)` 对上帧 color 重标定。FSR3 内部 exposure/luma history 不等同 D4 摄影曝光；不能让两套值互相反馈。改 D2 分域 history 后核对 `previousFrameRenderSize`、`maxRenderSize` 与各内部分辨率资源。
4. 完整保留 Prepare Inputs→Luma/Shading SPD→Shading Change→Prepare Reactivity→Luma Instability→Accumulate/Reproject/Upsample→RCAS。若 WebGPU binding/dispatch 改写，只改物理调度，不删除输入或重要算法分支。Graph 仍属于 Frame Program 一个 submit。

**D3 结束可观察点**：FSR3 production input 不再只有 motion.xy/zero mask；合法/非法 motion、局部变化与真实上帧尺寸可被 tracing 到具体 stage；输出仍是工作空间 HDR，尚未直接当显示颜色。

## 7. D4：工作色域、全链预曝光与 GPU 自动曝光

### D4.1 工作色域迁移

- 在材质纹理采样、glTF factors/emissive、灯光、physical sky LUT/IBL 的入口标当前色域并做一次明确的 linear Rec.2020 变换；不改 depth、normal、AO、motion。对直接光、IBL 与天空同色值的合成建立数值 oracle，避免 double conversion。中间 radiance/histories 的语义标 `working-linear/Rec.2020/pre-exposed`。
- `SurfaceMaterialPass` 继续按 `P_t` 乘最终 scene radiance；`PhysicalSkyPass` 与 `AerialPerspectivePass` 对**新增**辐射同样乘 `P_t`，不要重复乘已有 HDR 输入。后续反射/透明/GI 用同一合同。

### D4.2 替换 CPU multiplier 为 GPU P/E

- 实现设备期双槽曝光 buffer，bootstrap `P_0=1`。begin 绑定上一已提交 `P_t`；Wicked 第一 pass 在 HDR/`P_t` 的 scene luminance 上半分辨率采样、组内 histogram 汇总；目标 Rec.2020 输入使用目标亮度系数或先转回源 Rec.709 基底，不照搬源 `0.2127/0.7152/0.0722` 直接点积。第二 pass 对 histogram 做 weighted log 平均、delta-time 指数适应、输出 `E_t` 并清 bins。Graph 显式连接 `P_t → HDR writers/meter` 与 `meter E_t → Present`。避免读取最后 mip 单个像素去代表整个 histogram。
- 曝光阈值、clamp、黑场、NaN/Inf、极端亮点和首帧制定确定规则。`P_(t+1)=E_t` 仅在本帧成功 submit 后生效；abort 保持旧 read slot，device loss 重新 bootstrap。一个 GPU buffer slot 不得同时作为当前 read 与 write；当前帧 CPU 绝不 map/read 曝光作 render 决策。
- 先移植 Wicked 原始完整基线，再考虑本地中心权重、percentile、manual exposure 等扩展；每个扩展写明是否偏离源数学和所增加的 GPU 工作量。

**D4 结束可观察点**：Surface、sky、aerial 在非 1 的 `P_t` 下仍同域；FSR3 history 有合法 `P_t/P_prev`；meter 输出在 GPU 被显示分支真实消费；正常亮度变化不使所有 temporal history 清空。

## 8. D5：Bloom、grade、GT7 与 Canvas

1. 在 Frame Program 添加 `reconstructed-hdr`、`bloom-hdr`、`adapted-exposure`、`display-color` 等**有消费者**的语义产品与边。Bloom 使用固定 Filament High core、threshold on、flare/dirt off 的 downsample/upsample/combine，保留奇偶尺寸 9/13 tap 选择；阈值先除 `P_t` 或等效转换到 scene luminance 单位。核对 RGBA16F storage/filtering/attachment usage 和纹理层数，以 WebGPU 合法 pass 序列执行，不自建 submit。
2. Filament `hdrColorAt` 的静态 white balance/CDL/contrast/vibrance/saturation、LogC、GT7 tone、gamut/OETF 按固定源顺序生成**同一 SDR LUT**；LUT 仅参数变更时更新。把动态 `E_t/P_t` 放在采样前。移植 GT7ToneMapper 的 Rec.2020→ICtCp、toe/shoulder、chroma 和目标亮度处理；对 SDR LUT 最终输出做数值 oracle（灰阶、肤色、饱和高亮、负值/过曝）。不要以旧 `tonemap_sdr.ts` 改名当完整 GT7。
3. `SurfacePresentPass.ts` 改为最终 display transform 的消费者，停止 `textureLoad(HDR).rgb` 直接写 swapchain。SDR 使用实际 preferred canvas format、目标 gamut/OETF 与 UI 的 display-referred 合成。若 UI producer 当前缺席，先固定其未来插入点，不能为它创建空 pass。
4. HDR profile 先查 GPUWeb living spec 与运行时 `configure/getConfiguration()`；仅实际可用的 `rgba16float`、extended tone mapping 和输出 colorSpace 组合才启用。HDR grade/tone 需按源顺序展开为宽范围数学路径，保留 >1 值和目标 peak/paper white，避开 Filament SDR `hdrColorAt` 的 saturate；这是具名本地适配，单独对照 GT7 源数学。fallback 为同一 Renderer 的 SDR specialization，不保留旧 Present 路径。

**D5 结束可观察点**：SDR canvas 不再接 raw HDR；Bloom/grade/GT7 都有实际 GPU producer→consumer；HDR 路径只在成功能力协商后存在，未取得目标浏览器/显示器画质证据时只称实现 profile，不称 HDR 画质验收。

## 9. D6：一次模块集中检查、返工与交接

先逐条对[设计文档](../next-design/temporal-radiometry-presentation.md)核实；遇到遗漏或把 donor 阶段缩成同名近似实现，直接返工。检查重点：

- 源阶段/分支与本地文件对照；FSR3 pinned stages、Wicked histogram 两 pass/clear、Filament 选定 Bloom/ColorGrading/GT7 数学。没实现的分支如实写缺口，不升 adopted。
- 唯一 production Graph/submit；motion 符号和 jitter、validity、local-change、opaque reactive、透明 absent；没有 GPU→CPU→GPU 曝光或 work control。
- history 的真实 GPU writer、begin/commit/abort、output/internal resize、camera cut、空场景、replacement/device epoch；普通曝光变化与局部 patch 不整屏失效。
- `P_t` 与 `E_t` 的空间/比值、sky/aerial/material 色域和 pre-exposure、曝光后 Bloom/grade/tone 的顺序；SDR/HDR 能力协商、UI 插入点和无双重 OETF。
- WebGPU 限额、bind group、texture usage、pipeline cache 与暂存资源预算；这些是源码/配置检查，不编造已量测的性能结论。

**此时才集中运行一次** typecheck、正式 build、必要 targeted tests：motion/jitter/depth 的 CPU/WGSL oracle，P/E 递推与 abort/resize history 契约，Wicked histogram/适应与 Filament 选定 tone/LUT 数值 oracle，Frame Program producer→consumer/单提交结构检查。若能用现有 GPU 环境进行有针对性的实测可运行并记录；环境不可用如实说明。修明显问题后同步 `project/workstreams/active/eengine-next-clean-rebuild.yaml`、已实现 current facts 和来源账本的实际状态，`currentSlice` 转到 VSM，并开始 VSM 的详细设计/实施。不要为每个 D 子步骤建全套 browser/evidence/claim 门禁。

正式浏览器矩阵、不同场景/材质与 feature interactions、resize/camera cut/device loss、SDR/HDR 显示器画质、GPU pass/bandwidth/P50/P95 和 formal evidence/claims，留给 Next Renderer 总验收。模块检查未跑的项目要明写“未运行”与原因，不以静态文档宣称 GPU 画质或上游 adoption 已完成。
