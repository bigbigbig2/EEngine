# Geometry

## GEO-MESHOPT · meshoptimizer Cooker

- Local owner/source: `OEngine/src/geometry/GeometryAssetPackage.ts`、Cooker 与 `meshoptimizer@1.0.0`。
- Upstream: <https://github.com/zeux/meshoptimizer>
- Revision: tag `v1.0`, commit `73583c335e541c139821d0de2bf5f12960a04941`；npm integrity `sha512-xsmHsLUFiImOMBwFUqXLqYniaA5rJPZYhgJvyuBsk3cfMWJi8S3BPLkvU2KvYciAV3dwrON20GiiwQJ9eTO/uA==`。
- Upstream source: `meshopt_clusterizer.js`、`meshopt_clusterizer.d.ts`、`meshopt_clusterizer.test.js`。
- License: MIT；包内 `LICENSE.md` 和源码 notice 必须保留。
- Adoption: direct dependency。
- Retained invariants: triangle-list 输入、Meshlet vertex/triangle limits、local/global index、winding、sphere/cone bounds；material/alpha/double-sided 不跨 Meshlet。
- OEngine/WebGPU differences: Cooker 只提取精确 range 并写 OEngine sections，不序列化 WASM heap/上游 struct；超过 512 triangles 的 hierarchy node 使用保守 sphere 并关闭 cone。
- Fallback/lifecycle: 非有限 bounds 回退到保守 AABB sphere；版本、integrity 或 license 改变必须更新 recipe identity。
- Local validation: `geometry-hierarchy.test.mjs`、package reopen/determinism 和上游 clusterizer regression。

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

- Local owner/source: `OEngine/src/core/OrbitControls.ts` 及 Rendering Lab。
- Upstream: <https://github.com/mrdoob/three.js>
- Revision: `7cda7e710d884827fc73ff1a3aa63270846513d7`。
- Upstream source: `examples/jsm/controls/OrbitControls.js`。
- License: MIT，copyright three.js authors；本地源码 header 保留 notice。
- Adoption: traceable local port of interaction semantics; no runtime dependency。
- Retained invariants: target orbit、polar/azimuth/distance limits、rotate/dolly/pan、damping、events 和 explicit dispose。
- OEngine/WebGPU differences: 使用 OEngine Vec3/Transform3D 和 +Z camera convention；不会把 three.js 对象带入渲染热路径。
- Fallback/lifecycle: input 只累计 delta；`dispose()` 移除事件；无 GPU allocation。
- Local validation: controls unit tests 与 Rendering Lab interaction。

## GEO-LAB-ASSET · Dungeon validation asset

- Local owner/source: `examples/rendering-lab/assets/dungeon_warkarma.glb` 与 `THREE-LICENSE.txt`。
- Upstream: <https://github.com/mrdoob/three.js>；作品 “Dungeon - Low Poly Game Level Challenge” by Warkarma。
- Revision: repository `7cda7e710d884827fc73ff1a3aa63270846513d7`；SHA-256 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`。
- Upstream source: `examples/models/gltf/dungeon_warkarma.glb`。
- License: upstream repository MIT evidence and retained attribution/license file。
- Adoption: copied validation asset only。
- Retained invariants: unchanged GLB, static nodes, embedded WebP materials and stable hash。
- OEngine/WebGPU differences: OEngine packed glTF loader/Cooker/residency owns import; no upstream renderer、SSR 或 loader code is used。
- Fallback/lifecycle: import/cook failure is visible and blocks fixture readiness；asset GPU resources belong to Packed residency owner。
- Local validation: Rendering Lab import、Packed residency、first-frame diagnostics。
