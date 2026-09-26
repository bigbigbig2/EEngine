# Validation 宿主约束

- 本目录只拥有浏览器验证、性能运行、证据协议与本机 artifact，不拥有产品 Renderer 或 Example Library。
- 每个 Case 使用独立 Document、独立 WebGPU 生命周期和唯一 registry id；Runner 不理解渲染算法。
- 每个 case 显式声明 `evidenceRole`；`diagnostic` 可不绑定 claim，且任何情况下都不能发布 accepted evidence。lab 固定为 `diagnostic`。
- 不添加运行时 legacy/candidate backend 开关，不复用用户 Chrome profile、扩展、已有 tab 或缓存。
- `passed` 必须同时满足新鲜度、错误聚合、Case assertion 和 dispose；`unsupported` 不能掩盖 correctness failure。
- Raw artifact 默认写入仓库根 `.local/validation/` 且不提交；只有 clean revision、条件完整且可复算的 summary 才能进入 `OEngine/benchmarks/`。
- 协议、registry、Runner 或 artifact schema 的实现可连续修改；该大模块连通后集中运行 typecheck 与必要的 targeted tests。`protocol-self-test`、真实 WebGPU Case、clean revision 和 `--run --accept` 属于最终验收或主动诊断，不能成为普通开发的前置门禁。自动 case 位于 `validation/cases/<id>/`，观察实验位于 `validation/labs/<id>/`。
