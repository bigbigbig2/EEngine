---
id: virtual-assets
kind: domain
owner: virtual-assets
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryProductAdmission.ts
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryDemandReadbackRing.ts
    - OEngine/src/gpu/GeometryProductResidencyProfile.ts
    - OEngine/src/gpu/GeometryProductSlotPool.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
    - OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts
    - OEngine/src/gpu/GeometryProductResidentAttributes.ts
---
# Virtual Assets

## 当前 owner 与生产连接

已核对入口为 [GeometryProductAdmission](../../OEngine/src/gpu/GeometryProductAdmission.ts)、[GeometryProductMultiRuntime](../../OEngine/src/gpu/GeometryProductMultiRuntime.ts)、VirtualGeometrySceneSourceV1、FrameProgramLowering 和当前 Product GPU ABI。

Loader/Cooker 提供 Product descriptor/pages；admission 负责验证/激活，multi-runtime 管理 Product/shard slots 与 replacement/release，residency 发布当前页位置。FrameProgramLowering 将 virtual metadata/banks 与选中 frame geometry 传给唯一 SurfaceV4；GPU hierarchy/work/raster 消费当前产品，不由 Loader 长期持有 GPU owner。

当前 GeometryProductGpuAbiV1 的数值 ABI version 为3；16B page-location 的 raw/resident 地址使用1024-slot namespace，64B heap header word12发布实际物理 slotsPerBank，GPU heap lookup 在 bank read 前校验实际范围。API 名称中的 V1 是 Product 合同名，不是当前 GPU 数值版本。M1 全 Node suite 的既有失败不追改；本轮 codec/profile/streaming fixtures 已迁移，实际结果与未运行范围见执行计划 G2.1。

Web/Offline/procedural Scene mapper 读取完整 immutable descriptor，按真实 asset forest 与 instance multiplicity 发布 depth/队列上界，合并不再 clamp；RenderWorld 在创建 Scene 资源前检查协商 buffer/binding/dispatch 与 Visibility work namespace。Resident decoder 核实实际 group header 的 meshlet count 与 descriptor 一致，防止页内容突破已声明 work 上界。空 instance list 明确拒绝。合法 page fixtures 已覆盖当前 admission/residency/multi-runtime 的 targeted 合同；原失败记录和仍未关闭的缺口保留在执行计划，不能视为完整 streaming 规模验收。

四 bank 按 GPUDevice 共享；auto 无显式预算默认4×32MiB，profile512/768/1024MiB是 ceiling，实际容量按预算/limit/page协商。MultiRuntime scene metadata 默认64MiB，是唯一 GPU directory（Product Table嵌入其中）；各 Product只保CPU descriptor/source与页生命周期。六 section 的 bounded CPU free-range lists 在末读 fence 后回收，不移动live range；单 Product standalone 仍拥有自己唯一 metadata。共享banks/metadata的used、reserved、retiring与peak分别计账，不能将每 Product共享bank evidence相加。

Streaming mainring 由命令提交 commit、abort cancel；延迟map/consume后 exact slot/generation 分发IO/upload，不按同revision首个Product路由。Scheduler的in-flight reservation与verified raw pages共预算，read/upload按Product服务次数与本地priority/age公平排序；physical pressure实际接入frame间revoke→真实queue fence→release→upload retry。错误留在runtime/Renderer diagnostics；无本帧readback控制或额外submit。超工作集仍会thrash，不保证任意小预算达到完整fine LOD。

Renderer device loss checkpoint/replay全部active/dormant owned sources及slot/generation/asset ranges，重新注册各Product streaming；失败replay保持sources可retry。GPU压力fixture验证coarse coverage、pin保护与多Product进展，真实Renderer消费winner/native HDR/Temporal并恢复全部Product。独立shadow view是实际VSM caster及延迟page demand producer；FrameGeometryArena已按真实需求预留lean产品。完整本地authored大场景及规模压力通过既定正确性/恢复/卸载验收，具体source、artifact、成本和OPEN仅见执行计划G2.4；有限预算仍有thrash，不据此宣称所有IO/fairness策略或性能已最优。

Residency publication事件同步管理streaming source注册：dormant/retiring撤销注册并取消IO/verified队列，active恢复，destroy/device loss解除订阅；CPU取消不替代末读GPU fence。单Product退休不会继续向已释放source/owner上传迟到页。

Scene卸载区分caller admission与Renderer创建/recovery replay的Product责任：后者由`releaseScene`撤publication、取消streaming，末读GPU fence成功后释放Product/source并移除登记；前者默认保留caller释放责任。失败fence保登记可重试，重复卸载不提交空命令，迟到卸载不删新Product登记。Device loss取消main/shadow mapping与IO，source仍由checkpoint保留供replay/retry。GPU ring在真实loss通知reset；map abort/range失效先于通知时，仅失败冷路径等queue完成或loss并允许通知交付，只有观察到loss/destroy才取消，存活device的真实mapping/fence失败仍可观察。完整authored Runner已验证恢复旧epoch与Scene释放后的Product banks/metadata/allocations归零；实际验收范围与OPEN见执行计划G2.4。

## 边界与验证

当前 cook profile 为 `static-pbr-page-local-f32-lean-v7`，WASM input ABI4。raw Product/OEGPACK 不再携带无 runtime reader 的64B/triangle continuity；旧flag bits6/7明确要求recook，旧ABI3 WASM在规划前拒绝。cook内部 seam/domain/lineage/误差数学保留，float32 position及normal/tangent/UV/color编码不变。新真实payload bytes参与分组与LOD acceptance，可能改变cut和page packing；不能据删除字段直接推断质量或整bank VRAM收益。实际验证和限制只读执行计划G2.2。

来源及阶段映射集中在[geometry ledger](../porting/geometry.md)，既有 ABI/容器细节保留在对应 specs。本页不复制旧 Phase 标签、固定 asset 字节数、预算或 claim accepted 状态。

真实 GPU handoff/culling 的检查覆盖所选 producer/consumer 与输入；cook、替换、取消、device recovery、全几何容量和大型场景需要各自生产验证。已存在 virtual 输入绑定不等于未来完整 Virtual Geometry 工作域或完整 VT/Virtual Shadow。

目标和退出要求见[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)及[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。paused 工作保留其历史/待做范围，不成为活跃 currentSlice 或源码完成证明。
