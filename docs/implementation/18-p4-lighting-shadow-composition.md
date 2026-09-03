# P4：Clustered Lighting、Shadow Service 与 HDR Composition 执行记录

状态：Implemented（Lighting/Shadow Feature owner 边界已接入；画面算法 Gate 仍需后续 production GPU 证据）
阶段：P4 Clustered Lighting + Shadow Service + HDR Composition
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)
对应 P3：[17-p3-visibility-surface-contract.md](./17-p3-visibility-surface-contract.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P4-LIGHT-SHADOW-01` |
| 目标 | 将 GPU Light Buffer → Cluster/Froxel → Direct HDR Lighting，以及 CSM/Atlas/Contact Shadow 收拢到稳定 owner 边界。 |
| 输入 | P3 Surface、Depth/HZB、View/Camera、GPU Light Buffer、Environment 与 Shadow Atlas。 |
| 输出 | Cluster parameters/lookup/data、active light list、Shadow Atlas visibility 和线性 HDR direct-lighting target。 |
| Producer | `LightClusterPass` 在 GPU 上生成 candidate/active light list 和 bounded cluster data；`ShadowService` 调度 CSM/Atlas 的 GPU raster work。 |
| Consumer | `LightingPass` 逐像素消费所属 Cluster 与 Shadow Atlas；后续 P5 GI/Reflection/AO 只消费 HDR lighting contract。 |
| ABI/容量 | 不改变现有 GPU Light、LightList、ClusterData、Shadow Atlas、RasterWork ABI；容量检查、overflow mask 和 cluster histogram 继续由现有 producer/counter 实现。 |
| 生命周期 | `LightingFeature` 持有 Cluster/Direct/Background composition；`ShadowService` 持有场景阴影 owner；FrameGraph 管理 transient cluster/HDR 资源，Shadow Atlas 按 feature 开关惰性分配。 |

## 实现内容

- 新增 [LightingFeature](../../OEngine/src/render/features/LightingFeature.ts)，组合 `LightClusterPass`、`LightingPass` 与 `EnvironmentBackgroundPass`。
- 新增 [ShadowService](../../OEngine/src/gpu/ShadowService.ts)，隐藏 `ShadowContext` 的内部资源和 raster 实现，提供统一的启停、选择、绘制、Packed CSM 释放与证据入口。
- `GPULightCollection` 改由 `shadow_service` 持有阴影 owner；Renderer 不再直接访问 `ShadowContext` 或分别构造 Cluster/Lighting/Background pass。
- GPU producer → consumer 闭环保持不变：Light Buffer 生成 GPU light list，Cluster assignment 写 bounded data，Lighting fullscreen consumer 读取 cluster；阴影使用 `drawIndirect` 消费 GPU RasterWork。
- 保持默认阴影语义：`Light.casts_shadow = true`；Directional/Point/Spot 仍由统一 Shadow Service 管理现有 CSM/Atlas/Contact Shadow 路径。
- 新增 P4 源码合同测试，覆盖 owner 接线、cluster→lighting 消费、阴影服务边界、默认阴影和 overflow 证据。

## 开源参考与适配

本包没有新增算法移植。Cluster assignment、PBR direct lighting、CSM practical split、Shadow Atlas 和 contact-shadow 既有来源与许可证记录继续由 `docs/references/porting/R5-01-surface-lighting.md`、`R5-02-packed-csm-shadow.md` 和相关 R4/R5 ledger 拥有。本包只迁移 owner/composition seam，不复制 native descriptor、MDI、mesh shader 或 64-bit atomic 能力。

## 正确性、性能与删除边界

- Cluster capacity、candidate/active/cluster overflow、histogram、灯光遍历计数继续写入 GPU counters；Shadow cascade、atlas pixels、alpha work、queue overflow 继续写入现有 shadow counters。
- Direct Lighting 和 Shadow 仍在统一线性 HDR 方程中组合；Shadow Service 只提供 visibility/filtering，不直接改写最终颜色。
- Feature 关闭时不创建 Cluster consumer 所需的新图资源；Shadow Atlas 通过 `setEnabled(false)` 释放，释放动作等待 owning GPU work 完成。
- 本包不宣称 TAA、SSR、GTAO 或 GI 画质已修复，也不宣称 Direct Lighting 已通过 production GPU 时间 Gate；这些需要后续同条件 browser/GPU artifact。
- 普通 Scene 的旧 raster 实现仍由 `ShadowContext` 作为内部实现承载，不能在没有 Packed/legacy 双路径迁移证据前删除；本包已消除 Renderer 对该实现的直接 owner 依赖。

## 验证记录

已运行：

```text
cd OEngine
npm run build
npm run build:test
node --test tests/p4-lighting-shadow-feature.test.mjs
```

此前 P3/P4 共享的完整回归、shader 审计和 examples evidence 仍作为基线；本包未执行浏览器人工截图和真实 GPU 画面 Gate，原因是本次只迁移 owner/composition seam，没有改变光照或阴影数学。下一次改变 Lighting/Shadow 画面算法时必须重新采集 GPU timestamp、counter、debug view、截图和数值 artifact。

## 阶段提交约束

代码、测试、文档和验证完成后使用独立中文提交；正文列出 LightingFeature、ShadowService、ABI/容量未变更、GPU producer/consumer、验证命令和未运行的 browser/GPU Gate，并排除 `three.js` 用户现有 gitlink 修改。
