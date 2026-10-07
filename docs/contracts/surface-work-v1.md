---
id: surface-work-v1
kind: contract
status: frozen
owners:
  - frame-runtime
  - shading
  - visibility
version: 1
consumers:
  - OEngine/src/render/pipeline/RendererCore.ts
  - OEngine/src/render/surface/SurfacePresentPass.ts
invariants:
  - current visibility work is produced and indirectly consumed on the GPU without a CPU count readback
  - unsupported frequency bands use full-rate shading on the same pipeline
  - program identity excludes publication generations and bindings resolve the current graph publication
  - radiance is the only materialized Surface product in this profile and no temporal reuse is supported
validation:
  - node tools/vibe.mjs verify --module
  - node tools/vibe.mjs verify --full
state: history
verifies:
  - checks
  - project/domains
---
# Surface / Work V1：Phase 2 实现边界

本合同记录已退役的早期 Phase 2 结构，不再描述当前或目标 SurfaceWork V3。当前实现事实见 [Shading](../domains/shading.md)，目标和执行见 [SurfaceWork V3](../next-design/eengine-extreme-performance-rebuild-2026-10.md) 与[执行计划](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。下文只供历史追溯，不代表正式 GPU 画质或性能验收；旧 evidence 不转授新合同。

## 所有权与提取

| 保留资产 | 当前 owner / 消费者 | 切断边界 |
| --- | --- | --- |
| 透视重建、投影梯度、材质采样、Filament-derived PBR | `surface_material_kernel.ts` → `surface_material_program.ts` | 删除旧 `sparse_shading_resolve.ts` 包装和 ResolvePass；数学不降级重写 |
| 程序与物理绑定 | 历史 `SurfaceProducts.ts`、`SurfaceKernelBindingPlan.ts`、`AppearanceCachePass.ts` | 不消费历史 Sparse pipeline descriptor/cache/revision owner；V3 稳定 ABI 尚未冻结 |
| 场景发布记录与活跃类摘要 | `GpuShadingPublication.ts` 类型、`GpuRenderWorld.ts` 发布实现 | 删除旧 publication store/transaction 和 candidate coordinator；现有 GPU Scene 发布测试继续约束真实消费者 |
| 普通资产 heap、240-byte view、材质/纹理/几何 generation | `GpuAssetStore`、`GpuSparseShadingFrameAbi`、Scene/Texture owners | 历史 Sparse 命名不代表旧链；新 Surface 仍直接消费，字节布局不变 |
| FrameGraph、Visibility、LightCluster、frame domain | 各自现有 owner | 保留合法消费者；不把整个 FrameProducts 当作新 Product Planner |

来源函数与数学对照沿用 [R02/Surface 迁移映射](../porting/next-renderer.md)，本次不引入或冒称新的算法移植。

## 有限计划与绑定生命周期

Renderer 从场景发布的固定 64 类摘要选择可能执行的静态 kernel；GPU 决定每类本帧数量。graph key 覆盖内部/输出尺寸、格式、VG、HZB/late-recheck、Meshlet 容量及执行设置、有效频率开关、活跃类和纹理 bank mask。拓扑不变时 FrameGraphBindingLayout 用当前帧 publication 重绑定资源，不因对象或材质 generation 改变就创建新程序。

Surface 程序按 WGSL、kernel specialization、layout、format 和设备能力边界缓存；缓存属于当前 device，销毁时清空。当前 capability 标记为 `webgpu-core`，真实 limits 由 layout planner 检查；缓存不跨设备共享。bind group 在执行时从当前 graph 资源解析，view uniform 写入当前材质/纹理/publication generation。缺少必需资源立即报错，不用旧 revision 顶替；GPU 检查 hit 身份，失败呈现错误色。资源退役继续归 Scene/资产 owner 和 submission 生命周期，Surface 不接管 Loader 资源。

这是一套固定有限计划，不是通用成本优化器。当前没有自动 dense/compact 选择，也没有跨消费者 normal/motion 物化策略。

## Product 与 GPU Work

当前只物化 internal-full `rgba16float` radiance，中间 coarse 输出由 Present 按同帧频率计划重建；pre-exposure 当前固定为 1。geometric-normal、shading-normal、motion、material-identity 的逻辑 schema 不表示已有独立输出产品。法线等可作为 kernel 内部中间值，不能当作下游已发布纹理。

队列元素、计数器、容量与间接参数以 [ShadingWork V1](../specs/shading-work-v1.md) 为准：8-byte record、最多 width×height 项、GPU classify/finalize/scatter、按类 indirect consumer。超设备容量在创建前拒绝；运行期无效身份/overflow 走显式错误输出，不静默丢 hit。空工作保持合法零 dispatch。CPU 不读取计数决定当前帧工作量；诊断 readback 必须显式请求。

频率 profile 以 [Frequency Plan V1](../specs/shading-frequency-plan-v1.md) 为准：静态 opaque unlit factor、认证 1×1 unlit texture 可进入 2×2/4×4；其余 full-rate，边界和运动按规则拒绝粗化。无历史复用；full-rate 与 coarse 共用一个生产 Renderer。该 profile 的结构成立不等于净 GPU 收益。

## 验证范围

`surface-product-closure` 检查逻辑/物理闭包、程序与绑定身份、限额失败；`shading-work-capacity` 和 `shading-frequency-plan` 检查容量与尺寸；`surface-reconstruction-projected` 及保留的材质数学 oracle 检查数值；retired-path guard 阻止旧 owner 回流。`phase1-visibility` 仅提供新链 GPU diagnostic，不升级正式声明。

完整画质、authored tangent/更多光照组合、双机整帧收益和广泛受光降频仍是独立 open gates；Temporal 与跨域 Work Runtime 不在此合同完成范围。
