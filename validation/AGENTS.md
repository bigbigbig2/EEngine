# Validation 宿主约束

- 本目录只拥有浏览器验证、性能运行、证据协议与本机 artifact，不拥有产品 Renderer 或 Example Library。
- 每个 Case 使用独立 Document、独立 WebGPU 生命周期和唯一 registry id；Runner 不理解渲染算法。
- **claim 层已退休**（2026-10-05）。case 不再声明 `evidenceRole` 或 `covers`，`errorAllowlist` 规则不再携带 `ownerClaim`；`validation/src/shared/registry.mjs` 的对应校验规则一并移除。理由：claim 层要求 clean revision + 完整浏览器链路，在破坏式重建期间这两个条件不成立，因此它 12 天零产出却维护着约 2,300 行机制。验证职责转移给：`checks/` 的检查集合（含 `gpu-environment` 走真实 GPU oracle）、以及 `validation/` 自身的真实 WebGPU case。
- 不添加运行时 legacy/candidate backend 开关，不复用用户 Chrome profile、扩展、已有 tab 或缓存。
- `passed` 必须同时满足新鲜度、错误聚合、Case assertion 和 dispose；`unsupported` 不能掩盖 correctness failure。
- Raw artifact 默认写入仓库根 `.local/validation/` 且不提交。
- 协议、registry、Runner 或 artifact schema 的实现可连续修改；该大模块连通后集中运行 typecheck 与必要的 targeted tests。`protocol-self-test` 与真实 WebGPU Case 属于最终验收或主动诊断，不能成为普通开发的前置门禁。自动 case 位于 `validation/cases/<id>/`，观察实验位于 `validation/labs/<id>/`。
- 快速数值验证请用 `node tools/gpu-oracle.mjs <name>`（Tier 2）：它跑真实 WGSL 与真实 GPU，秒级返回，不需要 clean revision。
