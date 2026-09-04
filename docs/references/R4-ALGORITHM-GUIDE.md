# OEngine R4 参考实现与算法研究指南

Status: research guide

本文件只负责回答“R4 应阅读、比较和复用哪些外部证据”。它不拥有任务状态、ABI 或 Gate；当前状态见 [STATUS](../implementation/STATUS.md)，长期决策见 [ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md)，正式采用记录见 [porting](./porting/README.md)。

## 已冻结方向

```text
R3 RasterWork
→ R4-A Hardware Visibility Contract
→ R4-B Single Material Resolve
→ R4-C optional Software/Hybrid profile optimization
```

- Hardware-first 是完整正确主链，Software Raster 不是 Material Resolve 的前置条件。
- HW/SW 共享 32 位 frame-local VisibilityKey、reverse-Z depth 和 Resolve lookup。
- Standard PBR 只扫描一次可见像素；不再按活跃材质数重复全屏。
- WebGPU baseline 不假设 64 位原子、buffer device address、mesh/task shader、multi-draw-indirect 或无限 bindless。
- 外部实现只能提供算法和工程证据；OEngine 的 ABI、owner、capacity、overflow、fallback 与 feature-off 语义由本仓库冻结。

## 证据等级

不再使用主观星级。每个来源按以下类别使用：

| 类别 | 可证明内容 | 不能单独证明 |
|---|---|---|
| official specification | API、格式、材质和语言语义 | 某种实现更快 |
| paper / mathematical authority | 算法、不变量、误差模型 | WebGPU 工程可用性 |
| production engine/sample | 完整 producer/consumer、资源与性能结构 | 可直接移植到 WebGPU |
| WebGPU implementation | WGSL/API 可行性、binding 和 dispatch 约束 | AAA 生产成熟度 |
| concept-only | 候选方向 | 可复制代码或完成证据 |

## R4-A · Hardware Visibility Contract

| 来源 | 固定用途 | 采用边界 |
|---|---|---|
| Burns & Hunt, *The Visibility Buffer* | frame-local primitive key、deferred attribute reconstruction | paper authority；不复制未明确授权的代码 |
| Timberdoodle `aa7f35483a9e312acb458d5a32ae9e0eea13c220` | Visibility lookup 与 material resolve 数据流 | Apache-2.0；只局部移植可追溯区段 |
| WebGPU/WGSL specification | fragment depth、pixel center、atomic 和 resource semantics | 规格权威；不能用 D3D 行为覆盖 WebGPU 未定义边界 |
| glTF 2.0 | alpha mode、cutoff、double-sided、UV/texture transform 语义 | 不定义 OEngine GPU record 或资源池 |
| OEngine R3 ledger | `VisibleCluster/RasterWork` 真实 ABI | 本地实现是 R4 lookup 的第一输入 |

R4-A 的关键本地决定不是照抄某个引擎，而是让 multi-Meshlet Cluster 可唯一回查：

```text
VisibilityKey
→ rasterWorkSlot + localTriangle
→ RasterWork[rasterWorkSlot]
→ visibleClusterSlot + meshletRecordIndex
→ VisibleCluster / Instance / Geometry / Material
```

v1 为 `7-bit localTriangle + 25-bit rasterWorkSlot`；整个 `0x01FFFFFF` slot 保留，`0xFFFFFFFF` 是 empty，避免合法 key 与 sentinel 相撞。

Alpha-tested Visibility 只提前建立 `MaterialVisibilityRecord` 逻辑子集；完整 Standard PBR record 与纹理 residency 仍由 R4-B 冻结。当前按材质 bucket 的 Alpha consumer 只是迁移对象，不是最终 GPU-driven 结构。

正式采用边界见 [R4-A ledger](./porting/R4-A-01-unified-visibility-contract.md)。

## R4-B · Single Material Resolve

| 来源 | 固定用途 | 采用边界 |
|---|---|---|
| OEngine R2-D-08 | barycentric、analytic gradient、normalized decode、mirrored/non-uniform tangent frame | 已验证本地实现，优先迁移而不是重写 |
| OEngine R2-D-09 | `previous_from_current`、singular fallback、velocity reference | 已验证本地实现，禁止恢复 per-pixel inverse |
| Filmic Worlds visibility-buffer article | 为什么跨三角形 implicit derivative 失效、解析梯度结构 | mathematical/engineering article；按公式和测试独立实现 |
| Schied et al., *Deferred Attribute Interpolation Shading* | deferred interpolation 与导数理论 | paper authority |
| The Forge `cd5046893faba2dc7869243873bf01f02a6f0df9` | single visible-pixel shading、triangle filtering、material/texture lookup | Apache-2.0；拒绝 Vulkan descriptor/MDI 假设 |
| Falcor `eb540f6748774680ce0039aaf3ac9279266ec521` | scene/material abstraction 与可验证 reference | NVIDIA BSD-style；拒绝 DXR/native bindless 假设 |
| glTF 2.0 | metallic-roughness、normal、occlusion、emissive、alpha 和扩展字段语义 | 不是完整 BRDF/IBL 数值权威 |
| Filament `bdd01e82539938db70c60259e4e6c17bc2bdaba4` | Standard PBR/IBL、颜色空间、normal convention 的生产参考 | 固定源码区段后才允许局部移植 |
| glTF Sample Viewer `f9fce9ee7bc62c5433d2a1bf84be229225c7bd19` | glTF 视觉与材质一致性 oracle | 以截图/数值对照为主，不自动决定 OEngine 架构 |
| three.js `7cda7e710d884827fc73ff1a3aa63270846513d7` | 两个 compute rasterizer 示例的最低垂直功能与性能基线 | 不是产品范围和性能上限 |

The Forge 所谓 texture arrays 更接近 native descriptor/resource array 策略，不能直接解释为 WebGPU `texture_2d_array` bank。R4-B 必须在真实 B/C 资产上比较有界 array-bank、atlas 或少量固定 binding 方案，并验证 resample、mip、padding、branch、resident bytes 和 adapter limits。

Shader Bin、Resolve/Lighting fusion 只有在通用 Resolve 的 profile 证明分支或带宽成为主瓶颈后才进入任务；不作为 R4-B v1 前置设计。

正式采用边界见 [R4-B ledger](./porting/R4-B-01-single-material-resolve.md)。

## R4-C · Software/Hybrid Raster

| 来源 | 固定用途 | 采用边界 |
|---|---|---|
| Pineda 1988 | edge function 与增量 raster 数学 | paper authority |
| Microsoft rasterizer rules | OEngine SW deterministic top-left 规则 | 不能宣称 exact-edge 上所有 WebGPU HW 后端归属相同 |
| Scthe/nanite-webgpu `b9cd33f65bb3cdba0464717e0fa621d330d2116f` | WebGPU SW/HW Pass、buffer/atomic/merge 工程参考 | MIT；拒绝低精度 packed depth 和 demo owner |
| MaskedOcclusionCulling `6cbbd7621cce670cf081a44272669e240300879e` | fixed-point coverage、边界和 CPU oracle 设计 | Apache-2.0；SIMD/native 表达需按 WebGPU 重做 |
| Nanite SIGGRAPH 2021 | micro-triangle classifier、HW/SW 分工概念 | concept/paper only；拒绝 64-bit/BDA/native command 假设 |
| WebGPU/WGSL specification | 32 位 atomic、depth/texture/attachment 和 pass semantics | 最终 API 语义权威 |

推荐 v1 是两阶段完整 `u32`：

```text
Stage 1: coverage + WebGPU-compatible viewport depth → atomicMax(depthBits)
Stage 2: same coverage/depth → equal winner depth → atomicMin(VisibilityKey)
```

两阶段共享同一 coverage/depth WGSL。`atomicMin(key)` 只承诺帧内执行顺序无关；若 `rasterWorkSlot` 每帧重排，不承诺跨帧 winner 身份稳定。

OEngine SW 可以采用 deterministic top-left rule，但 HW/SW 测试必须区分非边界 exact match 与 exact shared-edge 容许差异。边界允许 primitive owner 不同，不允许 coverage hole、非法重叠或最终 surface 不一致。

SW feature 开启的固定成本必须计入：两个 `u32` 原子屏幕缓冲约 `8 B/pixel`、clear、classifier、indirect、transfer/combine，以及写 `frag_depth` 对 early-depth 优化的限制。`feature off` 必须为零资源/零 Pass；`feature on + queue empty` 不能自动宣称零成本。

正式采用边界见 [R4-C ledger](./porting/R4-C-01-software-hybrid-raster.md)。

## 明确拒绝直接移植

- 64 位 atomic visibility payload。
- buffer device address、Vulkan/DX12 descriptor heap、MDI/DGC。
- 无界 bindless texture/material。
- Scthe 的低精度 packed depth。
- Nanite 的完整 material classification、streaming 和 native command model。
- Lighthugger 表达性代码：当前 GPL-3.0；“MIT available upon request” 在实际取得书面 MIT 授权前不构成可移植许可。
- 为了“架构完整”默认开启 Software Raster。

## 执行阅读顺序

1. 阅读 [ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md) 和 R3 ABI ledger。
2. 执行 R4-A：先冻结 Key/lookup 和 Hardware oracle，再迁移 alpha-tested。
3. 执行 R4-B：先迁移 R2-D-08/09 的已验证数学，再建立 Material/Texture GPU records，最后删除 Material Expand。
4. 执行 R4-C：先 CPU oracle 和离线小图，再接 SW queue/merge，最后用 A/B/C 决定默认 profile。
5. 每次复制或翻译表达性代码前，在对应 porting ledger 固定真实源码路径、测试路径和 retained notice。

## 研究项，不是当前承诺

- MSAA sample-level VisibilityKey。
- Resolve/Lighting fusion。
- 大量 Shader Bin 或通用材质图。
- Texture streaming / Virtual Texture。
- 64 位 Key 或跨帧持久 Visibility identity。
- Software Raster 覆盖 alpha、复杂 clip 和所有三角形。

这些项目只有新的正确性、WebGPU capability 或性能证据才能升级为实施任务。
