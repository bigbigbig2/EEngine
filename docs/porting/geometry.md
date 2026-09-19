# Geometry

## S6 consumer mapping (2026-09-19)

S6 changes only production ownership and entry topology; it does not replace or shorten the Nyx geometry stages. `load_gltf()` now reaches the Web Product Runtime, while `GeometryAssetPackage`/`GeometryCooker` symbols that remain in the tree are explicitly internal oracle/ABI/test consumers. The public entry audit and the browser replacement/device-loss cases prove the Product publication and recovery consumers; they do not claim that every retained oracle module is a production route or that the original DX12 byte layout is reproduced.

## GEO-NYX-OEG3 · Nyx Native Geometry Cooker / Runtime Page ABI

- Local owner/source: `OEngine/tools/oengine-asset-core/`、`OEngine/src/assets/GeometryAbiV3.ts`、`OEngine/src/assets/OegPackV3.ts`、`OEngine/src/assets/geometry-product/OegPackProductAsset.ts`、`OEngine/src/assets/geometry-product/OegPackSceneManifestV3.ts`、`OEngine/src/gpu/VirtualGeometryResidency.ts`、`OEngine/src/shaders/oegpack_v3_decode.ts`。
- Upstream: 用户提供的仓库外本地只读 Nyx 源码；声明身份 `moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`。本次实现未从网络获取源码。
- Verified source identity: `MeshletBuilder.cpp` SHA-256 `b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a`；`ModelConvert.cpp` `8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059`；`MeshletStructs.h` `1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23`；`DAGCull.slang` `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e`。CMake 与 `tools/build-native-cooker.mjs` 在每次构建前都强制复核这些 hash。
- Upstream source: `MiniEngine/Model/MeshletBuilder.cpp`、`MiniEngine/Model/ModelConvert.cpp`、`MiniEngine/Model/MeshletStructs.h`、`MiniEngine/Model/Shaders/DAGCull.slang`，以及本地 bundled `cgltf`、`meshoptimizer`、`lz4`。
- License: Nyx/MiniEngine MIT（Microsoft）；meshoptimizer MIT（Arseny Kapoulkine）；cgltf MIT（Johannes Kuhlmann）；LZ4 BSD-2-Clause（Yann Collet）。完整文本见 `OEngine/tools/oengine-asset-core/THIRD_PARTY_NOTICES.md`。
- Adoption: 可追溯局部移植。直接编译本地 Nyx bundled meshoptimizer 0.25、cgltf 和 LZ4；Group/DAG/Hierarchy/Page 算法按 Nyx 不变量移植到 OEngine 独立 V3 ABI，不把 Nyx runtime 作为 OEngine 运行时依赖。
- Retained invariants: material-domain 边界；position-remap topology；同 LOD `partitionClusters`；跨 Group seam lock；`simplifyWithAttributes` 与带显式标志的 sloppy fallback；coarse meshlet `refineGroupId`；propagated parent error；每 LOD BVH8 加 top BVH；coarse/bootstrap 优先；固定 256 KiB decoded page；LZ4/raw 独立页；常驻 metadata；page-local vertex/index payload。
- OEngine/WebGPU differences: 48 B hierarchy、64 B GroupHeader、48 B MeshletHeader 和 16 B GroupDirectory 是 OEngine `OEGPACK V3.0` 的显式 little-endian ABI；disk offset 使用 u64，GPU address 使用 bank/slot u32；128 MiB bank/512 slots。Offline 产物的 scene/instance 索引由 `docs/specs/oegpack-scene-manifest-v3.md` 冻结，并自 ADR-0016 S6 起与 Web 路线共用 `Geometry Product admission -> VirtualGeometryResidency -> Renderer` 同一条路径（已删除 OEGPACK 专用 bootstrap residency adapter）。
- Fallback/lifecycle: attribute-aware simplification未达到冻结比率时仅在 recipe 允许时使用 `meshopt_simplifySloppy`，并设置 `kGroupSimplificationFallback`、放大 error、计数；不做隐藏的 source-vertex runtime fallback。bootstrap owner 失败时销毁全部 bank，显式 `destroy()` 释放 GPUBuffer。
- Local validation: C++ struct/offset `static_assert`、不同线程数 byte-identical golden、native/TS reopen、CRC/hash、DAG/bootstrap、page independence、corruption、Chrome WGSL raw-record decode/readback 与 medium-scene diagnostic cook。格式冻结还需要 [OEGPACK V3 spec](../specs/oegpack-v3.md) 规定的真实生产 Visibility consumer。

## GEO-NYX-WEB-COOKER · Browser-first WASM Geometry Product producer（移植中）

- Local owner/source: `OEngine/tools/oengine-web-geometry-cooker/`、`OEngine/tools/oengine-asset-core/src/geometry/GeometryCooker.cpp`、`OEngine/tools/oengine-asset-core/src/product/DecodedGeometryProduct.cpp`、`OEngine/src/assets/web-cook/wasm/WebGeometryCookerAbi.ts`。
- Upstream: 用户提供的本地 Nyx 只读快照，无可验证 `.git` metadata；2026-09-17 复核母稿列出的 7 个 Nyx source hash，构建入口在编译前强制复核；meshoptimizer 0.25 header hash `a05dfed026d1dbeea6b38751ff22397e48a6706a4138e92a160ad57e33f7c0fd`。
- License/adoption: Nyx/MiniEngine MIT、meshoptimizer MIT；完整 notice 见 `OEngine/tools/oengine-web-geometry-cooker/THIRD_PARTY_NOTICES.md`。可追溯局部移植；首个 browser profile 直接把已审查的 Nyx C++ port 编译为单线程 WASM，不链接 Native CLI、cgltf、LZ4、文件系统或 OEGPACK writer。
- Function map: `Build/BuildLOD0Meshlets/BuildMeshletsFromIndices` -> `BuildMeshlets/CookDomain`；`GeneratePositionRemap/GroupMeshlets/BuildVertexLocksByGroups` -> `CookDomain/BuildSeamLocks`；`SimplifyGroup` -> 同名 local port；`SerializeGroup/BuildStreamingData/BuildHierarchy/ValidateBuild` -> `SerializeGroup/BuildNyxHierarchy/ValidateLodBuild/AssembleDecodedGeometryProductV1`。精确输入/输出和字段布局见 [Web Geometry Cooker ABI V1](../specs/web-geometry-cooker-abi-v1.md)。
- Retained invariants: meshoptimizer clusterizer、position remap、material domain、同 LOD partition、seam/attribute protect lock、attribute-aware simplify、显式 sloppy/permissive fallback、refine/error propagation、per-LOD BVH8 + top BVH、coarse-first、Group page-local、完整 bootstrap cut、256 KiB independent decoded Page。
- Web differences: Range/glTF accessor canonicalization 在 Worker TS 边界形成 bounded canonical binary，保留 interleaved stride、normalized integer、index、material alpha/double-sided 和 canonical defaults；WASM 返回 Product tables、content-manifest identity evidence 和 page handle，只有取得 whole-page output credit 才逐页拷到 exclusive `ArrayBuffer`，并在 adapter 侧校验 decoded page hash。`WebCookWorkerHost` 只在 Dedicated Worker 侧持有 CPU/WASM cooker，`WebCookWorkerEntry` 在 module 初始化期间有界队列命令，再转发 descriptor/page Transferable，并在 session generation/cancel/failure 时释放 source/handle；不先写 OEGPACK，不把 WASM memory/SAB 当 transferable，不创建 GPU object。Emscripten 6.0.9 产物已入库并经 `createDefaultWebCookWorker` 接入 Dedicated Worker，admission/residency 已接通 `GeometryProductAdmissionController`；Web profile 把一个 canonical material domain 映射为一个 Product asset（asset index == domain index == catalog primitive index），保证 GPU per-instance material 单值，与 Native importer “一 mesh 一 asset（合并兼容 domain）” 粒度不同但共用同一 Product ABI。
- Fallback/lifecycle: input/recipe/reserved/padding/index/finite/budget 错误整体 fail closed；opaque handle 在 generation cancel/failure 时整体销毁，未 offer descriptor/page 不允许进入 admission。`portable-pool` 通过 `WebCookWorkerPool` 固定 session generation ownership，Worker crash/messageerror 使 generation 失效并补建 replacement slot；`WebCookClient` 对 source/WASM/output 做 page-global reservation 与统一释放。pthread 变体已构建到 `wasm/vendor/threads/`，仅在 `crossOriginIsolated && SharedArrayBuffer` capability gate 通过时选择，未通过时显式 fallback 到 `portable-single`；真实部署握手仍需浏览器 smoke。
- Local validation: Native ABI oracle 对同一 canonical cube 连续 cook 两次并逐 section/page byte compare；C++/TS canonical + recipe bytes 共用 SHA-256 golden；覆盖 length、normal declaration、non-finite、index 和 budget negative case。Emscripten build、Dedicated Worker、Range coalescing 与 Nyx 三腿 differential corpus 已交付；`run:glb-web-product` 用真实 Dungeon GLB（798 mesh / 25 material）在 Chrome 跑通并做 HDR 像素覆盖率断言（region 256、linear-HDR luminance > 0.02、门禁为 `litPixels >= 64`；实测值随 revision 变化，`a6b730a` 上为 12023/65536）。Worker crash/OOM、portable-pool/pthread 与 THIRD_PARTY 之外的性能证据仍属于后续阶段。

## GEO-NYX-VIRTUAL-RUNTIME · Product V1 hierarchy/address consumer（移植中）

- Local owner/source: `OEngine/src/gpu/GeometryProductGpuAbiV1.ts`、`VirtualGeometryResidency.ts`、`OEngine/src/shaders/virtual_geometry_product.ts`、`hierarchical_work_generation.ts`、`OEngine/src/render/HierarchicalWorkGenerator.ts`。已接通 `MeshletWorkCandidate`、bucket raster、VisibilityKey 与 Sparse Shading（main + packed CSM），是 production consumer。
- Upstream: 用户提供的本地 Nyx 只读快照，无可验证 `.git` metadata；声明 commit 仅作线索。2026-09-16 复核 `MiniEngine/Model/Shaders/DAGCull.slang` SHA-256 `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e`、`VBufferMesh.slang` `9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d`、`GeometryStreaming.cpp` `acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072`；其余源文件/hash 见 [0016](../implementation/0016-virtualized-assets.md#nyx-移植工作流强制)。
- License/adoption: Nyx/MiniEngine MIT，notice 见 `OEngine/tools/oengine-asset-core/THIRD_PARTY_NOTICES.md`；可追溯局部移植，不直接依赖 DX12 runtime。
- Function map（当前已实现的部分）：`MeshletStructs.h::HierarchyNode`、`GroupHeader`、`MeshletHeader`、`GroupDataLocation` → V3 decoded profile、Product heap 的 bounds/error/Group/page/bank-slot-generation 解码；`DAGCull.slang::ProcessNodeBatch` 的 root seeding、BVH8 internal child wavefront、leaf bounds/HZB/SSE 与 resident check → `HierarchicalWorkGenerator` 的 Product-specialized root/traversal；`GeometryStreaming::PinRootPages` 与 `SyncMemoryAndAddressTable` 的 pinned activation 和映射 → `VirtualGeometryResidency`。输入为 Product descriptor、instance geometry slot/generation、resident page；输出仍是现有 GPU traversal/VisibleCluster queue，不让 CPU 构造最终可见列表。
- Retained invariants: V3 48/64/48-byte record、24-bit GroupID、7-bit local MeshletID、BVH8、原始 parent error、独立 Page hash、generation-before-bank-read、有界全有或全无队列、上一帧 HZB fail-open；Product metadata 仅一只 storage binding，避免超过 WebGPU 10 storage buffers/stage 基线。
- WebGPU differences: Nyx bindless GPU address 改为 Product heap 和最多 4 个 128 MiB storage bank；Slang wave/global atomics 改为现有 64-lane WGSL workgroup/ping-pong indirect rounds、32-bit CAS reservation；Group request mask、延迟 page demand（`GeometryPageDemandV1` + rotating readback ring）与 `hierarchy_virtual_find_resident_ancestor_v1` resident ancestor fallback 已接入；GPU bindings 使用 Device 级共享 `GeometryProductSlotPool`（4 × 128 MiB bank、256 KiB 页、2048 slot），由 `retain()` 取得固定 bank 绑定，避免 demand 上传新建未绑定 bank。
- Fallback/lifecycle: root queue overflow 不编造不可渲染 parent；无效 Product generation/node/location fail closed；resident ancestor fallback、demand 写入、revoke→retire→安全复用驱逐、device-loss `abandonForDeviceLoss` 与 Product revision 原子替换（release→re-stage→retire）已实现；仍缺 ADR-0014 浏览器 MILESTONE 证据。
- Validation: CPU metadata heap/record/generation/section negative oracle、非零 ProductTableSlot admission/rollback、V3 native golden；原版 DAGCull/VBufferMesh 已由 Nyx Slang 2026.10 编译/reflection harness 校验，真实浏览器 readback 由 `virtual-product-production` 与 `virtual-geometry-component` 提供，覆盖 demand/ancestor fallback、VisibilityKey 和容量 1 overflow fail-closed；相同 workload GPU 性能证据仍属于后续 PERF，不在第五步宣称。

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

## ADR-0016 · Nyx 移植验收 corpus

§18.4 硬门禁的落点（允许布局/ID/压缩字节不同，几何合同必须一致）：

- **source provenance**：见 `GEO-NYX-OEG3` / `GEO-NYX-WEB-COOKER` 的本地快照、核验日期与 SHA-256；CMake 与两个 build 脚本在编译前强制复核 7 个 Nyx 源 hash。
- **function map**：同两条目的 Function map 表，逐函数对应到 OEngine native/WASM/WGSL 实现。
- **invariant checklist**：`OEngine/tests/nyx-differential-corpus.test.mjs` 的 `assertNyxInvariants` 检查 meshlet 顶点/三角形上限、非空 Product、完整 bootstrap cut、有限 parent error、有序 asset bounds；`summarize()` 另外断言每个 Group 的 payload 完全落在一个 Page 内。
- **differential corpus**：同一条确定性 GLB 分别由 **Native Offline Cooker（cgltf + native importer）** 与 **Web Runtime（Web canonicalizer + pinned WASM cooker）** cook，比较 recipe hash、asset/hierarchy/group 计数、bootstrap cut 大小、asset bounds（1e-3 容差）与 max meshlet 顶点/三角形；两者必须等价。
- **negative corpus**：见下表。
- **运行证据**：`validation/` 的 `run:glb-web-product`（真实 Dungeon GLB、Chrome、HDR 覆盖率断言、accepted）。

| 负例 | 落点 |
| --- | --- |
| 非法 meshlet 上限 / 空 Product / 缺 bootstrap / 非有限 error / 反向 bounds | `nyx-differential-corpus.test.mjs` |
| 跨页 Group | `nyx-differential-corpus.test.mjs` |
| header/metadata/compressed bytes/logical link corruption | `oegpack-v3.test.mjs` |
| stale generation / duplicate / retry / budget / abort | `geometry-page-scheduler.test.mjs`、`geometry-product-admission.test.mjs` |
| overflow（output / readback / demand） | `web-cook-budget.test.mjs`、`geometry-page-demand-abi.test.mjs` |
| 取消 / 回滚 / replacement / device-loss recovery | `geometry-product-admission.test.mjs`、`virtual-geometry-product.test.mjs` |
| 缺页 fallback / eviction / retiring slot | `virtual-geometry-product.test.mjs`、`geometry-page-streaming-runtime.test.mjs` |

**第五步已完成（保留平台边界）**：`build-nyx-reference-harness.mjs` 在只读临时目录中原字节编译并运行 Nyx `MeshletBuilder.cpp`，输出真实 groups/hierarchy/meshlets、空输入拒绝、确定性、bounds、infinity error-sentinel、attribute seam lock 与 sloppy fallback；`build-nyx-model-convert-reference-harness.mjs` 抽取并运行原版 `WalkGraph`、`ParallelCompileMeshes`、`BuildModel`，验证节点/实例/相机、共享 mesh 去重、scene 拒绝与临时源队列；`SaveModel` 的原版接受/zero-draw/越页/cleanup 分支做 source-audit，未把 Windows DX12 file-mapping 字节布局当 WebGPU oracle。原版 GPU shader 由 Nyx Slang 2026.10 编译到 SPIR-V 并反射 entry point，随后由 WebGPU 浏览器 counter/readback 验证对应语义。三者都不把 OEngine port 当 Nyx oracle，`External Algorithm Complete` 已可标记；不宣称原版 DX12 MiniEngine 整体构建或跨 API 字节相同。

### 第五步机器校验产物（2026-09-19）

七项 Nyx 源 hash、函数级映射、真实 consumer、WebGPU 适配、fallback 和 oracle 状态统一维护在 [`nyx-function-map.json`](./nyx-function-map.json)。`npm run audit:nyx-function-map` 只读取清单中的七个 Nyx 源文件，同时校验生产 WGSL 语义 token、GPU counter 和 validation case。当前 `referenceHarness.status` 为 `verified-source-harnesses`，`notExternalAlgorithmComplete` 为 `false`，第五步可标记 `External Algorithm Complete`。

`nyx-differential-corpus.test.mjs` 现在运行独立 Nyx MeshletBuilder/ModelConvert harness，并覆盖 seam/fallback、Web Cook determinism、Native/Web/Nyx 三腿结构、DAG/层次可达性、asset bounds containment、bootstrap identity；`validation/src/cases/virtual-product-production/main.ts` 的真实 Chrome 证据覆盖两页 Product bootstrap、缺页遍历、ancestor fallback、GPU queue/VisibilityKey counters，`virtual-geometry-component` 覆盖注入 overflow 的真实 GPU readback。malformed Product、stale generation 和 cancel 负例仍由对应 Product/page/cook targeted tests 覆盖；正式 GPU 性能与原版 DX12 整体工程运行不在本步声明范围。
