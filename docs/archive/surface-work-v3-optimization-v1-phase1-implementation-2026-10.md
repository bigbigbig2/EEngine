---
id: next-execution/surface-work-v3-optimization-v1-phase1-implementation-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 优化 Phase 1：连续域、LOD lineage 与局部摘要发布

日期：2026-10-03。Phase 0 提交：`3c0113d8`。范围是本阶段的数据生产、发布和生命周期；采样调度在 Phase 2，缓存和重工作在后续阶段，本页不作整帧性能结论。

## 实际实现

### 连续域与独立字段

`SurfaceContinuity.ts` 和 Native/WASM 共用的 `SurfaceMetadata.h` 使用 position 反向流形边构建几何域；UV0、UV1、normal、tangent、color 分别检查端点连续性。几何不再受全顶点字节相等约束。不同材质阻止字段域混用，普通资产的几何连接仍可保留；Product 按自身材质 domain 分作用域。

退化与非流形是身份风险；UV singular、normal/tangent 非法以及字段 LOD-local 状态各自编码。two-sided 继续由 meshlet/group flags 表示，不写 domain0。镜像 UV 仅分裂该 UV chart。风险不再“任意一个非零 → 整个 domain0”。

新的 primitive metadata 为64 B：六个domain、identity/field risk、normal/color variation、两组UV span、position/attribute error。fieldRisk bits16–21表示逐字段LOD-local，bits24–31编码上取整的tangent角锥；两者不混用。此布局是本轮实际源代码布局，不表示最终整链ABI已验收。

### LOD 继承

Product 的 meshlet 保留每triangle metadata；输入三角形到优化后meshlet按有向循环索引键逐项转移，重复三角形使用有界列表依次消费，失配明确失败。SimplifyGroup收集实际输入角点lineage，随完整记录weld、UV orientation split、simplify结果、tangent regeneration和compact remap转移。

新triangle逐字段求三个角点lineage交集：唯一来源继承；无法继承时仅该字段使用新LOD-local域，保留能继承的几何与其他字段。新的局部域使用单独推进的命名空间，不与下一个material domain的源域重号。position error累计继承误差与当前简化误差；attribute error包含更新、normal修正与tangent再生成。

普通Geometry的coarse index LOD使用原source vertices。`GeometrySurfacePublication.ts` 依据原triangle身份或角点交集继承字段域，未对应字段使用LOD-local域；按真实cluster/representation统计当前bounds。

### 真正发布资源

- 普通Geometry：GpuAssetStore在同一residency plan追加64 B/primitive metadata，纳入真实upload、增长预算、rollback与retirement；GPU Geometry ABI9的meshlet record为128 B，独立发布primitive identity offset、metadata offset与version。
- Product：GeometryCooker序列化64 B records，group bit7表示continuity-v2，沿已有256 KiB页和Product residency进入GPU；bit6-only旧metadata明确要求recook。CPU admission检查格式关系，GPU group flags mask同步更新。
- recipe变为`static-pbr-page-local-f32-continuity-v6`，Native与WASM使用同一源代码；单线程和pthread artifacts均重新构建并替换。没有保留第二解码路径。
- Surface后续classifier从现有geometry/texture publication读取；本阶段不假装已经改变SurfaceWork的winner equality gate。

### 局部纹理摘要

`texture/TextureLocalVariation.ts` 是设备无关min/max hierarchy、footprint query、normal-cone derivation及binary codec。每mip独立局部树；query覆盖bilinear halo、trilinear第二mip、repeat/mirror/clamp及完整由调用者提供的anisotropic support包围框。RGBA bounds可用于颜色、ORM通道、HDR/emissive以及normal的相关误差推导，不能直接证明任意非线性shader图的最终误差。

Texture package cooker v2.3优先为实际RGBA8 encoded variant生成binary摘要chunk；selected variant验证并解析，residency直接发布值。sRGB离线bounds包含一个8-bit quantum的保守解码精度余量，不宣称硬件转换精确等于ideal pow。摘要是CPU metadata输入，GPU容量由共享variation pool单独计账，避免假称每个texture layer都另分一份摘要显存。

压缩variant没有可验证CPU decoder或旧package没有摘要时，`TextureVariationResidency`直接用GPU textureLoad读取实际驻留格式的解码值；不借用未压缩source的范围。该步骤在TextureResidency初次发布或mip promotion中，使用原caller encoder，没有独立production submit。

Pool最多32 MiB，含descriptor table、mip/level tables和数值payload。有限块大小4/8/16/32/64调整摘要粒度；满池使有关字段摘要未知并局部细率，不丢着色、不增加无限容量，也不把整张8K纹理交给一个超长workgroup。descriptor带generation/revision/residentMip；unmapped mip不能作为有效摘要。

onFinished才提交CPU owner状态；abort归还新预约、保持旧版本；正确generation在GPU completion之后retire。双producer、pending retire、跨generation复用明确拒绝；pipeline创建失败释放pool和账本。TextureResidency evidence暴露实际pool bytes/节点/降级/拒绝/离线发布计数。

## 阶段检查与真实限制

本阶段按用户要求做定向检查，整个Surface矩阵仍在Phase7。

- 全工程typecheck、test编译与engine build；Native cooker、共用C++ ABI oracle；单线程与pthread WASM编译。
- 定向CPU检查覆盖跨primitive连通、各字段seam、不同物体/重复面、镜像UV、源/LOD继承、真实GPU ABI offset、mip/wrap/footprint、binary/package roundtrip与publication生命周期。
- 实际单线程WASM执行检查包含continuity-v2 metadata、双面不清域、UV0独立域、coarse LOD真实减面、canonical windows、descriptor/页生产与重复读取。
- GPU oracle使用生产TextureVariationResidency与其WGSL；NPOT、offline upload、显式sRGB解码、硬件sRGB和BC1解码5个case、58个hierarchy nodes通过；API errors和device loss为零。显式sRGB最大差约1.79e-7，其余与实际输入参考一致。

最初将硬件sRGB与理想CPU公式直接比较失败，随后用独立逐texel GPU consumer读取实际decoded输入再做CPU hierarchy reference；没有靠放宽阈值掩盖错误。Dawn宿主仍输出D3D12 adapter/cache-blob诊断，这些日志保留，不推断其根因或用组件结果证明浏览器整帧性能。

Native build第一次因vendor工作树CRLF与固定upstream LF hashes不匹配失败；核对22个文件的LF内容全部与固定SHA相符后，只恢复工作树LF，不修改vendor算法或绕过hash验证。

未运行整帧Showcase/截图、移动相机画质、GPU P50/P95、新旧性能对照或pthread浏览器初始化矩阵。当前仍有旧classifier和dense Surface产品，按Phase2–5删除；本阶段GPU oracle不证明它们已切换，不提升V3性能或完整上游adoption状态。
