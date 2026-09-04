# Stage 5：旧路径删除与产品闭环验收

> 状态：待执行。
> 
> 目的：证明新算法是真正的唯一生产实现，并在目标场景、性能、显存和可观测性上完成闭环。

## 1. 删除原则

只有替代 consumer 已通过正确性、GPU timing、显存、feature-off 和 browser sequence Gate，才允许删除旧代码。删除对象包括：

- `MaterialExpandPass`、`VelocityPass` 的已迁移 consumer；
- 旧 AO composite/history；
- 旧 SSR trace/correction/history；
- 旧 TAA/classification/resolve；
- 重复 `OpaqueLightingPipeline`、`IndirectCompositePass`、IBL/Shadow/OIT owner；
- 不再被 runtime 引用的 authored/generated/oracle shader 和配置字段。

## 2. 删除前证据

每个删除批次必须保存：

- `rg` 引用审计和 shader source audit；
- FrameGraph graph diff，证明无 hidden consumer；
- feature-on/off GPU timing 与资源分配差异；
- 同输入新旧 paired 截图/序列和数值误差；
- overflow、fallback、device-lost、resize、history invalidation 和 completion 证据。

不得因为类名没有引用就直接删除；必须证明真实运行路径未命中。

## 3. 产品 Gate

目标基线：1920×1080、DPR 1、60 FPS、整帧预算 16.667 ms，中等偏高默认配置。至少覆盖：

- 静态高几何 + GPU-driven visibility；
- 动态灯光影响静态场景；
- 室内 lightmap/probe volume/IBL fallback；
- Local Reflection Probe + SSSR；
- AO/阴影/Contact Shadow；
- 快速相机、物体运动、镜面高光和 DRS 切换；
- 透明重叠与 Heavy Workload。

每个场景同时检查画面序列、GPU phase P50/P95/P99、显存峰值、transient/history、上传量、overflow/fallback 和 feature-off 增量。

## 4. 代码与文档收口

完成后更新：

- `CURRENT-STATE.md`：只写已由源码和 artifact 证明的事实；
- `STATUS.md`：将对应阶段标为 `产品闭环`；
- `docs/references/porting/`：补齐每个外部算法的 source/commit/license/差异/benchmark；
- ADR：只有长期架构决策发生变化才新增或修订；
- `README.md`、路线和测试：删除失效入口、旧配置和重复测试。

## 5. 最终退出条件

1. 单一主管线、单一真实 consumer 链路成立；
2. 所有目标效果算法和 shader source 可追溯；
3. 正确性序列、GPU 时间、显存和 feature-off Gate 全部通过；
4. 旧 Pass、旧 shader、旧资源 owner、旧配置和死测试已删除；
5. 文档状态、代码引用和 artifact 互相一致；
6. 通过阶段独立中文提交，并且不包含用户已有 `three.js` gitlink 修改。

