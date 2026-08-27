# R2-B-06 · Runtime build 删除准备矩阵

## 目的与边界

本文冻结 R2-B 结束时新 Geometry package 与 legacy runtime build 的边界，供
R2-C/D 逐项迁移和删除。R2-B 不把 package 数据偷接到旧 GPU ABI，也不为了
“看起来集成”保留双写。

新路径只有两种入口：

```text
离线/浏览器程序化输入：SourceGeometry → cookGeometryAssetPackage() → bytes
浏览器 package load：bytes → openGeometryAssetPackage() → validated views
```

`openGeometryAssetPackage()` 位于 `src/assets`，只导入 Package Kernel；不导入
meshoptimizer、`GeometryCooker`、Renderer、GPUDevice 或 legacy `niMeshlets`。
它从最终 bytes 验证 Meshlet/Cluster/BVH8/stream/index/material 所有引用，失败时
在 GPU range 分配前拒绝。程序化 geometry 允许调用同一个 in-memory Cooker，
但 package reopen 绝不在缺 section 时偷偷重建。

## Legacy reader / consumer 迁移矩阵

| 当前 owner / 入口 | 当前 build/read 行为 | R2-C/D 目标 consumer | 删除条件 | 所属后续任务 |
|---|---|---|---|---|
| `geometry/BoxGeometry.ts` | constructor 调 `niFromGeometry(buildBoxMesh())` | `buildBoxSourceGeometry()` → in-memory Cooker → residency handle | Box 页面使用 package residency 且画面/counter 通过 | R2-C / R2-D |
| `loaders/gltf/gltfGeometry.ts` | 已先生成 `SourceGeometry`，随后仍调 legacy `niFromGeometry()` | importer 输出 source/package identity；runtime load 只 open + resident | A/B/C glTF 不再执行 Meshlet/BVH build | R2-C / R2-D |
| `loaders/usd/usdMesh.ts` | import 后直接 `niFromGeometry()` | USD normalize 到同一 `SourceGeometry` seam | USD fixture 通过新 Cooker/validator | R2-D |
| `loaders/shadeFormat.ts` | load 时 `rebuildBvhFromMeshlets()` | 版本化 Geometry package reader | 旧 shade asset 有明确 reject/re-cook 策略 | R2-D |
| `geometry/niMeshlets.ts` | legacy Meshlet、压缩 attribute、Dynamic BVH build 与旧 header 混合 | 无 runtime owner；算法由 Cooker/package schema 取代 | 下列所有 reader/consumer 迁移完成 | R2-D |
| `gpu/MeshletGpuTable.ts` | 读取 legacy `MeshletGeometryBase` 并持有 `GeometryBlasPool` | R2-C `GpuAssetStore` 已完成新纵切；R2-D 迁生产 consumer | 新 section ranges 已可上传、释放并复算 bytes；A/C/普通 Scene consumer 切换后删除旧 owner | R2-C / R2-D |
| `gpu/GeometryBlasPool.ts` | 上传 legacy 32 B Dynamic BVH node | 独立 Cluster/BVH8 GPU ranges | 新 owner/range 已验证；当前 BVH8 不进入 R3 v1，真实 legacy consumer 清空后删除旧 owner；LPV 不被误删 | R2-C / R3 |
| legacy Visibility readers/shaders | 读取旧 meshlet header/packed attr 地址 | 新 Meshlet/Cluster/stream table word index | R3 GPU producer → consumer 闭环通过 | R3 / R4 |

`gpu/DynamicBvh.ts` 还被 TLAS/LPV 使用，不能因为 Geometry BVH8 到位就整文件删除。
这里只删除 geometry 侧的 legacy owner；TLAS、光照探针与 ray-query 的生命周期由
各自 Context/阶段拥有。

## 静态禁止项

- `src/assets/GeometryAssetPackage.ts` 不得导入 `meshoptimizer`、`GeometryCooker`、
  `niMeshlets`、GPU 或 Renderer；
- 新 package load 不得调用 `buildMeshlets`、`simplify`、hierarchy build 或 BVH build；
- legacy Loader 不得同时上传旧 ABI 与新 ABI；迁移点必须一次切换并删除旧调用；
- package 缺失/corruption 只能拒绝或请求 re-cook，不得 runtime 修补；
- R2-C residency 只消费 validated section views，不重新解释 Loader 临时对象。

## R2-B 证据与未越界声明

- `examples/r2-geometry-package` 在浏览器执行一次 Cooker 后，将 bytes 交给纯
  `openGeometryAssetPackage()`；页面显示 package/hash/bytes/error 和 CPU selector
  报告，不创建 GPU 资源；
- Node 测试从重算 hash 的损坏 package 验证 cycle、orphan、非单调 error、BVH
  false negative、stream/index/material/position bounds corruption 全部被拒绝；
- A/B/C 真实 GPU residency、upload bytes 和 traversal counter 属于 R2-C/R3，
  R2-B 不把“新 package 尚未被 GPU 使用”伪装成完成的性能收益。

## R2-C 结果与 R2-D 接手清单

已完成：

1. 每类 Geometry section 已有 GPU range/stride/alignment、全局 range 重定位与 resident bytes 复算；
2. package validation、u32 range 和 adapter buffer/storage limit 在目标分配/提交前检查；
3. 新纵切由 `AssetHandle` + compact table 唯一持有 GPU residency，grow/abort/release 无私有 submit；
4. `r2-gpu-residency` 已通过完整黄金资产 package → Compute → Hardware `drawIndirect` live 页面和 JSON/readback 门禁；GPU roundtrip、画面、WebGPU validation、abort/release 与 `privateSubmitCount=0` 全部通过。

R2-D 已完成：

1. 冻结 Instance/Packed ABI，并让普通 Scene adapter 与 Packed source 写入同一 `GpuScene`；
2. 完成 1k/10k/100k bulk、0%/1%/10%/100% transform/material patch、stable-frame zero upload 与 Instance + Geometry Hardware consumer 画面/counter 证据。

R2-D/G2 收口结果：

1. A/B/C 和真实 Damaged Helmet glTF 已切到 SourceGeometry → Cooker → Package → `GpuAssetStore/GpuScene` → production Packed Visibility/Material/Velocity bindings；
2. Packed/package 主路径不创建等量 `Mesh/Node3D`，也不创建 legacy `MeshletGpuTable`；旧 owner 仅在 legacy Scene consumer 请求时惰性创建，因此不再双驻留同一 Packed 数据；
3. A/B/C smoke 与 C full 均确认 one-submit、真实 counter、画面和 WebGPU diagnostics；G2 已关闭。旧普通 Scene、阴影和透明 consumer 的类级删除随 R3/R4/R5 迁移完成。
