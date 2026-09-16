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
- [Geometry Product V1](./geometry-product-v1.md) — draft producer-neutral descriptor/page/provider 合同。
- [Virtual Geometry Runtime V1](./virtual-geometry-runtime-v1.md) — draft admission/residency/feedback/publication 合同。
