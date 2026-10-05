---
id: archive/2026-09-21-web-100m-phase-b-canonical-windowing
state: history
---
# ADR-0018 Phase B Canonical Windowing 审评（2026-09-21）

本记录声明 Phase B 的实现与 contract/oracle 完成，不声明 Runtime Validated、Performance Evaluated 或 ADR Complete。正式浏览器 100M PERF 仍属于后续 Phase K。

## 结果

Web runtime cook 已从：

```text
total source admission → full-scene canonical ArrayBuffer → one WASM call
```

改为：

```text
metadata catalog → bounded source ranges → bounded canonical window
→ incremental WASM builder append → Product plan
```

总资产 `sourceBytes` 只保留为 catalog/progress 元数据，不再作为 live source admission；session/global ledger 只按配置的 source window capacity 预留。`NyxWebRuntimeCooker` 暴露 source/canonical current、peak、limit、planned/completed window 证据，每个 window append 后释放 canonical input，再进入下一 window。

WASM ABI major 仍为 2，增加 begin/append/finish/destroy builder。portable-single 与 experimental pthread checked-in artifacts 均由固定 Emscripten 6.0.9 重建；真实 artifact oracle 已执行两次独立 append，而不只是 native stub。

## 原设计 Exit Criteria 对照

| Phase B 要求 | 证据 | 结论 |
| --- | --- | --- |
| 100M canonical peak 不超过配置预算 | metadata workload：100,000,000 triangles、1,000 primitives；64 MiB canonical budget；125 windows；peak 47,349,120 bytes | 满足 |
| 100M → 250M 时 peak 不按总量同比增长 | 250,000,000 triangles、2,500 primitives；313 windows；peak 仍为 47,349,120 bytes | 满足；增长的是 window count |
| 不保留 whole-scene decoded geometry | range reader、canonical domain 和 canonical ArrayBuffer 都限制在一个 window；native builder append 返回后不保留 canonical input/decoded canonical asset | 满足 |
| 结果不因 window 边界改变 | native oracle：两个 window 与同顺序 monolithic plan 的 descriptor sections byte-identical；真实 WASM artifact 验证两个 asset 输出 | 满足 |

上述 100M/250M 是按真实 canonical ABI byte formula 生成的 metadata-scale oracle，不是浏览器 PERF run。encoder 实际字节与 planner estimate 在 runtime 中逐 window 强校验；完整 451 项 engine suites 通过。

## 所有权变化

- `maxSourceBytes` 现在表示 live source-window capacity，不表示总 GLB/glTF 大小上限。
- `maxCanonicalInputBytes` 表示单个 canonical window 上限。
- source reader 只在一个 window canonicalize 期间存活。
- canonical `ArrayBuffer` 只活到同步 WASM append/plan/cook 已复制输入为止。
- builder 会保留 cooked assets/serialized groups 以最终规划 Product；这是原设计 Phase D 的 `retainedGroups` 问题，不属于 Phase B decoded-canonical owner。

## 明确保留的下一阶段边界

- 单个 primitive 自身超过 source/canonical window 时 fail closed，并报告 `Phase C spatial sharding is required`。100M single-giant-primitive 因此进入 Phase C，不通过扩大预算绕过。
- Zorah v2 的 `EXT_meshopt_compression` bounded decode 尚未实现，仍停在 catalog capability gate；Zorah 的 1.627B source triangles 与 18.937B logical triangles 继续作为真实规模控制组，不能被 metadata oracle 替代。
- Phase D 仍需释放 completed Group payload，并实现 cook-and-spill；当前工作没有把它误报为完成。

## 验证

```text
npm test
451 tests passed, 0 failed

node tools/build-web-geometry-cooker-oracle.mjs
web geometry cooker ABI oracle passed
```

最后门禁使用 `node tools/vibe.mjs verify --changed`；其结果记录在本次提交交付说明中。
