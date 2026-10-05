---
id: archive/2026-09-22-web-100m-phase-d-cook-and-spill
state: history
---
# ADR-0018 Phase D Cook-and-Spill 审评（2026-09-22）

本记录声明 Phase D 的实现、contract 和 oracle 完成；不声明 100M 浏览器
Runtime Validated、Performance Evaluated、Phase E 或 ADR Complete。正式 100M
内存峰值、TTFMF 和 PERF 仍必须在独立 `validation/` host、clean revision 上取得。

## 结果

plan-backed WASM Product 的 page 生命周期现在是：

```text
read spill
  ├─ hit  -> 校验 key / decoded identity / checksum -> 返回独立副本
  └─ miss -> produce page -> checksum -> put atomically -> release WASM page
```

新增 `WebGeometryPageSpillStoreV1`，提供 bounded Memory backend 和 OPFS backend。
artifact key 固定为 `ProductID + revision + PageID + sessionGeneration`；OPFS
文件使用自校验 envelope，Memory 与 OPFS 都按 encoded artifact bytes 记录
current/peak/limit/owner count，并拒绝 partial、corrupt、mixed-generation 和
mixed-checksum artifact。读取始终返回可 transfer 的独立 `ArrayBuffer`。

成功写入 spill 后，WASM ABI 的可选
`oengine_web_geometry_cook_release_page(handle, pageId)` 释放该页 decoded
buffer 及对应 serialized Group；旧的 ABI-v2 artifact 没有此 symbol 时，
TypeScript fallback 保留旧 plan memory，仍保持正确性。Worker 默认优先 OPFS，
不可用时回退到 bounded Memory store。

## 原设计对照

| ADR-0018 Phase D 要求 | 当前实现与证据 | 结论 |
| --- | --- | --- |
| Cook shard → page → spill → release | `WasmPlanPageSource.materialize()` 先 `put`，成功后调用 `releasePage()` | 满足实现路径 |
| 不以未来 page read 为由长期保留 Group | spill 成功后释放 WASM page/Group；artifact owner 转移到 Spill Store | 满足 ABI/生命周期合同 |
| OPFS 为大模型首选，Memory 为 fallback | `createPreferredWebGeometryPageSpillStoreV1()` 检测 OPFS，失败回退 bounded Memory | 满足 |
| page re-read byte-exact | Memory/OPFS contract tests 覆盖独立副本、transfer 后重读和 corruption rejection | 满足 contract/oracle |
| identity/hash 稳定 | key、revision、decodedHash128、decodedPageHash128、完整 SHA-256 均校验 | 满足 |
| 取消、失败、retry、release 不发布混合 generation | AbortSignal、sessionGeneration、release/dispose 和 stale-result guard 已接入 | 满足 contract/oracle |
| 100M WASM/serialized-group peak bounded | 已有释放机制和 owner evidence；尚未在独立浏览器 100M workload 捕获正式峰值 | 未升级为 Runtime Validated/PERF |

## Nyx 与所有权边界

- Nyx 的 meshlet、Group、hierarchy 和 page layout 未改写；Phase D 只在 page
  materialization 后增加外部 artifact owner 和可选 release entry point。
- WASM plan 仍拥有 descriptor、Product identity 和未 spill 的临时状态；Spill
  Store 只拥有 immutable decoded page artifact；GPU Product、GPU address 和
  residency 不进入 spill store。
- `readPage()` 在 spill hit 时不会再次调用 cooker；`release()` 会停止后续
  page work、回收当前 generation 的 spill keys，并让迟到结果失效。

## 验证范围

新增 contract 覆盖：

- Memory/OPFS exact reread、transfer 后独立副本和 checksum corruption；
- maxBytes fail-closed、current/peak/owner/release/dispose 记账；
- generation isolation、Product descriptor identity 和 decoded hash 校验；
- plan-backed Product 首次 cook、第二次 spill hit、稳定 payload checksum；
- checked-in single-thread 与 pthread Emscripten artifact 均包含可选 release hook。

这些证据证明 producer/storage contract 和 WASM artifact 一致性，不证明
Zorah 的 `EXT_meshopt_compression` bounded decode、100M 浏览器 RuntimeValidated、
正式 TTFMF/PERF，亦不关闭 Phase E 的 Multi-Product runtime ABI。

## 后续门槛

1. 在独立 validation host 上用冻结的 100M single-giant workload 捕获 WASM、
   serialized-group、spill 和 page-cache owner 的 current/peak/limit。
2. 完成 Zorah bounded `EXT_meshopt_compression` decode，并做 Nyx differential、
   seam、determinism 和正式浏览器证据。
3. 进入 Phase E，冻结多 Product、Product Table、replacement/eviction 和
   GPU consumer 的 ABI 与 contract。
