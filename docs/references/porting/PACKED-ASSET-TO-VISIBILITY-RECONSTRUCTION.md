# Packed Asset 到 Visibility 重构移植登记

Reference ID: `PACKED-ASSET-TO-VISIBILITY-RECONSTRUCTION`

Status: in progress

对应实施设计：[12-packed-asset-to-surface-reconstruction](../../implementation/12-packed-asset-to-surface-reconstruction.md)。本登记只覆盖第一步 `Packed glTF → VisibilityKey/Reverse-Z`，不把第二步 Material Resolve/Surface 的计划冒充已完成移植。

## 采用矩阵

| 能力 | 上游 | 固定版本 | 许可证 | 状态 |
|---|---|---|---|---|
| glTF scene/mesh/primitive normalize | Khronos glTF 2.0 | 2.0 specification | CC-BY-4.0（规格） | 按规格独立实现 |
| vertex/index/meshlet cooker | meshoptimizer | `73583c335e541c139821d0de2bf5f12960a04941` / v1.0 | MIT | direct dependency，沿用现有 Cooker |
| hierarchy/SSE/cone/HZB | Bevy、Niagara、meshoptimizer | 见 `R3-01` | MIT / Apache-2.0 | 已有可追溯移植，保留 |
| exact triangle filter/compact | The Forge | `cd5046893faba2dc7869243873bf01f02a6f0df9` | Apache-2.0；相关 AMD block 保留其 MIT notice | 可追溯局部移植，进行中 |
| KTX2 container | Khronos KTX-Software | 第一批生产接入前冻结 tag/commit | Apache-2.0 | 待采用；禁止无来源自制解析器 |
| Basis Universal payload/transcode | BinomialLLC basis_universal | 第一批生产接入前冻结 tag/commit | Apache-2.0 | 待采用；禁止把 RGBA8 数组扩容冒充压缩驻留 |
| residency transaction/lifetime | AnKi / O3DE / Bevy 可验证 owner 结构 | 第一批 owner 移植前逐项冻结 | BSD-3-Clause / Apache-2.0 / MIT OR Apache-2.0 | 移植不变量，WebGPU owner 独立实现 |

## The Forge triangle filtering

```text
upstream repository: https://github.com/ConfettiFX/The-Forge
commit: cd5046893faba2dc7869243873bf01f02a6f0df9
source:
  Common_3/Renderer/VisibilityBuffer/Shaders/FSL/TriangleFiltering.h.fsl
  Examples_3/Visibility_Buffer/src/Shaders/FSL/TriangleFiltering.comp.fsl
license:
  Apache-2.0 project license
  TriangleFiltering.h.fsl 中标识的 AMD MIT notice 必须随表达性移植保留
decision: port（triangle classification/compaction invariants）
```

保留的不变量：

- homogeneous clip-space orientation/degenerate classification；
- near-plane crossing conservative handling；
- screen-frustum bounding classification；
- 23.8 fixed-point/MSAA-aware small-primitive test；
- workgroup local compaction、单次 global reservation、连续写入；
- 输入 index/bounds 验证和输出容量检查。

OEngine/WebGPU 差异：

- 输入不是上游 draw/mesh batch，而是 OEngine `SelectedCluster` 展开的 exact candidate `RasterWork`；
- 输出仍叫 `RasterWork`，一个 record 精确对应一个 triangle；
- 不采用 native MDI、descriptor indexing、wave intrinsic、64-bit atomic 或 buffer address；
- OPAQUE/MASK 是同一 producer 的有界语义分类，不按材质创建队列或 draw；
- `VisibilityKey` 等于最终 RasterWork slot；不复制 Vulkan/D3D command model；
- mirrored、double-sided、WebGPU clip range、viewport orientation和 reverse-Z 必须先由 CPU/GPU oracle 冻结；不能为了减少 work 猜测符号。

失败与 fallback：manifest/preparation 在编码前证明 worst-case capacity；生产 queue 不允许截断。运行时若仍发生 overflow，frame 标记 corruption/fail-visible，不能用部分 compact 结果冒充完整画面。

本地回归目标：CPU reference vectors、TS/WGSL ABI、degenerate/backface/frustum/near/small-primitive、mirrored/double-sided、OPAQUE/MASK、capacity/overflow、exact drawIndirect、debug lookup、Dungeon 与 dense Gate。

## glTF normalize / static merge / true instancing

按 glTF 2.0 规格独立实现，不复制 three.js Loader 运行时代码。当前迁移必须保留：accessor/index/attribute validation、node world transform、material alpha/double-sided 分类、共享 mesh 的 true instancing、compatible primitive merge 与 source provenance。three.js 只作为本地行为对照，不是运行时依赖或代码所有权来源。

## KTX2 / Basis 与纹理驻留

状态仍为 `待采用`。在固定 KTX-Software 与 basis_universal 版本、编译方式、目标格式 profile、worker/WASM 生命周期、许可证和测试向量前，不允许删除来源纹理路径并声称“4K 压缩驻留已完成”。第一步最终 Gate 必须证明 compatible block payload 直接上传到 BC/ETC2/ASTC bank，没有先生成等尺寸 RGBA8 GPU source 再 render-copy。

## 性能假设

- static merge/true instancing 降低 package、allocation、upload 和 root 数；
- scene transaction 把约 806 次 geometry command/await 收敛为一个 cold-load command/submit；
- exact filter 删除固定 `meshlet × 128 triangles` 的无效顶点提交；
- OPAQUE position-only visibility 不绑定完整 material/texture，MASK 单独支付 alpha 成本；
- KTX2/Basis 目标是降低 source/staging/resident bytes，而不是仅换文件扩展名。

最终结论只能由同条件 paired artifact 给出；本登记不预先宣称预算已达到。
