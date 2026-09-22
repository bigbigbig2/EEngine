# ADR-0018 Phase I Current-HZB Late Recheck 审评（2026-09-22）

本记录最初冻结 ADR-0018 §28 的 bounded diagnostic policy；生产闭环随后由
`2026-09-22-web-100m-production-closure.md` 补齐。生产路径直接过滤标准
MeshletWork，不改变既有 Geometry/Visibility identity。

## 结果

- 新增 32-byte candidate record 与 32-byte atomic queue header 镜像；最大容量
  固定为 65,536 条记录。
- WGSL contract 使用 current HZB 四角 footprint sample、reverse-Z farthest
  (`min`) 规则和 all-or-nothing reservation；invalid projection/depth fail-open。
- 只有 `Uncertain | Expensive` 且带 `Conservative` 证明的 candidate 才能被拒绝。
- 输出 queue overflow 不发布 partial work，consumer 必须退回 source queue，因此
  不会因为优化容量压力改变图像。
- CPU oracle 覆盖 dense-occlusion reduction、invalid metadata、overflow fallback
  和 raster vertex accounting。
- 生产 FrameGraph 已接通 `previous HZB -> coarse raster -> current HZB -> compute
  filter -> filtered indirect raster`，final raster 直接消费输出 queue。
- 生产容量受 VisibilityKey 24-bit slot 与 adapter buffer limit 约束；65,536 只保留
  为 diagnostic candidate oracle 上限。source invalid/stale/overflow 会复制 source
  work 并正常发布 indirect count，而不是清零几何。

## ADR-0018 对照

| ADR-0018 Phase I 要求 | 当前实现与证据 | 结论 |
| --- | --- | --- |
| Previous-HZB traversal → current HZB → late candidate recheck | 生产 FrameGraph 与 filtered indirect final raster | 实现接线完成；浏览器证据仍需 Phase K |
| 只重查 uncertain / expensive | flags + conservative guard；oracle 断言非 eligible candidate 保留 | 满足 |
| selected meshlets / raster vertices 下降 | oracle 在遮挡样例中从 3 条/1152 vertices 降为 2 条/768 vertices | 实现/数值证据；未升级 PERF |
| image parity unchanged | invalid/overflow fail-open；所有被拒绝记录必须有 conservative 证明 | contract 保证边界；截图 parity 尚无真实浏览器证据 |
| 没有 consumer 时移除 pass | spec 要求 feature-off 不创建 queue/dispatch；未把事后诊断冒充 production consumer | 满足生命周期约束 |

## 验证边界

定向 oracle 通过后，再运行 `npm run typecheck`、`npm run build:test` 和完整
engine suites。独立 browser dense-occlusion case、GPU P50/P95 和 formal 100M
PERF 仍是开放 gate；本提交不宣称 RuntimeValidated 或 Performance Improved。
