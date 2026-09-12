# Geometry

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
- Local validation: controls unit tests；浏览器交互 Gate 等待 ADR-0012 的后续宿主。
