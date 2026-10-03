# Surface V3 优化 Phase 7 验证记录

日期：2026-10-03。结论：**未通过；正确性用例失败，生产浏览器编译阻塞，连续画质和性能验收未完成。**

本次按用户明确要求启动统一验收，范围依据[执行计划 §11–13](surface-work-v3-optimization-v1-execution-2026-10.md)。以下是诊断结果，不是来源 adoption、正式性能 claim 或 Phase 7 完成证据。没有提交“验收通过”的 commit。

## 固定条件与证据

- 测试源码：`c28d0292c7d4416a02b8d501cbecdaa9599be607` 加工作树修改；不是 clean revision。开始前已有 classifier、lighting、material cache、visual regression runner 和 registry 修改，均予以保留。
- GPU：NVIDIA GeForce GTX 1650 Ti，4096 MiB；驱动 581.42。
- 浏览器：Chrome 154.0.8037.92，独立 headless 进程，真实 NVIDIA WebGPU，1920×1080 viewport，deviceScaleFactor 1。
- 场景：Showcase Dungeon；GLB SHA256 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`。
- 启动组：默认 VSM-off/jitter-off，以及显式 VSM-on/jitter-on；示例曝光 4，沿用示例 AO/FSR3/Bloom 配置。由于未进入稳定渲染，本次不是固定内分辨率、预热或热状态的正式性能实验。
- 本地证据目录：`.local/validation/surface-v3-phase7-20261003/`。`manifest.json` 保存 revision、源码 SHA256、硬件、浏览器状态与 baseline 对象身份；`source.patch` 保存 tracked 工作树差异。`.local` 文件不随 Git 文档自动分发。
- 可重复运行的本地脚本：`.local/run-phase7-checks.mjs`、`.local/phase7-browser.mjs`、`.local/showcase-compile-isolation.mjs`、`.local/phase7-manifest.mjs`。

## 编译与组件结果

| 检查 | 结果 | 实际范围与限制 |
|---|---|---|
| OEngine typecheck、build:test、build | 通过 | 最后修改后重新执行；日志 `engine-typecheck.log`、`test-build.log`、`engine-build.log` |
| Surface/geometry/texture/ABI/timing targeted tests | 50/50 通过 | `targeted-tests.log`；CPU/合同检查不能证明生产 GPU 消费 |
| Showcase 独立 typecheck | 通过 | `.local/phase7-showcase-tsconfig.json`；`showcase-typecheck.log` |
| Showcase benchmark metrics tests | 4/4 通过 | `node --test examples/tests/showcase-benchmark.test.mjs`；含缺失测量与条件漂移拒绝比较 |
| validation typecheck/build | 通过 | `validation-build.log`；存在 bundle size warning |
| examples 全量 typecheck | 失败 | 老示例 `RenderingLab`、`PerformancePanel` 等仍引用已删除 Renderer API；没有恢复 retired API 来消除错误 |
| Native/core 与 Native Web ABI 构建 | 失败/环境阻塞 | 本机 MinGW g++ 8.1 工具链探测/编译失败；`native-build.log`、`native-web-abi.log`。本轮不宣称 Native metadata 生产者通过 |
| WASM、WASM threads build target | 通过增量目标检查 | 两者输出 `ninja: no work to do`，不能表述为本轮全量重新编译 |
| checked-in WASM artifact | 6/6 通过 | continuity-v2、独立 canonical windows、Product ABI、descriptor/payload、transfer 后重读；`wasm-artifact.log` |
| cell geometry GPU oracle | 通过组件检查 | 64 pixels、2 winners、2 setups、1024 B setup；不等于整帧消费链通过 |
| cell address GPU oracle | 通过组件检查 | `gpu-components/cell-address-gpu-oracle.json` |
| appearance bounds GPU oracle | 7 cases 通过组件检查 | `gpu-components/appearance-bound-gpu-oracle.json` |
| texture variation GPU oracle | 5 cases 通过组件检查 | `gpu-components/texture-variation-native.json` |
| FieldStore GPU oracle | 通过组件检查 | `gpu-components/surface-field-store-gpu-oracle.json` |
| cell plan GPU oracle | **失败** | 原 8 cases 通过，新增两个独立不变量失败，见下文 |

原生 Dawn/D3D12 oracle stderr 出现 cached pipeline blob `0x8000FFFF`，部分探测出现 adapter initialization warning；组件报告的 `apiErrors` 为空不等于浏览器矩阵干净通过。保留 stderr，不将这些结果升级为整链证据。

## 已复现的阻塞

### 生产 classifier 编译无法在诊断时限内完成

真实 Showcase 两组均完成资产加载并报告“场景已就绪”，但 90 秒后 `frameCount` 仍为 2；这不是两个正确画面完成的证明。等待至少 5 帧失败，随后的截图调用也在 5 秒后超时。

独立 `production-cell-browser` 已编译 constants 与 facts，停在 `Compiling classify_cells_stage_0` 超过 90 秒。单独抽取 Showcase stage 0 WGSL 的 compile-only 实验不提交 GPU work：module compilation info 无 WGSL error，但 `createComputePipelineAsync` 超过 45 秒；空 shader control 约 24 ms 完成。这把阻塞定位到生产 classifier pipeline 编译路径，尚未证明是哪一个编译器阶段或调用链造成。

诊断拆分中 load-only 约 1.2 s、scalar-only 约 11.8 s，bound evaluation 仍超过 45 秒；这些变体仅存于 `.local`，没有用跳过误差检查或禁用效果的变体替换生产链。超时后仅终止本次启动的浏览器树；人为终止后的 InstanceDropped 不记作自发 device loss。

### 混合域 map 发布非紧凑索引

`separated mixed domains use compact group indices`：tile 0、plane 0、lane 32 发布 group 32，但 plan 只有 2 slots。源码按原始 representative lane 写入 map，同时用 unique identity count 作为 slot count，两个索引空间不一致。日志：`cell-plan-expanded.log`；前 8 cases 和失败身份保存在 `cell-plan-expanded.json`。

### 混合域绕过字段误差预算

`mixed domains preserve field error bounds`：tile 0、plane 0、group 0 超过 0.02 的字段误差预算。交错两域内部值随 lane 变化，irregular 分支只按 identity 合并，没有调用 regular 分支的 group validity/field bound 判定。日志：`cell-plan-error-bounds.log` 与同名 JSON。两个新用例保留失败，不调整断言去迎合当前实现。

## 本轮修正与验证边界

1. 修正 classifier fact settings 的 WGSL/CPU 布局、首次 constants publication 前上传、bind group 1 和 material directory dispatch 数；dictionary/setup capacity 与 geometry producer 使用同一规划函数。
2. 修正 compact settings 的 `first_tile/tile_count` 顺序与 representative 最小值选择；发布 plane 的 map offset。
3. 修正 generic synthetic classifier 的 predicate 选择，避免它调用依赖生产库的 specialized predicate；GPU fixture 只 dispatch tile 维，删除重复 21 次同组写入。
4. 性能汇总补入新 classifier、geometry setup、FieldStore/SignalStore maintenance；新增回归测试先观察到 Surface total 仅 2、预期 18，再修正至通过。Showcase metrics 类型检查同步修正。

这些修正已通过上述编译/定向检查；生产 constants→classifier→compact 的完整运行仍受编译阻塞，不能宣称 Showcase 已修好。混合域两个正确性问题尚未修复。

## 截图、连续画质、生命周期与性能

| Phase 7 要求 | 本轮状态 |
|---|---|
| 默认 Showcase 1080p 启动 | 失败；`showcase/report.json` |
| VSM-on + jitter-on 启动 | 失败；`showcase-vsm/report.json`；另有 VSM WGSL unreachable warning |
| 截图 | 两组仅得到 `00-before-start.png`；production fixture 得到显示编译阶段的 `production-cell/failure.png`。均为诊断截图，**没有有效渲染质量截图** |
| 静止、慢移、快速转动、disocclusion 连续序列 | 未跑到；启动先失败，不能用启动截图代替 |
| linear HDR 与最终呈现误差、能量/coat/spec/normal/UV seam | 未完成；没有有效连续输出与参考对照 |
| 真实跨 primitive/meshlet、字段/信号多率覆盖 | 未完成；synthetic oracle 不替代实际 production producer→consumer |
| cold/warm cache、partial miss、HDR spill、最坏混合域/全 miss 容量与恰好一次写入 | 未完成整链验证；两个新增 mixed oracle 已失败 |
| resize/cut/abort/device loss、上一提交在途、scene unload、slot reuse、LOD/纹理发布 | 未跑到生产生命周期矩阵；CPU 合同测试不替代这些项 |
| 工作量、字节与 active/reserved/peak/retired 容量表 | 未采集有效稳定渲染数据；不将 allocator capacity 当作流量 |
| Surface 全成本与整帧 P50/P95 | 未测量；预热和有效样本数均未建立 |
| 四版本同条件比较 | 未执行；`89f0a94`、`15f12f7b`、`e7296be9` 及 `0676cf28` Git 对象均存在，但尚未在独立 checkout 验证可运行性。当前候选不能稳定渲染，不能组成有效比较；未捏造旧版本成绩 |

因此 §12 五类结论分别为：结构兑现未完成生产证据；正确性失败且画质未验证；GPU 工作收益未测；字节/容量收益未测；总体性能未测。修复生产 classifier 编译路径及 mixed map/bounds 后，必须从真实出图继续上述验收范围，不能把本次组件通过数当作 Phase 7 完成。
