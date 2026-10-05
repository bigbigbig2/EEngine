---
id: reviews/2026-09-22-web-100m-phase-g-gpu-demand-compaction
state: history
---
# ADR-0018 Phase G GPU Demand Dedup / Compaction 审评（2026-09-22）

本记录把 Phase G 的“Product-local request mask + priority record compaction”
落到当前虚拟几何可见性链，并区分实现证据与尚未取得的浏览器/PERF 证据。

## 结果

- `HierarchicalWorkGenerator` 为虚拟 Product work set 分配有界的 Product-local
  page bitmask；每次 encode 在 GPU dispatch 前清零。
- hierarchy traversal 在 queue reservation 前对 pageId 执行 `atomicOr`，同一帧
  camera cut 反复命中的 page 只保留一条 demand record；mask header 记录
  attempted/unique/duplicates/overflow。
- queue 仍是 16B header + 16B record，最大 256KiB；超过 capacity 的记录只置
  overflow，不写越界。延迟 readback ring 和 CPU scheduler 的 generation/hash/
  retry/上传预算保持不变。
- Product binding 暴露 pageCount，mask 大小为 `ceil(pageCount / 32)` words，最大
  1MiB；feature-off 不创建 queue/mask/readback 资源。

权威合同为
[`web-geometry-demand-compaction-v1.md`](../specs/web-geometry-demand-compaction-v1.md)。

## ADR-0018 对照

| ADR-0018 Phase G 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| Product-local request mask | `GeometryPageDemandMaskV1` + hierarchy root/traversal binding 14；按 Product-local pageId 原子置位 | 满足 implementation/contract |
| priority record compaction | 首次置位才进入 16B bounded priority record；CPU 合并延迟 main/shadow demand 时保留最高 priority | 满足当前单 Product producer epoch；统一多 Product consumer 仍开放 |
| camera-cut duplicates reduced before readback | mask 把重复 pageId 截断在 queue producer 之前；contract 测试覆盖 9 次命中压缩为 4 条 | 满足 local oracle/contract |
| bounded queue/readback | 256KiB demand queue、1MiB mask、延迟 ring slot 上限和 overflow header | 满足 bounded ABI |
| producer/consumer/counters | GPU hierarchy -> queue -> delayed ring -> streaming runtime -> scheduler；mask/queue counters 与 CPU evidence 均有定义 | 满足 contract；尚无独立浏览器 counter capture |

## 验证

本次定向验证通过：

```text
26 tests passed, 0 failed
npm run typecheck
npm run build:test
```

覆盖 demand ABI、mask duplicate/overflow/reset、WGSL atomic producer、shadow
共享 scheduler、delayed readback、scheduler retry/hash/cancel 和 Product
retirement。完整仓库门禁仍需在提交后执行 `node tools/vibe.mjs verify --changed`。

## 保留的门槛

这些证据是 Node/contract/oracle，不是独立浏览器画面或正式性能结果。以下仍
不能宣称完成：

- clean 100M browser host 上的真实 GPU mask duplicate ratio、readback bytes 和
  overflow-rate；
- 统一多 Product browser consumer（当前 renderer binding 仍以一个 Product 为
  一组 work-set mask）；
- 100M formal PERF、Zorah bounded `EXT_meshopt_compression` decode，以及后续
  Phase H–M。
