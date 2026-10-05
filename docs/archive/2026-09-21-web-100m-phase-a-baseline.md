---
id: archive/2026-09-21-web-100m-phase-a-baseline
state: history
---
# ADR-0018 Phase A 基线记录（2026-09-21）

这份记录是诊断证据，不是 Runtime Validated、Performance Evaluated 或 ADR Complete 声明。原始报告位于忽略目录 `.local/validation/web-100m-phase-a-baseline/`，不会把大型 GLB 或浏览器 raw artifact 提交进仓库。

## 资产选择

Phase A 同时使用两类输入：

| 输入 | source triangles | nodes | primitives | 最大 primitive | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| `nyx-zorah-v2-official` | 1,627,207,159 | 16,988 | 3,163 | 32,054,609 | 官方真实 authored、高实例化、超过 1B unique 的主规模控制组 |
| `authored-local-large-glb` | 4,871,612 | 1,041 | 1,920 | 1,364,306 | 真实 authored multi-primitive 主控制组 |
| `amazon-lumberyard-bistro-exterior` | 2,829,226 | 1,297 | 1,591 | 82,015 | 真实 authored 场景交叉控制组 |
| `single-giant-100m.glb` | 100,000,000 | 1 | 1 | 100,000,000 | 原设计要求的 pathological single-giant-primitive 目标组 |

选择依据是几何语义，而不是文件 MB：`authored-local-large-glb` 的 source triangles、primitive 数和最大 primitive 都高于 Bistro；Bistro 的额外文件大小主要来自 854,491,628 bytes embedded image payload，而不是更多 geometry。两份 authored GLB 均为本地用户资产；Bistro 目录携带 `LICENSE.txt`（CC BY 4.0）和 `README.txt`，large 资产当前未找到许可证文件，因此只作为本地诊断输入，不作为可再分发 benchmark artifact。

Zorah v2 来自 [NVIDIA 官方归档](https://developer.download.nvidia.com/ProGraphics/nvpro-samples/zorah_main_public.v2.gltf.7z)，许可证为 MIT。归档不进入 Git；本地结构化扫描冻结的 multi-file identity SHA-256 为 `7fca3001761d379b724b905a9abe7308af4c993d7472120b6943f603212251f6`。它由 10,366,362-byte JSON glTF 和 10,001,629,940-byte 外置 `.bin` 组成，要求 `EXT_meshopt_compression`，解码目标 buffer 声明为 31,690,629,768 bytes。实际扫描值略低于 Nyx README 的 1,639,668,228 unique / 18,949,504,889 instanced triangles；归档 README 已说明分发版移除了部分 vegetation，因此工作负载以下载资产的 accessor/node 事实为准。

## 实际结果

### 当前正式生产预算（source 128 MiB）

四份输入都在相同的第一阻塞点失败：

```text
WebCookCoordinator: GLB source exceeds maxSourceBytes=134217728
```

| 输入 | 文件 bytes | 首次失败 owner | range-read peak | catalog | canonical/WASM/GPU |
| --- | ---: | --- | ---: | --- | --- |
| Zorah v2 glTF + buffer | 10,011,996,302 | `WebCookCoordinator` · `source-admission` | 10,366,362 | 未到达 | 未到达 |
| `large.glb` | 477,591,060 | `WebCookCoordinator` · `source-admission` | 1,635,692 | 未到达 | 未到达 |
| Bistro | 1,035,637,812 | `WebCookCoordinator` · `source-admission` | 2,014,912 | 未到达 | 未到达 |
| 100M pathological | 2,800,457,176 | `WebCookCoordinator` · `source-admission` | 1,116 | 未到达 | 未到达 |

这证明当前实现把 GLB 或 JSON glTF 的 declared total source bytes 当作 live source admission，而不是按已读取 range 的 source window 计费。Zorah 到失败点只实际读取了 10,366,362-byte descriptor，没有读取 10 GB 外置 buffer。100M pathological 只在本机按行流式生成，generator peak 192,000 bytes；它不是 authored application scene，只用于命中 ADR-0018 的 single-giant-primitive 门禁。

### 仅放宽 source budget 的诊断变体

将 100M pathological 的 source limit 临时提高到 3 GiB、将 `large.glb` 提高到 512 MiB 后，二者都能完成 catalog，随后在 visible-first bootstrap 选择阶段失败：

```text
automatic visible-first bootstrap exceeds 16777216 bytes
```

这把第二个阻塞点定位到 `WebCookCoordinator` 的固定 bootstrap source cap，而不是把它误归因到 WASM、meshlet、retainedGroups 或 GPU residency。该变体仍是 diagnostic-only，没有修改产品预算，也没有宣称 Phase B 已完成。

Zorah 的 source limit 临时提高到 12 GiB 后，下一阻塞点更早出现在 catalog：

```text
GlbSceneCatalog: GLB requires unsupported extension 'EXT_meshopt_compression'
```

Zorah 的第二门禁因此是 meshopt window decode/canonicalization，而不是 bootstrap、WASM 或 GPU。range source 现在能正确把 URI-less 的 31.69 GB decode destination 识别为 virtual buffer，不再将其误判为缺失文件，也不会把 virtual decode capacity 算入网络 source bytes；真正的 meshopt 增量解码尚未实现。

## 与原设计稿逐条对照

| 原设计稿要求 | Phase A 结果 |
| --- | --- |
| §38 建立 L0 10M、L1 100M、L2 250M、L3 500M、L4 1B workload | 已建立 100M pathological；Zorah 同时超过 L1 source 与 L4 logical scale，且有固定 identity。独立 10M/250M/500M identities 仍未建立 |
| §39 支持 `single-giant-primitive`、`many-primitives`、`city-grid` 等模式 | 已验证 single-giant-primitive；Zorah 提供真实 many-primitives/high-instancing 覆盖；city-grid/dense-indoor/high-occlusion/camera-cut generator 仍未完成 |
| Phase A 记录 Catalog、Range Read、Canonical、WASM、Meshlet、Simplification、retainedGroups、Descriptor、Admission、GPU metadata、GPU residency 的精确 owner | 已为每个 owner 输出 current/peak/limit/status；当前路径在 source-admission 和 bootstrap-selection 两处被准确定位，后续 owner 明确标记 not-reached |
| Phase A exit：100M failure owner + exact peak evidence | 已满足 diagnostic exit：100M source SHA、source bytes、range peak、failure owner/code/message 和 owner 表均已冻结 |
| §45 的 bounded source/WASM/GPU 目标值 | 尚未验证；当前结果说明在进入这些阶段前就被总 source bytes 和固定 bootstrap cap 阻塞 |
| §40 Nyx differential hard gate | 尚未进入 geometry cook，不得宣称通过 |
| 正式 PERF / clean revision / browser evidence | 尚未运行；本记录明确为 diagnostic-only |

## 当前结论

Phase A 已完成“失败归因”，但没有完成架构能力。下一步严格进入 workstream Phase B：把 source admission 从 total declared bytes 改为有界 source window，让 catalog/priority/bootstrap 只按 range 读取和 owner budget 计费，并为 Zorah 增加 bounded `EXT_meshopt_compression` decode window；不得先实现空间分片或 GPU 优化。Zorah 是正式真实规模目标，但其最大 primitive 只有约 32.1M，不能替代 100M single-giant-primitive 的 Phase C 门禁。
