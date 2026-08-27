# R2-B-01 · meshoptimizer 1.0.0 direct dependency

## Reference

- Reference ID：`R2-B-01-MESHOPT-NPM`
- upstream project：meshoptimizer
- repository URL：https://github.com/zeux/meshoptimizer
- locked tag：`v1.0`
- locked commit：`73583c335e541c139821d0de2bf5f12960a04941`
- npm package：`meshoptimizer@1.0.0`
- npm integrity：`sha512-xsmHsLUFiImOMBwFUqXLqYniaA5rJPZYhgJvyuBsk3cfMWJi8S3BPLkvU2KvYciAV3dwrON20GiiwQJ9eTO/uA==`
- license：MIT；依赖包保留 `LICENSE.md` 与源码 notice
- verified on：2026-08-27
- decision：`direct dependency`

## 固定源码与测试

- Clusterizer/WASM wrapper：npm package `meshopt_clusterizer.js`
- Type contract：npm package `meshopt_clusterizer.d.ts`
- Upstream regression：npm package `meshopt_clusterizer.test.js`
- package source SHA-256：`8c6aa9c1ab5b19e6654d448b047a4186541b7c39a3aa5717973a76cec22221a3`
- package license SHA-256：`e4a26033e3551fb2722888949fbb41e77aee628e8e8f04dcffeee301aa7e5634`
- local dependency lock：`OEngine/package.json` 与 `OEngine/package-lock.json`

上游文件明确标注“Built from meshoptimizer 1.0”并保留 MIT copyright。OEngine 不再把 provenance 无法证明的 `src/geometry/meshoptimizer.ts` 用于新 package；旧文件只服务尚未迁移的 legacy `niMeshlets`，删除截止点是 R2-B-06/R2-D。

## 采用 API 与不变量

- `MeshoptClusterizer.ready`：异步初始化同一份浏览器/Node WASM；
- `buildMeshlets()`：输入 triangle-list `Uint32Array`、`Float32Array` position、stride 与 recipe limits；
- `extractMeshlet()`：只读取每个 Meshlet 的精确 vertex/triangle range；
- `computeMeshletBounds()`：取得上游 sphere/cone，随后由 OEngine conservative validator 验证并编码。

保留：每个 Meshlet 的 unique vertex/triangle limits、local triangle index、全局 vertex index、winding、bounds/cone 语义。OEngine 按 material range 分批调用，禁止 alpha mode、double-sided 或 material ID 跨 Meshlet 边界。

OEngine recipe 额外要求 `meshletMaxVertices >= 3`：上游 JS boundary 接受更小值，但 triangle-list 无法由不足 3 个 unique vertex 的 Meshlet 表达，因此在调用外部算法前拒绝。

## OEngine 差异

- 不序列化上游 `meshopt_Meshlet` struct、WASM heap offset 或 raw aggregate buffer；
- npm wrapper 的 aggregate triangle allocation 可能包含未使用尾部，OEngine 只通过 `extractMeshlet()` 取得精确 range，再紧凑写入自己的 sections；
- 新 ABI 是 `GeometryDirectory`、`MeshletRecords`、`MeshletVertexIndices`、`MeshletTriangleIndices`，不复用旧 `niMeshlets` header；
- 上游 bounds 发生非有限值时显式 warning 并退回保守 AABB sphere；序列化 radius 至少覆盖所有 Meshlet vertex；
- runtime `openGeometryAssetPackage()` 只验证 sections，不调用 meshoptimizer；
- Cooker 不依赖 WebGPU、Renderer、GPU Buffer 或 Node-only crypto。

## 性能假设与验证

- 减少：runtime 重复 Meshlet build 与 legacy object/header construction；
- 增加：离线 WASM build、source/recipe SHA-256、package reopen validator；
- R2-B-01 记录 Meshlet count、payload/package bytes 和 32/64、64/64、64/128 variant；
- R2-C 才记录 residency/upload，R3 才用 GPU counter/timestamp证明 traversal/raster 收益；本任务不伪造 GPU 性能提升。

## Failure / fallback

- WebAssembly 不可用、WASM 初始化失败、输出为空/越界或 bounds 无法保守化：Cook 失败，不在 runtime 静默重建；
- degenerate/non-manifold 按 recipe warning/reject；
- package reopen 或 Geometry cross-section validator 失败：不返回 `CookResult`；
- npm version/integrity、固定 commit 或许可证变化：必须显式更新 ledger、recipe identity 与黄金 hash。

## 本地验证

- 上游 `meshopt_clusterizer.test.js`：4/4；
- OEngine 完整 `npm test`：97/97；独立 production build 通过；
- OEngine `geometry-meshlet-cooker.test.mjs`：deterministic rebuild、triangle coverage、material boundary、degenerate warning/reject、bounds/cone、validly rehashed corruption；
- 根目录 `examples/r2-meshlet-cooker`：production build 已通过；本机 Edge 页面截图显示 `PASS`、512 triangles、13/8/6 Meshlets 与 byte-identical rebuild。应用内 Browser runtime 初始化失败，备用验证未采集 console 日志，因此 console 不登记为通过证据。
