# ADR-0016: Runtime-first 虚拟化资产

Status: accepted

## Context

OEngine 的 Web 产品入口需要继续保持 `load("scene.glb")` / `load("scene.gltf")`，并在浏览器内尽快产生首个可绘制结果。把 Native Offline Cooker 和完整预处理文件设为唯一入口，会把部署、迭代和动态内容都绑定到离线流水线；反过来，让 Web Cooker、OEGPACK loader 各自拥有 residency 和 renderer 又会形成两套长期生产路径。

现有 native cooker、OEGPACK V3 parser、bootstrap residency proof 和唯一 GPU-driven 渲染主管线提供了可复用基础，但尚不存在 Web Runtime Cooker、生产级 page residency、GPU demand 闭环或 Geometry Product 的生产者无关合同。

## Decision

采用 Runtime-first 双 Producer、单 Runtime 架构：

- Web 主路线为 `GLB/glTF -> Web Runtime Cooker（WASM + Worker）-> Geometry Product`。Cooker 以有界任务和背压渐进产生完整可验证的 product revision，边 Cook 边向 Runtime 提供可绘制结果，而不是先写出完整文件。
- Offline 第二路线为 `GLB/glTF -> 独立 Native/C++ Cooker -> OEGPACK -> Geometry Product adapter`。它可以使用更高预算、不同算法和全局优化，服务预发布、弱客户端与稳定 CDN 分发。
- 两个 Cooker 不要求共用源码、内部 DAG、Group/Page 划分或字节结果；统一点是版本化、生产者无关的 Geometry Product 合同，以及其后的 admission、Geometry Residency、GPU hierarchy/work、VisibilityKey、Sparse Shading 和唯一 `MainRenderPipeline`。
- 第一版 Geometry Product runtime profile 与 OEGPACK V3 decoded profile 兼容，以复用现有 GPU 数据布局和 consumer；OEGPACK 文件 offset、压缩块和 metadata prefix hash 不进入 Web Cooker 内部合同。
- 已发布 revision 内的 hierarchy、Group、Page identity 不可变。快速 bootstrap 是独立且完整可绘制的 revision；后续 refinement 通过已冻结 identity 的 page 补齐，或通过新 revision 的完整准入和原子替换完成。
- `ProductID + revision` 是 GroupID/PageID 的作用域。Web 与 Offline 产物不得按局部 ID 混拼；新 revision 只有在合法 activation cut 已 resident 后才能切换，旧 revision 在提交安全边界后退休。
- Web cache、OPFS、GPU decompression、Virtual Texturing 和 microtriangle software raster 均不是 correctness 基线；只有证据证明必要时再独立引入。
- Nyx 是本架构的算法移植来源。Web 与 Native 不要求共用源码，但 Meshlet/Group/LOD simplification、hierarchy/DAG、page streaming、resident fallback 和 meshlet-local visibility 必须从用户提供的本地 Nyx 只读快照源函数/Shader 逐项移植；不得用自研简化算法、只保留概念或删除中间阶段。允许变化的仅是 WASM/WGSL/WebGPU 资源、I/O、地址表示和生命周期适配。

本决策由四个子决策细化：A 管理 Offline Cooker/OEGPACK；B 管理生产者无关的 admission/residency；C 管理唯一 renderer 的消费与切换；D 区分纹理网络渐进与真实物理 residency。

## Consequences

Runtime Asset 与 GPU resource owner 继续分离。Loader、Worker、WASM heap、source range 和 cache record 都不能持有长期 GPU 资源。Web Cooker 需要独立的 session 协议、全局线程/内存预算、Transferable block credit、取消和 Worker failure 语义；GPU 对象不跨 Cooker Worker 传递。

Runtime-first 不等于无界在线处理，也不承诺所有输入都能立即出图。大单 primitive、低性能 CPU、无合适浏览器部署能力或极低首帧目标仍可选择 Offline 路线。两条输入路线只能在 Geometry Product admission 之前分叉，不能分叉渲染器。

精确跨 owner 合同进入 [Geometry Product V1](../specs/geometry-product-v1.md) 与 [Virtual Geometry Runtime V1](../specs/virtual-geometry-runtime-v1.md)；Nyx provenance、函数映射和反简化门禁进入 [0016 implementation](../implementation/0016-virtualized-assets.md)。研究母稿不再承担权威合同。

## Verification

必须在真实浏览器分别证明 Web GLB 主路线和 Offline OEGPACK 路线进入同一 Geometry Product admission，并共享同一 hierarchy/work/visibility/shading consumer。每条 Nyx 移植切片都要提交本地快照路径、源文件 SHA-256、函数/entry-point 映射、保留不变量、WebGPU 差异、license/notice 和 CPU/WASM/WGSL differential oracle；只通过 TypeScript unit test 或只移植 OEGPACK writer 不算完成。每条可运行切片还要覆盖预算、backpressure、容量/overflow、取消、失败、revision 替换、device loss 和 feature-off；性能结论必须按 [VALIDATION](../VALIDATION.md) 固定 workload 对比 source、cook、upload、首个有意义帧与稳定帧成本。
