---
id: render-product-work-history-v1
kind: contract
status: proposed
owners:
  - frame-runtime
  - visibility
  - shading
version: 1
consumers:
  - OEngine/src/render/pipeline/MainRenderPipeline.ts
  - OEngine/src/render/pipeline/FrameProducts.ts
  - OEngine/src/render/TemporalHistoryRegistry.ts
invariants:
  - product demand and representation depend on declared consumers and semantic domains
  - GPU work producers close through bounded GPU consumers
  - revision-local bindings cannot enter device-lifetime program caches
  - histories reject incompatible identity or representation before reuse
validation:
  - OEngine/tests/contract/opaque-shading-demand.test.mjs
  - OEngine/tests/contract/shading-program-specialization.test.mjs
  - OEngine/tests/contract/advanced-frame-abi.test.mjs
  - OEngine/tests/contract/bounded-gpu-work-protocol.test.mjs
---
# Render Product、GPU Work 与 History 最小合同

此合同对应 [ADR-0019](../adr/0019-eengine-next-renderer.md) 的 A 批次。它定义现有真实消费者需要的边界，**不新增二进制 ABI**。队列具体字段、产品具体格式与各算法历史仍由对应 spec/owner 维护；合同状态保持 `proposed`，直到下面尚缺的稳定身份和产品表示选择落地。

## Product demand 与物理表示

- [OpaqueShadingDemand](../../OEngine/src/render/pipeline/OpaqueShadingDemand.ts) 只从不可变 receiver summary、功能拓扑和调试需求派生；不能从本帧 CPU 可见列表或 GPU readback 推导。该快照同时供 publication 与 FrameGraph 使用，摄像机移动不触发无关程序重编。
- 一个逻辑产品的声明至少交代消费者、分辨率/空间、语义与颜色或物理单位、所需精度/覆盖、曝光约定和跨帧有效性。无需给每个产品分配纹理；所选执行计划在其真正的 GPU 消费者首次使用时，明确 fuse、recompute、materialize 或有效 history reuse，并声明转换 owner。
- 当前生产路径的有界方案为：单次 compute resolve 融合材质和 direct lighting；`ShadingSurfaceLite`、`DiffuseSurfaceLite`、Velocity 根据消费者物化；缺少 receiver 时不创建对应输出；`ScreenSpaceDiffuseOffFrame` 的 AO=1 是逻辑常量，不占纹理。现行 `FrameProducts` 中的空间域、阶段、pre-exposure 和可选资源是事实来源。未来增加缓存或低频表示时必须保持这些语义，不能仅按产品名称替换纹理。
- 当前首个有限计划由 `compileOpaqueSurfaceProductPlan` 从发布需求选择：IBL 在无后段间接消费者时融合，在有后段消费者时延后到 GI/lighting consumer；Normal、Diffuse Reflectance 与 Velocity 按需求物化；Normal 或 Diffuse 任一存在时共用一份 Material Flags。`SurfaceFeature` 只按该计划分配可选输出，计划先验证需求与发布 mask 一致。后续可增加有证据的 recompute/cache 方案，不把这套固定选择冒称全局成本优化器。
- 输出 mask 和设备 capability 是程序身份的一部分；revision/generation 与具体资源绑定不进入稳定程序身份。同一 shader/layout/能力闭包可复用 GPU pipeline，每个 Scene publication 必须新建自己的绑定组缓存并验证 revision。device loss 丢弃程序缓存；输出 mask/绑定/源码变化选新程序。GPU 仍按旧提交的 serial 安全退役 revision 资源。

## GPU 工作闭环

- MeshletWork 和 ShadingWork 先共用控制面协议，不共用元素布局、header 或物理队列。[BoundedGpuWorkProtocol](../../OEngine/src/gpu/BoundedGpuWorkProtocol.ts) 在实际队列分配前核对 producer、GPU consumer、元素 ABI、容量、字节需求、设备 limits、counter 语义、溢出处理和间接执行方式；生产路径分别用它计算 MeshletWork 与 ShadingBin heap 的分配字节。两者都有 attempted/written/overflow，MeshletWork 另有 consumed/invalid，层次遍历队列另有 peak/fallback，不能强行补成同一 header。当前两条生产路径溢出时都压制本帧间接输出，不把部分结果当完整画面。各自的 WGSL reservation、finalizer、元素 ABI 和 GPU consumer 保持原样；[GpuWorkGenerationAbi](../../OEngine/src/gpu/GpuWorkGenerationAbi.ts) 是上游层次队列，不等于最终 Product MeshletWork。
- `DirectSingleBin` 是合法的固定有界工作路径，不能为满足“所有工作必须先 compact”的形式要求而增添额外往返。新 Ray/Page 工作流只有在分类/压缩节省的 GPU 成本超过分类与间接开销，且空任务/溢出可解释时，才进入生产执行。
- GPU producer 的本帧结果由 GPU consumer 闭环消费。CPU feedback 可以异步决定以后帧的驻留，不生成本帧最终可见列表。

## Temporal identity 与失效

- [TemporalHistoryRegistry](../../OEngine/src/render/TemporalHistoryRegistry.ts) 拥有尺寸域、活动状态、提交/中止、ping-pong、曝光缩放及整帧拓扑失效；信号 owner 仍拥有方差、置信度、拒绝/滤波算法。不同语义/空间/表示的 history 不互换。
- 光照输入身份由灯光版本与 Probe 版本的有序组合组成，不能将两个版本相加，否则不同变化会碰撞。默认历史在光照身份变化时失效；纯几何 GTAO history 明确声明不依赖光照版本，因此仅光照变化时可继续读取。它仍须在相机、尺寸、场景、表示或自身 feature 变化时失效；GI、SSR、Color、曝光历史维持光照依赖。
- 帧内 `VisibilityKey` 或 MeshletWork 队列索引不可直接跨帧复用。后续产品以稳定 scene/object generation、实际几何/材质版本及投影运动/遮挡判定建立对应关系；实例替换、页/代理变化、切换表示与 disocclusion 必须使受影响的历史失效或降低置信度。AO、GI、Reflection 可保留信号专属失效粒度，不要求所有历史在每次局部变化时整帧清空。
- 当前主管线传入的 pre-exposure multiplier 是 1；`PreExposureContract` 已存在不代表真实动态曝光缩放闭环完成。接入动态乘子后，各 HDR-like 产品与旧历史必须使用同一代曝光约定或合法 rescale。

## 切片退出条件

本合同先固定边界并显示缺口。后续实施用第一个真实消费者决定具体产品表示成本规则；用实际身份/运动数据实现局部历史失效；用源到生产映射验证 Ray/Page 队列。变更 WGSL 布局、队列 ABI 或状态机时，更新 `docs/specs/` 和相应 contract/oracle。当前程序缓存改动仅证明 pipeline 复用与 revision 隔离的本地合同；真实浏览器运行和性能收益需要独立证据。
