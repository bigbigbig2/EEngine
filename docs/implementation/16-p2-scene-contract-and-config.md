# P2：GPU Scene、Frame Contract、配置与能力检查执行记录

状态：Implemented（基础合同已接入；GPU Scene/Lighting consumer 迁移按 P3+ 继续）  
阶段：P2 场景、视图和初始化边界  
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)  
对应 P1：[15-p1-frame-infrastructure.md](./15-p1-frame-infrastructure.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P2-CONTRACT-01` |
| 目标 | 统一 Renderer 初始化配置、GPU 能力校验和 CPU→View/FrameGraph 的单帧合同。 |
| 依赖 | P0/ADR-0012、P1 `RenderFeatureRegistry` 与 R1–R2 GPU Scene/Asset owner。 |
| 当前入口 | `Renderer` constructor/`initialize()`/`render()`、`RenderSettings`、`GpuAssetStore`、`GpuScene`、`GpuPackedSceneRegistry`。 |
| 改动边界 | 新增 `RendererConfig`、`RenderFrameContract` 和能力快照；不改 Visibility、Surface、Lighting、AO、SSR、TAA 算法，不建立第二条管线。 |
| Producer | 初始化配置生产唯一 `RenderSettings` patch；`createRenderFrameContract()` 生产 frame index、View/输出尺寸、jitter、Feature bits、history revision。 |
| Consumer | Renderer 使用归一化配置初始化资源和 Feature；View 设置使用帧合同；FrameGraph topology/evidence 使用同一 feature/尺寸语义；调用方可读取能力快照。 |
| ABI/容量 | `RendererConfig` 是初始化期 CPU 配置；`RenderFrameContract` 是只读标量合同，无 GPU buffer/queue ABI。设备能力只记录实际 Feature 名和关键 Limit，不向外泄漏 GPU 对象。 |
| Overflow | 空必需 Feature、非正 required limit、设备缺失必需 Feature/Limit 均在 GPU 资源创建前抛错；不进入半兼容路径、不静默降级。配置数值继续由 `RenderSettings.validate()` 统一校验。 |
| Owner/Lifetime | Runtime Asset 与 GPU owner 仍由 `GpuAssetStore/GpuScene/GpuPackedSceneRegistry` 持有；RendererConfig/FrameContract 不持有 GPU 资源；device lost 仍由 Renderer 原有恢复/销毁路径处理。 |
| Upstream | 本包没有新增算法移植；配置/Frame Contract 是 OEngine 运行时边界，复用现有 RenderSettings、ViewContext、FrameGraph 合同。后续算法仍须从 `docs/references/README.md` 选定可追溯实现。 |

## 实现内容

- `RendererConfig` 提供固定中等偏高默认：内部比例 1、AO/SSR 半分辨率、GTAO/SSSR/TAAU 默认开启；便捷字段归一化到单一 `RenderSettingsPatch`，显式 `renderSettings` 覆盖便捷字段。
- `Renderer` 构造器接受配置，`initialize({ config })` 可做一次初始化覆盖；运行时仍只有 `configure()` 这一数值/开关修改入口。
- Renderer 对 adapter 创建路径和调用方传入的 GPUDevice 统一校验 `indirect-first-instance`、`float32-blendable`、`texture-formats-tier1` 及最小 Limit；校验失败在创建 Graphics owner 前明确报错。
- `Renderer.capabilities` 暴露冻结的能力/Limit 快照，保持 GPU 对象与内部资源表私有。
- `RenderFrameContract` 在每帧生成并冻结，View 使用合同中的尺寸和 jitter，避免 Pass 自行推导不同的 frame domain。
- 新增配置和帧合同单元测试，覆盖默认策略、覆盖优先级、无第二管线、合同冻结和非法尺寸。

## 正确性与性能 Gate

- 默认配置只产生一套 RenderSettings/主帧管线；不引入 Low/Medium/High 三套运行时。
- Feature-off 仍由 P1 registry/FrameGraph pruning 处理，不保留无消费者资源或 history。
- 能力不足必须 fail-fast；不把缺失 Feature/Limit 当作 unsupported 后继续半初始化。
- FrameContract 只分配冻结的 CPU 标量快照，不创建 Pass、Buffer、readback、额外 encoder 或 submit。
- 本阶段不宣称 GPU Scene consumer 已全部迁移，也不宣称画质或 GPU 性能改善；这些 Gate 属于 P3–P8。

## 验证记录

已运行：

```text
cd OEngine
npm run build:test
node --test tests/p2-scene-contract.test.mjs
```

阶段收尾还需运行：`npm run build`、`npm test`、`npm run audit:shaders`、`examples/npm run build`、`examples/npm run test:evidence`，以及命中浏览器示例的人工 GPU/console 检查。由于本包不改变画面算法，浏览器截图 Gate 留到 P3+ 首个画面变化工作包。

## 删除与后续迁移

本包删除了 Renderer 内部配置分散风险，但暂不删除历史 `QualityProfile` 类型和旧 Pass 参数读取；它们仍有已有测试/调用方，必须在 P3–P8 consumer 迁移和配置收敛后按引用、生命周期与性能证据删除。不得新增长期 legacy/new 双运行时。

## 阶段提交约束

代码、测试、文档和验证完成后使用独立中文提交，正文列出配置默认、能力 fail-fast、合同 ABI、验证命令和未运行的浏览器 Gate；排除 `three.js` 用户现有 gitlink 修改。
