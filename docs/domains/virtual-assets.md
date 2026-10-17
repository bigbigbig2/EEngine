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
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/render/SceneRefinement.ts
    - OEngine/src/render/vsm/VsmCasterRecordPass.ts
    - OEngine/src/shaders/vsm_caster_records.ts
    - OEngine/src/shaders/vsm_allocate_pages.ts
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryDemandReadbackRing.ts
    - OEngine/src/gpu/GeometryProductResidencyProfile.ts
    - OEngine/src/gpu/GeometryProductBytePool.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryQueryCut.ts
    - OEngine/src/gpu/GeometryQueryWorkingSet.ts
    - OEngine/src/gpu/GeometryQueryCoverage.ts
    - OEngine/src/gpu/GeometryQueryDirectory.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
    - OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts
    - OEngine/src/assets/geometry-product/GeometryProductResidentAttributes.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/assets/geometry-product/GeometryProductV1.ts
    - OEngine/src/assets/geometry-product/OegPackProductProvider.ts
    - OEngine/src/assets/geometry-product/GeometryProductQuerySection.ts
    - OEngine/src/gpu/GeometryQueryDirectory.ts
    - OEngine/src/gpu/GeometryQueryDomain.ts
---
# Virtual Assets

## 当前 owner 与生产连接

2026-10-16 VT复审后的实际接线：VSM候选脏页经`VsmCasterRecordPass`先计数实际保守pair，再选择总量可容纳的完整页，per-page prefix/cursor生成记录；FrameProgram把同一筛选allocation交给clear/raster/commit。未选页继续dirty，最老页先行；单页超过pair容量仍保留完整implicit。VSM回收在原四类内先冷槽、后近期槽，使用已有last_visited的8帧间隔，不永久pin历史需求；当前帧请求仍全部保护。没有CPU同帧控制、额外submit或改变shadow geometry需求。既有72B延迟publication receipt拆出allocation/coarse misses、evictions、pairMode/failure/pending；caster不再擦掉allocator pending。limited不等于已收敛，`SceneRefinement`进入limited会撤销旧settled时间。Graphics device geometry ledger按共享bank+metadata只计一次，当时固定256KiB单页单槽的slack没有因此消失；后续GRS-1切换见下段。具体检查与剩余边界见当前VT执行§9。

2026-10-15初始化调度切换：HTTP Cooked Product的bootstrap与持续流送共用`CookedAssetPreparation`批读取；`AssetWorkerPool`中的Dedicated Worker执行Range、CRC/LZ4/布局、可选decoded SHA和resident position/UV数值扫描。`GeometryProductResidentAttributes`已迁到CPU assets层；主线程按实际任务receipt重建品牌、检查完整身份/返回域，复用prepared bounds/refine数据，不再次逐顶点扫描。memory/custom provider保留独立的未预验证snapshot/digest边界。完整256KiB逻辑页仍跨线程transfer，GPU只上传已验证payload prefix；没有新的页物理ABI。默认4批×16页候选、全局256MiB临时/32MiB编码/64MiB ready信用，ready直到上传、丢弃或source释放才回收。Worker完成仍不能直接发布位置表，唯一普通帧事务和退休fence继续归residency/runtime。每个revision source独占CPU会话，device loss取消旧runtime读取而保留可重放source；范围计数包含Worker真实IO。

2026-10-14以`2caf5fe2`核对：Product驻留保留原始紧凑Page，每页一个256KiB物理槽，不展开96B/vertex属性。准入扫描布局/索引、层次work bound和position/half-UV有限值；GPU直接解码并恢复完整format状态。未预验证source在异步digest前取得自有字节/身份快照，校验和上传消费同一快照；可信adapter明确区分真实SHA digest和CRC-only策略。几何页ABI/调度不等于未来纹理VT页，不能因两者都有“页”而合并owner。

已核对入口为 [GeometryProductAdmission](../../OEngine/src/gpu/GeometryProductAdmission.ts)、[GeometryProductMultiRuntime](../../OEngine/src/gpu/GeometryProductMultiRuntime.ts)、VirtualGeometrySceneSourceV1、FrameProgramLowering 和当前 Product GPU ABI。

Loader/Cooker 提供 Product descriptor/pages；admission 负责验证/激活，multi-runtime 管理 Product/shard slots 与 replacement/release，residency 发布当前页位置。FrameProgramLowering 将 virtual metadata/banks 与选中 frame geometry 传给唯一 SurfaceV4；GPU hierarchy/work/raster 消费当前产品，不由 Loader 长期持有 GPU owner。

当前 GeometryProductGpuAbiV1 数值版本为6：16B page-location发布bank/flags、16B对齐byte offset、完整generation与有效payload bytes，header word12为实际bankByteCapacity。GeometryProductBytePool使用完整OffsetAllocator移植按有效前缀分配，不再保留物理256KiB slot owner；四bank与metadata初始容量由Cooked目录规划。普通帧扩容保持活页offset和各section record index，候选epoch使Visibility/Temporal Occlusion/VSM及Surface的绑定重建，abort回旧代，成功fence后退旧buffer。逻辑页、hash/LZ4/Worker与原始顶点格式不变。GRS-3已在真实Renderer检查bank/metadata增长、abort/retry与opaque/MASK/Surface/VSM消费；独立原始Page解码、完整Bistro/Dungeon启动/收敛与卸载也有集中记录。成本、原失败与测量限制只读[GRS执行](../next-execution/eengine-geometry-residency-startup-execution-2026-10.md)，不由局部检查推导4GB或整Renderer性能资格。

Web/Offline/procedural Scene mapper 读取完整 immutable descriptor，按真实 asset forest 与 instance multiplicity 发布 depth/队列上界，合并不再 clamp；RenderWorld 在创建 Scene 资源前检查协商 buffer/binding/dispatch 与 Visibility work namespace。Resident decoder 核实实际 group header 的 meshlet count 与 descriptor 一致，防止页内容突破已声明 work 上界。空 instance list 明确拒绝。合法 page fixtures 已覆盖当前 admission/residency/multi-runtime 的 targeted 合同；原失败记录和仍未关闭的缺口保留在执行计划，不能视为完整 streaming 规模验收。

四 bank 按 GPUDevice 共享；auto无显式预算ceiling为128MiB，profile512/768/1024MiB同为ceiling，初始buffer按目录有效前缀及headroom规划；未知catalog每bank最多1MiB起步。MultiRuntime scene metadata按section实际计数规划，默认256MiB上限，是唯一 GPU directory（Product Table嵌入其中）；各 Product只保CPU descriptor/source与页生命周期。六 section 的 bounded CPU free-range lists 在末读 fence 后回收，不移动live range；单 Product standalone 仍拥有自己唯一 metadata。共享banks/metadata的used、reserved、retiring与peak分别计账，不能将每 Product共享bank evidence相加。

Streaming mainring 由命令提交 commit、abort cancel；延迟map/consume后 exact slot/generation 分发IO/upload，不按同revision首个Product路由。2026-10-15初始化调度（INIT-1）：几何流送解压后先进入`submitted`（隐藏槽写入payload，不公开位置表）；主帧在prepare阶段选择有界候选，经`uploadRegions`一次性编码位置表拷贝，并在本帧同一命令提交成功（`onFinished`）时原子推进`resident`与版本，abort则干净回滚候选状态；退休通过本模块发出的提交Fence批次异步回收，不无条件await整设备队列；Residency维护单调refine依赖反向索引，在几何入驻/退休时向VSM传递紧凑局部变化区，消除整实例AABB导致的无效阴影重绘。Scheduler的in-flight reservation与verified raw pages共预算，read/upload按Product服务次数与本地priority/age公平排序；physical pressure实际接入frame间revoke→真实queue fence→release→upload retry。错误留在runtime/Renderer diagnostics；无本帧readback控制或额外submit。超工作集仍会thrash，不保证任意小预算达到完整fine LOD。

Renderer device loss checkpoint/replay全部active/dormant owned sources及slot/generation/asset ranges，重新注册各Product streaming；失败replay保持sources可retry。GPU压力fixture验证coarse coverage、pin保护与多Product进展，真实Renderer消费winner/native HDR/Temporal并恢复全部Product。独立shadow view是实际VSM caster及延迟page demand producer；FrameGeometryArena已按真实需求预留lean产品。完整本地authored大场景及规模压力通过既定正确性/恢复/卸载验收，具体source、artifact、成本和OPEN仅见执行计划G2.4；有限预算仍有thrash，不据此宣称所有IO/fairness策略或性能已最优。

Residency publication事件同步管理streaming source注册：dormant/retiring撤销注册并取消IO/verified队列，active恢复，destroy/device loss解除订阅；CPU取消不替代末读GPU fence。单Product退休不会继续向已释放source/owner上传迟到页。

持续页stage只写隐藏payload槽。普通帧由residency统一编码新增/退休地址、候选版本和保守影响，submit后推进CPU状态，abort保留旧映射及可重试stage；退休槽只由撤映射帧的成功fence释放，失败可观测。影响在发布时按最新coarse反向索引计算，跨页/待消费批次按asset union，共享group覆盖全部引用asset，whole-asset fallback优先；VSM提交才ack。实际published计数与completion staged计数分开。初始化设计的空间/时间合批和阴影层级双工作域尚未完成，状态只读当前执行计划。

Scene卸载区分caller admission与Renderer创建/recovery replay的Product责任：后者由`releaseScene`撤publication、取消streaming，末读GPU fence成功后释放Product/source并移除登记；前者默认保留caller释放责任。失败fence保登记可重试，重复卸载不提交空命令，迟到卸载不删新Product登记。Device loss取消main/shadow mapping与IO，source仍由checkpoint保留供replay/retry。GPU ring在真实loss通知reset；map abort/range失效先于通知时，仅失败冷路径等queue完成或loss并允许通知交付，只有观察到loss/destroy才取消，存活device的真实mapping/fence失败仍可观察。完整authored Runner已验证恢复旧epoch与Scene释放后的Product banks/metadata/allocations归零；实际验收范围与OPEN见执行计划G2.4。

## 边界与验证

当前 vertex cook profile 为 `static-pbr-page-local-f32-lean-v7`，query recipe 为 `shared-meshlet-source-remap-cut-v3`，WASM input ABI6。raw Product/OEGPACK 不再携带无 runtime reader 的64B/triangle continuity；旧flag bits6/7明确要求recook，旧WASM ABI在规划前拒绝。cook内部 seam/domain/lineage/误差数学保留，float32 position及normal/tangent/UV/color编码不变。新真实payload bytes参与分组与LOD acceptance，可能改变cut和page packing；不能据删除字段直接推断质量或整bank VRAM收益。实际验证和限制只读执行计划G2.2。

SCGI query 扩展采用同一 schema2 Product，runtime profile 为 `oengine-vg-v2-v3-decoded-query3`：OGQ2 v3 section含160B header、32B/asset、80B/cluster、完整 source primitive/vertex remap与内容SHA256，native/portable/pthread producer一致更新。admission在异步等待前复制provider metadata，摘要校验在GPU分配和page IO前完成；Worker resident receipt绑定同一query内容摘要，不能把另一份descriptor的验证结果用于上传。query lease保持原始四bank/page payload，并派生按binding limit分段的v2地址目录，内含所选三角形的source remap；group/meshlet和属性解码仍共用raster helper。GPU世界域需求经独立分窗延迟ring归并为asset局部包络，cut选择相交clusters并只retain其pages；请求沿现有scheduler及普通frame publication，未齐备不能形成完整lease，普通压力eviction不挑选仍被query持有的页。当前实例与cut包络不匹配、越域ray、未支持形变均为unknown。现有Product coarse没有保真证明，critical条件强制精确叶节点，不能据误差预算宣称已支持有损coarse减量。全空cut消费和scene提交/中止/退休具有独立owner；这不代表默认生产GI已接通。详细单元状态只读[SCGI执行](../next-execution/eengine-surface-cache-gi-execution-2026-10.md)。

来源及阶段映射集中在[geometry ledger](../porting/geometry.md)，既有 ABI/容器细节保留在对应 specs。本页不复制旧 Phase 标签、固定 asset 字节数、预算或 claim accepted 状态。

真实 GPU handoff/culling 的检查覆盖所选 producer/consumer 与输入；cook、替换、取消、device recovery、全几何容量和大型场景需要各自生产验证。已存在 virtual 输入绑定不等于未来完整 Virtual Geometry 工作域或完整 VT/Virtual Shadow。

当前目标和退出要求由 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 导航；已完成 Geometry 单元的结果按日期回看历史执行记录。paused 工作保留其历史/待做范围，不成为活跃 currentSlice 或源码完成证明。
