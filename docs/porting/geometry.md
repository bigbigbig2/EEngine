# Geometry

## GEO-NYX-OEG3 · Nyx Native Geometry Cooker / Runtime Page ABI

- Local owner/source: `OEngine/tools/oengine-asset-core/`、`OEngine/src/assets/GeometryAbiV3.ts`、`OEngine/src/assets/OegPackV3.ts`、`OEngine/src/gpu/GeometryBootstrapResidencyV3.ts`、`OEngine/src/shaders/oegpack_v3_decode.ts`。
- Upstream: 用户提供的仓库外本地只读 Nyx 源码；声明身份 `moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`。本次实现未从网络获取源码。
- Verified source identity: `MeshletBuilder.cpp` SHA-256 `b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a`；`ModelConvert.cpp` `8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059`；`MeshletStructs.h` `1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23`；`DAGCull.slang` `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e`。CMake 与 `tools/build-native-cooker.mjs` 在每次构建前都强制复核这些 hash。
- Upstream source: `MiniEngine/Model/MeshletBuilder.cpp`、`MiniEngine/Model/ModelConvert.cpp`、`MiniEngine/Model/MeshletStructs.h`、`MiniEngine/Model/Shaders/DAGCull.slang`，以及本地 bundled `cgltf`、`meshoptimizer`、`lz4`。
- License: Nyx/MiniEngine MIT（Microsoft）；meshoptimizer MIT（Arseny Kapoulkine）；cgltf MIT（Johannes Kuhlmann）；LZ4 BSD-2-Clause（Yann Collet）。完整文本见 `OEngine/tools/oengine-asset-core/THIRD_PARTY_NOTICES.md`。
- Adoption: 可追溯局部移植。直接编译本地 Nyx bundled meshoptimizer 0.25、cgltf 和 LZ4；Group/DAG/Hierarchy/Page 算法按 Nyx 不变量移植到 OEngine 独立 V3 ABI，不把 Nyx runtime 作为 OEngine 运行时依赖。
- Retained invariants: material-domain 边界；position-remap topology；同 LOD `partitionClusters`；跨 Group seam lock；`simplifyWithAttributes` 与带显式标志的 sloppy fallback；coarse meshlet `refineGroupId`；propagated parent error；每 LOD BVH8 加 top BVH；coarse/bootstrap 优先；固定 256 KiB decoded page；LZ4/raw 独立页；常驻 metadata；page-local vertex/index payload。
- OEngine/WebGPU differences: 48 B hierarchy、64 B GroupHeader、48 B MeshletHeader 和 16 B GroupDirectory 是 OEngine `OEGPACK V3.0` 的显式 little-endian ABI；disk offset 使用 u64，GPU address 使用 bank/slot u32；128 MiB bank/512 slots；当前 bootstrap owner 不实现 ADR-0016-B 的 demand scheduler/eviction/feedback。
- Fallback/lifecycle: attribute-aware simplification未达到冻结比率时仅在 recipe 允许时使用 `meshopt_simplifySloppy`，并设置 `kGroupSimplificationFallback`、放大 error、计数；不做隐藏的 source-vertex runtime fallback。bootstrap owner 失败时销毁全部 bank，显式 `destroy()` 释放 GPUBuffer。
- Local validation: C++ struct/offset `static_assert`、不同线程数 byte-identical golden、native/TS reopen、CRC/hash、DAG/bootstrap、page independence、corruption、Chrome WGSL raw-record decode/readback 与 medium-scene diagnostic cook。格式冻结还需要 [OEGPACK V3 spec](../specs/oegpack-v3.md) 规定的真实生产 Visibility consumer。

## GEO-NYX-VIRTUAL-RUNTIME · Product V1 hierarchy/address consumer（移植中）

- Local owner/source: `OEngine/src/gpu/GeometryProductGpuAbiV1.ts`、`VirtualGeometryResidency.ts`、`OEngine/src/shaders/virtual_geometry_product.ts`、`hierarchical_work_generation.ts`、`OEngine/src/render/HierarchicalWorkGenerator.ts`。尚未接通 `MeshletWorkCandidate`、bucket raster、VisibilityKey 和 Sparse Shading，因此不是 production candidate。
- Upstream: 本地 `D:\Nyx-main` 快照，无可验证 `.git` metadata；声明 commit 仅作线索。2026-09-16 复核 `MiniEngine/Model/Shaders/DAGCull.slang` SHA-256 `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e`、`VBufferMesh.slang` `9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d`、`GeometryStreaming.cpp` `acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072`；其余源文件/hash 见 [0016](../implementation/0016-virtualized-assets.md#nyx-移植工作流强制)。
- License/adoption: Nyx/MiniEngine MIT，notice 见 `OEngine/tools/oengine-asset-core/THIRD_PARTY_NOTICES.md`；可追溯局部移植，不直接依赖 DX12 runtime。
- Function map（当前已实现的部分）：`MeshletStructs.h::HierarchyNode`、`GroupHeader`、`MeshletHeader`、`GroupDataLocation` → V3 decoded profile、Product heap 的 bounds/error/Group/page/bank-slot-generation 解码；`DAGCull.slang::ProcessNodeBatch` 的 root seeding、BVH8 internal child wavefront、leaf bounds/HZB/SSE 与 resident check → `HierarchicalWorkGenerator` 的 Product-specialized root/traversal；`GeometryStreaming::PinRootPages` 与 `SyncMemoryAndAddressTable` 的 pinned activation 和映射 → `VirtualGeometryResidency`。输入为 Product descriptor、instance geometry slot/generation、resident page；输出仍是现有 GPU traversal/VisibleCluster queue，不让 CPU 构造最终可见列表。
- Retained invariants: V3 48/64/48-byte record、24-bit GroupID、7-bit local MeshletID、BVH8、原始 parent error、独立 Page hash、generation-before-bank-read、有界全有或全无队列、上一帧 HZB fail-open；Product metadata 仅一只 storage binding，避免超过 WebGPU 10 storage buffers/stage 基线。
- WebGPU differences: Nyx bindless GPU address 改为 Product heap 和最多 4 个 128 MiB storage bank；Slang wave/global atomics 改为现有 64-lane WGSL workgroup/ping-pong indirect rounds、32-bit CAS reservation；Group request mask 与延迟 page demand 尚未接入，不能把当前 leaf skip 说成 ancestor fallback。
- Fallback/lifecycle: root queue overflow 不编造不可渲染 parent；无效 Product generation/node/location fail closed；实际 resident ancestor/refine meshlet 抑制、需求写入、提交安全的替换/驱逐尚未完成，S1/S4 不得验收。
- Validation: CPU metadata heap/record/generation/section negative oracle、非零 ProductTableSlot admission/rollback、V3 native golden；尚缺该 WGSL 的真实浏览器编译/readback、Nyx DAG 与 VBuffer differential corpus、Visibility screenshot、相同 workload GPU 性能证据。后续补齐 `ProcessMeshletBatch`、`computeMain`、`VBufferMesh::BuildVertexOutput/meshMain/pixelMain` 与 `GeometryStreaming::Update/EnqueueAsyncLoad/OnPageIOComplete/ImmediateEvict` 的逐函数对照。

## GEO-MESHOPT · meshoptimizer Cooker

- Local owner/source: `OEngine/src/assets/GeometryAssetPackage.ts`、`OEngine/src/geometry/GeometryCooker.ts` 与 `meshoptimizer@1.0.0`。
- Upstream: <https://github.com/zeux/meshoptimizer>
- Revision: tag `v1.0`, commit `73583c335e541c139821d0de2bf5f12960a04941`；npm integrity `sha512-xsmHsLUFiImOMBwFUqXLqYniaA5rJPZYhgJvyuBsk3cfMWJi8S3BPLkvU2KvYciAV3dwrON20GiiwQJ9eTO/uA==`。
- Upstream source: `meshopt_clusterizer.js`、`meshopt_clusterizer.d.ts`、`meshopt_clusterizer.test.js`。
- License: MIT；包内 `LICENSE.md` 和源码 notice 必须保留。
- Adoption: direct dependency。
- Retained invariants: triangle-list 输入、Meshlet vertex/triangle limits、local/global index、winding、sphere/cone bounds；material/alpha/double-sided 不跨 Meshlet。
- OEngine/WebGPU differences: Cooker 只提取精确 range 并写 Runtime Package V2，不序列化 WASM heap/上游 struct；默认 `static-pbr-compact-v2` 的 position/normal/tangent/UV/color pack 与共享 WGSL decode 是 OEngine 独立 ABI，meshoptimizer 仍只负责 meshlet/simplification；position quantization error 被扩入 meshlet/cluster bounds。超过 512 triangles 的 hierarchy node 使用保守 sphere 并关闭 cone。
- Fallback/lifecycle: 非有限 bounds 回退到保守 AABB sphere；版本、integrity 或 license 改变必须更新 recipe identity。
- Local validation: package reopen/determinism、compact/fallback byte comparison、position/normal/UV 数值 oracle、conservative bounds、真实 Chrome Visibility/Shadow/Material consumer 和上游 clusterizer regression。

## GEO-HIERARCHY · Bevy Meshlet hierarchy/SSE

- Local owner/source: `OEngine/src/geometry/GeometryHierarchy.ts`、hierarchical work-generation CPU oracle。
- Upstream: <https://github.com/bevyengine/bevy>
- Revision: `5f8270f2e049f90139a503d1e930070d926f9427`。
- Upstream source: `crates/bevy_pbr/src/meshlet/cull_instances.wgsl`、`cull_bvh.wgsl`、`cull_clusters.wgsl`、`meshlet_cull_shared.wgsl`、`fill_counts.wgsl`。
- License: MIT OR Apache-2.0；OEngine 采用 MIT 路径并保留必要 notice。
- Adoption: traceable local port of scheduling and math invariants。
- Retained invariants: instance-to-root staging、perspective/orthographic SSE、conservative world scale、nearest sphere distance、wavefront indirect scheduling、fail-open culling。
- OEngine/WebGPU differences: 使用 OEngine Cluster hierarchy/BVH8、32-bit index、有界 queue 和 all-or-nothing child reservation；不采用 Bevy ECS、native render graph、push constants、subgroup 或 64-bit atomic。
- Fallback/lifecycle: reservation 失败渲染可绘制 parent；projection/HZB 不确定时 fail open。
- Local validation: `geometry-hierarchy.test.mjs`、`gpu-work-generation.test.mjs` 与 WGSL/CPU SSE 对照。

## GEO-CONTROLS · Orbit camera controls

- Local owner/source: `OEngine/src/camera/OrbitControls.ts`。
- Upstream: <https://github.com/mrdoob/three.js>
- Revision: `7cda7e710d884827fc73ff1a3aa63270846513d7`。
- Upstream source: `examples/jsm/controls/OrbitControls.js`。
- License: MIT，copyright three.js authors；本地源码 header 保留 notice。
- Adoption: traceable local port of interaction semantics; no runtime dependency。
- Retained invariants: target orbit、polar/azimuth/distance limits、rotate/dolly/pan、damping、events 和 explicit dispose。
- OEngine/WebGPU differences: 使用 OEngine Vec3/Transform3D 和 +Z camera convention；不会把 three.js 对象带入渲染热路径。
- Fallback/lifecycle: input 只累计 delta；`dispose()` 移除事件；无 GPU allocation。
- Local validation: controls unit tests；浏览器交互 Gate 等待 ADR-0014 的独立 `validation/` 宿主。
