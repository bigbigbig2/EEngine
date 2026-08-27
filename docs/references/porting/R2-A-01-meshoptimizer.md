# R2-A-01 · meshoptimizer Cooker 依赖登记

## Reference

- Reference ID：`R2-A-01-MESHOPT`
- upstream project：meshoptimizer
- repository URL：https://github.com/zeux/meshoptimizer
- locked tag：`v1.0`
- locked commit：`73583c335e541c139821d0de2bf5f12960a04941`
- verified on：2026-08-27
- license：MIT，采用或分发时保留上游 `LICENSE.md` notice
- maturity：生产项目使用的独立几何优化库

## 源码与测试

- Meshlet/cluster：`src/clusterizer.cpp`、`src/meshoptimizer.h`
- simplify/error：`src/simplifier.cpp`、`src/meshoptimizer.h`
- upstream regression：`demo/tests.cpp` 中的 `clusterBounds*`、`meshlets*`、simplifier tests
- OEngine 当前候选 seam：`OEngine/src/geometry/meshoptimizer.ts`

远端 tag/commit、上述源码路径和 MIT license 已通过固定 commit 的 Git remote/raw source 核验。当前 `meshoptimizer.ts` 是 reconstructed 内嵌 WASM wrapper，没有可证明的原始生成版本或保留 notice，因此不把它直接声明为 v1 package 的权威实现。R2-B 必须从本记录的固定上游重新生成/引入或证明 byte/API provenance。

## 算法范围与 ABI

- 输入：triangle-list `u32` indices、float position stream、vertex stride、Meshlet limits 和 cone weight。
- 预期输出：Meshlet vertex/triangle ranges、cluster bounds/cone、simplified indices 和 object-space error。
- OEngine package ABI 由 `GeometryAssetSchema` 冻结，不直接序列化 `meshopt_Meshlet`、C++ struct padding 或 WASM heap address。

## 保留不变量

- source index 必须在 vertex range 内；
- max vertices/triangles 是 recipe 输入并进入 content identity；
- Meshlet local indices 与 triangle count 不越界；
- bounds/cone 语义与固定上游版本一致；
- simplify error 只作为 Cooker 输入证据，还需 OEngine monotonic propagation 和 sampled/reference validator。

## OEngine 适配

- 只用于设备无关 Cooker，不把上游 allocator、线程或 native pointer 带入 runtime；
- R2 v1 默认评估 64 vertices / 128 triangles，同时保留 32/64、64/64 等离线 variant 数据；
- 输出重打包为 OEngine section/range ABI；GPU 只读取 `u32` index/word offset；
- Runtime package load 不再次调用 Meshlet/simplify build。

## 性能假设与验证

- 假设：离线 vertex locality、Meshlet build 与 simplify 能减少 runtime CPU 工作，并为 R3 展开前减量提供数据；
- R2-B 记录 Cook time、source/package/resident bytes、Meshlet/Cluster 数、triangle 利用率和不同 limits variant；
- R3 才验证 traversal/raster GPU 收益，不能以库成熟度替代 OEngine A/B/C benchmark。

## Fallback / failure

- WASM/工具不可用、输入越界或生成结果不通过 validator：Cook 失败，不在 runtime 静默重建；
- simplify/error 无法验证：输出显式 single-level asset；
- 许可证 notice/provenance 不完整：拒绝把现有 embedded wrapper用于 package v1。

## 本地验证与决定

- R2-A：SourceGeometry/package kernel tests，不执行 Meshlet 算法；
- R2-B：上游统计对照、黄金资产、deterministic package、CPU selector/validator；
- decision：`adopt` 固定上游算法能力；R2-B-01 已选择 `meshoptimizer@1.0.0` direct dependency，精确包、integrity、文件 hash、API 和 OEngine 差异见 [R2-B-01 ledger](./R2-B-01-meshoptimizer-package.md)；
- reason：避免重新实现成熟的 Meshlet、bounds/cone 和 simplification 基础算法，同时保持 OEngine 自有 package/GPU ABI。
