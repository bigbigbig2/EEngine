# OEngine 规范

spec 是实现之间的精确合同，不负责解释长期取舍或报告进度。

## 状态

- `draft`：语义或布局仍可变，consumer 不得依赖未冻结字段。
- `candidate`：已有双方实现和测试，等待真实生产 consumer 或里程碑冻结。
- `frozen`：同 major version 内不可破坏；变更需要新版本和迁移说明。
- `retired`：不再供新 consumer 使用。

每篇 spec 必须声明 Status、Owners、Version/Compatibility、Contract 和 Validation。源代码常量与 spec 冲突时先停止扩散，确定哪一侧错误并同步实现、spec 和 oracle；不能仅修改文档掩盖 ABI 分叉。

## 索引

- [OEGPACK V3.0](./oegpack-v3.md) — candidate Offline container 与 V3 decoded profile。
- [OEGPACK Scene Manifest V3](./oegpack-scene-manifest-v3.md) — candidate  pack/asset/instance 索引合同。
- [Geometry Product V1](./geometry-product-v1.md) — draft producer-neutral descriptor/page/provider 合同。
- [Virtual Geometry Runtime V1](./virtual-geometry-runtime-v1.md) — draft admission/residency/feedback/publication 合同。
- [Web Geometry Cooker ABI V1](./web-geometry-cooker-abi-v1.md) — draft Dedicated Worker/WASM canonical input、recipe、Product section 与 ownership 合同。
- [Web Geometry Page Artifact / Spill Store V1](./web-geometry-page-artifact-v1.md) — draft Page artifact identity、Memory/OPFS spill、checksum、budget 与 lifecycle 合同。
- [Web Geometry Multi-Product Runtime V1](./web-geometry-multi-product-runtime-v1.md) — Phase E Product Table、Product-local identity、replacement/eviction/dormancy/release 与实例 ABI 合同。
- [Web Geometry Visible-First Product Scheduler V1](./web-geometry-visible-first-product-scheduler-v1.md) — Phase F current-view/spatial priority、TTFMF 与 total cook completion 边界、后台 refinement 和取消合同。
- [Web Geometry GPU Demand Dedup / Compaction V1](./web-geometry-demand-compaction-v1.md) — Phase G Product-local page mask、bounded priority demand queue、overflow 与 delayed readback 合同。
- [Web Geometry Adaptive GPU Residency Profile V1](./web-geometry-residency-profile-v1.md) — Phase H negotiated-limit profile selector、共享 page-bank capacity 与 feature-off 合同。
- [Web Geometry Current-HZB Late Recheck V1](./web-geometry-current-hzb-late-recheck-v1.md) — Phase I bounded current-HZB candidate recheck、overflow fallback 与 image-parity 合同。
- [Web CookSession Protocol V1](./web-cook-session-protocol-v1.md) — draft main thread/Worker 命令事件、credit ownership 与状态机合同。
