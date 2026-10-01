---
id: shading
kind: domain
owner: shading
---
# Shading

## 当前源码事实

当前复核提交为 `11d906ab`；文中旧的 `84e77c3d` 只表示此前一次结构核对，不代表当前源码版本。

核对日期：2026-10-02；源码基线 `84e77c3d`。本页描述当前实现，目标见[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，执行见[SurfaceWork V3 计划](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。结构主链已切换，完整 AAA 数学、整帧 history、浏览器画质和性能仍未验收，本页不作性能通过声明。

当前 Surface 生产链为唯一 V3 路径，仍在算法收敛阶段：

```text
VisibilityKey / Depth / MeshletWork / shared frame geometry
  → SurfaceWorkRuntime
  → cache lookup → GeometryRecord → hit-mask-gated miss field evaluation
  → diffuse / specular / coat / IBL packet work
  → packet reconstruct
  → HDR / Sky / Aerial / FSR3 / Radiometry / Bloom / Present
```

旧 SurfaceMaterialPass、Probe、SurfaceSampleAbi、sample worker/result/Resolve 协调器以及旧 Appearance/SparseLighting owner 已删除；不保留 fallback 或兼容桥。

### Appearance

`SurfaceMaterialCachePass` 在 GeometryRecord 之前按当前已接入的 VisibilityKey、材质槽、字段版本和纹理驻留版本做 key 比较；命中直接写六层 fields，未命中压入有界 miss queue。当前 `SurfaceGeometryPass` 尚未读取 hit mask，仍按 record range 发布 GeometryRecord；hit mask 只在后续 miss evaluator 中生效，因此“命中绕过几何 heavy work”尚未实现。sampler、UV set/transform、footprint 和 variation revision 尚未完整进入 key；字段评估仍是本地 fallback kernel，尚未绑定每个 publication 的完整 `AppearanceResidentKernel`，因此不能宣称材质图语义已完全保持。

AppearanceGraphCompiler 已支持 typed dependencies、等价采样合并、常量/无用通道处理和 product 分类，lowering 输出 WGSL 求值程序。GpuMaterialStore 发布字段版本，AppearanceProgramRegistry 持有程序 leases，AppearanceStaticResidency 管理静态产品与 completion 退役。当前 mutable material 编辑仍需要实际 republication/resync，不能宣称所有动态输入或 nonlocal providers 已完成。

### 共享几何与照明

FrameGeometryArena/Vertices 提供当帧共享 clips/triangles/attributes。`SurfaceGeometryPass` 通过 `winnerPrimitiveArenaConsumerWgsl` 和 `surfaceGeometrySourceReaderWgsl` 统一恢复 winner、ordinary source 属性、实例变换、几何/着色法线、切线、UV、导数、视向、深度、身份和 signature，并写入唯一 GeometryRecord。Appearance 与 lighting 只读该记录。

`SurfaceLightingWorkPass` 现在按 GeometryRecord 和 fields 发布独立 diffuse/specular/coat/IBL packet，并使用 GGX、Smith visibility、Schlick Fresnel、金属度和能量分配计算。`SurfaceReconstructionPass` 只做 packet 映射、TemporalFacts 有效性判断、AO/reactive 传播和 pre-exposure 应用；真实跨帧 signal history、cluster/VSM/AO/IBL provider 资源仍待接入。

SurfaceWork 的 packet/reconstruct owner 负责未来的 signal history 资源；当前实现尚未接入完整 history read/reject/age。TemporalFacts 独立发布 motion/identity/validity 基础产品，FSR3 读取其 motion/mask 与 Surface reactive；Surface 不另有 motion attachment。当前基础事实与最终 signal reactive 的完整合同仍待重构收敛。

## 最终目标与现状差距

| 原文目标 | 当前差距 |
| --- | --- |
| implicit/uniform/mixed SurfaceWork，不全员 pixel task | 64-lane tile classifier 已发布三类覆盖、bounded sample/exception、indirect count 和 sample map；Product/形变输入与数值/性能验收仍待完成 |
| 唯一 SurfaceGeometryRecord | 已由 `SurfaceGeometryPass` 生产；skin/morph、Product 跨 LOD/source/seam 对应仍有缺口 |
| lookup 前置、仅 miss heavy work | lookup 已在 GeometryRecord 前注册，hit mask 已生成但尚未被 GeometryRecord 消费；完整 publication kernel miss evaluation 未接通 |
| 独立 diffuse/specular/coat/IBL work | 四类 packet 已独立资源和 counters；cluster、VSM、AO、physical/authored IBL provider 尚未接线 |
| 廉价 reconstruct | 已不重新解码 Geometry Product 或执行材质图；真实 signal history reject/age 尚未完成 |
| FrameGraph 看到真实阶段 | lookup、GeometryRecord、miss evaluation、packet 和 reconstruct 均是独立 FrameGraph 节点 |
| 原文完整生命周期和四版本验收 | 未通过；文档切换不提升状态 |

skin/morph/previous deformation、Product 跨 LOD/source/seam 对应、nonlocal/provider、屏外 VSM caster 与透明 composition 均继续列为缺口。当前源码仍在返工，未重新完成整个新目标的编译、浏览器、连续画质和稳定热状态性能验收。

## Owner 与入口

- shading：`render/surface/` 下的新 SurfaceWorkRuntime、GeometryRecord、cache、signal packet 和 reconstruct owner；`WinnerPrimitiveInterpolation.ts` 与 appearance publication 作为保留的数学/资源资产。
- materials-textures：AppearanceGraphCompiler、GpuMaterialStore、TextureResidency、AppearanceStaticResidency、AppearanceProgramRegistry 和 publication 生命周期。
- visibility/geometry：winner/depth 和共享 frame geometry；frame-runtime：FrameProgram/Lowering/FrameGraph/submit。
- temporal：TemporalFacts/TemporalFabric/FSR3 的基础事实与事务；signal owner 管理专用 confidence/history。

上述五个 owner 已属于当前生产路径；文档仍把未验收的算法和效果标为进行中。

历史来源与数值/组件检查保留在[porting ledger](../porting/next-renderer.md)及固定 revision。R02/R03/R20/R23 等 adoption 和正式 claims 需各自满足来源、数值和真实 GPU 消费证据，不从旧组件结果转授新主链。已退休的 contracts/specs 不规定新 SurfaceWork ABI。
