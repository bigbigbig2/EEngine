---
id: archive/2026-09-22-web-100m-phase-j-dynamic-page-scheduler
state: history
---
# ADR-0018 Phase J Dynamic Page Scheduler 审评（2026-09-22）

本记录把 ADR-0018 Phase J 的 camera/IO/GPU/frame pressure 调度要求落到现有
Product page scheduler，同时保留固定预算作为 hard cap。

## 结果

- `GeometryPageSchedulerV1` 新增纯预算映射：stable 收缩、moving 保守、cut 在
  声明上限内 burst；GPU pressure、frame pressure 和 IO pressure 共同限制
  concurrency、in-flight bytes、upload bytes/frame。
- page decoded bytes 自动成为 in-flight/upload floor，避免 adaptive 收缩到
  无法传输一个完整 Page 的非法预算。
- pressure、budget change、cut burst、throttled frame、active budget 都进入
  scheduler evidence；原有 demand overflow、retry、cancel、late result 和
  upload budget counters 保持不变。
- `GeometryPageStreamingRuntimeV1.updatePressure()` 是唯一 runtime 入口；它不
  触碰 Product identity、generation 或 residency ownership。

## ADR-0018 对照

| Phase J 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| 根据 camera state 动态调节 | `stable`/`moving`/`cut` 三态映射，cut 仅恢复 caps | 满足 implementation/unit |
| 根据 IO throughput 调节 | 目标吞吐与实际吞吐形成 `ioPressure` | 满足 implementation/unit |
| 根据 GPU pressure / frame time 调节 | normalized GPU pressure + target frame ratio | 满足 implementation/unit |
| bounded reads/in-flight/upload | caps、minimums、page-size floor 均在预算计算中校验 | 满足 |
| pressure/retry/cancel/overflow evidence | adaptive evidence 与既有 scheduler evidence 合并输出 | 满足 |
| generation/device-loss safety | unregister/abort/late-result 分支未改变 | 满足 contract；真实 device-loss 仍需 browser gate |

## 验证边界

`npm run typecheck`、fresh test build、定向 adaptive + legacy scheduler tests 通过。
独立 browser 的 camera-cut burst、稳定视角降压、真实 IO/GPU 曲线和 formal
100M PERF 仍是开放 gate，因此不升级 RuntimeValidated 或 Performance Improved。
