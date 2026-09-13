# Validation 宿主约束

- 本目录只拥有浏览器验证、性能运行、证据协议与本机 artifact，不拥有产品 Renderer 或 Example Library。
- 每个 Case 使用独立 Document、独立 WebGPU 生命周期和唯一 registry id；Runner 不理解渲染算法。
- 不添加运行时 legacy/candidate backend 开关，不复用用户 Chrome profile、扩展、已有 tab 或缓存。
- `passed` 必须同时满足新鲜度、错误聚合、Case assertion 和 dispose；`unsupported` 不能掩盖 correctness failure。
- Raw artifact 默认不提交；只有 clean revision、条件完整且可复算的 summary 才能进入 `OEngine/benchmarks/`。
- 修改协议、registry、Runner 或 artifact schema 时先运行 `npm run typecheck`、`npm test` 和 protocol self-test；真实 WebGPU Case 还必须运行命中的浏览器测试。
